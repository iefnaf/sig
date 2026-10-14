// Spike: connector <-> steward Durable Object protocol. See docs/design/connector-do-protocol.md.
import { Agent, routeAgentRequest, getAgentByName } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

interface Env {
	Steward: DurableObjectNamespace;
	SERVER_KEY: string;
	ADMIN_TOKEN: string;
}

const enc = new TextEncoder();

// ---- device tokens: st1.<deviceId>.<epoch>.<issuedAt>.<mac> ---------------------------------

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

// ---- Durable Object ------------------------------------------------------------------------

export class Steward extends Agent<Env> {
	// In-memory on purpose: a new value after idle proves the object was evicted (hibernated).
	instanceId = crypto.randomUUID().slice(0, 8);
	harness: any;

	constructor(ctx: any, env: Env) {
		super(ctx, env);
		// Scripted "steward" model: replies with a short note; text containing SLOW streams for ~20s.
		const faux = fauxProvider({ tokensPerSecond: 6 });
		const lastText = (req: any) => {
			const m = [...req.messages].reverse().find((x: any) => x.role !== "system");
			const c = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : (m?.content ?? []);
			return c.flatMap((p: any) => (p.type === "text" ? [p.text] : [])).join("");
		};
		const route = (req: any) => {
			const t = lastText(req);
			if (t.includes("SLOW")) return fauxAssistantMessage([fauxText(Array.from({ length: 90 }, (_, i) => `word${i}`).join(" "))]);
			return fauxAssistantMessage([fauxText(`Noted: ${t.slice(0, 60)}`)]);
		};
		faux.setResponses(Array.from({ length: 300 }, () => route));
		const registry = createRegistry();
		this.harness = new PiHarness({
			harness: ({ storage, context }: any) => {
				const models = createModels();
				models.setProvider(faux.provider);
				return Harness.open(storage, { models, registry }, context);
			},
			defaults: { model: faux.getModel() },
		});
		this.lifecycle.use(this.harness);
	}

	// Simplified transcript for assertions.
	async harnessView() {
		const records: any[] = await this.harness.messages();
		const text = (r: any) => {
			const c = r?.model?.[0]?.content ?? r?.content ?? [];
			return typeof c === "string" ? c : c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
		};
		const messages = records.filter((r) => r.kind === "pi.user" || r.kind === "pi.assistant").map((r) => ({ role: r.kind === "pi.user" ? "user" : "assistant", text: text(r).slice(0, 80) }));
		return { messages, pending: await this.harness.pending(), instanceId: this.instanceId };
	}

	async crash() {
		// Forcibly resets the object, as if it had crashed mid-run.
		this.ctx.abort("spike: simulated crash");
	}

	async onStart() {
		this.ensureSchema();
		this.sql`INSERT INTO meta(k, v) VALUES ('wakes', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`;
	}

	private ensureSchema() {
		this.sql`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER)`;
		this.sql`CREATE TABLE IF NOT EXISTS device (deviceId TEXT PRIMARY KEY, name TEXT, epoch INTEGER, revoked INTEGER DEFAULT 0, lastHello TEXT)`;
		this.sql`CREATE TABLE IF NOT EXISTS pairing (code TEXT PRIMARY KEY, expiresAt INTEGER, used INTEGER DEFAULT 0)`;
		this.sql`CREATE TABLE IF NOT EXISTS outbox (cmdId TEXT PRIMARY KEY, deviceId TEXT, cseq INTEGER, kind TEXT, payload TEXT,
			state TEXT, attempts INTEGER DEFAULT 0, sentAt INTEGER, ackDeadline INTEGER, ackTimeoutSec INTEGER, result TEXT)`;
		this.sql`CREATE TABLE IF NOT EXISTS event_inbox (workerId TEXT, seq INTEGER, payload TEXT, receivedAt INTEGER, PRIMARY KEY (workerId, seq))`;
		this.sql`CREATE TABLE IF NOT EXISTS worker_ack (workerId TEXT PRIMARY KEY, upTo INTEGER)`;
	}

	private bump(k: string) {
		this.sql`INSERT INTO meta(k, v) VALUES (${k}, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1`;
	}

	// ---- admin / RPC (called from the Worker) ----

	async stats() {
		const wakes = this.sql<{ v: number }>`SELECT v FROM meta WHERE k = 'wakes'`[0]?.v ?? 0;
		const counters = Object.fromEntries(this.sql<{ k: string; v: number }>`SELECT k, v FROM meta`.map((r) => [r.k, r.v]));
		return { instanceId: this.instanceId, wakes, counters, connections: [...this.getConnections()].length, now: Date.now() };
	}

	async dump() {
		return {
			outbox: this.sql`SELECT cmdId, deviceId, cseq, kind, state, attempts FROM outbox ORDER BY cseq`,
			acks: this.sql`SELECT workerId, upTo FROM worker_ack`,
			inbox: this.sql`SELECT workerId, COUNT(*) AS n, MIN(seq) AS minSeq, MAX(seq) AS maxSeq FROM event_inbox GROUP BY workerId`,
			devices: this.sql`SELECT deviceId, name, epoch, revoked FROM device`,
		};
	}

	async createPairing() {
		const code = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[b & 31]).join("");
		this.sql`INSERT INTO pairing(code, expiresAt) VALUES (${code}, ${Date.now() + 10 * 60_000})`;
		return { code };
	}

	async pair(code: string, name: string) {
		const row = this.sql<{ expiresAt: number; used: number }>`SELECT expiresAt, used FROM pairing WHERE code = ${code}`[0];
		if (!row || row.used || row.expiresAt < Date.now()) return null;
		this.sql`UPDATE pairing SET used = 1 WHERE code = ${code}`;
		const deviceId = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
		this.sql`INSERT INTO device(deviceId, name, epoch) VALUES (${deviceId}, ${name}, 1)`;
		return { deviceId, token: await mintToken(this.env, deviceId, 1) };
	}

	async revoke(deviceId: string) {
		this.sql`UPDATE device SET epoch = epoch + 1, revoked = 1 WHERE deviceId = ${deviceId}`;
		for (const c of this.getConnections(`dev:${deviceId}`)) c.close(4403, "revoked");
		return { ok: true };
	}

	async enqueue(deviceId: string, kind: string, args: unknown, ackTimeoutSec = 15) {
		const cseq = (this.sql<{ m: number | null }>`SELECT MAX(cseq) AS m FROM outbox WHERE deviceId = ${deviceId}`[0]?.m ?? 0) + 1;
		const cmdId = crypto.randomUUID();
		this.sql`INSERT INTO outbox(cmdId, deviceId, cseq, kind, payload, state, ackTimeoutSec)
			VALUES (${cmdId}, ${deviceId}, ${cseq}, ${kind}, ${JSON.stringify(args ?? {})}, 'queued', ${ackTimeoutSec})`;
		this.deliver(cmdId);
		return { cmdId, cseq, state: this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${cmdId}`[0].state };
	}

	// Sends one outbox row if the device has a live connection; (re)arms the ack deadline via alarm.
	private deliver(cmdId: string) {
		const row = this.sql<{ deviceId: string; cseq: number; kind: string; payload: string; ackTimeoutSec: number; attempts: number }>
			`SELECT deviceId, cseq, kind, payload, ackTimeoutSec, attempts FROM outbox WHERE cmdId = ${cmdId}`[0];
		if (!row) return false;
		const conn = this.connFor(row.deviceId);
		if (!conn) return false;
		conn.send(JSON.stringify({ t: "cmd", id: cmdId, cseq: row.cseq, kind: row.kind, args: JSON.parse(row.payload) }));
		const now = Date.now();
		this.sql`UPDATE outbox SET state = 'sent', attempts = attempts + 1, sentAt = ${now}, ackDeadline = ${now + row.ackTimeoutSec * 1000} WHERE cmdId = ${cmdId}`;
		void this.schedule(row.ackTimeoutSec, "resendUnacked");
		return true;
	}

	// Alarm-driven: survives hibernation because the state lives in SQLite.
	async resendUnacked() {
		this.bump("alarmRuns");
		const due = this.sql<{ cmdId: string; attempts: number }>`SELECT cmdId, attempts FROM outbox WHERE state = 'sent' AND ackDeadline <= ${Date.now()}`;
		for (const r of due) {
			if (r.attempts >= 4) this.sql`UPDATE outbox SET state = 'failed' WHERE cmdId = ${r.cmdId}`;
			else this.deliver(r.cmdId);
		}
		// schedule() has whole-second resolution, so the alarm can fire slightly before a millisecond deadline.
		// Re-arm while anything is still waiting for an ack; otherwise a command would be stuck forever.
		const waiting = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent'`[0].n;
		if (waiting) void this.schedule(1, "resendUnacked");
	}

	private connFor(deviceId: string) {
		for (const c of this.getConnections(`dev:${deviceId}`)) return c;
		return undefined;
	}

	// ---- Agents SDK hooks ----

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
		const row = this.sql<{ epoch: number; revoked: number }>`SELECT epoch, revoked FROM device WHERE deviceId = ${p.deviceId}`[0];
		if (!row) return { ok: false as const, code: 4401, reason: "unknown device" };
		if (row.revoked || row.epoch !== p.epoch) return { ok: false as const, code: 4403, reason: "revoked" };
		return { ok: true as const, deviceId: p.deviceId };
	}

	async onConnect(connection: any, ctx: { request: Request }) {
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
			connection.send(JSON.stringify({ t: "error", code: "bad_request" }));
			return;
		}
		switch (m.t) {
			case "app_ping": {
				const wakes = this.sql<{ v: number }>`SELECT v FROM meta WHERE k = 'wakes'`[0]?.v ?? 0;
				connection.send(JSON.stringify({ t: "app_pong", re: m.id, instanceId: this.instanceId, wakes, now: Date.now() }));
				return;
			}
			case "hello": {
				this.sql`UPDATE device SET lastHello = ${JSON.stringify({ at: Date.now(), bootId: m.bootId, workers: m.workers })} WHERE deviceId = ${st.deviceId}`;
				const acks = Object.fromEntries(this.sql<{ workerId: string; upTo: number }>`SELECT workerId, upTo FROM worker_ack`.map((r) => [r.workerId, r.upTo]));
				connection.send(JSON.stringify({ t: "welcome", re: m.id, protocol: 1, serverTime: Date.now(), acks }));
				// redeliver everything not yet accepted
				const pending = this.sql<{ cmdId: string }>`SELECT cmdId FROM outbox WHERE deviceId = ${st.deviceId} AND state IN ('queued','sent') ORDER BY cseq`;
				for (const r of pending) this.deliver(r.cmdId);
				return;
			}
			case "cmd_ack": {
				if (m.status === "accepted") this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${m.re} AND state IN ('sent','queued')`;
				else if (m.status === "duplicate") this.sql`UPDATE outbox SET state = ${m.result ? (m.result.ok ? "done" : "failed") : "accepted"}, result = ${JSON.stringify(m.result ?? null)} WHERE cmdId = ${m.re}`;
				else if (m.status === "rejected") this.sql`UPDATE outbox SET state = 'failed', result = ${JSON.stringify({ code: m.code })} WHERE cmdId = ${m.re}`;
				return;
			}
			case "cmd_result": {
				this.sql`UPDATE outbox SET state = ${m.ok ? "done" : "failed"}, result = ${JSON.stringify(m.data ?? m.error ?? null)} WHERE cmdId = ${m.re}`;
				return;
			}
			case "events": {
				const touched = new Set<string>();
				for (const e of m.batch as Array<{ workerId: string; seq: number }>) {
					const before = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${e.workerId} AND seq = ${e.seq}`[0].n;
					if (before) this.bump("dupEvents");
					else this.sql`INSERT INTO event_inbox(workerId, seq, payload, receivedAt) VALUES (${e.workerId}, ${e.seq}, ${JSON.stringify(e)}, ${Date.now()})`;
					touched.add(e.workerId);
				}
				// Wake the steward: each report event becomes one idempotent submission (also for duplicates).
				for (const e of m.batch as Array<any>) {
					if (e.type !== "report") continue;
					const receipt = await this.harness.submit(`[worker ${e.workerId} reported ${e.status}] ${e.summary ?? ""}`, { operationId: `evt:${e.workerId}:${e.seq}`, whenBusy: "followUp" });
					this.bump(receipt.accepted ? "submitAccepted" : "submitDuplicate");
				}
				for (const workerId of touched) {
					this.sql`INSERT OR IGNORE INTO worker_ack(workerId, upTo) VALUES (${workerId}, 0)`;
					for (;;) {
						const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0].upTo;
						const next = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq = ${upTo + 1}`[0].n;
						if (!next) break;
						this.sql`UPDATE worker_ack SET upTo = ${upTo + 1} WHERE workerId = ${workerId}`;
					}
					const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0].upTo;
					connection.send(JSON.stringify({ t: "events_ack", workerId, upTo }));
					const gap = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq > ${upTo + 1}`[0].n;
					if (gap) connection.send(JSON.stringify({ t: "resync", workerId, from: upTo + 1 }));
				}
				return;
			}
			default:
				connection.send(JSON.stringify({ t: "error", re: m.id, code: "unsupported" }));
		}
	}
}

// ---- Worker entry --------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const stub = () => getAgentByName(env.Steward as any, "owner") as Promise<any>;
		const isAdmin = () => bearer(request) === env.ADMIN_TOKEN;

		if (url.pathname === "/pair" && request.method === "POST") {
			const body = (await request.json()) as { code: string; name: string };
			const res = await (await stub()).pair(body.code, body.name);
			return res ? json(res) : json({ error: "invalid code" }, 400);
		}
		if (url.pathname.startsWith("/admin/")) {
			if (!isAdmin()) return json({ error: "forbidden" }, 403);
			const s = await stub();
			if (url.pathname === "/admin/stats") return json(await s.stats());
			if (url.pathname === "/admin/dump") return json(await s.dump());
			if (url.pathname === "/admin/pairing") return json(await s.createPairing());
			if (url.pathname === "/admin/harness") return json(await s.harnessView());
			if (url.pathname === "/admin/crash") { try { await s.crash(); } catch {} return json({ ok: true }); }
			const body = request.method === "POST" ? ((await request.json()) as any) : {};
			if (url.pathname === "/admin/revoke") return json(await s.revoke(body.deviceId));
			if (url.pathname === "/admin/enqueue") return json(await s.enqueue(body.deviceId, body.kind, body.args, body.ackTimeoutSec));
			return json({ error: "not found" }, 404);
		}

		const routed = await routeAgentRequest(request, env as any, {
			// Stateless pre-check: bad tokens never wake the Durable Object.
			onBeforeConnect: async (req) => {
				const p = await parseToken(env, bearer(req));
				if (!p) return new Response("unauthorized", { status: 401 });
			},
		});
		return routed ?? new Response("not found", { status: 404 });
	},
};
