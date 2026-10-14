// Spike 2: remaining pi verification. Usage: node 02-abort-session-concurrency.mjs <e|f|g|h|i|j|l>
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = "/tmp/shepherd-spike-run2";
const EXT = new URL("./report-ext.ts", import.meta.url).pathname;

function startPi({ cwd, sessionDir, extra = [], ext = true, tag = "pi" }) {
	const args = ["--mode", "rpc", ...(sessionDir ? ["--session-dir", sessionDir] : ["--no-session"]), ...(ext ? ["--extension", EXT] : []), ...extra];
	const spawnedAt = Date.now();
	const child = spawn("pi", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	const events = [];
	const waiters = new Map();
	let buf = "";
	let bytes = 0;
	child.stdout.on("data", (chunk) => {
		bytes += chunk.length;
		buf += chunk.toString("utf8");
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).replace(/\r$/, "");
			buf = buf.slice(i + 1);
			if (!line) continue;
			let rec;
			try { rec = JSON.parse(line); } catch { continue; }
			if (rec.type === "response" && rec.id && waiters.has(rec.id)) { waiters.get(rec.id)(rec); waiters.delete(rec.id); continue; }
			events.push({ t: Date.now(), rec });
		}
	});
	let stderr = "";
	child.stderr.on("data", (c) => (stderr += c.toString()));
	let exit = null;
	child.on("exit", (code, sig) => { exit = { code, sig, t: Date.now() }; });
	let n = 0;
	const send = (cmd, ms = 30000) => new Promise((resolve, reject) => {
		const id = `${tag}${++n}`;
		waiters.set(id, resolve);
		child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); reject(new Error(`timeout ${cmd.type}; stderr=${stderr.slice(-300)}`)); } }, ms);
	});
	const waitFor = (pred, ms = 120000) => new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			const hit = events.find((e) => pred(e.rec));
			if (hit) return resolve(hit);
			if (Date.now() - start > ms) return reject(new Error("waitFor timeout; stderr=" + stderr.slice(-300)));
			setTimeout(tick, 50);
		};
		tick();
	});
	const settledCount = () => events.filter((e) => e.rec.type === "agent_settled").length;
	const waitSettled = async (from = 0, ms = 180000) => {
		const start = Date.now();
		while (settledCount() <= from) {
			if (Date.now() - start > ms) throw new Error("settle timeout");
			await new Promise((r) => setTimeout(r, 50));
		}
	};
	return { child, events, send, waitFor, waitSettled, settledCount, stderr: () => stderr, spawnedAt, bytes: () => bytes, exit: () => exit };
}

const fresh = (name) => {
	const base = join(ROOT, name);
	rmSync(base, { recursive: true, force: true });
	const cwd = join(base, "work"); const sessionDir = join(base, "sessions");
	mkdirSync(cwd, { recursive: true }); mkdirSync(sessionDir, { recursive: true });
	return { cwd, sessionDir, base };
};
const files = (cwd) => readdirSync(cwd).filter((f) => !f.startsWith("."));
const stop = (p) => { try { p.child.stdin.end(); } catch {} setTimeout(() => p.child.kill("SIGKILL"), 3000); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sh = (c) => { try { return execSync(c, { encoding: "utf8" }).trim(); } catch { return ""; } };
const counts = (p) => Object.entries(p.events.reduce((m, e) => ((m[e.rec.type] = (m[e.rec.type] || 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(" ");

const exp = process.argv[2];

if (exp === "e") {
	console.log("EXP E: abort during a long tool, then continue in the same process");
	const d = fresh("e");
	const p = startPi(d);
	await p.send({ type: "prompt", message: "Run the bash command `sleep 25` first. Then create e.txt containing E. Then call report with status done." });
	await p.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash");
	console.log("  sleep running:", sh("pgrep -f 'sleep 25' | wc -l").trim());
	const t0 = Date.now();
	const ab = await p.send({ type: "abort" }, 60000);
	console.log("  abort response:", JSON.stringify(ab.success), `${Date.now() - t0}ms`);
	await p.waitFor((r) => r.type === "agent_settled");
	const settled = p.events.find((e) => e.rec.type === "agent_settled").rec;
	console.log("  settled:", JSON.stringify(settled));
	console.log("  sleep still running after abort:", sh("pgrep -f 'sleep 25' | wc -l").trim());
	const st = await p.send({ type: "get_state" });
	console.log("  isStreaming:", st.data.isStreaming, "messageCount:", st.data.messageCount);
	const from = p.settledCount();
	await p.send({ type: "prompt", message: "Create e.txt containing E, then call report with status done." });
	await p.waitSettled(from);
	console.log("  files after continue:", files(d.cwd));
	stop(p);
} else if (exp === "f") {
	console.log("EXP F: new_session / switch_session / fork / get_entries shapes");
	const d = fresh("f");
	const p = startPi(d);
	await p.send({ type: "prompt", message: "Create f1.txt containing one. Then call report status done." });
	await p.waitSettled(0);
	const s1 = (await p.send({ type: "get_state" })).data;
	console.log("  session1:", s1.sessionId, "msgs", s1.messageCount);
	const ns = await p.send({ type: "new_session" });
	const s2 = (await p.send({ type: "get_state" })).data;
	console.log("  new_session:", JSON.stringify(ns.data), "->", s2.sessionId, "msgs", s2.messageCount, "same file?", s2.sessionFile === s1.sessionFile);
	const sw = await p.send({ type: "switch_session", sessionPath: s1.sessionFile });
	const s3 = (await p.send({ type: "get_state" })).data;
	console.log("  switch_session back:", JSON.stringify(sw.data), "->", s3.sessionId === s1.sessionId, "msgs", s3.messageCount);
	const ent = await p.send({ type: "get_entries" });
	const arr = ent.data?.entries ?? ent.data;
	console.log("  get_entries: keys", Object.keys(ent.data ?? {}), "count", Array.isArray(arr) ? arr.length : "?", "bytes", JSON.stringify(ent).length);
	console.log("  entry types:", Array.isArray(arr) ? [...new Set(arr.map((e) => e.type))].join(",") : "?");
	const lim = await p.send({ type: "get_entries", limit: 2 }).catch((e) => ({ error: String(e) }));
	console.log("  get_entries with limit:2 ->", lim.success === false ? "error " + lim.error : "count " + (lim.data?.entries ?? lim.data ?? []).length);
	const tree = await p.send({ type: "get_tree" });
	console.log("  get_tree bytes", JSON.stringify(tree).length);
	const fm = await p.send({ type: "get_fork_messages" });
	console.log("  fork_messages:", JSON.stringify(fm.data).slice(0, 200));
	const first = (fm.data?.messages ?? fm.data ?? [])[0];
	if (first?.entryId) {
		const fk = await p.send({ type: "fork", entryId: first.entryId });
		const s4 = (await p.send({ type: "get_state" })).data;
		console.log("  fork:", JSON.stringify(fk.data).slice(0, 120), "-> new session?", s4.sessionId !== s1.sessionId);
	}
	console.log("  session files:", readdirSync(d.sessionDir).length);
	stop(p);
} else if (exp === "g") {
	console.log("EXP G: 5 concurrent pi processes sharing one session dir; startup and RSS");
	const base = fresh("g");
	const ps = [];
	for (let i = 0; i < 5; i++) {
		const cwd = join(base.base, `work${i}`); mkdirSync(cwd, { recursive: true });
		ps.push(startPi({ cwd, sessionDir: base.sessionDir, tag: `p${i}_` }));
	}
	const ready = await Promise.all(ps.map(async (p) => { await p.send({ type: "get_state" }); return Date.now() - p.spawnedAt; }));
	console.log("  time to first get_state (ms):", ready.join(", "));
	await new Promise((r) => setTimeout(r, 1500));
	const rss = ps.map((p) => Math.round(Number(sh(`ps -o rss= -p ${p.child.pid}`)) / 1024));
	console.log("  idle RSS (MB):", rss.join(", "));
	await Promise.all(ps.map((p, i) => p.send({ type: "prompt", message: `Create g${i}.txt containing ${i}. Then call report status done.` })));
	await Promise.all(ps.map((p) => p.waitSettled(0)));
	console.log("  all settled; files:", ps.map((_, i) => existsSync(join(base.base, `work${i}`, `g${i}.txt`))).join(","));
	console.log("  session files in shared dir:", sh(`find ${base.sessionDir} -name '*.jsonl' | wc -l`));
	const rss2 = ps.map((p) => Math.round(Number(sh(`ps -o rss= -p ${p.child.pid}`)) / 1024));
	console.log("  RSS after run (MB):", rss2.join(", "));
	ps.forEach(stop);
} else if (exp === "h-holder") {
	// helper: acts as a "connector" that dies. prints pi pid
	const d = { cwd: process.argv[3], sessionDir: process.argv[4] };
	const p = startPi(d);
	console.log("PI_PID=" + p.child.pid);
	await p.send({ type: "prompt", message: "Run the bash command `sleep 31` and then say done." });
	await p.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash");
	console.log("TOOL_RUNNING");
	await new Promise((r) => setTimeout(r, 600000));
} else if (exp === "h") {
	console.log("EXP H: what happens to pi and its tool processes when the connector is SIGKILLed");
	const d = fresh("h");
	const holder = spawn("node", [new URL(import.meta.url).pathname, "h-holder", d.cwd, d.sessionDir], { stdio: ["ignore", "pipe", "inherit"] });
	let piPid = 0, running = false;
	holder.stdout.on("data", (c) => { for (const l of c.toString().split("\n")) { if (l.startsWith("PI_PID=")) piPid = Number(l.slice(7)); if (l === "TOOL_RUNNING") running = true; } });
	while (!running) await new Promise((r) => setTimeout(r, 100));
	console.log("  pi pid", piPid, "alive:", alive(piPid), "sleep procs:", sh("pgrep -f 'sleep 31' | wc -l").trim());
	holder.kill("SIGKILL");
	for (const secs of [2, 8, 20, 36]) {
		await new Promise((r) => setTimeout(r, (secs - (secs === 2 ? 0 : [2, 8, 20, 36][[2, 8, 20, 36].indexOf(secs) - 1])) * 1000));
		console.log(`  +${secs}s after connector SIGKILL: pi alive=${alive(piPid)} sleep procs=${sh("pgrep -f 'sleep 31' | wc -l").trim()}`);
	}
	try { process.kill(piPid, "SIGKILL"); } catch {}
	sh("pkill -f 'sleep 31'");
} else if (exp === "i") {
	console.log("EXP I: report reliability (4 runs) and the no-report fallback");
	const results = [];
	for (let i = 0; i < 4; i++) {
		const d = fresh(`i${i}`);
		const p = startPi(d);
		await p.send({ type: "prompt", message: ["Create notes.txt with one line about the sky.", "Add a file todo.txt listing two chores.", "Create a.txt with the text alpha and b.txt with the text beta.", "Write hello.py that prints hi."][i] });
		await p.waitSettled(0);
		const reports = p.events.filter((e) => e.rec.type === "tool_execution_start" && e.rec.toolName === "report");
		results.push({ run: i, reportCalls: reports.length, status: reports[0]?.rec.args?.status, bytes: p.bytes(), counts: counts(p) });
		stop(p);
	}
	for (const r of results) console.log("  ", JSON.stringify(r));
	console.log("  -- fallback: no extension, plain-text question");
	const d = fresh("i-fallback");
	const p = startPi({ ...d, ext: false });
	await p.send({ type: "prompt", message: "I want to add authentication. Ask me exactly one clarifying question and wait for my answer. Do not use tools." });
	await p.waitSettled(0);
	const last = await p.send({ type: "get_last_assistant_text" });
	console.log("  settled:", JSON.stringify(p.events.find((e) => e.rec.type === "agent_settled").rec), "tools:", p.events.filter((e) => e.rec.type === "tool_execution_start").length);
	console.log("  last text:", JSON.stringify(last.data).slice(0, 240));
	stop(p);
} else if (exp === "j") {
	console.log("EXP J: image input over RPC");
	const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const b of buf) r = t[(r ^ b) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
	const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
	const w = 256, h = 256; const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; } }
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
	const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
	const d = fresh("j");
	const p = startPi({ ...d, ext: false });
	const r = await p.send({ type: "prompt", message: "What single color fills this image? Answer with one word.", images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] });
	console.log("  prompt response:", JSON.stringify(r.success ? r.data : r));
	await p.waitSettled(0);
	const last = await p.send({ type: "get_last_assistant_text" });
	console.log("  answer:", JSON.stringify(last.data).slice(0, 200));
	const st = (await p.send({ type: "get_state" })).data;
	console.log("  model supports images?", JSON.stringify(st.model?.input ?? st.model?.inputs ?? st.model?.modalities ?? "n/a"));
	stop(p);
} else if (exp === "l") {
	console.log("EXP L: project-local extension and context in an untrusted dir, headless");
	const d = fresh("l");
	const marker = join(d.base, "EXT_LOADED");
	mkdirSync(join(d.cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(d.cwd, ".pi", "extensions", "probe.ts"), `import { writeFileSync } from "node:fs";\nexport default function (pi: any) { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`);
	writeFileSync(join(d.cwd, "AGENTS.md"), "Always end every answer with the word PINEAPPLE.\n");
	for (const mode of ["default", "--no-approve", "--approve"]) {
		rmSync(marker, { force: true });
		const p = startPi({ ...d, extra: mode === "default" ? [] : [mode] });
		const from = 0;
		await p.send({ type: "prompt", message: "Say hello in five words." });
		await p.waitFor((r) => r.type === "agent_settled", 60000).catch(() => {});
		const last = await p.send({ type: "get_last_assistant_text" }).catch(() => ({ data: {} }));
		const ui = p.events.filter((e) => String(e.rec.type).startsWith("extension_ui")).map((e) => e.rec.method ?? e.rec.type);
		console.log(`  [${mode}] project extension executed: ${existsSync(marker)} | AGENTS.md honored: ${/PINEAPPLE/i.test(JSON.stringify(last.data))} | ui requests: ${JSON.stringify(ui)}`);
		stop(p);
		await new Promise((r) => setTimeout(r, 500));
	}
} else if (exp === "k") {
	console.log("EXP K: pi itself SIGKILLed mid-tool; do its tool processes survive?");
	const d = fresh("k");
	const p = startPi(d);
	await p.send({ type: "prompt", message: "Run the bash command `sleep 33` and then say done." });
	await p.waitFor((r) => r.type === "tool_execution_start" && r.toolName === "bash");
	console.log("  pi alive:", alive(p.child.pid), "sleep procs:", sh("pgrep -f 'sleep 33' | wc -l").trim());
	p.child.kill("SIGKILL");
	for (const secs of [2, 6]) {
		await new Promise((r) => setTimeout(r, secs === 2 ? 2000 : 4000));
		console.log(`  +${secs}s after pi SIGKILL: pi alive=${alive(p.child.pid)} sleep procs=${sh("pgrep -f 'sleep 33' | wc -l").trim()}`);
	}
	sh("pkill -f 'sleep 33'");
} else if (exp === "m") {
	console.log("EXP M: read-only mode via --tools allowlist");
	const d = fresh("m");
	const p = startPi({ ...d, ext: true, extra: ["--tools", "read,grep,find,ls,report"] });
	await p.send({ type: "prompt", message: "Create a file named x.txt containing X. Use any tool you have. If you cannot create files, say so plainly and then call report with status blocked." });
	await p.waitSettled(0);
	const used = [...new Set(p.events.filter((e) => e.rec.type === "tool_execution_start").map((e) => e.rec.toolName))];
	console.log("  tools used:", used, "| x.txt created:", files(d.cwd).includes("x.txt"));
	const last = await p.send({ type: "get_last_assistant_text" });
	console.log("  last text:", JSON.stringify(last.data).slice(0, 200));
	stop(p);
} else {
	console.log("usage: node 02-abort-session-concurrency.mjs <e|f|g|h|i|j|k|l|m>");
}
if (exp !== "h-holder") setTimeout(() => process.exit(0), 4000);
