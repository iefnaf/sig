// A local mock steward DO for connector tests: /pair issues a device token, the WS endpoint
// authenticates it, welcomes hello, lets the test inject start_worker commands, acks every
// event batch, and records everything per worker.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

export function startMockSteward() {
	const token = `st1.test.${randomUUID().slice(0, 8)}`;
	const deviceId = "dev_mock";
	const events = []; // all WorkerEvents, in arrival order
	const cmdResults = [];
	const waiters = []; // resolved when a matching event arrives
	let wss = null;
	let conn = null;
	let swallowAcks = false;
	let swallowAllFrames = false; // heartbeat test: never send anything after upgrade
	let upgrades = 0;
	let pings = 0;

	const server = createServer((req, res) => {
		if (req.url === "/pair" && req.method === "POST") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ deviceId, token }));
			});
			return;
		}
		res.writeHead(404);
		res.end("mock steward");
	});
	wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		upgrades++;
		if (!req.url.startsWith("/agents/steward/owner")) { socket.destroy(); return; }
		if (req.headers.authorization !== `Bearer ${token}`) { socket.write("HTTP/1.1 401\r\n\r\n"); socket.destroy(); return; }
		wss.handleUpgrade(req, socket, head, (ws) => {
			conn = ws;
			ws.on("message", (data) => {
				const m = JSON.parse(data.toString());
				if (m.t === "ping") { pings++; if (!swallowAllFrames) ws.send(JSON.stringify({ t: "pong", re: m.id })); }
				if (m.t === "hello" && !swallowAllFrames) ws.send(JSON.stringify({ t: "welcome", re: m.id, protocol: 1, serverTime: Date.now() }));
				if (m.t === "events") {
					for (const e of m.batch) {
						if (!swallowAcks) { /* record normally */ }
						events.push(e);
						for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(e)) waiters[i].resolve(e), waiters.splice(i, 1);
					}
					if (!swallowAllFrames && !swallowAcks) {
						const upTo = Math.max(...m.batch.map((e) => e.seq));
						ws.send(JSON.stringify({ t: "events_ack", workerId: m.batch[0].workerId, upTo }));
					}
				}
				if (m.t === "cmd_result") cmdResults.push(m);
			});
		});
	});

	const send = (o) => conn && conn.readyState === conn.OPEN && conn.send(JSON.stringify(o));
	const startWorker = (args) => { const id = randomUUID(); send({ t: "cmd", id, kind: "start_worker", args }); return id; };
	const sendCmd = (kind, args, id = randomUUID()) => { send({ t: "cmd", id, kind, args }); return id; };
	const waitFor = (pred, ms = 20000) => new Promise((resolve, reject) => {
		const hit = events.find(pred);
		if (hit) return resolve(hit);
		const w = { pred, resolve };
		waiters.push(w);
		setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("waitFor timeout")); } }, ms).unref();
	});

	const waitConnected = (ms) => new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => (conn && conn.readyState === conn.OPEN ? resolve() : Date.now() - t0 > ms ? reject(new Error("connector never connected")) : setTimeout(tick, 50));
		tick();
	});

	const dropConn = () => { try { conn?.close(); } catch {} conn = null; };

	return {
		server,
		waitConnected,
		set swallowAcks(v) { swallowAcks = v; },
		set swallowAllFrames(v) { swallowAllFrames = v; },
		dropConn,
		startWorker,
		sendCmd,
		waitFor,
		events: () => events,
		cmdResults: () => cmdResults,
		upgrades: () => upgrades,
		pings: () => pings,
		close: () => new Promise((done) => { try { conn?.close(); } catch {} wss.close(); server.close(() => done()); }),
		listen: () => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port))),
	};
}
