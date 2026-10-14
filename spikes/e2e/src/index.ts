// End-to-end spike: Feishu inbound (webhook) + connector protocol + steward M1 core,
// all in one Durable Object. No LLM anywhere: dispatch is triggered by fixed commands.
//
// Flow: user sends "/派发 修一下登录bug" in Feishu -> webhook -> DO parses -> thread+worker
// created -> outbox command -> connector (sim) -> events flow back -> reducer -> templates
// -> report card lands in Feishu.
import { Agent, routeAgentRequest, getAgentByName } from "agents";
import { Memory } from "../../steward-m1/src/memory.ts";
import { applyEvents } from "../../steward-m1/src/reducer.ts";
import { Outbound, type ChannelAdapter } from "../../steward-m1/src/outbound.ts";
import { processIntents } from "../../steward-m1/src/scheduler.ts";
import type { Db } from "../../steward-m1/src/db.ts";
import type { NotifyPayload } from "../../steward-m1/src/templates.ts";
import type { WorkerEvent } from "../../steward-m1/src/types.ts";
import { SCHEMA } from "../../steward-m1/src/schema.ts";

interface Env {
	Steward: DurableObjectNamespace;
	SERVER_KEY: string;
	ADMIN_TOKEN: string;
	FEISHU_APP_ID: string;
	FEISHU_APP_SECRET: string;
	FEISHU_OWNER_OPEN_ID: string;
}

const enc = new TextEncoder();
const hmacKey = (secret: string, usage: KeyUsage[]) =>
	crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

async function mintToken(env: Env, deviceId: string, epoch: number): Promise<string> {
	const base = `st1.${deviceId}.${epoch}.${Date.now()}`;
	const mac = toHex(await crypto.subtle.sign("HMAC", await hmacKey(env.SERVER_KEY, ["sign"]), enc.encode(base)));
	return `${base}.${mac}`;
}
async function parseToken(env: Env, token: string | null): Promise<{ deviceId: string; epoch: number } | null> {
	if (!token) return null;
	const parts = token.split(".");
	if (parts.length !== 5 || parts[0] !== "st1" || !/^[0-9a-f]{64}$/.test(parts[4])) return null;
	const base = parts.slice(0, 4).join(".");
	const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.SERVER_KEY, ["verify"]), fromHex(parts[4]), enc.encode(base));
	return ok ? { deviceId: parts[1], epoch: Number(parts[2]) } : null;
}
const bearer = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
const json = (body: unknown, status = 200) => Response.json(body, { status });

// ---- DO storage as the M1 Db facade ----
class DoDb implements Db {
	constructor(private storage: DurableObjectStorage) {}
	exec(sql: string): void {
		this.storage.sql.exec(sql).toArray();
	}
	run(sql: string, ...params: unknown[]): void {
		this.storage.sql.exec(sql, ...(params as never[])).toArray();
	}
	get<T>(sql: string, ...params: unknown[]): T | undefined {
		return (this.storage.sql.exec(sql, ...(params as never[])).toArray() as T[])[0];
	}
	all<T>(sql: string, ...params: unknown[]): T[] {
		return this.storage.sql.exec(sql, ...(params as never[])).toArray() as T[];
	}
}

// ---- Feishu adapter over plain fetch (no SDK in the Worker) ----
class FeishuAdapter implements ChannelAdapter {
	private token: { value: string; expiresAt: number } | null = null;
	constructor(private env: Env) {}

	private async accessToken(): Promise<string> {
		if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
		const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ app_id: this.env.FEISHU_APP_ID, app_secret: this.env.FEISHU_APP_SECRET }),
			signal: AbortSignal.timeout(10_000),
		}).then((x) => x.json() as Promise<{ code: number; tenant_access_token?: string; expire?: number }>);
		if (r.code !== 0 || !r.tenant_access_token) throw new Error(`feishu token ${r.code}`);
		this.token = { value: r.tenant_access_token, expiresAt: Date.now() + (r.expire ?? 7200) * 1000 };
		return this.token.value;
	}

	async sendText(openId: string, text: string) {
		const t = await this.accessToken();
		const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
			body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
			signal: AbortSignal.timeout(10_000),
		}).then((x) => x.json() as Promise<{ code: number; msg?: string; data?: { message_id?: string } }>);
		if (r.code !== 0) throw new Error(`feishu sendText ${r.code} ${r.msg}`);
		return { providerMsgId: r.data!.message_id! };
	}

	async send(payload: NotifyPayload & { cardTitle?: string }, openId: string): Promise<{ providerMsgId: string }> {
		const elements: unknown[] = [{ tag: "markdown", content: `**${payload.conclusion}**` }];
		if (payload.did.length) elements.push({ tag: "markdown", content: payload.did.map((d) => `- ${d}`).join("\n") });
		if (payload.needsYou) elements.push({ tag: "markdown", content: `**需要你决定**：${payload.needsYou}` });
		if (payload.needsYou) {
			elements.push({ tag: "button", text: { tag: "plain_text", content: "同意" }, type: "primary", behaviors: [{ type: "callback", value: { action: "approve" } }] });
			elements.push({ tag: "button", text: { tag: "plain_text", content: "先不要" }, type: "default", behaviors: [{ type: "callback", value: { action: "hold" } }] });
		}
		const card = {
			schema: "2.0",
			config: { update_multi: true },
			header: { title: { tag: "plain_text", content: payload.cardTitle ?? "Shepherd 汇报" }, template: payload.tone === "failure" ? "red" : payload.tone === "attention" ? "orange" : "green" },
			body: { elements },
		};
		const t = await this.accessToken();
		const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
			body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) }),
			signal: AbortSignal.timeout(10_000),
		}).then((x) => x.json() as Promise<{ code: number; msg?: string; data?: { message_id?: string } }>);
		if (r.code !== 0) throw new Error(`feishu send ${r.code} ${r.msg}`);
		return { providerMsgId: r.data!.message_id! };
	}
}

const rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export class Steward extends Agent<Env> {
	db: DoDb;
	memory: Memory;
	outbound: Outbound;
	feishu: FeishuAdapter;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new DoDb(ctx.storage);
		this.memory = new Memory(this.db);
		this.outbound = new Outbound(this.db);
		this.feishu = new FeishuAdapter(env);
		for (const ddl of SCHEMA) ctx.storage.sql.exec(ddl).toArray();
		for (const ddl of DEVICE_SCHEMA) ctx.storage.sql.exec(ddl).toArray();
	}

	// ---- Feishu inbound ----

	async feishuEvent(body: Record<string, any>): Promise<{ challenge?: string }> {
		if (body.type === "url_verification") return { challenge: body.challenge };
		const header = body.header ?? {};
		const eventId = String(header.event_id ?? "");
		if (!eventId) return {};
		// Lock the verification token on first sight; reject mismatches afterwards.
		const tok = String(header.token ?? "");
		const locked = this.db.get<{ v: string }>(`SELECT v FROM sh_meta WHERE k = 'feishu_token'`);
		if (!locked) this.db.run(`INSERT OR REPLACE INTO sh_meta (k, v) VALUES ('feishu_token', ?)`, tok);
		else if (locked.v !== tok) return {};

		if (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sh_inbound WHERE channel = 'feishu' AND msgId = ?`, eventId)!.n) return {};
		this.db.run(`INSERT INTO sh_inbound (channel, msgId, receivedAt) VALUES ('feishu', ?, ?)`, eventId, Date.now());

		if (header.event_type === "im.message.receive_v1") await this.handleMessage(body.event);
		else if (header.event_type === "card.action.trigger") await this.handleCardAction(body.event);
		return {};
	}

	private async handleMessage(event: any) {
		const openId = event?.sender?.sender_id?.open_id;
		if (openId !== this.env.FEISHU_OWNER_OPEN_ID) return; // owner only
		const msg = event?.message ?? {};
		if (msg.chat_type !== "p2p") return;
		let text = "";
		try {
			text = String(JSON.parse(msg.content ?? "{}").text ?? "");
		} catch {
			return;
		}
		// Quoting one of our reports routes the message to that thread (steward.md §3.1 signal 1).
		const quoted = this.db.get<{ threadId: string }>(`SELECT threadId FROM sh_outbound WHERE providerMsgId = ?`, msg.parent_id ?? msg.root_id ?? "");
		if (quoted) {
			await this.feishu.sendText(openId, `（M1 无 LLM：这条回复已路由到 Thread ${quoted.threadId}，但只有总管能理解它。）`);
			return;
		}
		if (text.startsWith("/状态")) {
			const s = this.memory.situation();
			const lines = s.threads.map((t) => `${t.state === "running" ? "▶" : t.state === "waiting_you" ? "❓" : "·"} ${t.title}（${t.state}${t.unread ? "，未读" : ""}）`);
			await this.feishu.sendText(openId, lines.length ? lines.join("\n") : "还没有任何 Thread。发「/派发 <要做的事>」开始。");
			return;
		}
		if (text.startsWith("/派发") || text.startsWith("/dispatch")) {
			const prompt = text.replace(/^\/(派发|dispatch)\s*/, "").trim();
			if (!prompt) {
				await this.feishu.sendText(openId, "用法：/派发 <要做的事>");
				return;
			}
			await this.dispatch(openId, prompt, msg.message_id);
			return;
		}
		await this.feishu.sendText(openId, "M1 阶段只支持：/派发 <要做的事>、/状态。");
	}

	private async handleCardAction(event: any) {
		if (event?.operator?.open_id !== this.env.FEISHU_OWNER_OPEN_ID) return;
		const action = event?.action?.value?.action ?? "?";
		const cardMsgId = event?.context?.open_message_id;
		const thread = this.db.get<{ threadId: string }>(`SELECT threadId FROM sh_outbound WHERE providerMsgId = ?`, cardMsgId ?? "");
		if (thread) {
			const q = this.memory.openQuestion(thread.threadId);
			if (q) this.memory.answerQuestion(q.qid);
		}
		await this.feishu.sendText(this.env.FEISHU_OWNER_OPEN_ID, `已收到按钮「${action}」（M1 记录到此为止；按钮的实际效果由总管实现）。`);
	}

	// ---- fixed-command dispatch (no LLM) ----

	private async dispatch(openId: string, prompt: string, fromMsgId: string) {
		const devices = this.db.all<{ deviceId: string }>(`SELECT deviceId FROM device WHERE revoked = 0`);
		const online = devices.filter((d) => this.connFor(d.deviceId));
		if (!devices.length) {
			await this.feishu.sendText(openId, "还没有已配对的机器。先运行连接器配对，再派发。");
			return;
		}
		if (!online.length) {
			await this.feishu.sendText(openId, "已配对的机器都不在线，任务已排队，机器连上后会自动开始。");
		}
		const deviceId = (online[0] ?? devices[0]).deviceId;
		const threadId = `t_${rid()}`;
		const workerId = `w_${rid()}`;
		const title = prompt.slice(0, 16) + (prompt.length > 16 ? "…" : "");
		this.memory.registerMachine(deviceId, "machine");
		this.memory.createThread(threadId, title, prompt, fromMsgId);
		this.memory.registerWorker({ workerId, threadId, deviceId, agent: "pi", mode: "write" });
		const cmdId = `cmd_${rid()}`;
		const cseq = (this.db.get<{ m: number | null }>(`SELECT MAX(cseq) AS m FROM outbox WHERE deviceId = ?`, deviceId)!.m ?? 0) + 1;
		this.db.run(
			`INSERT INTO outbox (cmdId, deviceId, cseq, kind, payload, state, ackTimeoutSec) VALUES (?, ?, ?, 'start_worker', ?, 'queued', 15)`,
			cmdId, deviceId, cseq, JSON.stringify({ workerId, threadId, prompt }),
		);
		this.memory.timeline(threadId, "dispatch", `派发给 ${deviceId}：${prompt}`, { cmdId, workerId });
		this.deliver(cmdId);
		await this.feishu.sendText(openId, `已创建「${title}」并派发（worker ${workerId.slice(0, 8)}）。完成后我会汇报。`);
	}

	// ---- connector protocol (from the do-protocol spike) ----

	private ensureDeviceSchema() {
		for (const ddl of DEVICE_SCHEMA) this.ctx.storage.sql.exec(ddl).toArray();
	}

	private connFor(deviceId: string) {
		for (const c of this.getConnections(`dev:${deviceId}`)) return c as unknown as { send: (s: string) => void };
		return undefined;
	}

	private deliver(cmdId: string) {
		const row = this.db.get<{ deviceId: string; cseq: number; kind: string; payload: string; ackTimeoutSec: number; attempts: number }>(
			`SELECT deviceId, cseq, kind, payload, ackTimeoutSec, attempts FROM outbox WHERE cmdId = ?`, cmdId,
		);
		if (!row) return false;
		const conn = this.connFor(row.deviceId);
		if (!conn) return false;
		conn.send(JSON.stringify({ t: "cmd", id: cmdId, cseq: row.cseq, kind: row.kind, args: JSON.parse(row.payload) }));
		const now = Date.now();
		this.db.run(`UPDATE outbox SET state = 'sent', attempts = attempts + 1, sentAt = ?, ackDeadline = ? WHERE cmdId = ?`, now, now + row.ackTimeoutSec * 1000, cmdId);
		void this.schedule(row.ackTimeoutSec, "resendUnacked");
		return true;
	}

	async retryOutbound() {
		try {
			const n = await this.outbound.flush(this.feishuProxy, "feishu");
			if (n) this.bump("feishuSent", n);
		} catch (e) {
			console.error("retryOutbound failed:", e instanceof Error ? e.message : String(e));
		}
		if (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sh_outbound WHERE status = 'queued'`)!.n) void this.schedule(30, "retryOutbound");
	}

	async resendUnacked() {
		const due = this.db.all<{ cmdId: string; attempts: number }>(`SELECT cmdId, attempts FROM outbox WHERE state = 'sent' AND ackDeadline <= ?`, Date.now());
		for (const r of due) {
			if (r.attempts >= 4) this.db.run(`UPDATE outbox SET state = 'failed' WHERE cmdId = ?`, r.cmdId);
			else this.deliver(r.cmdId);
		}
		if (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent'`)!.n) void this.schedule(1, "resendUnacked");
	}

	shouldSendProtocolMessages() {
		return false;
	}

	async getConnectionTags(_c: unknown, ctx: { request: Request }) {
		const p = await parseToken(this.env, bearer(ctx.request));
		return p ? [`dev:${p.deviceId}`] : [];
	}

	private async authenticate(request: Request) {
		const p = await parseToken(this.env, bearer(request));
		if (!p) return { ok: false as const, code: 4401, reason: "unauthorized" };
		const row = this.db.get<{ epoch: number; revoked: number }>(`SELECT epoch, revoked FROM device WHERE deviceId = ?`, p.deviceId);
		if (!row) return { ok: false as const, code: 4401, reason: "unknown device" };
		if (row.revoked || row.epoch !== p.epoch) return { ok: false as const, code: 4403, reason: "revoked" };
		return { ok: true as const, deviceId: p.deviceId };
	}

	async onConnect(connection: any, ctx: { request: Request }) {
		this.ensureDeviceSchema();
		const auth = await this.authenticate(ctx.request);
		if (!auth.ok) {
			connection.close(auth.code, auth.reason);
			return;
		}
		for (const other of this.getConnections(`dev:${auth.deviceId}`)) {
			if ((other as any).id !== connection.id) (other as any).close(4409, "superseded");
		}
		connection.setState({ deviceId: auth.deviceId, role: "connector" });
	}

	async onMessage(connection: any, raw: string | ArrayBuffer) {
		if (typeof raw !== "string") return;
		const st = connection.state as { deviceId?: string } | null;
		if (!st?.deviceId) return;
		let m: any;
		try {
			m = JSON.parse(raw);
		} catch {
			return;
		}
		try {
			await this.handleConnectorMessage(connection, m);
		} catch (err) {
			console.error("connector message failed:", m.t, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
			// The ack below is best-effort: the connector replays unacked events after reconnect.
		}
	}

	private async handleConnectorMessage(connection: any, m: any) {
		switch (m.t) {
			case "hello": {
				const pending = this.db.all<{ cmdId: string }>(`SELECT cmdId FROM outbox WHERE deviceId = ? AND state IN ('queued','sent') ORDER BY cseq`, st.deviceId);
				connection.send(JSON.stringify({ t: "welcome", re: m.id, protocol: 1, serverTime: Date.now() }));
				for (const r of pending) this.deliver(r.cmdId);
				return;
			}
			case "cmd_ack": {
				if (m.status === "accepted") this.db.run(`UPDATE outbox SET state = 'accepted' WHERE cmdId = ? AND state IN ('sent','queued')`, m.re);
				else if (m.status === "rejected") this.db.run(`UPDATE outbox SET state = 'failed' WHERE cmdId = ?`, m.re);
				return;
			}
			case "events": {
				const events: WorkerEvent[] = m.batch;
				const r = applyEvents(this.memory, events);
				for (const i of r.intents) if (i.type === "notify") { /* handled by processIntents below */ }
				processIntents(this.memory, this.outbound, "feishu");
				this.outbound.mergeQuiet(60_000);
				let sent = 0;
				try {
					sent = await this.outbound.flush(this.feishuProxy, "feishu");
					if (sent) this.bump("feishuSent", sent);
				} finally {
					// If anything is still queued (send failed), retry from an alarm instead of
					// relying on the next events batch to call flush again.
					if (this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sh_outbound WHERE status = 'queued'`)!.n) void this.schedule(6, "retryOutbound");
				}
				// cumulative acks back to the connector
				const byWorker = new Set(events.map((e) => (e as any).workerId as string));
				for (const workerId of byWorker) {
					const ack = this.db.get<{ upTo: number }>(`SELECT upTo FROM sh_worker_ack WHERE workerId = ?`, workerId);
					connection.send(JSON.stringify({ t: "events_ack", workerId, upTo: ack?.upTo ?? 0 }));
				}
				return;
			}
		}
	}

	// The M1 Outbound expects an adapter with send({id, kind, threadId, payload}); adapt to Feishu owner DM.
	private feishuProxy = {
		send: async (out: { payload: NotifyPayload }) => this.feishu.send(out.payload, this.env.FEISHU_OWNER_OPEN_ID),
	};

	private bump(k: string, by = 1) {
		this.db.run(`INSERT INTO sh_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + ?`, k, by, by);
	}

	// ---- admin ----

	async stats() {
		return {
			threads: this.memory.situation().threads,
			outbound: this.db.all(`SELECT status, COUNT(*) AS n FROM sh_outbound GROUP BY status`),
			commands: this.db.all(`SELECT cmdId, kind, state, attempts FROM outbox`),
			events: this.db.all(`SELECT workerId, COUNT(*) AS n FROM sh_event GROUP BY workerId`),
			meta: this.db.all(`SELECT k, v FROM sh_meta`),
		};
	}

	async createPairing() {
		const code = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b & 31]).join("");
		this.db.run(`INSERT INTO pairing (code, expiresAt) VALUES (?, ?)`, code, Date.now() + 10 * 60_000);
		return { code };
	}

	async pair(code: string, name: string) {
		const row = this.db.get<{ expiresAt: number; used: number }>(`SELECT expiresAt, used FROM pairing WHERE code = ?`, code);
		if (!row || row.used || row.expiresAt < Date.now()) return null;
		this.db.run(`UPDATE pairing SET used = 1 WHERE code = ?`, code);
		const deviceId = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
		this.db.run(`INSERT INTO device (deviceId, name, epoch) VALUES (?, ?, 1)`, deviceId, name);
		return { deviceId, token: await mintToken(this.env, deviceId, 1) };
	}
}

const DEVICE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sh_meta (k TEXT PRIMARY KEY, v INTEGER)`,
	`CREATE TABLE IF NOT EXISTS device (deviceId TEXT PRIMARY KEY, name TEXT, epoch INTEGER, revoked INTEGER DEFAULT 0, lastHello TEXT)`,
	`CREATE TABLE IF NOT EXISTS pairing (code TEXT PRIMARY KEY, expiresAt INTEGER, used INTEGER DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS outbox (cmdId TEXT PRIMARY KEY, deviceId TEXT, cseq INTEGER, kind TEXT, payload TEXT,
		state TEXT, attempts INTEGER DEFAULT 0, sentAt INTEGER, ackDeadline INTEGER, ackTimeoutSec INTEGER, result TEXT)`,
];

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const stub = async () => getAgentByName(env.Steward as any, "owner") as Promise<any>;
		const isAdmin = () => bearer(request) === env.ADMIN_TOKEN;

		// Feishu webhook (the URL configured in the app is /feishu)
		if (request.method === "POST" && (url.pathname === "/feishu" || url.pathname === "/channels/feishu/events")) {
			const body = (await request.json().catch(() => ({}))) as Record<string, any>;
			const res = await (await stub()).feishuEvent(body);
			return json(res);
		}
		if (url.pathname === "/pair" && request.method === "POST") {
			const body = (await request.json()) as { code: string; name: string };
			const res = await (await stub()).pair(body.code, body.name);
			return res ? json(res) : json({ error: "invalid code" }, 400);
		}
		if (url.pathname.startsWith("/admin/")) {
			if (!isAdmin()) return json({ error: "forbidden" }, 403);
			const s = await stub();
			if (url.pathname === "/admin/stats") return json(await s.stats());
			if (url.pathname === "/admin/pairing") return json(await s.createPairing());
			if (url.pathname === "/admin/flush") { await s.retryOutbound(); return json(await s.stats()); }
			return json({ error: "not found" }, 404);
		}
		const routed = await routeAgentRequest(request, env as any, {
			onBeforeConnect: async (req) => {
				const p = await parseToken(env, bearer(req));
				if (!p) return new Response("unauthorized", { status: 401 });
			},
		});
		return routed ?? new Response("not found", { status: 404 });
	},
};
