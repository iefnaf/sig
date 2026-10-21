// The signed-link web (issue #22, spec §7.3–7.4 / §12.2, steward.md §10; ADR-0001 decisions
// 7 and 12, superseded by ADR-0005): the only door into the web app is a one-time link —
// minted by `POST /api/login-link` (the SERVER_KEY holder, ADR-0003) or a card's 查看详情
// button. Opening it exchanges the single-use, short-expiry token for a session cookie bound
// to the owner; the session opens the web workspace (workspace.ts / workspace-api.ts: a
// static page that talks to a small JSON API), plus the server-rendered machine and
// raw-process pages.
//
// Token formats (SERVER_KEY-signed, rotatable like every other MAC in the deployment):
//   link    wl1.<target>.<expiresAt>.<nonce>.<mac>   one use, ≤15 min
//   session ws1.<sid>.<mac>                           random sid, DB-backed, 7 days
// The Worker layer verifies the HMACs statelessly (index.ts) so blind probes never wake the
// Durable Object; single-use and session liveness are DB facts, checked here.
//
// Page content comes from the memory module's `views` (ledger.ts) and the protocol-layer
// device list — never raw table SQL scattered in handlers. Write actions from the web are
// logged to the audit trail like every other management action.
import type { Ledger } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";
import { BRAND_HEAD, BRAND_LOCKUP, BRAND_STYLE } from "./brand.ts";
import { handleWorkspaceApi, type WorkspaceApiDeps } from "./workspace-api.ts";

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "sig_session";

const enc = new TextEncoder();

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
  workspace: Pick<WorkspaceApiDeps, "budget" | "submitMessage" | "submitAction" | "settings" | "saveModel" | "pairing" | "revoke">;
  sessionEnded?(sid: string): void;
  /** The workspace page: a static asset fetched through the Worker's assets binding. */
  shell(): Promise<Response>;
  now?(): number;
}

interface SessionRow {
  sid: string;
  csrf: string;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function loginPromptPage(message: string, status: number): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Sig</title>
${BRAND_HEAD}
<style>${BRAND_STYLE}body{font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:480px}</style>
</head>
<body><main>
${BRAND_LOCKUP}
<p>${esc(message)}</p>
<p class="hint">新的登录链接用 <code>POST /api/login-link</code> 签发（15 分钟内有效，只能打开一次）。</p>
</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export class WebApp {
  readonly #deps: WebDeps;
  constructor(deps: WebDeps) {
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

  /** Absolute one-time URL for a message card's 查看详情 button, or null before any origin is known. */
  async linkUrl(target: string): Promise<string | null> {
    const origin = this.origin();
    if (!origin) return null;
    const { token, expiresAt } = await mintLinkToken(this.#deps.secrets[0]!, target, this.#now());
    this.#sql`
      INSERT INTO sh_web_link (tokenHash, target, expiresAt, createdAt)
      VALUES (${await sha256Hex(token)}, ${target}, ${expiresAt}, ${this.#now()})
    `;
    return `${origin}/link/${token}`;
  }

  // ---- the link → session exchange ----------------------------------------------------------------

  /** Consumes a verified link token: single-use, short expiry; mints the owner session. */
  async openLink(token: string, secure: boolean): Promise<Response> {
    const hash = await sha256Hex(token);
    // Conditional consume (spike bug 1's pattern): exactly one concurrent open can flip
    // usedAt from NULL — the loser sees changes() == 0 and is told the link is spent.
    this.#sql`
      UPDATE sh_web_link SET usedAt = ${this.#now()}
      WHERE tokenHash = ${hash} AND usedAt IS NULL AND expiresAt > ${this.#now()}
    `;
    const consumed = this.#sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    const row = this.#sql<{ target: string; usedAt: number | null; expiresAt: number }>`
      SELECT target, usedAt, expiresAt FROM sh_web_link WHERE tokenHash = ${hash}
    `[0];
    if (!row) return loginPromptPage("链接无效。", 403);
    if (!consumed) return loginPromptPage(row.expiresAt <= this.#now() ? "链接已过期。" : "链接已使用过，只能打开一次。", 410);
    const location = row.target === "home" ? "/app" : `/app/threads/${row.target.replace(/^t\//, "")}`;
    const { cookie } = await this.openSession(secure);
    return new Response(null, { status: 303, headers: { location, "set-cookie": cookie } });
  }

  #purgeExpiredWebRows(now: number): void {
    this.#sql`DELETE FROM sh_web_link WHERE expiresAt < ${now - 24 * 3600_000}`;
    this.#sql`DELETE FROM sh_web_session WHERE expiresAt < ${now}`;
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
    const row = this.#sql<{ csrf: string }>`
      SELECT csrf FROM sh_web_session WHERE sid = ${sid} AND expiresAt > ${this.#now()}
    `[0];
    if (!row) return null;
    this.#sql`UPDATE sh_web_session SET lastSeenAt = ${this.#now()} WHERE sid = ${sid}`;
    return { sid, csrf: row.csrf };
  }

  // ---- the app pages -------------------------------------------------------------------------------

  /** Handles /app* with the session cookie gate; every other route is the caller's. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = await this.#sessionFromRequest(request);
    if (!session) {
      return url.pathname.startsWith("/app/api/")
        ? Response.json({ error: "auth_required" }, { status: 401, headers: { "cache-control": "no-store" } })
        : loginPromptPage("请先登录。", 401);
    }

    if (url.pathname.startsWith("/app/api/")) {
      return handleWorkspaceApi(request, url, session, {
        ledger: this.#ledger,
        devices: () => this.#deviceViews().map(({ deviceId, name, online, revoked }) => ({ deviceId, name, online, revoked })),
        now: () => this.#now(),
        endSession: (sid) => { this.#sql`DELETE FROM sh_web_session WHERE sid = ${sid}`; this.#deps.sessionEnded?.(sid); },
        audit: (reason, detail) => this.#deps.audit(reason, detail),
        ...this.#deps.workspace,
      });
    }

    // The workspace: /app is the whole conversation; a Thread URL (the card links and the
    // session viewer's way back) opens the same page with that Thread selected; settings
    // and machines are dialogs the page opens over the same shell.
    if (request.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/settings" || url.pathname === "/app/machines")) return this.workspaceShell(url);
    const thread = /^\/app\/threads\/([\w-]+)$/.exec(url.pathname);
    if (thread && request.method === "GET") {
      return this.#ledger.threads.get(thread[1]!) ? this.workspaceShell(url) : new Response("not found", { status: 404 });
    }
    // The old raw-process URL (ADR-0001 decision 12) opens the workspace's session viewer.
    const rawProcess = /^\/app\/threads\/([\w-]+)\/workers\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (rawProcess && request.method === "GET") return this.workspaceShell(url);

    return new Response("not found", { status: 404 });
  }

  /**
   * The workspace page. Its script and styles are same-origin files, so the policy can forbid
   * every inline script and every other origin: whatever an agent or a repository puts in the
   * conversation can only ever be displayed, never executed.
   */
  private async workspaceShell(url: URL): Promise<Response> {
    const page = await this.#deps.shell();
    if (!page.ok) return new Response("workspace unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    const socket = `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
    return new Response(page.body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          `connect-src 'self' ${socket}`,
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
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
