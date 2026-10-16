import { SELF, env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { Steward } from "../src/steward.ts";

export function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

// DO SQLite is NOT rolled back between tests in this setup (state visibly carries over), so
// every channel test starts by clearing the sh_* tables the same way the outbox tests reach
// in with raw SQL.
export async function resetChannelState(): Promise<void> {
  // Any RPC first: it flows through the SDK lifecycle, which runs onStart() → migrations.
  // Hitting runInDurableObject on a cold DO would find no sh_* tables yet.
  await ownerStub().setupState();
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    // `.bind` matters: the SDK's sql tagged template reads `this.ctx`, so it must be invoked
    // through the instance (the outbox tests use method-call form for the same reason).
    const sql = (
      instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }
    ).sql.bind(instance);
    sql`DELETE FROM sh_channel`;
    sql`DELETE FROM sh_qr_setup`;
    sql`DELETE FROM sh_inbound`;
    sql`DELETE FROM sh_outbound`;
    sql`DELETE FROM sh_channel_log`;
    sql`DELETE FROM sh_channel_token`;
    sql`DELETE FROM sh_channel_pace`;
  });
}

// ---- Feishu mock (service binding FEISHU_API, wired in vitest.config.ts) ----

export interface MockReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  url: string;
  body: string | null;
  at: number;
}

const MOCK = "https://feishu.invalid";

// vitest.config.ts always binds FEISHU_API; the optionality only exists for production.
function feishuMock(): Fetcher {
  if (!env.FEISHU_API) throw new Error("FEISHU_API service binding missing — check vitest.config.ts");
  return env.FEISHU_API;
}

export async function mockReset(): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/reset`, { method: "POST" });
}

export async function mockQueue(...replies: MockReply[]): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/queue`, { method: "POST", body: JSON.stringify(replies) });
}

/** Scripts the device flow (see vitest.config.ts): `begin`/`polls` are FIFO arrays whose last entry repeats. */
export async function mockRegistration(script: { begin?: unknown[]; polls?: unknown[] }): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/registration`, { method: "POST", body: JSON.stringify(script) });
}

export async function mockCalls(): Promise<RecordedCall[]> {
  const res = await feishuMock().fetch(`${MOCK}/__control/calls`, { method: "POST" });
  return res.json();
}

export function sendCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && c.path.startsWith("/open-apis/im/v1/messages"));
}

export function tokenCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.path.startsWith("/open-apis/auth/v3/tenant_access_token"));
}

export function registrationCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.path === "/oauth/v1/app/registration");
}

export function configPatchCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "PATCH" && /\/open-apis\/application\/v7\/applications\/[^/]+\/config$/.test(c.path));
}

// The credentials every helper below uses; the webhook's verification token must match
// `messageEvent({ token })` and `urlVerification({ token })`.
export const TEST_APP_ID = "cli_test_app";
export const TEST_APP_SECRET = "sec_test_secret";
export const TEST_VERIFY_TOKEN = "verify-token";
export const SETUP_URL = "https://example.com/setup?token=test-setup-token-not-a-secret";

export async function submitSetupCredentials(
  appId = TEST_APP_ID,
  appSecret = TEST_APP_SECRET,
  verificationToken = TEST_VERIFY_TOKEN,
): Promise<Response> {
  const body = new URLSearchParams({ action: "manual", appId, appSecret, verificationToken });
  return SELF.fetch(SETUP_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** Posts a setup-page action (QR flow start / scope scan / webhook PATCH). */
export function postSetupAction(action: string): Promise<Response> {
  return SELF.fetch(SETUP_URL, {
    method: "POST",
    body: new URLSearchParams({ action }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** Polls the QR state machine until the given phase appears (alarm-driven, so async). */
export async function waitForQrPhase(phase: string | string[], timeoutMs = 20_000): Promise<void> {
  const wanted = Array.isArray(phase) ? phase : [phase];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await ownerStub().qrSetupState();
    if (row && wanted.includes(row.phase)) return;
    if (Date.now() > deadline) throw new Error(`qr phase ${wanted.join("|")} not reached; now: ${row?.phase ?? "none"} err=${row?.lastError ?? "-"}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The decrypted channel config, read inside the DO — tests need the QR-generated verification token. */
export interface ChannelConfigView {
  appId: string;
  appSecret: string;
  verificationToken: string;
  ownerOpenId: string | null;
  brand: "feishu" | "lark";
  source: "manual" | "qr";
  webhookStatus: string | null;
}
export async function readChannelConfig(): Promise<ChannelConfigView | null> {
  return runInDurableObject(ownerStub(), async (instance: Steward) => {
    const load = (instance as unknown as { loadFeishuConfig: () => Promise<ChannelConfigView | null> }).loadFeishuConfig;
    return await load.call(instance);
  });
}

/** Submits credentials and binds `ou_owner` with a first DM; the confirmation send settles. */
export async function configureAndBind(senderId = "ou_owner"): Promise<void> {
  await submitSetupCredentials();
  const res = await postEvent(messageEvent({ msgId: `om_bind_${senderId}`, senderId, text: "hi" }));
  expect(res.status).toBe(200);
  await waitWhileOutboundPending();
}

export interface MessageEventOptions {
  msgId?: string;
  senderId?: string;
  chatType?: "p2p" | "group";
  text?: string;
  parentId?: string;
  messageType?: string;
  createTime?: number;
  token?: string;
  appId?: string;
}

export function messageEvent(opts: MessageEventOptions = {}) {
  const now = Date.now();
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${opts.msgId ?? "om_default"}`,
      event_type: "im.message.receive_v1",
      create_time: String(opts.createTime ?? now),
      token: opts.token ?? TEST_VERIFY_TOKEN,
      app_id: opts.appId ?? TEST_APP_ID,
    },
    event: {
      message: {
        message_id: opts.msgId ?? "om_default",
        root_id: "",
        parent_id: opts.parentId ?? "",
        create_time: String(opts.createTime ?? now),
        chat_id: "oc_default",
        chat_type: opts.chatType ?? "p2p",
        message_type: opts.messageType ?? "text",
        content: JSON.stringify({ text: opts.text ?? "hello" }),
      },
      sender: {
        sender_id: { open_id: opts.senderId ?? "ou_owner" },
        sender_type: "user",
        tenant_key: "tenant",
      },
    },
  };
}

export function postEvent(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/channels/feishu/events", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

export function urlVerification(token = TEST_VERIFY_TOKEN): Promise<Response> {
  return postEvent({ type: "url_verification", challenge: "ch-123", token });
}

/** Polls until no sh_outbound row is queued/sending (the void-fired delivery settled). */
export async function waitWhileOutboundPending(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await ownerStub().outboundRows(20);
    if (pending.every((row) => row.status === "sent" || row.status === "failed")) return;
    if (Date.now() > deadline) throw new Error(`outbound rows still pending: ${JSON.stringify(pending.map((r) => [r.id, r.status]))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function pairDevice(name: string): Promise<{ deviceId: string; token: string }> {
  const { code } = await ownerStub().createPairing();
  const res = await SELF.fetch("https://example.com/pair", { method: "POST", body: JSON.stringify({ code, name }) });
  return res.json();
}

export function connect(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch("https://example.com/agents/steward/owner?role=connector", { headers });
}

export function helloPayload(deviceId: string, connEpoch: number, overrides: Record<string, unknown> = {}) {
  return {
    t: "hello",
    id: `hello-${connEpoch}-${Math.random()}`,
    protocol: { min: 1, max: 1 },
    deviceId,
    bootId: "boot-1",
    connEpoch,
    connector: { version: "0.1.0", os: "darwin", arch: "arm64", node: "22.13.0" },
    machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
    agents: [],
    repos: [],
    limits: { maxWorkers: 4, running: 0 },
    workers: [],
    pendingAcks: [],
    ...overrides,
  };
}

// Buffered message reader: attached before the first frame can arrive, so server-pushed
// messages (cmd redelivery, events_ack, resync) triggered by unrelated RPC calls are never
// dropped the way an attach-after-send `once` listener can be.
export class MessageReader {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((m: Record<string, unknown>) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return this.nextWhere(() => true, timeoutMs);
  }

  async nextWhere(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const index = this.queue.findIndex(pred);
    if (index >= 0) return this.queue.splice(index, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for a matching message (${this.queue.length} queued)`));
      }, timeoutMs);
      const waiter = (m: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }
}

export function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
}

// Connects, attaches a MessageReader, says hello, and awaits the welcome. The reader stays
// valid for every subsequent frame on this connection.
export async function connectAndHello(
  deviceId: string,
  token: string,
  connEpoch = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ ws: WebSocket; reader: MessageReader; welcome: Record<string, unknown> }> {
  const res = await connect(token);
  const ws = res.webSocket!;
  ws.accept();
  const reader = new MessageReader(ws);
  ws.send(JSON.stringify(helloPayload(deviceId, connEpoch, overrides)));
  const welcome = await reader.nextWhere((m) => m.t === "welcome");
  return { ws, reader, welcome };
}
