// Simulated connector for the e2e spike: pairs, keeps the WS open, and when a start_worker
// command arrives it simulates a pi worker (started -> progress -> report -> settled).
// Usage: node sim-connector.mjs <BASE_URL> <pairingCode> [machineName]
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const [BASE, code, name = "mac-studio-sim"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pair = await fetch(`${BASE}/pair`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ code, name }),
}).then((r) => r.json());
if (!pair.deviceId) throw new Error(`pair failed: ${JSON.stringify(pair)}`);
console.log("paired:", pair.deviceId);

const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/agents/steward/owner?role=connector&proto=1", {
	headers: { authorization: `Bearer ${pair.token}` },
	handshakeTimeout: 8000,
});
const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
const workers = new Map(); // workerId -> { seq }
let helloId = randomUUID();

ws.on("open", () => {
	console.log("ws open, saying hello");
	send({ t: "hello", id: helloId, bootId: randomUUID().slice(0, 8), protocol: { min: 1, max: 1 }, workers: [] });
});
ws.on("message", (data) => {
	const m = JSON.parse(data.toString());
	if (m.t === "cmd" && m.kind === "start_worker") return onCommand(m);
	if (m.t === "events_ack") console.log(`ack ${m.workerId} upTo ${m.upTo}`);
});
ws.on("close", (c, r) => { console.log("closed", c, r.toString()); process.exit(1); });

async function onCommand(m) {
	console.log(`cmd ${m.kind} -> worker ${m.args.workerId}: ${m.args.prompt}`);
	send({ t: "cmd_ack", re: m.id, status: "accepted" });
	send({ t: "cmd_result", re: m.id, ok: true, data: { workerId: m.args.workerId } });
	const workerId = m.args.workerId;
	const w = { seq: 0 };
	workers.set(workerId, w);
	const emit = (obj) => { w.seq++; send({ t: "events", id: randomUUID(), batch: [{ workerId, seq: w.seq, ts: Date.now(), ...obj }] }); };

	await sleep(800);
	emit({ type: "started", branch: "shepherd/sim-1" });
	await sleep(700);
	emit({ type: "progress", tool: "read", target: "auth/session.ts", turn: 1 });
	await sleep(700);
	emit({ type: "progress", tool: "edit", target: "auth/session.ts", turn: 2 });
	await sleep(600);
	emit({
		type: "report", status: "done",
		summary: `已完成：${m.args.prompt}`,
		changes: ["auth/session.ts: 修改了刷新逻辑（模拟）", "auth/session.test.ts: 新增用例（模拟）"],
		decisions: ["沿用 session 方案（模拟）"],
		tests: { ran: true, passed: true },
		git: { branch: "shepherd/sim-1", ahead: 2, dirty: 0, pushed: false },
	});
	emit({ type: "settled", outcome: "reported" });
	console.log("done, events emitted");
}

console.log("connector running (Ctrl-C to stop)");
setInterval(() => { try { ws.ping(); } catch {} }, 25000);
