// The browser web app (issue #22; browser entry superseded by ADR-0010). Password, passkey,
// and signed-link exchanges all open the same database-backed session, which gates the
// workspace. Production links are single-use and short-expiry; Preview deployments can make
// them reusable.
//
// Token formats (deployment-key-signed and rotatable):
//   link    wl1.<target>.<expiresAt>.<nonce>.<mac>   production: one use, ≤15 min
//   session ws1.<sid>.<mac>                           random sid, DB-backed, 7 days
// The owner Durable Object owns the keys and checks single-use/session liveness.
//
// Page content comes from the memory module's `views` (ledger.ts) and the protocol-layer
// device list — never raw table SQL scattered in handlers. Write actions from the web are
// logged to the audit trail like every other management action.
import type { Ledger } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";
import { loginPage } from "./login-page.ts";
import { verifyAssertionResponse, verifyRegistrationResponse, WebauthnVerifyError } from "./webauthn.ts";
import { handleWorkspaceApi, type WorkspaceApiDeps } from "./workspace-api.ts";
import { WorkspaceError } from "./workspace.ts";

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "sig_session";
/**
 * One ceremony, one round trip (candidate-2 design): short enough that a stolen challenge is
 * useless within seconds of being issued. 60s is a guess, not a measurement — the `agents` SDK's
 * own docs (docs/lifecycle.md) confirm a Durable Object's JS heap does not survive an eviction
 * between requests (which is exactly why this is a DB row and not an in-memory Map/alarm), but
 * neither it nor anything else in the package states how long an idle instance is typically kept
 * warm, so there's no real number to calibrate against.
 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 60_000;

const enc = new TextEncoder();

export interface LoginLinkPolicy {
  ttlMs: number;
  singleUse: boolean;
}

export const DEFAULT_LOGIN_LINK_POLICY: LoginLinkPolicy = { ttlMs: LINK_TTL_MS, singleUse: true };

function positiveDurationMs(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loginLinkPolicyFromEnv(
  ttlMs: string | number | undefined,
  reusableLink: string | boolean | undefined,
): LoginLinkPolicy {
  const reusable = reusableLink === true || reusableLink === "true";
  return { ttlMs: positiveDurationMs(ttlMs, LINK_TTL_MS), singleUse: !reusable };
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  const out = new Uint8Array(pairs.length);
  pairs.forEach((pair, i) => {
    out[i] = parseInt(pair, 16);
  });
  return out;
}

/** The byte encoding WebAuthn's `challenge` field wants on the wire. Not the W3C `base64url` of
 *  anything WebAuthn-specific — just a generic bytes-to-string encoding, which is why this lives
 *  here rather than in webauthn.ts (graft 1's module boundary is about wire-format *shapes*, not
 *  about who is allowed to base64url-encode a buffer). */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mac(secret: string, payload: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(payload)));
}

async function macOk(secret: string, payload: string, claimedHex: string): Promise<boolean> {
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    fromHex(claimedHex) as BufferSource,
    enc.encode(payload),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- link tokens --------------------------------------------------------------------------------

export interface MintedLink {
  token: string;
  expiresAt: number;
}

/** Target grammar: `home` or `t/<threadId>` — no dots or colons, so the flat format parses. */
export function linkTargetForThread(threadId: string): string {
  return `t/${threadId}`;
}

export async function mintLinkToken(secret: string, target: string, now = Date.now(), ttlMs = LINK_TTL_MS): Promise<MintedLink> {
  const expiresAt = now + ttlMs;
  const nonce = randomHex(16);
  const base = `wl1.${target}.${expiresAt}.${nonce}`;
  return { token: `${base}.${await mac(secret, base)}`, expiresAt };
}

export interface VerifiedLink {
  target: string;
  nonce: string;
  expiresAt: number;
}

/**
 * Stateless check: HMAC intact (against any key in the set — the SERVER_KEY_PREVIOUS window
 * of issue #27 keeps unopened links working through a rotation) and not past expiry.
 * Single-use is a DB fact, not checked here.
 */
export async function verifyLinkToken(secrets: readonly string[], token: string | null): Promise<VerifiedLink | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "wl1" || !/^[0-9a-f]{64}$/.test(parts[4]!)) return null;
  const [prefix, target, expiresRaw, nonce, macHex] = parts as [string, string, string, string, string];
  if (!/^[\w/-]+$/.test(target) || !/^\d+$/.test(expiresRaw) || !/^[0-9a-f]{32}$/.test(nonce)) return null;
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const payload = `${prefix}.${target}.${expiresRaw}.${nonce}`;
  for (const secret of secrets) {
    if (await macOk(secret, payload, macHex)) return { target, nonce, expiresAt };
  }
  return null;
}

// ---- WebAuthn challenge tokens --------------------------------------------------------------------

export interface WebauthnChallenge {
  /** Opaque; echoed back by the client as `challengeToken` and re-verified at that point. */
  token: string;
  /** base64url bytes for `navigator.credentials.create()/.get()`'s `challenge` field. */
  challenge: string;
  expiresAt: number;
}

/**
 * Same idiom as mintLinkToken: `wc1.<purpose>.<sid|->.<expiresAt>.<nonce>.<mac>`, HMAC'd under
 * secrets[0]. `challenge` is base64url(UTF-8 bytes of `token`) — there is no separate
 * random-bytes-plus-lookup step; the WebAuthn "challenge" the browser signs IS this token, just
 * re-encoded into the byte format the browser API wants. Pure function: no DB access, callable
 * from the Worker layer (login) without waking the DO.
 */
export async function mintWebauthnChallenge(
  secret: string,
  purpose: "register" | "authenticate",
  sid: string,
  now = Date.now(),
  ttlMs = WEBAUTHN_CHALLENGE_TTL_MS,
): Promise<WebauthnChallenge> {
  const expiresAt = now + ttlMs;
  const nonce = randomHex(16);
  const base = `wc1.${purpose}.${sid}.${expiresAt}.${nonce}`;
  const token = `${base}.${await mac(secret, base)}`;
  return { token, challenge: toBase64Url(enc.encode(token)), expiresAt };
}

export interface VerifiedWebauthnChallenge {
  purpose: "register" | "authenticate";
  sid: string;
  nonce: string;
}

/**
 * Stateless HMAC + expiry check only — mirrors verifyLinkToken exactly, including being safe to
 * call before the DO wakes. Does NOT enforce single-use (see WebApp#consumeWebauthnNonce): a
 * verified-but-unconsumed token proves "the Worker minted this and it hasn't expired," not "this
 * hasn't been used" — that can only be established by the one DB write, atomically with
 * whatever the token authorizes.
 */
export async function verifyWebauthnChallenge(secrets: readonly string[], token: string | null): Promise<VerifiedWebauthnChallenge | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== "wc1" || !/^[0-9a-f]{64}$/.test(parts[5]!)) return null;
  const [prefix, purpose, sid, expiresRaw, nonce, macHex] = parts as [string, string, string, string, string, string];
  if ((purpose !== "register" && purpose !== "authenticate") || !/^[\w-]+$/.test(sid) || !/^\d+$/.test(expiresRaw) || !/^[0-9a-f]{32}$/.test(nonce)) {
    return null;
  }
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const payload = `${prefix}.${purpose}.${sid}.${expiresRaw}.${nonce}`;
  for (const secret of secrets) {
    if (await macOk(secret, payload, macHex)) return { purpose, sid, nonce };
  }
  return null;
}

// ---- session cookie -----------------------------------------------------------------------------

export async function sessionCookieValue(secret: string, sid: string): Promise<string> {
  return `ws1.${sid}.${await mac(secret, `ws1.${sid}`)}`;
}

/** The Worker's stateless pre-check: returns the sid when the cookie is well-formed. */
export async function parseSessionCookie(secrets: readonly string[], value: string | null): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "ws1" || !/^[0-9a-f]{64}$/.test(parts[2]!)) return null;
  for (const secret of secrets) {
    if (await macOk(secret, `ws1.${parts[1]}`, parts[2]!)) return parts[1]!;
  }
  return null;
}

export interface PasskeyView {
  credentialId: string;
  label: string;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

// ---- views (rendered shapes — the data comes from ledger.views, steward.md §10) -----------------

export interface DeviceView {
  deviceId: string;
  name: string;
  online: boolean;
  revoked: boolean;
  lastSeen: number | null;
  agents: string[];
  slots: string;
}

export interface WebDeps {
  sql: SqlExecutor;
  /** The key set: [0] is the primary (everything new is minted with it); the rest keep
   * verifying during a SERVER_KEY rotation window (issue #27, auth.ts). */
  secrets: readonly string[];
  ledger: Ledger;
  /** Protocol-layer `device` rows (steward.ts owns that table): deviceId, name, epoch, revoked. */
  listDevices(): Array<{ deviceId: string; name: string | null; revoked: boolean }>;
  /** Revocation bumps the epoch and closes the connection with 4403 (protocol §5.1). */
  revokeDevice(deviceId: string): void;
  /** Whether the device has a live protocol connection — the L3 stream's precondition. */
  machineConnected(deviceId: string): boolean;
  audit(reason: string, detail: string): void;
  /** The owner mutations behind the workspace API (steward.ts owns the conversation). */
  workspace: Pick<
    WorkspaceApiDeps,
    | "budget"
    | "submitMessage"
    | "submitAction"
    | "settings"
    | "saveModel"
    | "selectModel"
    | "testModel"
    | "pairing"
    | "revoke"
    | "addDirectory"
    | "browseDirectory"
    | "webauthnRegisterOptions"
    | "webauthnRegisterVerify"
    | "webauthnRemove"
  >;
  sessionEnded?(sid: string): void;
  loginLinkPolicy?: LoginLinkPolicy;
  now?(): number;
}

interface SessionRow {
  sid: string;
  csrf: string;
  recent: boolean;
}

function loginPromptPage(message: string, status: number): Response {
  return loginPage(message, status);
}

export class WebApp {
  readonly #deps: WebDeps;
  constructor(deps: WebDeps) {
    const policy = deps.loginLinkPolicy;
    if (policy && (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs < 1)) {
      throw new RangeError("login link TTL must be positive");
    }
    this.#deps = deps;
  }

  get #sql(): SqlExecutor {
    return this.#deps.sql;
  }

  get #ledger(): Ledger {
    return this.#deps.ledger;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  // ---- deployment origin (absolute links need it; the DO learns it from its requests) ----

  recordOrigin(origin: string): void {
    this.#sql`
      INSERT INTO sh_deploy (id, origin, updatedAt) VALUES (1, ${origin}, ${this.#now()})
      ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, updatedAt = excluded.updatedAt
    `;
  }

  origin(): string | null {
    return (this.#sql<{ origin: string }>`SELECT origin FROM sh_deploy WHERE id = 1`[0]?.origin ?? null);
  }

  /** Absolute login URL for a message card's 查看详情 button, or null before any origin is known. */
  async linkUrl(target: string): Promise<string | null> {
    const origin = this.origin();
    if (!origin) return null;
    const policy = this.#deps.loginLinkPolicy ?? DEFAULT_LOGIN_LINK_POLICY;
    const { token, expiresAt } = await mintLinkToken(this.#deps.secrets[0]!, target, this.#now(), policy.ttlMs);
    this.#sql`
      INSERT INTO sh_web_link (tokenHash, target, expiresAt, createdAt)
      VALUES (${await sha256Hex(token)}, ${target}, ${expiresAt}, ${this.#now()})
    `;
    return `${origin}/link/${token}`;
  }

  // ---- the link → session exchange ----------------------------------------------------------------

  /** Consumes a verified link token and mints the owner session. */
  async openLink(token: string, secure: boolean): Promise<Response> {
    const hash = await sha256Hex(token);
    const row = this.#sql<{ target: string; usedAt: number | null; expiresAt: number }>`
      SELECT target, usedAt, expiresAt FROM sh_web_link WHERE tokenHash = ${hash}
    `[0];
    const policy = this.#deps.loginLinkPolicy ?? DEFAULT_LOGIN_LINK_POLICY;
    if (!row) return loginPromptPage("This sign-in link is invalid. / 登录链接无效。", 403);
    if (row.expiresAt <= this.#now()) {
      return loginPromptPage("This sign-in link has expired. / 登录链接已过期。", 410);
    }
    if (policy.singleUse) {
      // Conditional consume (spike bug 1's pattern): exactly one concurrent open can flip
      // usedAt from NULL — the loser sees changes() == 0 and is told the link is spent.
      this.#sql`
        UPDATE sh_web_link SET usedAt = ${this.#now()}
        WHERE tokenHash = ${hash} AND usedAt IS NULL AND expiresAt > ${this.#now()}
      `;
      const consumed = this.#sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      if (!consumed) {
        return loginPromptPage("This sign-in link has already been used. / 链接已使用过，只能打开一次。", 410);
      }
    }
    const location = row.target === "home" ? "/app" : `/app/threads/${row.target.replace(/^t\//, "")}`;
    const { cookie } = await this.openSession(secure);
    return new Response(null, { status: 303, headers: { location, "set-cookie": cookie } });
  }

  #purgeExpiredWebRows(now: number): void {
    this.#sql`DELETE FROM sh_web_link WHERE expiresAt < ${now - 24 * 3600_000}`;
    this.#sql`DELETE FROM sh_web_session WHERE expiresAt < ${now}`;
    // Nonce rows are already spent the moment they exist (#consumeWebauthnNonce inserts them
    // only once, at verify time) — this is housekeeping, not a correctness window like the two
    // DELETEs above.
    this.#sql`DELETE FROM sh_web_webauthn_nonce WHERE usedAt < ${now - 24 * 3600_000}`;
  }

  /** INSERT OR IGNORE INTO sh_web_webauthn_nonce: true the first time a nonce is seen, false on
   *  replay. mintWebauthnChallenge never touches the DB, so this insert is the only state a
   *  WebAuthn challenge ever has — there is nothing to pre-register before the attempt. */
  #consumeWebauthnNonce(nonce: string): boolean {
    const now = this.#now();
    // Invalid assertions consume nonces too; prune here so anonymous traffic cannot grow the
    // replay ledger indefinitely when nobody completes a session.
    this.#sql`DELETE FROM sh_web_webauthn_nonce WHERE usedAt < ${now - 24 * 3600_000}`;
    this.#sql`INSERT OR IGNORE INTO sh_web_webauthn_nonce (nonce, usedAt) VALUES (${nonce}, ${now})`;
    return this.#sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
  }

  /** Discoverable-credential registration options (Usage §1): no username to collect (ADR-0003,
   *  single owner), so userId is a fixed constant and excludeCredentials is every passkey this
   *  deployment already has, so the platform authenticator does not offer to re-register one. */
  async webauthnRegisterOptions(
    sid: string,
    rpId: string,
  ): Promise<{ challenge: string; challengeToken: string; rpId: string; userId: string; excludeCredentials: { id: string; transports: string[] }[] }> {
    const { token, challenge } = await mintWebauthnChallenge(this.#deps.secrets[0]!, "register", sid, this.#now());
    return {
      challenge,
      challengeToken: token,
      rpId,
      userId: toBase64Url(enc.encode("owner")),
      excludeCredentials: this.listPasskeys().map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
    };
  }

  /** Discoverable passkey sign-in options; the challenge key never leaves the owner DO. */
  async webauthnLoginOptions(rpId: string): Promise<{ challenge: string; challengeToken: string; rpId: string; expiresAt: number }> {
    const { token, challenge, expiresAt } = await mintWebauthnChallenge(this.#deps.secrets[0]!, "authenticate", "-", this.#now());
    return { challenge, challengeToken: token, rpId, expiresAt };
  }

  /**
   * Verifies a registration ceremony and stores the new credential. `attestation` is `unknown`
   * on purpose (synthesis graft 1): only webauthn.ts's verifyRegistrationResponse is allowed to
   * assert its shape.
   */
  async webauthnRegisterVerify(sid: string, rpId: string, origin: string, label: string, attestation: unknown): Promise<void> {
    const wire = attestation !== null && typeof attestation === "object" ? (attestation as Record<string, unknown>) : {};
    const challengeToken = typeof wire.challengeToken === "string" ? wire.challengeToken : null;
    const verified = await verifyWebauthnChallenge(this.#deps.secrets, challengeToken);
    // Defense in depth alongside CSRF: a challenge minted for a different session than the one
    // redeeming it is treated the same as a bad/expired token.
    if (!verified || verified.purpose !== "register" || verified.sid !== sid) throw new WorkspaceError("bad_request", 400);
    if (!this.#consumeWebauthnNonce(verified.nonce)) {
      this.#deps.audit("webauthn_register_failed", "replay");
      throw new WorkspaceError("replay", 409);
    }
    let result;
    try {
      result = await verifyRegistrationResponse(wire, { rpId, origin, expectedChallenge: toBase64Url(enc.encode(challengeToken!)) });
    } catch (err) {
      this.#deps.audit("webauthn_register_failed", err instanceof WebauthnVerifyError ? err.reason : (err instanceof Error ? err.message : String(err)));
      throw new WorkspaceError("attestation_invalid", 400);
    }
    const now = this.#now();
    this.#sql`
      INSERT INTO sh_web_credential (credentialId, publicKeyCose, signCount, label, transports, rpId, createdAt, lastUsedAt)
      VALUES (${result.credentialId}, ${result.publicKeyCose}, ${result.signCount}, ${label.trim().slice(0, 80)}, ${JSON.stringify(result.transports)}, ${rpId}, ${now}, ${null})
    `;
    this.#deps.audit("webauthn_register_verified", result.credentialId);
  }

  /**
   * Verifies a login assertion and, on success, opens the exact same session openLink does —
   * the one reuse point. `assertion` is `unknown` on purpose (synthesis graft 1): only
   * webauthn.ts's verifyAssertionResponse is allowed to assert its shape.
   */
  async webauthnLoginVerify(rpId: string, origin: string, secure: boolean, assertion: unknown): Promise<Response> {
    const wire = assertion !== null && typeof assertion === "object" ? (assertion as Record<string, unknown>) : {};
    const challengeToken = typeof wire.challengeToken === "string" ? wire.challengeToken : null;
    const credentialId = typeof wire.credentialId === "string" ? wire.credentialId : null;
    const verified = await verifyWebauthnChallenge(this.#deps.secrets, challengeToken);
    if (!verified || verified.purpose !== "authenticate" || !credentialId) {
      return loginPromptPage("This sign-in request expired. Try again. / 登录已过期，请重试。", 410);
    }
    if (!this.#consumeWebauthnNonce(verified.nonce)) {
      this.#deps.audit("webauthn_login_failed", "replay");
      return loginPromptPage("This sign-in request has already been used. / 此登录请求已被使用。", 409);
    }
    const row = this.#sql<{ publicKeyCose: string; signCount: number }>`
      SELECT publicKeyCose, signCount FROM sh_web_credential WHERE credentialId = ${credentialId}
    `[0];
    if (!row) {
      this.#deps.audit("webauthn_login_failed", "unknown_credential");
      return loginPromptPage("No matching passkey was found. / 未找到匹配的通行密钥。", 401);
    }
    let result;
    try {
      result = await verifyAssertionResponse(wire, {
        rpId,
        origin,
        expectedChallenge: toBase64Url(enc.encode(challengeToken!)),
        storedPublicKeyCose: row.publicKeyCose,
        storedSignCount: row.signCount,
      });
    } catch (err) {
      this.#deps.audit("webauthn_login_failed", err instanceof WebauthnVerifyError ? err.reason : (err instanceof Error ? err.message : String(err)));
      return loginPromptPage("Passkey verification failed. / 通行密钥验证失败。", 401);
    }
    const now = this.#now();
    this.#sql`UPDATE sh_web_credential SET signCount = ${result.newSignCount}, lastUsedAt = ${now} WHERE credentialId = ${credentialId}`;
    this.#deps.audit("webauthn_login_verified", credentialId);
    const { cookie } = await this.openSession(secure);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": cookie, "cache-control": "no-store" },
    });
  }

  /** Settings → Security's list (ADR-0005): projects rows, drops publicKeyCose/signCount. */
  listPasskeys(): PasskeyView[] {
    return this.#sql<{ credentialId: string; label: string; transports: string | null; createdAt: number; lastUsedAt: number | null }>`
      SELECT credentialId, label, transports, createdAt, lastUsedAt FROM sh_web_credential ORDER BY createdAt
    `.map((row) => ({
      credentialId: row.credentialId,
      label: row.label,
      transports: row.transports ? (JSON.parse(row.transports) as string[]) : [],
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  /** No "last passkey" guard: the deployment password remains available, so removing the only
   *  passkey cannot lock the owner out. */
  removePasskey(credentialId: string): void {
    this.#sql`DELETE FROM sh_web_credential WHERE credentialId = ${credentialId}`;
  }

  /** Session liveness for browser WebSocket upgrades (the Worker layer only checks the MAC). */
  sessionAlive(sid: string): boolean {
    return (
      this.#sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_web_session WHERE sid = ${sid} AND expiresAt > ${this.#now()}
      `[0]!.n > 0
    );
  }

  /**
   * Opens an application session outright (the one-time-link exchange does this via
   * openLink; kept as its own step so the cookie shape lives in exactly one place).
   */
  async openSession(secure: boolean): Promise<{ sid: string; csrf: string; cookie: string }> {
    const sid = randomHex(32);
    const csrf = randomHex(32);
    const now = this.#now();
    this.#sql`INSERT INTO sh_web_session (sid, csrf, createdAt, expiresAt, lastSeenAt)
      VALUES (${sid}, ${csrf}, ${now}, ${now + SESSION_TTL_MS}, ${now})`;
    this.#purgeExpiredWebRows(now);
    const cookie = [
      `${SESSION_COOKIE}=${await sessionCookieValue(this.#deps.secrets[0]!, sid)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");
    return { sid, csrf, cookie };
  }

  async #sessionFromRequest(request: Request): Promise<SessionRow | null> {
    const cookie = request.headers.get("cookie") ?? "";
    const raw = cookie.split(/;\s*/).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? null;
    const sid = await parseSessionCookie(this.#deps.secrets, raw);
    if (!sid) return null;
    const now = this.#now();
    const row = this.#sql<{ csrf: string; createdAt: number }>`
      SELECT csrf, createdAt FROM sh_web_session WHERE sid = ${sid} AND expiresAt > ${now}
    `[0];
    if (!row) return null;
    this.#sql`UPDATE sh_web_session SET lastSeenAt = ${now} WHERE sid = ${sid}`;
    return { sid, csrf: row.csrf, recent: now - row.createdAt <= 10 * 60_000 };
  }

  // ---- the app pages -------------------------------------------------------------------------------

  /** Handles /app* with the session cookie gate; every other route is the caller's. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const thread = /^\/app\/threads\/([\w-]+)$/.exec(url.pathname);
    const rawProcess = /^\/app\/threads\/([\w-]+)\/workers\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    const api = url.pathname.startsWith("/app/api/");
    const asset = url.pathname.startsWith("/app/assets/");
    const assetName = asset ? url.pathname.slice("/app/assets/".length) : "";
    if (asset && (request.method !== "GET" || !/^[A-Za-z0-9][\w.-]*$/.test(assetName))) {
      return new Response("not found", { status: 404 });
    }
    const page = request.method === "GET" && (
      url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/app/settings" ||
      url.pathname === "/app/machines" || thread !== null || rawProcess !== null
    );
    // Unknown app routes stay 404 even without a session; the login gate is not a route index.
    if (!api && !asset && !page) return new Response("not found", { status: 404 });

    const session = await this.#sessionFromRequest(request);
    if (!session) {
      if (api) {
        return Response.json({ error: "auth_required" }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      if (asset) return new Response("unauthorized", { status: 401 });
      return loginPage();
    }

    if (api) {
      return handleWorkspaceApi(request, url, session, {
        ledger: this.#ledger,
        devices: () => this.#deviceViews().map(({ deviceId, name, online, revoked }) => ({ deviceId, name, online, revoked })),
        now: () => this.#now(),
        endSession: (sid) => { this.#sql`DELETE FROM sh_web_session WHERE sid = ${sid}`; this.#deps.sessionEnded?.(sid); },
        audit: (reason, detail) => this.#deps.audit(reason, detail),
        ...this.#deps.workspace,
      });
    }

    if (asset) {
      return new Response(null, { status: 204, headers: { "x-sig-asset": "1", "cache-control": "no-store" } });
    }

    // The workspace: /app is the whole conversation; a Thread URL (the card links and the
    // session viewer's way back) opens the same page with that Thread selected; settings
    // and machines are dialogs the page opens over the same shell.
    if (url.pathname === "/app" || url.pathname === "/app/" || url.pathname === "/app/settings" || url.pathname === "/app/machines") {
      return this.workspaceShell();
    }
    if (thread) {
      return this.#ledger.threads.get(thread[1]!) ? this.workspaceShell() : new Response("not found", { status: 404 });
    }
    // The old raw-process URL (ADR-0001 decision 12) opens the workspace's session viewer.
    if (rawProcess) return this.workspaceShell();

    return new Response("not found", { status: 404 });
  }

  /** The edge Worker supplies assets from the current deployment after this session gate. */
  private workspaceShell(): Response {
    return new Response(null, { status: 204, headers: { "x-sig-workspace-shell": "1", "cache-control": "no-store" } });
  }

  #deviceViews(): DeviceView[] {
    const ledgerMachines = new Map(this.#ledger.machines.list().map((m) => [m.deviceId, m]));
    return this.#deps.listDevices().map((device) => {
      const lm = ledgerMachines.get(device.deviceId);
      const running = lm ? this.#ledger.machines.runningCount(device.deviceId) : 0;
      return {
        deviceId: device.deviceId,
        name: lm?.name ?? device.name ?? device.deviceId,
        online: lm?.online ?? false,
        revoked: device.revoked,
        lastSeen: lm?.lastSeen ?? null,
        agents: lm?.agents ?? [],
        slots: lm ? `${running}/${lm.maxWorkers} 工位` : "",
      };
    });
  }
}
