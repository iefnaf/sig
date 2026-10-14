// Spike tests against a running Worker. Usage: BASE_URL=http://127.0.0.1:8787 node tests.mjs [t1 t2 ...]
// Admin token is read from ADMIN_TOKEN or .dev.vars.
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { ConnectorSim, newDisk, proxyAgent } from "./sim.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
let ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
	try { ADMIN = readFileSync(new URL("./.dev.vars", import.meta.url), "utf8").match(/ADMIN_TOKEN=(.+)/)[1].trim(); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = async (path, body) => {
	const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	return res.json();
};
const pairDevice = async (name) => {
	const { code } = await admin("/admin/pairing", {});
	const res = await fetch(BASE + "/pair", { method: "POST", body: JSON.stringify({ code, name }) });
	return res.json();
};
const out = (label, value) => console.log(`  ${label}:`, typeof value === "string" ? value : JSON.stringify(value));
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); return ok; };

const tests = {
	async t1_auth() {
		console.log("T1 auth and pre-check (bad tokens must not wake the DO)");
		const dev = await pairDevice("t1");
		check("pairing issues a token", !!dev.token, dev.deviceId);
		const reuse = await fetch(BASE + "/pair", { method: "POST", body: JSON.stringify({ code: "ZZZZZ", name: "x" }) });
		check("invalid pairing code rejected", reuse.status === 400);
		const attempt = (headers) => new Promise((resolve) => {
			const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/agents/steward/owner?role=connector", { headers, agent: proxyAgent });
			ws.on("unexpected-response", (_q, res) => resolve({ http: res.statusCode }));
			ws.on("open", () => ws.on("close", (code) => resolve({ closed: code })));
			ws.on("error", (e) => resolve({ error: e.message }));
			setTimeout(() => resolve({ error: "timeout" }), 15000);
		});
		const tampered = dev.token.slice(0, -4) + (dev.token.endsWith("0000") ? "1111" : "0000");
		check("no token -> HTTP 401", (await attempt({})).http === 401);
		check("tampered token -> HTTP 401", (await attempt({ authorization: `Bearer ${tampered}` })).http === 401);
		// wake accounting: let the DO be evicted, read wakes, fire bad attempts, read again
		console.log("  waiting 20s for the DO to be evicted ...");
		await sleep(20000);
		const s1 = await admin("/admin/stats");
		await sleep(20000);
		for (let i = 0; i < 10; i++) await attempt({ authorization: `Bearer ${tampered}` });
		const s2 = await admin("/admin/stats");
		out("stats before", { instanceId: s1.instanceId, wakes: s1.wakes });
		out("stats after 10 bad attempts", { instanceId: s2.instanceId, wakes: s2.wakes });
		check("10 bad attempts did not wake the DO (only the stats call did)", s2.wakes - s1.wakes === 1, `delta ${s2.wakes - s1.wakes}`);
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token });
		const w = await sim.start();
		check("valid token -> hello/welcome", w.t === "welcome");
		sim.stop();
	},

	async t2_revoke_and_supersede() {
		console.log("T2 revoke, supersede, close codes reach the client");
		const dev = await pairDevice("t2");
		const a = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0 });
		await a.start();
		const b = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0 });
		await b.start();
		await sleep(500);
		check("older connection closed with 4409 superseded", a.closes.some((c) => c.code === 4409), JSON.stringify(a.closes));
		await admin("/admin/revoke", { deviceId: dev.deviceId });
		await sleep(500);
		check("live connection closed with 4403 on revoke", b.closes.some((c) => c.code === 4403), JSON.stringify(b.closes));
		const c = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0 });
		const rej = await c.start().then(() => "opened", (e) => e.message);
		check("reconnect with revoked token -> close 4403", rej === "closed 4403", rej);
	},

	async t3_redelivery() {
		console.log("T3 command redelivery: first ack+result dropped, alarm resends, connector dedupes");
		const dev = await pairDevice("t3");
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 5000, faults: { dropFirstCmdReplies: 1 } });
		await sim.start();
		const r = await admin("/admin/enqueue", { deviceId: dev.deviceId, kind: "start_worker", args: { events: 4 }, ackTimeoutSec: 5 });
		out("enqueued", r);
		for (let i = 0; i < 30; i++) {
			await sleep(1000);
			const row = (await admin("/admin/dump")).outbox.find((o) => o.cmdId === r.cmdId);
			if (row && row.state === "done") { out("outbox", row); break; }
		}
		const row = (await admin("/admin/dump")).outbox.find((o) => o.cmdId === r.cmdId);
		check("command ended in state done", row?.state === "done", JSON.stringify(row));
		check("DO resent at least once", row?.attempts >= 2, `attempts ${row?.attempts}`);
		check("connector executed exactly once", sim.disk.executions === 1, `executions ${sim.disk.executions}`);
		const st = await admin("/admin/stats");
		out("DO counters", st.counters);
		sim.stop();
	},

	async t4_replay() {
		console.log("T4 event replay: socket killed after first batch, no acks received, reconnect and replay");
		const dev = await pairDevice("t4");
		const disk = newDisk();
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, disk, pingMs: 0, faults: { killAfterFirstBatch: true } });
		await sim.start();
		const workerId = "w_replay_" + Date.now();
		sim.emit(workerId, Array.from({ length: 120 }, (_, i) => ({ type: "progress", n: i })));
		await sleep(6000);
		const dump = await admin("/admin/dump");
		const inbox = dump.inbox.find((i) => i.workerId === workerId);
		const ack = dump.acks.find((a) => a.workerId === workerId);
		out("inbox", inbox);
		out("ack", ack);
		check("all 120 events stored exactly once", inbox?.n === 120 && inbox.minSeq === 1 && inbox.maxSeq === 120);
		check("cumulative ack reached 120", ack?.upTo === 120);
		check("connector truncated its log after ack", (disk.workers[workerId]?.log.length ?? -1) === 0, `log ${disk.workers[workerId]?.log.length}`);
		const st = await admin("/admin/stats");
		out("duplicate events ignored by DO", st.counters.dupEvents ?? 0);
		sim.stop();
	},

	async t5_offline_queue() {
		console.log("T5 command queued while the device is offline is delivered on hello");
		const dev = await pairDevice("t5");
		const r = await admin("/admin/enqueue", { deviceId: dev.deviceId, kind: "start_worker", args: { events: 4 }, ackTimeoutSec: 10 });
		check("enqueue while offline stays queued", r.state === "queued", r.state);
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0 });
		await sim.start();
		await sleep(2500);
		const row = (await admin("/admin/dump")).outbox.find((o) => o.cmdId === r.cmdId);
		check("delivered after welcome and completed", row?.state === "done", JSON.stringify(row));
		check("executed once", sim.disk.executions === 1);
		sim.stop();
	},

	async t6_hibernation() {
		console.log("T6 hibernation: do protocol-level pings keep the DO awake? latency warm vs cold");
		const rtt = async (sim) => { const t = Date.now(); const p = await sim.request({ t: "app_ping" }); return { ms: Date.now() - t, instanceId: p.instanceId, wakes: p.wakes }; };
		for (const [label, pingMs] of [["with ws pings every 5s", 5000], ["no pings (control)", 0]]) {
			const dev = await pairDevice("t6");
			const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs });
			await sim.start();
			const warm1 = await rtt(sim);
			const warm2 = await rtt(sim);
			console.log(`  [${label}] idle 40s ...`);
			await sleep(40000);
			const cold = await rtt(sim);
			const after = await rtt(sim);
			out("warm", [warm1, warm2]);
			out("after idle", [cold, after]);
			check(`[${label}] DO was evicted during idle (instanceId changed)`, cold.instanceId !== warm2.instanceId, `${warm2.instanceId} -> ${cold.instanceId}`);
			check(`[${label}] connection survived hibernation`, sim.closes.length === 0, JSON.stringify(sim.closes));
			out(`[${label}] cold RTT ms vs warm`, `${cold.ms} vs ${after.ms}`);
			sim.stop();
		}
	},

	async t8_steward_wake() {
		console.log("T8 events wake the steward (PiHarness): wake, idempotency under retransmission, crash recovery");
		const dev = await pairDevice("t8");
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0 });
		await sim.start();
		const harnessView = () => admin("/admin/harness");
		const stamp = Date.now();

		// a) a report event wakes the steward, which answers
		const wA = `w_wake_${stamp}`;
		sim.emit(wA, [{ type: "progress" }, { type: "report", status: "done", summary: "login bug fixed" }, { type: "settled", outcome: "reported" }]);
		await sleep(8000);
		let v = await harnessView();
		const userA = v.messages.filter((m) => m.role === "user" && m.text.includes(wA));
		const asstA = v.messages.filter((m) => m.role === "assistant" && m.text.startsWith("Noted: [worker " + wA));
		check("report event produced one steward input", userA.length === 1, JSON.stringify(userA));
		check("steward answered", asstA.length === 1, JSON.stringify(asstA));

		// b) retransmitting the same batch twice does not create more inputs
		const wB = `w_dup_${stamp}`;
		const batch = [{ workerId: wB, seq: 1, type: "progress" }, { workerId: wB, seq: 2, type: "report", status: "done", summary: "dup test" }, { workerId: wB, seq: 3, type: "settled" }];
		sim.send({ t: "events", id: "dup1", batch });
		await sleep(500);
		sim.send({ t: "events", id: "dup2", batch });
		sim.send({ t: "events", id: "dup3", batch });
		await sleep(8000);
		v = await harnessView();
		const userB = v.messages.filter((m) => m.role === "user" && m.text.includes(wB));
		const st = await admin("/admin/stats");
		check("same report sent 3 times -> exactly one steward input", userB.length === 1, `inputs ${userB.length}`);
		out("counters", { accepted: st.counters.submitAccepted, duplicate: st.counters.submitDuplicate, dupEvents: st.counters.dupEvents });
		check("duplicates were detected by operationId (accepted=false)", (st.counters.submitDuplicate ?? 0) >= 2);

		// c) crash mid-run, then leave the DO alone: does the alarm restart it and finish the run?
		const wC = `w_slow_${stamp}`;
		sim.emit(wC, [{ type: "report", status: "done", summary: "SLOW run" }]);
		let running = false;
		for (let i = 0; i < 20 && !running; i++) { await sleep(500); const pv = await harnessView(); running = pv.pending.some((p) => p.status === "running"); }
		check("steward run is in progress before the crash", running);
		const before = await harnessView();
		await admin("/admin/crash", {});
		console.log("  crashed the DO mid-run; not touching it for 60s ...");
		await sleep(60000);
		const after = await harnessView();
		out("instance before/after", `${before.instanceId} -> ${after.instanceId}`);
		const finished = after.messages.find((m) => m.role === "assistant" && m.text.startsWith("word0 word1"));
		check("DO instance was reset", before.instanceId !== after.instanceId);
		check("run completed after the crash without any request from us (alarm woke the DO)", !!finished && after.pending.length === 0, JSON.stringify(after.pending));
		sim.stop();
	},

	async t7_alarm_after_hibernation() {
		console.log("T7 alarm-driven resend works when the DO hibernated in between (no pings, ack timeout 20s)");
		const dev = await pairDevice("t7");
		const sim = new ConnectorSim({ baseUrl: BASE, token: dev.token, pingMs: 0, faults: { dropFirstCmdReplies: 1 } });
		await sim.start();
		const before = await sim.request({ t: "app_ping" });
		const r = await admin("/admin/enqueue", { deviceId: dev.deviceId, kind: "start_worker", args: { events: 3 }, ackTimeoutSec: 20 });
		await sleep(30000);
		const after = await sim.request({ t: "app_ping" });
		const row = (await admin("/admin/dump")).outbox.find((o) => o.cmdId === r.cmdId);
		out("instance before/after", `${before.instanceId} -> ${after.instanceId}`);
		check("DO hibernated between send and alarm", before.instanceId !== after.instanceId);
		check("alarm resent and command completed", row?.state === "done" && row.attempts >= 2, JSON.stringify(row));
		check("executed once", sim.disk.executions === 1);
		sim.stop();
	},
};

const wanted = process.argv.slice(2);
const names = Object.keys(tests).filter((n) => !wanted.length || wanted.some((w) => n.startsWith(w)));
console.log(`BASE_URL=${BASE}\n`);
for (const n of names) {
	try { await tests[n](); } catch (e) { console.log("  ERROR", n, e.message); }
	console.log();
}
process.exit(0);
