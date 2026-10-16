// Feishu channel adapter (steward.md §9, feishu-channel.md §4/§8). Webhook inbound (ADR-0001
// decision 9), im/v1 outbound. All HTTP goes through an injectable `fetcher` so the Durable
// Object can point it at a service binding in tests; production uses global `fetch`.
import {
  MessageTooLargeError,
  RetriableChannelError,
  type AttachmentRef,
  type Brand,
  type ChannelAdapter,
  type InboundEvent,
  type OutboundMessage,
} from "./types.ts";

// Mainland Feishu domain. Lark international accounts (tenant_brand=lark, learned during
// QR onboarding) use open.larksuite.com instead; the brand is part of the stored channel
// config and selects the base per deployment (feishu-channel.md §1, §8.1).
export const FEISHU_API_BASE = "https://open.feishu.cn";
export const LARK_API_BASE = "https://open.larksuite.com";

export function apiBaseFor(brand: Brand): string {
  return brand === "lark" ? LARK_API_BASE : FEISHU_API_BASE;
}

// feishu-channel.md §4: serialized message cap 30 KB. Keep a margin for JSON quoting.
export const MAX_SERIALIZED_BYTES = 30_000;

// Spike bug 3: Feishu sends used to hang with no timeout; every call gets 10 s.
export const SEND_TIMEOUT_MS = 10_000;

// OpenClaw practice adopted via research §2.4: Feishu signatures carry no expiry, so reject
// events whose timestamp deviates more than an hour (blocks long-delayed replay).
export const MAX_EVENT_SKEW_MS = 60 * 60_000;

// Refresh the tenant token this far ahead of its stated expiry.
export const TOKEN_REFRESH_MARGIN_MS = 120_000;

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  verificationToken: string;
}

/** Body of the v7 application-config PATCH (schema per the official SDK's `application.ts`). */
export interface ApplicationConfigPatch {
  event?: {
    subscription_type: "webhook" | "websocket";
    request_url?: string;
    add_events?: string[];
    remove_events?: string[];
  };
  callback?: {
    callback_type: "webhook" | "websocket";
    request_url?: string;
    add_callbacks?: string[];
    remove_callbacks?: string[];
  };
  event_and_callback_encrypt_strategy?: {
    encryption_key?: string;
    verification_token?: string;
  };
}

/** Minimal cache surface the DO implements (sh_channel_token + the refresh alarm). The
 * stored form is sealed (secretbox), so both halves are async. */
export interface TokenStore {
  getCachedToken(): Promise<{ token: string; expiresAt: number } | null>;
  saveToken(token: string, expiresAt: number): Promise<void>;
}

export interface FeishuAdapterOptions {
  credentials: FeishuCredentials;
  tokenStore: TokenStore;
  fetcher?: typeof fetch;
  sendTimeoutMs?: number;
  now?: () => number;
  /** Brand-selected open-API base; defaults to the Feishu (mainland) domain. */
  apiBase?: string;
  /**
   * Accept `url_verification` handshakes regardless of the presented token. Set only inside
   * the QR-switch window (issue #24): the PATCH that points the app at our webhook may have
   * Feishu's URL check signed with the app's *previous* console token, which a QR-created
   * app never told us. Echoing a challenge leaks nothing (it is Feishu that must reach the
   * URL); real events always require the stored token to match.
   */
  looseHandshake?: boolean;
}

interface FeishuEnvelope {
  header?: {
    event_id?: unknown;
    event_type?: unknown;
    create_time?: unknown;
    token?: unknown;
    app_id?: unknown;
  };
  event?: Record<string, unknown>;
}

function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly #creds: FeishuCredentials;
  readonly #tokens: TokenStore;
  readonly #fetcher: typeof fetch;
  readonly #sendTimeoutMs: number;
  readonly #now: () => number;
  readonly #apiBase: string;
  readonly #looseHandshake: boolean;

  constructor(opts: FeishuAdapterOptions) {
    this.#creds = opts.credentials;
    this.#tokens = opts.tokenStore;
    this.#fetcher = opts.fetcher ?? fetch;
    this.#sendTimeoutMs = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
    this.#apiBase = opts.apiBase ?? FEISHU_API_BASE;
    this.#looseHandshake = opts.looseHandshake ?? false;
  }

  async verifyAndParse(req: Request): Promise<InboundEvent | Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const envelope = (body ?? {}) as Record<string, unknown>;

    // The console's URL check handshake: echo the challenge only for the right token
    // (looseHandshake widens this to any token — see FeishuAdapterOptions).
    if (envelope.type === "url_verification") {
      if (envelope.token !== this.#creds.verificationToken && !this.#looseHandshake) {
        return new Response("invalid token", { status: 401 });
      }
      return Response.json({ challenge: envelope.challenge });
    }

    const header = (body as FeishuEnvelope)?.header;
    if (!header || typeof header.event_id !== "string" || typeof header.event_type !== "string") {
      return new Response("bad request", { status: 400 });
    }
    if (header.token !== this.#creds.verificationToken) return new Response("invalid token", { status: 401 });
    if (header.app_id !== this.#creds.appId) return new Response("wrong app", { status: 403 });

    const createAt = parseCreateTime(header.create_time);
    if (createAt === null) return new Response("bad request", { status: 400 });
    if (Math.abs(this.#now() - createAt) > MAX_EVENT_SKEW_MS) {
      return new Response("stale event", { status: 403 });
    }

    if (header.event_type === "im.message.receive_v1") {
      return this.parseMessageEvent(header.event_id, header.event_type, (body as FeishuEnvelope).event);
    }
    if (header.event_type === "card.action.trigger") {
      return this.parseCardActionEvent(header.event_id, header.event_type, (body as FeishuEnvelope).event);
    }
    return {
      kind: "other",
      msgId: header.event_id,
      eventId: header.event_id,
      eventType: header.event_type,
      raw: body,
    };
  }

  // feishu-channel.md §8.2: `action.value` round-trips verbatim and `context.open_message_id`
  // points at the card message — the callback routing signal. The value carries only the
  // action; Thread identity is resolved server-side from the card's providerMsgId.
  private parseCardActionEvent(eventId: string, eventType: string, event: Record<string, unknown> | undefined): InboundEvent | Response {
    const operatorId = (event?.operator as Record<string, unknown> | undefined)?.open_id;
    const context = event?.context as Record<string, unknown> | undefined;
    const value = (event?.action as Record<string, unknown> | undefined)?.value;
    const cardMsgId = context?.open_message_id;
    if (typeof operatorId !== "string" || typeof cardMsgId !== "string") {
      return new Response("bad request", { status: 400 });
    }
    const action = value && typeof (value as Record<string, unknown>).action === "string" ? String((value as Record<string, unknown>).action) : "";
    return {
      kind: "card_action",
      msgId: eventId,
      eventId,
      eventType,
      operatorId,
      action,
      cardMsgId,
      raw: event,
    };
  }

  private parseMessageEvent(eventId: string, eventType: string, event: Record<string, unknown> | undefined): InboundEvent | Response {
    const message = event?.message as Record<string, unknown> | undefined;
    const sender = event?.sender as Record<string, unknown> | undefined;
    const senderId = (sender?.sender_id as Record<string, unknown> | undefined)?.open_id;
    if (!message || typeof message.message_id !== "string" || typeof senderId !== "string") {
      return new Response("bad request", { status: 400 });
    }
    let text: string | undefined;
    if (message.message_type === "text" && typeof message.content === "string") {
      try {
        const parsed = JSON.parse(message.content) as { text?: unknown };
        if (typeof parsed?.text === "string") text = parsed.text;
      } catch {
        text = undefined;
      }
    }
    return {
      kind: "message",
      msgId: message.message_id,
      eventId,
      eventType,
      senderId,
      chatType: message.chat_type === "group" ? "group" : "p2p",
      messageType: typeof message.message_type === "string" ? message.message_type : undefined,
      text,
      parentId: typeof message.parent_id === "string" && message.parent_id !== "" ? message.parent_id : undefined,
      createAt: parseCreateTime(message.create_time) ?? undefined,
      raw: event,
    };
  }

  async send(out: OutboundMessage): Promise<{ providerMsgId: string }> {
    if (out.kind === "text" && typeof out.text !== "string") {
      throw new Error("text message without text");
    }
    if (out.kind === "card" && out.card === undefined) {
      throw new Error("card message without card");
    }
    const content = JSON.stringify(out.kind === "text" ? { text: out.text } : out.card);
    const serialized = new TextEncoder().encode(content).length;
    if (serialized > MAX_SERIALIZED_BYTES) {
      throw new MessageTooLargeError(`serialized message is ${serialized} bytes, over the ${MAX_SERIALIZED_BYTES} cap`);
    }
    const token = await this.getTenantAccessToken();
    const data = (await this.#api("/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      // `uuid` makes retries provider-idempotent: even if a claim steal races a slow send,
      // Feishu deduplicates and the user sees one message.
      body: JSON.stringify({ receive_id: out.to, msg_type: out.kind === "text" ? "text" : "interactive", content, uuid: out.id }),
    })) as { data?: { message_id?: unknown } };
    if (typeof data?.data?.message_id !== "string") {
      throw new RetriableChannelError("send succeeded without a message_id");
    }
    return { providerMsgId: data.data.message_id };
  }

  async fetchAttachment(ref: AttachmentRef): Promise<Uint8Array> {
    // feishu-channel.md §8.3: user-sent images need the message-resource API, not image.get.
    const token = await this.getTenantAccessToken();
    const res = await this.#apiRaw(
      `/open-apis/im/v1/messages/${encodeURIComponent(ref.messageId)}/resources/${encodeURIComponent(ref.fileKey)}?type=${ref.type === "file" ? "file" : "image"}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** tenant_access_token cached by the DO and refreshed ahead of expiry (steward.md §9.2). */
  async getTenantAccessToken(): Promise<string> {
    const cached = await this.#tokens.getCachedToken();
    const now = this.#now();
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.token;
    const data = (await this.#api("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.#creds.appId, app_secret: this.#creds.appSecret }),
    })) as { tenant_access_token?: unknown; expire?: unknown };
    if (typeof data?.tenant_access_token !== "string" || typeof data?.expire !== "number") {
      throw new Error("tenant_access_token response malformed");
    }
    const expiresAt = now + data.expire * 1000;
    await this.#tokens.saveToken(data.tenant_access_token, expiresAt);
    return data.tenant_access_token;
  }

  /**
   * PATCH /open-apis/application/v7/applications/:app_id/config — the webhook switch
   * (feishu-channel.md §2.1/§8.2). Requires the `application:application:patch` scope (the
   * second scan). The event subscription URL takes effect immediately; the transport switch
   * itself only lands after a console republish — verified by event arrival, not this 200.
   */
  async applicationConfigPatch(appId: string, body: ApplicationConfigPatch): Promise<void> {
    const token = await this.getTenantAccessToken();
    await this.#api(`/open-apis/application/v7/applications/${encodeURIComponent(appId)}/config`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** JSON POST/GET with the shared timeout and error classification; returns the parsed body. */
  async #api(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.#apiRaw(path, init);
    return await res.json().catch(() => ({}));
  }

  async #apiRaw(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetcher(`${this.#apiBase}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.#sendTimeoutMs),
      });
    } catch (err) {
      throw new RetriableChannelError(`feishu request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (isRetriableStatus(res.status)) {
      throw new RetriableChannelError(`feishu http ${res.status}`);
    }
    if (!res.ok) {
      // 4xx (bad token, bad request, size…) is permanent: retrying cannot fix it.
      const body = await res.text().catch(() => "");
      throw new Error(`feishu http ${res.status}: ${body.slice(0, 200)}`);
    }
    const code = (await res.clone().json().catch(() => ({}))) as { code?: unknown };
    if (typeof code?.code === "number" && code.code !== 0) {
      throw new Error(`feishu code ${code.code}`);
    }
    return res;
  }
}

// `create_time` is a millisecond string in the v2 schema; tolerate second-precision senders
// (anything below ~2001-09-09 in ms is clearly seconds).
function parseCreateTime(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
