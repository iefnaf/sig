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
import { nextDue, renderDigest } from "../../steward-m1/src/routines.ts";
import type { Db } from "../../steward-m1/src/db.ts";
import type { NotifyPayload } from "../../steward-m1/src/templates.ts";
import type { WorkerEvent } from "../../steward-m1/src/types.ts";
import { SCHEMA } from "../../steward-m1/src/schema.ts";
import { PiHarness } from "agents/harness/pi";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { buildStewardExtension, type StewardContext } from "../../steward-m2/src/steward.ts";

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
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body === undefined ? {} : JSON.parse(JSON.stringify(body, (_k, v) => (v === undefined ? null : v))) ?? {}), {
		status,
		headers: { "content-type": "application/json" },
	});

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

	async sendCard(openId: string, card: { elements: unknown[] }, template: string): Promise<{ providerMsgId: string }> {
		const full = { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "Shepherd" }, template }, body: card };
		const t = await this.accessToken();
		const r = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
			body: JSON.stringify({ receive_id: openId, msg_type: "interactive", content: JSON.stringify(full) }),
			signal: AbortSignal.timeout(10_000),
		}).then((x) => x.json() as Promise<{ code: number; msg?: string; data?: { message_id?: string } }>);
		if (r.code !== 0) throw new Error(`feishu sendCard ${r.code} ${r.msg}`);
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
	harness: PiHarness;
	initError: string | undefined;
	runKind: "user" | "event" = "user";
	provenanceId: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = new DoDb(ctx.storage);
		this.memory = new Memory(this.db);
		this.outbound = new Outbound(this.db);
		this.feishu = new FeishuAdapter(env);
		for (const ddl of SCHEMA) ctx.storage.sql.exec(ddl).toArray();
		for (const ddl of DEVICE_SCHEMA) ctx.storage.sql.exec(ddl).toArray();
		// Routines survive isolate restarts through storage, but the wake does not:
		// re-arm on every construction (duplicate wakes are harmless — due checks are idempotent).
		if (this.db.get(`SELECT 1 FROM sh_routine WHERE enabled = 1 LIMIT 1`)) void this.schedule(15, "runRoutines");
		try {
			{
				// Env-var auth does not work inside the Worker: pi-ai resolves keys through
				// its own environment reader. Build the provider with the key inline instead
				// (the pattern from the pi-durable-edge project).
				const provider = createProvider({
					id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
					auth: { apiKey: { name: "DeepSeek API key", resolve: async () => ({ auth: { apiKey: env.DEEPSEEK_API_KEY }, source: "worker secret" }) } },
					models: Object.values(DEEPSEEK_MODELS), api: openAICompletionsApi(),
				} as never);
				const models = createModels();
				models.setProvider(provider);
				const registry = createRegistry();
				registry.install(buildStewardExtension(this.stewardCtx()));
				this.harness = new PiHarness({
					harness: ({ storage, context }) => Harness.open(storage, { models, registry }, context),
					defaults: { model: { provider: "deepseek", id: "deepseek-flash" } },
				});
				this.lifecycle.use(this.harness);
			}
		} catch (err) {
			this.initError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.error("steward harness init failed:", this.initError);
		}
	}

	private stewardCtx(): StewardContext {
		return {
			memory: this.memory,
			dispatch: async (i) => {
				const r = await this.dispatchToThread(i.threadId, i.prompt);
				return r;
			},
			askUser: async (a) => {
				await this.askUserCard(a);
			},
			notify: async (n) => {
				// Event-wake notifications: short text, attention tone colors the card.
				const elements = [{ tag: "markdown", content: n.text }];
				await this.feishu.sendCard(this.env.FEISHU_OWNER_OPEN_ID, { elements }, n.tone === "attention" ? "orange" : "green");
			},
			runIsUserInitiated: () => this.runKind === "user",
			currentProvenance: () => this.provenanceId,
		};
	}

	// ---- Feishu inbound ----

	async feishuEvent(body: Record<string, any>): Promise<{ challenge?: string }> {
		const bump = (k: string) => this.db.run(`INSERT INTO sh_meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`, k);
		bump("webhookCalls");
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

		try {
			if (header.event_type === "im.message.receive_v1") { bump("webhookMessages"); await this.handleMessage(body.event); }
			else if (header.event_type === "card.action.trigger") await this.handleCardAction(body.event);
		} catch (err) {
			// Log inside the DO: the RPC error envelope masks the real cause on the caller side.
			console.error("feishu event handling failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err), err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 4).join(" | ") : "");
		}
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
		await this.stewardReply(openId, text, msg.message_id);
	}

	private async handleCardAction(event: any) {
		if (event?.operator?.open_id !== this.env.FEISHU_OWNER_OPEN_ID) return;
		const action = event?.action?.value?.action ?? "?";
		if (action === "answer") {
			const { qid, choice } = event?.action?.value ?? {};
			if (qid) this.memory.answerQuestion(qid);
			await this.feishu.sendText(this.env.FEISHU_OWNER_OPEN_ID, `已记录你的选择：${choice ?? "（空）"}`);
			return;
		}
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
		if (!devices.length) {
			await this.feishu.sendText(openId, "还没有已配对的机器。先运行连接器配对，再派发。");
			return;
		}
		const threadId = `t_${rid()}`;
		const title = prompt.slice(0, 16) + (prompt.length > 16 ? "…" : "");
		this.memory.createThread(threadId, title, prompt, fromMsgId);
		const r = await this.dispatchToThread(threadId, prompt);
		if (r.ok) await this.feishu.sendText(openId, `已创建「${title}」并派发（worker ${String(r.workerId).slice(0, 8)}）。完成后我会汇报。`);
	}

	private async dispatchToThread(threadId: string, prompt: string): Promise<{ ok: boolean; workerId?: string; note?: string }> {
		const devices = this.db.all<{ deviceId: string }>(`SELECT deviceId FROM device WHERE revoked = 0`);
		const online = devices.filter((d) => this.connFor(d.deviceId));
		// A thread with history keeps its machine even offline (the command queues and resumes on reconnect).
		const lastWorker = this.db.get<{ deviceId: string }>(`SELECT deviceId FROM sh_worker WHERE threadId = ? ORDER BY rowid DESC LIMIT 1`, threadId);
		let deviceId: string;
		if (lastWorker && devices.some((d) => d.deviceId === lastWorker.deviceId)) deviceId = lastWorker.deviceId;
		else if (online.length) deviceId = online[0].deviceId;
		else return { ok: false, note: devices.length ? "所有机器都不在线" : "还没有配对任何机器" };
		const workerId = `w_${rid()}`;
		this.memory.registerMachine(deviceId, "machine");
		this.memory.registerWorker({ workerId, threadId, deviceId, agent: "pi", mode: "write" });
		const cmdId = `cmd_${rid()}`;
		const cseq = (this.db.get<{ m: number | null }>(`SELECT MAX(cseq) AS m FROM outbox WHERE deviceId = ?`, deviceId)!.m ?? 0) + 1;
		// Relay (spec §5.2): a second worker on a thread starts from the previous worker's branch.
		const prevBranch = this.db.get<{ branch: string | null }>(
			`SELECT branch FROM sh_worker WHERE threadId = ? AND branch IS NOT NULL ORDER BY rowid DESC LIMIT 1`, threadId,
		)?.branch;
		this.db.run(
			`INSERT INTO outbox (cmdId, deviceId, cseq, kind, payload, state, ackTimeoutSec) VALUES (?, ?, ?, 'start_worker', ?, 'queued', 15)`,
			cmdId, deviceId, cseq, JSON.stringify({ workerId, threadId, prompt, ...(prevBranch && prevBranch !== `shepherd/${workerId}` ? { base: prevBranch } : {}) }),
		);
		this.memory.timeline(threadId, "dispatch", `派发给 ${deviceId}：${prompt}`, { cmdId, workerId });
		if (!this.deliver(cmdId)) void this.schedule(5, "resendUnacked");
		return { ok: true, workerId };
	}

	// The steward's answer flow: submit durably, then poll from alarms (the webhook must
	// return to Feishu fast; the LLM run takes seconds).
	private async stewardReply(openId: string, text: string, msgId: string) {
		const operationId = `user:${msgId}`;
		this.db.run(
			`INSERT OR REPLACE INTO sh_run (operationId, kind, replyTo, status, createdAt) VALUES (?, 'user', ?, 'open', ?)`,
			operationId, openId, Date.now(),
		);
		this.runKind = "user";
		this.provenanceId = msgId;
		try {
			await this.harness.submit(text, { operationId, whenBusy: "followUp" });
			void this.schedule(1, "pollRun", { operationId });
		} catch (err) {
			this.db.run(`UPDATE sh_run SET status = 'failed' WHERE operationId = ?`, operationId);
			await this.feishu.sendText(openId, `总管没能开始处理（${err instanceof Error ? err.message : String(err)}）。可以用 /派发 直接派发。`);
		}
	}

	async pollRun(p: { operationId: string }) {
		const row = this.db.get<{ kind: string; replyTo: string | null; status: string; createdAt: number }>(
			`SELECT kind, replyTo, status, createdAt FROM sh_run WHERE operationId = ?`, p.operationId,
		);
		if (!row || row.status !== "open") return;
		if (Date.now() - row.createdAt > 180_000) {
			this.db.run(`UPDATE sh_run SET status = 'failed' WHERE operationId = ?`, p.operationId);
			if (row.kind === "user" && row.replyTo) await this.feishu.sendText(row.replyTo, "总管这次超时了。可以重发，或用 /派发 直接派发。");
			return;
		}
		try {
			const pending = await this.harness.pending();
			if (pending.some((x: { operationId: string }) => x.operationId === p.operationId)) {
				void this.schedule(2, "pollRun", p);
				return;
			}
			const res = await this.harness.wait(p.operationId);
			if (res.status === "done") {
				this.db.run(`UPDATE sh_run SET status = 'done' WHERE operationId = ?`, p.operationId);
				if (row.kind === "user" && row.replyTo && res.text) await this.feishu.sendText(row.replyTo, res.text);
			} else {
				this.db.run(`UPDATE sh_run SET status = 'failed' WHERE operationId = ?`, p.operationId);
				if (row.kind === "user" && row.replyTo) await this.feishu.sendText(row.replyTo, `总管没能完成（${res.reason ?? "未知原因"}）。可以重发，或用 /派发 直接派发。`);
			}
		} catch (err) {
			void this.schedule(3, "pollRun", p); // transient: keep polling until the timeout above
		}
	}

	private async askUserCard(a: { threadId?: string; question: string; options?: string[] }) {
		const qid = `q_${rid()}`;
		const threadId = a.threadId ?? this.memory.situation().threads[0]?.threadId;
		if (threadId) {
			this.memory.createQuestion(qid, threadId, null, a.question, "steward");
			this.memory.recomputeThreadStates();
		}
		const elements: unknown[] = [{ tag: "markdown", content: `**${a.question}**` }];
		for (const [i, opt] of (a.options ?? []).slice(0, 3).entries()) {
			elements.push({ tag: "button", text: { tag: "plain_text", content: opt }, type: i === 0 ? "primary" : "default", behaviors: [{ type: "callback", value: { action: "answer", qid, choice: opt } }] });
		}
		await this.feishu.sendCard(this.env.FEISHU_OWNER_OPEN_ID, { elements }, "orange");
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

	// ---- built-in routines (spec §8.3): deterministic, ledger-rendered, owner-created ----

	async runRoutines() {
		const now = Date.now();
		const due = this.db.all<{ id: string; kind: string; schedule: string }>(
			`SELECT id, kind, schedule FROM sh_routine WHERE enabled = 1 AND nextDueAt <= ?`, now,
		);
		for (const r of due) {
			let payload: NotifyPayload | null = null;
			if (r.kind === "digest") payload = renderDigest(this.memory);
			if (payload) {
				// A quiet routine with nothing to say stays quiet (renderDigest returns null).
				this.outbound.enqueue(`routine_${r.id}_${now}`, "feishu", `routine:${r.kind}`, payload);
				try {
					const n = await this.outbound.flush(this.feishuProxy, "feishu");
					if (n) this.bump("feishuSent", n);
				} catch (e) {
					console.error("routine flush failed:", e instanceof Error ? e.message : String(e));
					void this.schedule(10, "retryOutbound"); // the queue retries on its own alarm
				}
			}
			this.db.run(`UPDATE sh_routine SET lastRunAt = ?, nextDueAt = ? WHERE id = ?`, now, nextDue(r.schedule, now), r.id);
		}
		const next = this.db.get<{ m: number | null }>(`SELECT MIN(nextDueAt) AS m FROM sh_routine WHERE enabled = 1`)?.m;
		if (next) void this.schedule(Math.max(1, Math.ceil((next - Date.now()) / 1000)), "runRoutines");
	}

	async createRoutine(schedule: string, kind = "digest") {
		const id = `rt_${rid()}`;
		const nd = nextDue(schedule);
		this.db.run(`INSERT INTO sh_routine (id, kind, schedule, enabled, nextDueAt) VALUES (?, ?, ?, 1, ?)`, id, kind, schedule, nd);
		void this.schedule(Math.max(1, Math.ceil((nd - Date.now()) / 1000)), "runRoutines");
		return { id, kind, schedule, nextDueAt: nd };
	}

	async listRoutines() {
		return this.db.all(`SELECT id, kind, schedule, enabled, lastRunAt, nextDueAt FROM sh_routine ORDER BY nextDueAt`);
	}

	async disableRoutine(id: string) {
		this.db.run(`UPDATE sh_routine SET enabled = 0 WHERE id = ?`, id);
		return { id, enabled: 0 };
	}

	async resendUnacked() {
		// queued rows: deliver when the device is back; otherwise count sweeps and age out (~30min).
		for (const r of this.db.all<{ cmdId: string }>(`SELECT cmdId FROM outbox WHERE state = 'queued'`)) this.deliver(r.cmdId);
		this.db.run(`UPDATE outbox SET attempts = attempts + 1 WHERE state = 'queued'`);
		this.db.run(`UPDATE outbox SET state = 'failed' WHERE state = 'queued' AND attempts >= 60`);
		const due = this.db.all<{ cmdId: string; attempts: number }>(`SELECT cmdId, attempts FROM outbox WHERE state = 'sent' AND ackDeadline <= ?`, Date.now());
		for (const r of due) {
			if (r.attempts >= 4) this.db.run(`UPDATE outbox SET state = 'failed' WHERE cmdId = ?`, r.cmdId);
			else this.deliver(r.cmdId);
		}
		const waiting = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE state IN ('sent','queued')`)!.n;
		if (waiting) void this.schedule(due.length ? 1 : 30, "resendUnacked");
	}

	shouldSendProtocolMessages() {
		return false;
	}

	// Plain HTTP diagnostics, bypassing RPC (whose error envelope masks constructor failures).
	async onRequest(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/__diag")) {
			let conns: unknown = "err";
			let devices: unknown = "err";
			try {
				conns = Array.from(this.getConnections() as any).map((c: any) => ({ id: c.id, dev: (c.state as { deviceId?: string } | null)?.deviceId ?? "?", ready: c.readyState }));
			} catch (e) {
				conns = e instanceof Error ? e.message : String(e);
			}
			try {
				devices = this.db.all(`SELECT deviceId, name, revoked FROM device`);
			} catch (e) {
				devices = e instanceof Error ? e.message : String(e);
			}
			let outbox: unknown = "err";
			try {
				outbox = this.db.all(`SELECT cmdId, deviceId, cseq, state, attempts FROM outbox ORDER BY rowid DESC LIMIT 6`);
			} catch (e) {
				outbox = e instanceof Error ? e.message : String(e);
			}
			const info = { initError: this.initError ?? null, constructorOk: true, conns, devices, outbox, at: Date.now() };
			try {
				return new Response(JSON.stringify(info), { headers: { "content-type": "application/json" } });
			} catch (err) {
				return new Response(String(err), { status: 500 });
			}
		}
		return new Response("shepherd e2e DO");
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
				const dev = ((connection.state as { deviceId?: string } | null)?.deviceId) ?? "";
				const pending = this.db.all<{ cmdId: string }>(`SELECT cmdId FROM outbox WHERE deviceId = ? AND state IN ('queued','sent') ORDER BY cseq`, dev);
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
				// wake the steward for bookkeeping on report/settled (reply discarded: event runs are quiet)
				const wakeOn = events.filter((e) => e.type === "report" || e.type === "settled").at(-1) as undefined | (typeof events)[number];
				if (wakeOn) {
					const w = this.memory.worker((wakeOn as { workerId: string }).workerId);
					if (w) {
						const desc = wakeOn.type === "report"
							? `worker 汇报 ${wakeOn.status}：${(wakeOn as { summary?: string }).summary ?? ""}`
							: `worker 运行结束 ${wakeOn.outcome}`;
						const operationId = `evt:${(wakeOn as { workerId: string; seq: number }).workerId}:${(wakeOn as { seq: number }).seq}`;
						this.db.run(`INSERT OR REPLACE INTO sh_run (operationId, kind, status, createdAt) VALUES (?, 'event', 'open', ?)`, operationId, Date.now());
						this.runKind = "event";
						this.provenanceId = operationId;
						try {
							await this.harness.submit(`⟦event⟧ thread=${w.threadId} ${desc}`, { operationId, whenBusy: "followUp" });
							void this.schedule(3, "pollRun", { operationId });
						} catch { this.db.run(`UPDATE sh_run SET status = 'failed' WHERE operationId = ?`, operationId); }
					}
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
			initError: this.initError ?? null,
			runs: this.db.all(`SELECT operationId, kind, status FROM sh_run ORDER BY createdAt DESC LIMIT 8`),
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
	`CREATE TABLE IF NOT EXISTS sh_run (operationId TEXT PRIMARY KEY, kind TEXT, replyTo TEXT, status TEXT, createdAt INTEGER)`,
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
			try {
				const res = await (await stub()).feishuEvent(body);
				return json(res);
			} catch (err) {
				console.error("feishu webhook handler failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
				return json({ error: "handler failed" }, 200); // 200 so Feishu does not retry
			}
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
			if (url.pathname === "/admin/routine") {
				if (request.method === "POST") {
					const body = (await request.json().catch(() => ({}))) as { schedule?: string; kind?: string };
					try { return json(await s.createRoutine(body.schedule ?? "every@300", body.kind ?? "digest")); }
					catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
				}
				if (request.method === "DELETE") {
					const id = url.searchParams.get("id");
					if (!id) return json({ error: "id required" }, 400);
					return json(await s.disableRoutine(id));
				}
				return json(await s.listRoutines());
			}
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
