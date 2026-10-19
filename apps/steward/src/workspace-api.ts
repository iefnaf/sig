// The workspace's HTTP API (ADR-0004): one read endpoint and four owner mutations, all
// behind the signed session cookie the Worker already verified. Mutations additionally need
// the session's CSRF token in a header, a same-origin Origin, and a JSON body — so a form
// post or a cross-site fetch can never act for the owner. Every mutation carries a client
// request id; the Durable Object makes retries of one id a single effect.
import type { BudgetState } from "./budget.ts";
import type { Ledger } from "./ledger.ts";
import {
  WorkspaceError,
  workspaceSnapshot,
  type WorkspaceActionInput,
  type WorkspaceDevice,
  type WorkspaceInput,
} from "./workspace.ts";

export interface WorkspaceApiDeps {
  ledger: Ledger;
  budget(): BudgetState;
  devices(): WorkspaceDevice[];
  now(): number;
  submitMessage(input: WorkspaceInput): Promise<void>;
  submitAction(input: WorkspaceActionInput): Promise<void>;
  endSession(sid: string): void;
  audit(reason: string, detail: string): void;
  requireOrigin?: boolean;
  settings?(): Promise<unknown>;
  saveModel?(apiKey: string): Promise<void>;
  pairing?(id: string): Promise<{ code: string; expiresAt: number }>;
  revoke?(deviceId: string): void;
}

export interface ApiSession {
  sid: string;
  csrf: string;
}

/** A message may be long (pasted logs), but not unbounded: the model sees it verbatim. */
export const MAX_MESSAGE_CHARS = 16_000;
const MAX_BODY_BYTES = 70_000;
const REQUEST_ID = /^[\w-]{8,128}$/;
const THREAD_ID = /^[\w-]{1,128}$/;
const CARD_ID = /^[\w:.-]{1,256}$/;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** Length-independent comparison, so the token check does not leak a matching prefix. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new WorkspaceError("too_large", 413);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (text.trim() === "") return {};
  try {
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new WorkspaceError("bad_request");
  }
}

function parseMessage(body: Record<string, unknown>): WorkspaceInput {
  const { id, text, threadId, replyTo } = body;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new WorkspaceError("bad_request");
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_MESSAGE_CHARS) throw new WorkspaceError("bad_request");
  if (threadId !== undefined && (typeof threadId !== "string" || !THREAD_ID.test(threadId))) throw new WorkspaceError("bad_request");
  if (replyTo !== undefined && (typeof replyTo !== "string" || !CARD_ID.test(replyTo))) throw new WorkspaceError("bad_request");
  return { id, text, ...(threadId ? { threadId } : {}), ...(replyTo ? { replyTo } : {}) };
}

function parseAction(body: Record<string, unknown>): WorkspaceActionInput {
  const { id, cardId, action } = body;
  if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new WorkspaceError("bad_request");
  if (typeof cardId !== "string" || !CARD_ID.test(cardId)) throw new WorkspaceError("bad_request");
  if (typeof action !== "string" || action === "" || action.length > 256) throw new WorkspaceError("bad_request");
  return { id, cardId, action };
}

export async function handleWorkspaceApi(request: Request, url: URL, session: ApiSession, deps: WorkspaceApiDeps): Promise<Response> {
  if (url.pathname === "/app/api/workspace") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json({
      ...workspaceSnapshot({ ledger: deps.ledger, budget: deps.budget(), devices: deps.devices(), now: deps.now() }),
      csrf: session.csrf,
    });
  }
  if (url.pathname === "/app/api/settings" && request.method === "GET" && deps.settings) return json(await deps.settings());
  if (request.method !== "POST") return json({ error: "not_found" }, 404);

  const origin = request.headers.get("origin");
  if (!sameSecret(request.headers.get("x-csrf-token") ?? "", session.csrf) || (deps.requireOrigin ? origin !== url.origin : origin !== null && origin !== url.origin)) {
    return json({ error: "forbidden" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "json_required" }, 415);

  try {
    if (url.pathname === "/app/api/pairing" && deps.pairing) {
      const { id } = await readJson(request);
      if (typeof id !== "string" || !REQUEST_ID.test(id)) return json({ error: "bad_request" }, 400);
      const pair = await deps.pairing(id);
      return json({ ...pair, command: `npx @iefnaf/sig connect ${url.origin} ${pair.code}` });
    }
    if (url.pathname === "/app/api/settings/model" && deps.saveModel) {
      const { apiKey } = await readJson(request);
      if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8192) return json({ error: "bad_request" }, 400);
      await deps.saveModel(apiKey.trim());
      return json({ ok: true });
    }
    if (url.pathname === "/app/api/machines/revoke" && deps.revoke) {
      const { deviceId } = await readJson(request);
      if (typeof deviceId !== "string" || !deps.devices().some(d => d.deviceId === deviceId)) return json({ error: "not_found" }, 404);
      deps.revoke(deviceId);
      return json({ ok: true });
    }
    if (url.pathname === "/app/api/messages") {
      const input = parseMessage(await readJson(request));
      await deps.submitMessage(input);
      return json({ id: input.id, accepted: true }, 202);
    }
    if (url.pathname === "/app/api/actions") {
      const input = parseAction(await readJson(request));
      await deps.submitAction(input);
      return json({ id: input.id, accepted: true }, 202);
    }
    if (url.pathname === "/app/api/logout") {
      deps.endSession(session.sid);
      const secure = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
      const cookie = ["shepherd_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }
    const read = /^\/app\/api\/threads\/([\w-]{1,128})\/read$/.exec(url.pathname);
    if (read) {
      if (!deps.ledger.threads.get(read[1]!)) return json({ error: "thread_not_found" }, 404);
      deps.ledger.threads.markRead(read[1]!);
      return json({ ok: true });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof WorkspaceError) return json({ error: error.code }, error.status);
    // The mutation did not complete; the client retries with the same request id.
    deps.audit("web_api_failed", `${url.pathname} ${error instanceof Error ? error.message : String(error)}`);
    return json({ error: "retry" }, 503);
  }
}
