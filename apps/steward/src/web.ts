// The signed-link web (issue #22, spec §7.3–7.4 / §12.2, steward.md §10; ADR-0001 decisions
// 7 and 12): the only door into the web app is a one-time link the steward itself sent to
// the owner's chat — a report card's 查看详情 button, or the /网页 phrase. Opening it
// exchanges the single-use, short-expiry token for a session cookie bound to the owner;
// the session opens the Pip workspace (workspace.ts / workspace-api.ts: a static page that
// talks to a small JSON API), plus the server-rendered machine and raw-process pages.
//
// Token formats (SERVER_KEY-signed, rotatable like every other MAC in the deployment):
//   link    wl1.<target>.<expiresAt>.<nonce>.<mac>   one use, ≤15 min
//   session ws1.<sid>.<mac>                           random sid, DB-backed, 7 days
// The Worker layer verifies the HMACs statelessly (index.ts) so blind probes never wake the
// Durable Object; single-use and session liveness are DB facts, checked here.
//
// Page content comes from the memory module's `views` (ledger.ts) and the protocol-layer
// device list — never raw table SQL scattered in handlers. Write actions from the web (the
// revoke button) are logged to the audit trail like every other management action.
import type { Ledger } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";
import { handleWorkspaceApi, type WorkspaceApiDeps } from "./workspace-api.ts";

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
export const SESSION_COOKIE = "shepherd_session";

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
  /** The key set, resolved lazily: [0] is the primary (everything new is minted with it);
   * the rest keep verifying during a rotation window (issue #27). The Durable Object's own
   * auth root leads — a fresh deployment has no env key at all (ADR-0004). */
  secrets: () => Promise<readonly string[]>;
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
  accessOnly?: boolean;
  sessionEnded?(sid: string): void;
  /** The workspace page: a static asset fetched through the Worker's assets binding. */
  shell(): Promise<Response>;
  now?(): number;
}

interface SessionRow {
  sid: string;
  csrf: string;
}

function relTime(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  if (delta < 60_000) return "刚刚";
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 24 * 3600_000) return `${Math.floor(delta / 3600_000)} 小时前`;
  return `${Math.floor(delta / (24 * 3600_000))} 天前`;
}

function stateBadge(state: string): string {
  if (state === "running") return '<span class="badge running">▶ 运行中</span>';
  if (state === "waiting_you") return '<span class="badge waiting">❓ 等你</span>';
  return '<span class="badge idle">· 空闲</span>';
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function layout(title: string, active: "threads" | "machines", content: string): string {
  const nav = (href: string, key: "threads" | "machines", label: string) =>
    `<a href="${href}"${active === key ? ' class="active"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Pip</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 0 0 48px; }
  header { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid rgba(127,127,127,.3); position: sticky; top: 0; background: inherit; }
  header .brand { font-weight: 700; }
  header a { color: inherit; text-decoration: none; opacity: .75; padding: 4px 2px; }
  header a.active { opacity: 1; border-bottom: 2px solid #3370ff; }
  main { max-width: 720px; margin: 0 auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 20px 0 4px; }
  .meta { color: rgba(127,127,127,.9); font-size: 13px; margin-bottom: 12px; }
  .badge { display: inline-block; font-size: 12px; border: 1px solid rgba(127,127,127,.4); border-radius: 99px; padding: 0 8px; margin-left: 6px; vertical-align: 2px; }
  .badge.running { border-color: #2ea86f; color: #2ea86f; }
  .badge.waiting { border-color: #e6a23c; color: #e6a23c; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
  .dot.on { background: #2ea86f; }
  .dot.off { background: rgba(127,127,127,.5); }
  ol.timeline { list-style: none; margin: 8px 0; padding: 0; }
  ol.timeline li { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
  ol.timeline .k { flex: 0 0 44px; font-size: 12px; color: rgba(127,127,127,.95); padding-top: 2px; }
  ol.timeline .t { flex: 1; overflow-wrap: anywhere; white-space: pre-wrap; }
  ol.timeline .ts { flex: 0 0 auto; font-size: 12px; color: rgba(127,127,127,.9); padding-top: 2px; }
  .threads { display: flex; flex-direction: column; }
  .threads a.row { display: block; padding: 14px 0; border-bottom: 1px solid rgba(127,127,127,.18); color: inherit; text-decoration: none; }
  .threads .row .title { font-weight: 600; }
  .threads .row .sub { font-size: 13px; color: rgba(127,127,127,.95); margin-top: 2px; overflow-wrap: anywhere; }
  .machine { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 14px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
  .machine .name { font-weight: 600; flex: 1 1 100%; }
  .machine form { margin-left: auto; }
  .machine .revoked { color: #d5304f; }
  button { padding: 6px 16px; border: 0; border-radius: 6px; background: #d5304f; color: #fff; font: inherit; cursor: pointer; }
  .empty { color: rgba(127,127,127,.95); padding: 24px 0; }
  .hint { font-size: 13px; color: rgba(127,127,127,.95); }
</style>
</head>
<body>
<header><span class="brand">Pip</span>${nav("/app", "threads", "工作台")}${nav("/app/machines", "machines", "机器")}</header>
<main>
${content}
</main>
</body></html>`;
}

function loginPromptPage(message: string, status: number, siteUrl?: string): Response {
  // ADR-0004: with no password and no Access, the sign-in page says the one way in — a
  // one-time link minted on an already-paired machine. Before the first machine claimed the
  // deployment it names the connect command instead.
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Pip · 登录</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC","Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:520px}code{background:#f1f3ed;padding:1px 5px;border-radius:3px;overflow-wrap:anywhere}.hint{color:#6b7280;font-size:13px}</style>
</head>
<body><main>
<p>${esc(message)}</p>
<p>在已配对的电脑上运行 <code>shepherd login</code>，打开它给出的链接（10 分钟内有效，只能用一次）。</p>
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

  /** Absolute one-time URL for a chat message / card button, or null before any origin is known. */
  async linkUrl(target: string): Promise<string | null> {
    const origin = this.origin();
    if (!origin || this.#deps.accessOnly) return null; // the workspace is the only page; cards need no login link
    const { token, expiresAt } = await mintLinkToken((await this.#deps.secrets())[0]!, target, this.#now());
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
    const sid = randomHex(32);
    const csrf = randomHex(32);
    const now = this.#now();
    this.#sql`
      INSERT INTO sh_web_session (sid, csrf, createdAt, expiresAt, lastSeenAt)
      VALUES (${sid}, ${csrf}, ${now}, ${now + SESSION_TTL_MS}, ${now})
    `;
    this.#purgeExpiredWebRows(now);
    const cookie = [
      `${SESSION_COOKIE}=${await sessionCookieValue((await this.#deps.secrets())[0]!, sid)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");
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
      `${SESSION_COOKIE}=${await sessionCookieValue((await this.#deps.secrets())[0]!, sid)}`,
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
    const sid = await parseSessionCookie(await this.#deps.secrets(), raw);
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
        requireOrigin: this.#deps.accessOnly,
        ...this.#deps.workspace,
      });
    }

    // The workspace: /app is the whole conversation; a Thread URL (the card links and the
    // raw-process page's way back) opens the same page with that Thread selected.
    if (request.method === "GET" && (url.pathname === "/app" || (this.#deps.accessOnly && (url.pathname === "/app/settings" || url.pathname === "/app/machines")))) return this.workspaceShell(url);
    const thread = /^\/app\/threads\/([\w-]+)$/.exec(url.pathname);
    if (thread && request.method === "GET") {
      return this.#ledger.threads.get(thread[1]!) ? this.workspaceShell(url) : new Response("not found", { status: 404 });
    }

    if (url.pathname === "/app/machines" && request.method === "GET") return this.machinesPage(session);
    if (!this.#deps.accessOnly && url.pathname === "/app/machines/revoke" && request.method === "POST") return this.revokeMachine(request, session);

    // L3 raw process (spec §7.4): the server-rendered shell plus the little vanilla JS that
    // streams chunks over a web-role WebSocket (ADR-0001 decision 12).
    const rawProcess = /^\/app\/threads\/([\w-]+)\/workers\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (rawProcess && request.method === "GET") return this.#deps.accessOnly ? this.workspaceShell(url) : this.rawProcessPage(rawProcess[1]!, rawProcess[2]!);

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

  /**
   * The L3 page (spec §7.4): one worker's raw conversation and tool calls, streamed from the
   * machine through the DO without being stored there (protocol §6.6). Offline machines show
   * why the transcript is unavailable instead of a stream (connector-pi.md §11.4).
   */
  private rawProcessPage(threadId: string, workerId: string): Response {
    const thread = this.#ledger.threads.get(threadId);
    const worker = this.#ledger.workers.get(workerId);
    if (!thread || !worker || worker.threadId !== threadId) return new Response("not found", { status: 404 });
    const machine = this.#ledger.machines.get(worker.deviceId);
    const machineName = machine?.name ?? worker.deviceId;
    const meta = [
      `<a href="/app/threads/${esc(threadId)}" style="color:inherit">← ${esc(thread.title)}</a>`,
      `${esc(worker.agent)} @ ${esc(machineName)}${worker.branch ? ` · 分支 ${esc(worker.branch)}` : ""}`,
      `会话 ${esc(worker.sessionId ?? workerId)}`,
    ].join("<br>");
    const content = `<h1>原始过程</h1>${stateBadge(worker.state === "running" || worker.state === "starting" ? "running" : "idle")}
<p class="meta">${meta}</p>
<style>
  #entries { margin: 8px 0; }
  .entry { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid rgba(127,127,127,.18); }
  .entry .who { flex: 0 0 44px; font-size: 12px; color: rgba(127,127,127,.95); padding-top: 2px; }
  .entry.user .who { color: #3370ff; }
  .entry .body { flex: 1; min-width: 0; }
  .entry pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
  .entry .tool { font-size: 13px; color: rgba(127,127,127,.95); margin-top: 4px; overflow-wrap: anywhere; }
  #stream-status { font-size: 13px; color: rgba(127,127,127,.95); margin: 12px 0; min-height: 1em; }
  #more { background: #3370ff; margin-top: 8px; }
  .offline { border: 1px solid rgba(127,127,127,.4); border-radius: 8px; padding: 14px 16px; margin: 16px 0; }
</style>
${
      machine?.online && this.#machineConnected(worker.deviceId)
        ? `<div id="stream-status">连接中…</div>
<div id="entries"></div>
<button id="more" type="button" hidden onclick="loadMore()">继续加载</button>
<noscript><p class="hint">这个页面需要 JavaScript 才能流式显示原始对话。</p></noscript>
<script>
${rawProcessScript(workerId)}
</script>`
        : `<div class="offline"><strong>machine_offline：机器当前不在线</strong><br>
<span class="hint">原始对话和工具调用只保存在这台机器上，不会上传保存；机器连上后刷新此页即可查看。</span></div>`
    }`;
    return html(layout(`原始过程 · ${thread.title}`, "threads", content));
  }

  /** The web-role socket gate mirrors the machines page's data: online ledger state plus a
   * live protocol connection (the same signal history_open uses; both can drift briefly). */
  #machineConnected(deviceId: string): boolean {
    return this.#deps.machineConnected(deviceId);
  }

  private machinesPage(session: SessionRow): Response {
    const machines = this.#deviceViews();
    const now = this.#now();
    const rows = machines.map((m) => {
      const facts = [
        m.agents.length > 0 ? m.agents.join("、") : null,
        m.slots,
        m.lastSeen ? `上次在线 ${relTime(m.lastSeen, now)}` : "从未连接",
      ]
        .filter((p): p is string => p !== null)
        .join(" · ");
      const state = m.revoked
        ? `<span class="revoked">已撤销</span>`
        : `<span class="dot ${m.online ? "on" : "off"}"></span>${m.online ? "在线" : "离线"}`;
      const action = m.revoked
        ? ""
        : `<form method="post" action="/app/machines/revoke">
<input type="hidden" name="csrf" value="${session.csrf}">
<input type="hidden" name="deviceId" value="${esc(m.deviceId)}">
<button type="submit">撤销</button>
</form>`;
      return `<div class="machine">
<span class="name">${esc(m.name)}</span>
<span>${state}</span>
<span class="hint">${esc(facts)}</span>
${action}
</div>`;
    });
    const content = `<h1>机器</h1>
<p class="hint">要添加机器，在飞书里发 <code>/加机器</code>，把返回的命令放到那台机器的终端里运行。</p>
${rows.length > 0 ? rows.join("\n") : '<p class="empty">还没有配对过机器。在飞书里发「/加机器」开始。</p>'}`;
    return html(layout("机器", "machines", content));
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

  private async revokeMachine(request: Request, session: SessionRow): Promise<Response> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return new Response("bad request", { status: 400 });
    }
    if (form.get("csrf") !== session.csrf) return loginPromptPage("会话校验失败，请重新登录。", 403);
    const deviceId = form.get("deviceId") ?? "";
    if (!this.#deps.listDevices().some((d) => d.deviceId === deviceId && !d.revoked)) {
      return new Response("not found", { status: 404 });
    }
    // Protocol §5.1: bump the epoch — every previously issued token dies at once — and close
    // the live connection with 4403.
    this.#deps.revokeDevice(deviceId);
    this.#deps.audit("web_machine_revoked", deviceId);
    return new Response(null, { status: 303, headers: { location: "/app/machines" } });
  }
}

function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The L3 stream client (ADR-0001 decision 12: "a little vanilla JS only for the raw-process
 * stream"). Opens a web-role WebSocket, sends history_open, renders each chunk's entries with
 * DOM APIs (textContent — entry text is untrusted content, never innerHTML), acks every chunk
 * to slide the connector's window, and re-opens with the cursor when the byte budget ran out.
 */
function rawProcessScript(workerId: string): string {
  return `(function () {
  "use strict";
  var workerId = ${JSON.stringify(workerId)};
  var maxBytes = 2097152;
  var entriesEl = document.getElementById("entries");
  var statusEl = document.getElementById("stream-status");
  var moreBtn = document.getElementById("more");
  var cursor = null;
  var ws = null;
  var waiting = false;
  var total = 0;
  // The relay ends some streams silently (DO TTL sweep, connector idle sweep): anything
  // silent past ~65 s is dead by protocol (the relay row's 60 s TTL + schedule granularity),
  // so stop waiting and say so instead of parking on 连接中… forever.
  var SILENCE_MS = 65000;
  var watchdog = null;

  function say(text) { statusEl.textContent = text; }

  function stopWatchdog() {
    if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
  }

  function armWatchdog() {
    stopWatchdog();
    watchdog = setTimeout(function () {
      waiting = false;
      say("连接超时：流式连接中断，请刷新重试。");
      try { ws.close(); } catch (e) {}
    }, SILENCE_MS);
  }

  function endStream(message, offerMore) {
    waiting = false;
    stopWatchdog();
    say(message);
    if (moreBtn) moreBtn.hidden = !(offerMore && cursor);
    try { ws.close(); } catch (e) {}
  }

  function offline() {
    waiting = false;
    stopWatchdog();
    say("");
    var box = document.createElement("div");
    box.className = "offline";
    var strong = document.createElement("strong");
    strong.textContent = "machine_offline：机器当前不在线";
    var hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "原始对话只保存在那台机器上；机器连上后刷新此页即可查看。";
    box.appendChild(strong);
    box.appendChild(document.createElement("br"));
    box.appendChild(hint);
    entriesEl.parentNode.insertBefore(box, entriesEl);
    if (moreBtn) moreBtn.hidden = true;
  }

  function addEntry(entry) {
    var row = document.createElement("div");
    row.className = "entry " + entry.role;
    var who = document.createElement("span");
    who.className = "who";
    who.textContent = entry.role === "user" ? "指令" : "agent";
    var body = document.createElement("div");
    body.className = "body";
    var text = document.createElement("pre");
    text.textContent = entry.text;
    body.appendChild(text);
    var tools = entry.tools || [];
    for (var i = 0; i < tools.length; i++) {
      var tool = document.createElement("div");
      tool.className = "tool";
      tool.textContent = "[工具] " + tools[i].name + (tools[i].args ? " · " + tools[i].args : "");
      body.appendChild(tool);
    }
    row.appendChild(who);
    row.appendChild(body);
    entriesEl.appendChild(row);
  }

  function stream(since) {
    waiting = true;
    say(since ? "加载中…" : "连接中…");
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/agents/steward/owner?role=web");
    var openId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    ws.onopen = function () {
      var msg = { t: "history_open", id: openId, workerId: workerId, maxBytes: maxBytes };
      if (since) msg.since = since;
      ws.send(JSON.stringify(msg));
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      armWatchdog();
      if (m.t === "history_chunk") {
        total += m.entries.length;
        for (var i = 0; i < m.entries.length; i++) addEntry(m.entries[i]);
        ws.send(JSON.stringify({ t: "history_ack", re: m.re, n: m.n }));
        if (m.cursor) cursor = m.cursor;
        if (m.done) {
          // The connector says whether the page was budget-cut (truncated) — never guess from
          // byte counts: the budget is UTF-8 while string lengths are UTF-16, so CJK cuts
          // would read as "everything loaded" and strand the tail. An empty terminating page
          // means "nothing more" — distinct from a session that never had any content.
          if (m.truncated) {
            endStream(cursor ? "已达单次加载上限（2 MB）；可以继续加载后面的内容。" : "已达单次加载上限（2 MB）。", true);
          } else if (total === 0) {
            endStream("还没有任何对话内容。", false);
          } else if (m.entries.length === 0) {
            endStream("没有更多内容了。", false);
          } else {
            endStream("已加载全部内容。", false);
          }
        }
      } else if (m.t === "machine_offline") {
        stopWatchdog();
        try { ws.close(); } catch (e) {}
        offline();
      } else if (m.t === "error") {
        endStream("读取失败：" + (m.message || m.code || "未知错误"), false);
      }
    };
    ws.onclose = function () {
      if (waiting) offline(); // died mid-stream without done: treat as unavailable
    };
    ws.onerror = function () { say(""); };
    armWatchdog();
  }

  window.loadMore = function () {
    if (moreBtn) moreBtn.hidden = true;
    if (cursor) stream(cursor);
  };

  stream(null);
})();`;
}
