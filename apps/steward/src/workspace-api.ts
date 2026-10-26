// The workspace's HTTP API (ADR-0004): one read endpoint and four owner mutations, all
// behind the signed session cookie the Worker already verified. Mutations additionally need
// the session's CSRF token in a header, a same-origin Origin, and a JSON body — so a form
// post or a cross-site fetch can never act for the owner. Every mutation carries a client
// request id; the Durable Object makes retries of one id a single effect.
import { isThinkingLevel, type ComposerModelInput, type ModelSwitchInput } from "./llm/models.ts";
import type { ConnectionTestResult } from "./llm/connection-test.ts";
import type { BudgetState } from "./budget.ts";
import { DirectoryBrowseArgsSchema, RegisterRepoArgsSchema, type DirectoryBrowseArgs, type DirectoryListing, type RegisterRepoResult } from "@alexlikevibe/protocol";
import type { Ledger } from "./ledger.ts";
import {
  WorkspaceError,
  workspaceSnapshot,
  type WorkspaceActionInput,
  type WorkspaceDevice,
  type WorkspaceInput,
} from "./workspace.ts";

export interface MachineDirectoryInput {
  id: string;
  deviceId: string;
  path: string;
}

export type MachineDirectoryBrowseInput = DirectoryBrowseArgs & { deviceId: string };

export type MachineDirectoryResult =
  | { state: "pending"; id: string }
  | { state: "done"; id: string; repo: RegisterRepoResult["repo"] }
  | { state: "failed"; id: string; code: string };

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
  /** Issues #70/#74: the Settings page's runtime model switch — provider + modelId (+
   *  optional baseUrl), with `apiKey` optional once the provider has a sealed key: switching
   * to a previously keyed provider needs no re-entry, while giving a key reseals it (the
   * "fix a rejected key" flow stays the same single form). */
  saveModel?(input: ModelSwitchInput): Promise<void>;
  selectModel?(input: ComposerModelInput): Promise<unknown>;
  testModel?(input: ModelSwitchInput): Promise<ConnectionTestResult>;
  pairing?(id: string): Promise<{ code: string; expiresAt: number }>;
  revoke?(deviceId: string): void;
  addDirectory?(input: MachineDirectoryInput): Promise<MachineDirectoryResult>;
  browseDirectory?(input: MachineDirectoryBrowseInput, signal: AbortSignal): Promise<DirectoryListing>;
  /** `attestation`/the WebAuthn wire fields stay `unknown` here on purpose (synthesis graft 1):
   *  only webauthn.ts's verifyRegistrationResponse/verifyAssertionResponse ever assert their
   *  shape — this layer validates only that the JSON body is an object with the right keys
   *  present as non-empty strings, same depth as every other branch below. */
  webauthnRegisterOptions?(sid: string, rpId: string): Promise<{
    challenge: string;
    challengeToken: string;
    rpId: string;
    userId: string;
    excludeCredentials: { id: string; transports: string[] }[];
  }>;
  webauthnRegisterVerify?(sid: string, rpId: string, origin: string, label: string, attestation: unknown): Promise<void>;
  webauthnRemove?(credentialId: string): void;
}

export interface ApiSession {
  sid: string;
  csrf: string;
  /** Passkey enrollment and removal require a recent password or passkey ceremony. */
  recent: boolean;
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

/** Issue #70: provider + modelId (+ optional baseUrl) and the matching API key, all required
 *  together — switching provider always needs a new key, and re-submitting the same
 *  provider/modelId still reseals the key (the "fix a rejected key" flow is this same form). */
function parseModelSwitch(body: Record<string, unknown>): ModelSwitchInput {
  const { provider, modelId, apiKey, baseUrl, thinkingLevel } = body;
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) throw new WorkspaceError("bad_request");
  if (typeof provider !== "string" || !provider.trim() || provider.length > 128) throw new WorkspaceError("bad_request");
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 256) throw new WorkspaceError("bad_request");
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 8192)) throw new WorkspaceError("bad_request");
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || baseUrl.length > 2048)) throw new WorkspaceError("bad_request");
  return {
    provider: provider.trim(),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    modelId: modelId.trim(),
    ...(typeof apiKey === "string" && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(typeof baseUrl === "string" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  };
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
  const requireOrigin = deps.requireOrigin || url.pathname.startsWith("/app/api/machines/directories");
  if (!sameSecret(request.headers.get("x-csrf-token") ?? "", session.csrf) || (requireOrigin ? origin !== url.origin : origin !== null && origin !== url.origin)) {
    return json({ error: "forbidden" }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "json_required" }, 415);

  try {
    if ((url.pathname === "/app/api/settings/webauthn/register/options" ||
         url.pathname === "/app/api/settings/webauthn/register/verify" ||
         url.pathname === "/app/api/settings/webauthn/remove") && !session.recent) {
      return json({ error: "reauth_required" }, 403);
    }
    if (url.pathname === "/app/api/pairing" && deps.pairing) {
      const { id } = await readJson(request);
      if (typeof id !== "string" || !REQUEST_ID.test(id)) return json({ error: "bad_request" }, 400);
      const pair = await deps.pairing(id);
      return json({ ...pair, command: `npx @alexlikevibe/sig connect ${url.origin} ${pair.code}` });
    }
    if (url.pathname === "/app/api/settings/model/selection" && deps.selectModel) {
      const input = parseModelSwitch(await readJson(request));
      if (input.thinkingLevel === undefined) throw new WorkspaceError("bad_request");
      return json({ model: await deps.selectModel({ provider: input.provider, modelId: input.modelId, thinkingLevel: input.thinkingLevel }) });
    }
    if (url.pathname === "/app/api/settings/model/test" && deps.testModel) {
      return json(await deps.testModel(parseModelSwitch(await readJson(request))));
    }
    if (url.pathname === "/app/api/settings/model" && deps.saveModel) {
      await deps.saveModel(parseModelSwitch(await readJson(request)));
      return json({ ok: true });
    }
    if (url.pathname === "/app/api/machines/revoke" && deps.revoke) {
      const { deviceId } = await readJson(request);
      if (typeof deviceId !== "string" || !deps.devices().some(d => d.deviceId === deviceId)) return json({ error: "not_found" }, 404);
      deps.revoke(deviceId);
      return json({ ok: true });
    }
    if (url.pathname === "/app/api/machines/directories" && deps.addDirectory) {
      const { id, deviceId, path } = await readJson(request);
      if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof deviceId !== "string" || !/^[\w-]{1,128}$/.test(deviceId)) {
        throw new WorkspaceError("bad_request");
      }
      const args = RegisterRepoArgsSchema.safeParse({ path });
      if (!args.success) throw new WorkspaceError("bad_request");
      const result = await deps.addDirectory({ id, deviceId, path: args.data.path });
      return json(result, result.state === "pending" ? 202 : 200);
    }
    if (url.pathname === "/app/api/machines/directories/browse" && deps.browseDirectory) {
      const { deviceId, ...input } = await readJson(request);
      if (typeof deviceId !== "string" || !/^[\w-]{1,128}$/.test(deviceId)) throw new WorkspaceError("bad_request");
      const parsed = DirectoryBrowseArgsSchema.safeParse(input);
      if (!parsed.success) throw new WorkspaceError("bad_request");
      return json(await deps.browseDirectory({ deviceId, ...parsed.data }, request.signal));
    }
    if (url.pathname === "/app/api/settings/webauthn/register/options" && deps.webauthnRegisterOptions) {
      return json(await deps.webauthnRegisterOptions(session.sid, url.hostname));
    }
    if (url.pathname === "/app/api/settings/webauthn/register/verify" && deps.webauthnRegisterVerify) {
      const { challengeToken, clientDataJSON, attestationObject, label } = await readJson(request);
      if (typeof challengeToken !== "string" || typeof clientDataJSON !== "string" || typeof attestationObject !== "string") {
        return json({ error: "bad_request" }, 400);
      }
      if (typeof label !== "string" || !label.trim() || label.length > 80) return json({ error: "bad_request" }, 400);
      await deps.webauthnRegisterVerify(session.sid, url.hostname, url.origin, label.trim(), { challengeToken, clientDataJSON, attestationObject });
      return json({ ok: true });
    }
    if (url.pathname === "/app/api/settings/webauthn/remove" && deps.webauthnRemove) {
      const { credentialId } = await readJson(request);
      if (typeof credentialId !== "string" || !credentialId) return json({ error: "bad_request" }, 400);
      deps.webauthnRemove(credentialId);
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
      const cookie = ["sig_session=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");
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
