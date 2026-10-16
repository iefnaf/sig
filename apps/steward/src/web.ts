// The signed-link web (issue #22, spec §7.3–7.4 / §12.2, steward.md §10; ADR-0001 decisions
// 7 and 12): the only door into the web app is a one-time link the steward itself sent to
// the owner's chat — a report card's 查看详情 button, or the /网页 phrase. Opening it
// exchanges the single-use, short-expiry token for a session cookie bound to the owner;
// pages are then server-rendered HTML with no client JS and no build chain.
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
import type { Ledger, TimelineView, ThreadListEntry } from "./ledger.ts";
import type { SqlExecutor } from "./schema.ts";

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

async function sha256Hex(text: string): Promise<string> {
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

export type { TimelineView, ThreadListEntry };

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
  audit(reason: string, detail: string): void;
  now?(): number;
}

interface SessionRow {
  sid: string;
  csrf: string;
}

const KIND_LABELS: Record<string, string> = {
  user_instruction: "指令",
  dispatch: "派发",
  started: "开始",
  progress: "进展",
  report: "汇报",
  question: "问题",
  settled: "结束",
  lost: "失联",
  resumed: "恢复",
  note: "备注",
};

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
<title>${esc(title)} · Shepherd</title>
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
<header><span class="brand">Shepherd</span>${nav("/app", "threads", "Threads")}${nav("/app/machines", "machines", "机器")}</header>
<main>
${content}
</main>
</body></html>`;
}

function loginPromptPage(message: string, status: number): Response {
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Shepherd</title>
<style>body{font:15px/1.7 -apple-system,"PingFang SC","Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:0 16px}main{max-width:480px}</style>
</head>
<body><main>
<p>${esc(message)}</p>
<p class="hint">在飞书里对总管发 <code>/网页</code>，取一条新的一次性登录链接（15 分钟内有效，只能打开一次）。</p>
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
    const sid = randomHex(32);
    const csrf = randomHex(32);
    const now = this.#now();
    this.#sql`
      INSERT INTO sh_web_session (sid, csrf, createdAt, expiresAt, lastSeenAt)
      VALUES (${sid}, ${csrf}, ${now}, ${now + SESSION_TTL_MS}, ${now})
    `;
    this.#purgeExpiredWebRows(now);
    const cookie = [
      `${SESSION_COOKIE}=${await sessionCookieValue(this.#deps.secrets[0]!, sid)}`,
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
    if (!session) return loginPromptPage("这一页需要先登录。", 401);

    if (url.pathname === "/app" && request.method === "GET") return this.threadListPage();
    if (url.pathname === "/app/machines" && request.method === "GET") return this.machinesPage(session);
    if (url.pathname === "/app/machines/revoke" && request.method === "POST") return this.revokeMachine(request, session);

    const timeline = /^\/app\/threads\/([\w-]+)$/.exec(url.pathname);
    if (timeline && request.method === "GET") return this.timelinePage(timeline[1]!);

    return new Response("not found", { status: 404 });
  }

  private threadListPage(): Response {
    const entries = this.#ledger.views.threadList();
    const now = this.#now();
    const rows = entries.map((entry) => {
      const w = entry.lastWorker;
      const sub = [
        w ? `${w.agent} @ ${w.machineName}` : null,
        w?.lastProgress ? progressText(w.lastProgress) : null,
        `最后活动 ${relTime(entry.thread.lastActivityAt, now)}`,
      ]
        .filter((p): p is string => p !== null)
        .join(" · ");
      return `<a class="row" href="/app/threads/${esc(entry.thread.threadId)}">
<span class="title">${entry.thread.unread ? "● " : ""}${esc(entry.thread.title)}</span>${stateBadge(entry.thread.state)}
<div class="sub">${esc(sub)}</div>
</a>`;
    });
    const content = `<h1>Threads</h1>
<div class="threads">${rows.length > 0 ? rows.join("\n") : '<p class="empty">还没有任何 Thread。在飞书里发「/派发 &lt;repo&gt; &lt;要做的事&gt;」开始。</p>'}</div>`;
    return html(layout("Threads", "threads", content));
  }

  private timelinePage(threadId: string): Response {
    // §6.5: opening the Thread on the web clears unread — before the view is assembled, so
    // the page never renders its own unread dot.
    if (!this.#ledger.threads.get(threadId)) return new Response("not found", { status: 404 });
    this.#ledger.threads.markRead(threadId);
    const view = this.#ledger.views.timeline(threadId);
    if (!view) return new Response("not found", { status: 404 });
    return html(layout(view.thread.title, "threads", renderTimeline(view, this.#now())));
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

function progressText(lastProgress: string): string {
  try {
    const p = JSON.parse(lastProgress) as { phase?: unknown; tool?: unknown; target?: unknown };
    const parts = [typeof p.phase === "string" ? p.phase : null, typeof p.tool === "string" ? p.tool : null, typeof p.target === "string" ? p.target : null];
    const joined = parts.filter((x): x is string => x !== null).join(" ");
    return joined.length > 0 ? `最近：${joined}` : "";
  } catch {
    return "";
  }
}

/** The timeline body (L2): header + summary events, mobile-first single column (spec §7.4). */
export function renderTimeline(view: TimelineView, now: number): string {
  const { thread, entries, workers, openQuestion } = view;
  // Review #40/#2: goal is model-writable (start_worker/update_thread) and machine names are
  // connector-reported — every meta value goes through esc() like the rest of the page.
  const meta = [
    thread.goal ? `目标：${esc(thread.goal)}` : null,
    workers.length > 0
      ? [...new Set(workers.map((w) => `${esc(w.agent)} @ ${esc(w.machineName)}`))].join("、")
      : null,
    `建于 ${relTime(thread.createdAt, now)}`,
  ]
    .filter((p): p is string => p !== null)
    .join("<br>");
  const question = openQuestion
    ? `<p class="badge waiting">❓ 等你</p><p style="margin-top:4px">${esc(openQuestion.text)}</p>`
    : "";
  const items = entries.map((entry) => {
    const label = KIND_LABELS[entry.kind] ?? entry.kind;
    return `<li><span class="k">${esc(label)}</span><span class="t">${esc(entry.text)}</span><span class="ts">${relTime(entry.ts, now)}</span></li>`;
  });
  const workerRows = workers.map((w) => {
    const state =
      w.state === "running" || w.state === "starting" || w.state === "recovering"
        ? "▶"
        : w.state === "queued"
          ? "⏳"
          : w.state === "broken"
            ? "❌"
            : "·";
    return `<li>${state} ${esc(w.agent)} @ ${esc(w.machineName)}${w.branch ? ` · 分支 ${esc(w.branch)}` : ""}${w.lastOutcome ? ` · ${esc(w.lastOutcome)}` : ""}</li>`;
  });
  return `<h1>${thread.unread ? "● " : ""}${esc(thread.title)}</h1>${stateBadge(thread.state)}
<p class="meta">${meta}</p>
${question}
<ol class="timeline">
${items.length > 0 ? items.join("\n") : '<li><span class="k"></span><span class="t empty">还没有事件。</span></li>'}
</ol>
${workers.length > 0 ? `<h1 style="font-size:16px">Workers</h1><ul style="padding-left:18px">${workerRows.join("")}</ul>` : ""}`;
}
