// Spike: drive `pi --mode rpc` the way a Shepherd connector would. Usage: node 01-basic-steer-resume.mjs <a|b|c|d>
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/shepherd-spike-run";
const EXT = new URL("./report-ext.ts", import.meta.url).pathname;
const MODEL = [];

function startPi({ cwd, sessionDir, extra = [] }) {
	const args = ["--mode", "rpc", "--session-dir", sessionDir, ...MODEL, "--extension", EXT, ...extra];
	const child = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	const waiters = new Map();
	let buf = "";
	child.stdout.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (!line) continue;
			let rec;
			try { rec = JSON.parse(line); } catch { console.log("  [unparsable]", line.slice(0, 120)); continue; }
			if (rec.type === "response" && rec.id && waiters.has(rec.id)) { waiters.get(rec.id)(rec); waiters.delete(rec.id); continue; }
			events.push({ t: Date.now(), rec });
			note(rec);
		}
	});
	let stderr = "";
	child.stderr.on("data", (c) => (stderr += c.toString()));
	let n = 0;
	const send = (cmd) => new Promise((resolve, reject) => {
		const id = `r${++n}`;
		waiters.set(id, resolve);
		child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`timeout ${cmd.type}`)); } }, 30000);
	});
	const waitFor = (pred, ms = 120000) => new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			const hit = events.find((e) => pred(e.rec));
			if (hit) return resolve(hit.rec);
			if (Date.now() - start > ms) return reject(new Error("waitFor timeout; stderr=" + stderr.slice(-400)));
			setTimeout(tick, 100);
		};
		tick();
	});
	return { child, events, send, waitFor, stderr: () => stderr };
}

function note(rec) {
	const brief = {
		agent_start: "agent_start", agent_end: "agent_end", agent_settled: `agent_settled aborted=${rec.aborted}`,
		turn_start: "turn_start", turn_end: "turn_end",
		tool_execution_start: `tool_start ${rec.toolName} ${JSON.stringify(rec.args ?? {}).slice(0, 90)}`,
		tool_execution_end: `tool_end ${rec.toolName}`,
	}[rec.type];
	if (brief) console.log("  ·", brief);
	else if (rec.type && !["message_update", "message_start", "message_end", "tool_execution_update"].includes(rec.type)) console.log("  ·", rec.type);
}

const fresh = (name) => {
	const base = join(ROOT, name);
	rmSync(base, { recursive: true, force: true });
	const cwd = join(base, "work"); const sessionDir = join(base, "sessions");
	mkdirSync(cwd, { recursive: true }); mkdirSync(sessionDir, { recursive: true });
	return { cwd, sessionDir };
};
const files = (cwd) => readdirSync(cwd).filter((f) => !f.startsWith("."));
const stop = (p) => { try { p.child.stdin.end(); } catch {} setTimeout(() => p.child.kill("SIGKILL"), 3000); };

const exp = process.argv[2];

if (exp === "a") {
	console.log("EXP A: basic run, report tool, state, stats");
	const dirs = fresh("a");
	const p = startPi({ ...dirs });
	const r = await p.send({ type: "prompt", message: "Create a file hello.txt containing the text hi using your tools. When done, call the report tool with status done, a one-line summary and the changes list." });
	console.log("  prompt response:", JSON.stringify(r.data ?? r));
	await p.waitFor((e) => e.type === "agent_settled");
	console.log("  files:", files(dirs.cwd));
	const reportCalls = p.events.filter((e) => e.rec.type === "tool_execution_start" && e.rec.toolName === "report");
	console.log("  report calls:", reportCalls.length, JSON.stringify(reportCalls[0]?.rec.args));
	const st = await p.send({ type: "get_state" });
	console.log("  state:", JSON.stringify({ sessionFile: st.data?.sessionFile, sessionId: st.data?.sessionId, isStreaming: st.data?.isStreaming, messageCount: st.data?.messageCount }));
	const stats = await p.send({ type: "get_session_stats" });
	console.log("  stats:", JSON.stringify(stats.data).slice(0, 300));
	const last = await p.send({ type: "get_last_assistant_text" });
	console.log("  last text:", JSON.stringify(last.data).slice(0, 200));
	stop(p);
} else if (exp === "b") {
	console.log("EXP B: steer vs follow_up during a long tool call");
	const dirs = fresh("b");
	const p = startPi({ ...dirs });
	await p.send({ type: "prompt", message: "Run the bash command `sleep 8` first. After it finishes, create a.txt containing A. Then call the report tool with status done." });
	await p.waitFor((e) => e.type === "tool_execution_start" && e.toolName === "bash");
	const t0 = Date.now();
	const s = await p.send({ type: "steer", message: "Change of plan: create b.txt containing B instead of a.txt. Do not create a.txt." });
	console.log("  steer response:", JSON.stringify(s.data ?? s), `+${Date.now() - t0}ms after bash start`);
	const f = await p.send({ type: "follow_up", message: "After everything is done, also create c.txt containing C." });
	console.log("  follow_up response:", JSON.stringify(f.data ?? f));
	await p.waitFor((e) => e.type === "agent_settled", 180000);
	console.log("  files:", files(dirs.cwd));
	for (const f2 of files(dirs.cwd)) console.log("   ", f2, "=", JSON.stringify(readFileSync(join(dirs.cwd, f2), "utf8").trim()));
	stop(p);
} else if (exp === "c") {
	console.log("EXP C: kill the process mid-tool, then resume the session file in a new process");
	const dirs = fresh("c");
	const p1 = startPi({ ...dirs });
	await p1.send({ type: "prompt", message: "Run the bash command `sleep 20` first. Then create c.txt containing C. Then call the report tool with status done." });
	await p1.waitFor((e) => e.type === "tool_execution_start" && e.toolName === "bash");
	const st = await p1.send({ type: "get_state" });
	const sessionFile = st.data?.sessionFile;
	console.log("  sessionFile:", sessionFile, "exists:", existsSync(sessionFile ?? ""));
	p1.child.kill("SIGKILL");
	console.log("  killed pi mid-tool; files:", files(dirs.cwd));
	await new Promise((r) => setTimeout(r, 1000));
	const p2 = startPi({ ...dirs, extra: ["--session", sessionFile] });
	const st2 = await p2.send({ type: "get_state" });
	console.log("  resumed state:", JSON.stringify({ sessionId: st2.data?.sessionId, messageCount: st2.data?.messageCount, isStreaming: st2.data?.isStreaming }));
	const msgs = await p2.send({ type: "get_messages" });
	const list = msgs.data?.messages ?? [];
	console.log("  messages after resume:", list.map((m) => m.role + (Array.isArray(m.content) ? ":" + m.content.map((c) => c.type).join("+") : "")).join(" | "));
	await p2.send({ type: "prompt", message: "You were interrupted. Check what is done and finish the remaining work, then call the report tool." });
	await p2.waitFor((e) => e.type === "agent_settled", 180000);
	console.log("  files after continue:", files(dirs.cwd));
	stop(p2);
} else if (exp === "d") {
	console.log("EXP D: a question with no report tool call (what does the protocol show?)");
	const dirs = fresh("d");
	const p = startPi({ ...dirs });
	await p.send({ type: "prompt", message: "I want to add authentication to this project. Ask me one clarifying question before doing anything. Do not use any tools." });
	await p.waitFor((e) => e.type === "agent_settled");
	const last = await p.send({ type: "get_last_assistant_text" });
	console.log("  last text:", JSON.stringify(last.data).slice(0, 300));
	console.log("  tool calls:", p.events.filter((e) => e.rec.type === "tool_execution_start").length);
	stop(p);
} else {
	console.log("usage: node spike.mjs <a|b|c|d>");
}
setTimeout(() => process.exit(0), 4000);
