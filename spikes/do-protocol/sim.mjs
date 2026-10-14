// Simulated connector for the DO protocol spike. `disk` is a plain object standing in for LocalStore:
// pass the same object to a new instance to simulate a connector restart that keeps its files.
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { randomUUID } from "node:crypto";

export const proxyAgent = process.env.WS_PROXY ? new HttpsProxyAgent(process.env.WS_PROXY) : undefined;

const NO_RECONNECT = new Set([4401, 4403, 4409, 4426]);

export const newDisk = () => ({ connEpoch: 0, cmds: {}, executions: 0, workers: {} });

export class ConnectorSim {
	constructor({ baseUrl, token, disk = newDisk(), pingMs = 25000, faults = {}, quiet = true }) {
		Object.assign(this, { baseUrl, token, disk, pingMs, faults, quiet });
		this.bootId = randomUUID().slice(0, 8);
		this.ws = null;
		this.stopped = false;
		this.closes = [];
		this.log = [];
		this.pending = new Map();
		this.queue = [];
		this.flushTimer = null;
		this.sentBatches = 0;
		this.opened = null; // resolves on welcome
		this.dropCmdRepliesLeft = faults.dropFirstCmdReplies ?? 0;
	}

	wsUrl() {
		return this.baseUrl.replace(/^http/, "ws") + `/agents/steward/owner?role=connector&proto=1&connEpoch=${this.disk.connEpoch}`;
	}

	say(...a) {
		this.log.push(a.join(" "));
		if (!this.quiet) console.log("   [sim]", ...a);
	}

	start() {
		this.stopped = false;
		return new Promise((resolve, reject) => {
			this.opened = { resolve, reject };
			this.connect();
		});
	}

	connect() {
		this.disk.connEpoch++;
		const ws = new WebSocket(this.wsUrl(), { headers: { authorization: `Bearer ${this.token}` }, agent: proxyAgent });
		this.ws = ws;
		let pinger = null;
		ws.on("open", () => {
			this.send({
				t: "hello", id: randomUUID(), bootId: this.bootId, protocol: { min: 1, max: 1 },
				workers: Object.entries(this.disk.workers).map(([workerId, w]) => ({ workerId, lastSeq: w.seq })),
			});
			if (this.pingMs) pinger = setInterval(() => { try { ws.ping(); } catch {} }, this.pingMs);
		});
		ws.on("message", (data) => this.onMessage(JSON.parse(data.toString())));
		ws.on("unexpected-response", (_req, res) => {
			this.closes.push({ http: res.statusCode });
			this.opened?.reject(new Error(`http ${res.statusCode}`));
			this.opened = null;
			this.stopped = true;
		});
		ws.on("error", () => {});
		ws.on("close", (code, reason) => {
			clearInterval(pinger);
			this.queue = []; // unsent events stay in the on-disk log and are replayed after reconnect
			this.closes.push({ code, reason: reason.toString() });
			this.say("closed", code, reason.toString());
			if (this.opened && NO_RECONNECT.has(code)) { this.opened.reject(new Error(`closed ${code}`)); this.opened = null; }
			if (this.stopped || NO_RECONNECT.has(code)) return;
			setTimeout(() => this.connect(), 300);
		});
	}

	stop() {
		this.stopped = true;
		try { this.ws?.close(1000); } catch {}
	}

	crash() {
		this.stopped = true;
		try { this.ws?.terminate(); } catch {}
	}

	send(obj) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
	}

	request(obj, timeoutMs = 20000) {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			this.pending.set(id, resolve);
			this.send({ ...obj, id });
			setTimeout(() => { if (this.pending.delete(id)) reject(new Error("request timeout " + obj.t)); }, timeoutMs);
		});
	}

	// ---- events ----

	emit(workerId, events) {
		const w = (this.disk.workers[workerId] ??= { seq: 0, log: [], acked: 0 });
		for (const e of events) {
			w.seq++;
			const ev = { workerId, seq: w.seq, ts: Date.now(), ...e };
			w.log.push(ev);
			this.queue.push(ev);
		}
		this.scheduleFlush();
	}

	scheduleFlush() {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			const batch = this.queue.splice(0, 50);
			if (batch.length) {
				this.send({ t: "events", id: randomUUID(), batch });
				this.sentBatches++;
				if (this.faults.killAfterFirstBatch && this.sentBatches === 1) { this.say("fault: killing socket after first batch"); this.ws.terminate(); return; }
			}
			if (this.queue.length) this.scheduleFlush();
		}, 250);
	}

	replayFrom(acks) {
		for (const [workerId, w] of Object.entries(this.disk.workers)) {
			const from = (acks[workerId] ?? 0) + 1;
			w.acked = Math.max(w.acked, from - 1);
			w.log = w.log.filter((e) => e.seq >= from); // welcome.acks acts as a cumulative ack
			const missing = w.log.filter((e) => e.seq >= from);
			this.queue = this.queue.filter((e) => e.workerId !== workerId).concat(missing);
			if (missing.length) this.say("replay", workerId, "from", from, "count", missing.length);
		}
		this.scheduleFlush();
	}

	// ---- inbound ----

	onMessage(m) {
		if (m.re && this.pending.has(m.re)) { this.pending.get(m.re)(m); this.pending.delete(m.re); }
		switch (m.t) {
			case "welcome":
				this.replayFrom(m.acks ?? {});
				this.opened?.resolve(m);
				this.opened = null;
				break;
			case "events_ack": {
				const w = this.disk.workers[m.workerId];
				if (w) { w.acked = Math.max(w.acked, m.upTo); w.log = w.log.filter((e) => e.seq > m.upTo); }
				break;
			}
			case "resync": {
				const w = this.disk.workers[m.workerId];
				if (w) { this.queue.push(...w.log.filter((e) => e.seq >= m.from)); this.scheduleFlush(); }
				break;
			}
			case "cmd":
				this.onCmd(m);
				break;
		}
	}

	onCmd(m) {
		const known = this.disk.cmds[m.id];
		if (known) {
			this.say("duplicate cmd", m.id.slice(0, 8));
			this.send({ t: "cmd_ack", re: m.id, status: "duplicate", result: known.result });
			return;
		}
		const rec = (this.disk.cmds[m.id] = { state: "accepted", result: null, kind: m.kind });
		this.disk.executions++;
		const workerId = `w_${m.id.slice(0, 8)}`;
		const dropReplies = this.dropCmdRepliesLeft > 0;
		if (dropReplies) { this.dropCmdRepliesLeft--; this.say("fault: dropping ack+result for", m.id.slice(0, 8)); }
		else this.send({ t: "cmd_ack", re: m.id, status: "accepted" });
		setTimeout(() => {
			rec.state = "done";
			rec.result = { ok: true, data: { workerId } };
			if (!dropReplies) this.send({ t: "cmd_result", re: m.id, ok: true, data: { workerId } });
			if (m.kind === "start_worker") {
				const n = m.args?.events ?? 4;
				const evs = [];
				for (let i = 0; i < n - 2; i++) evs.push({ type: "progress", phase: "tool", tool: "edit", turn: i });
				evs.push({ type: "report", status: "done", summary: "spike done" });
				evs.push({ type: "settled", outcome: "reported" });
				this.emit(workerId, evs);
			}
		}, 200);
	}
}
