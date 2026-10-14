// Spike 3: does agent_before_settle enforcement get a report out of every run?  Usage: node 03-report-enforcement.mjs <enforced|plain> [runs]
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "enforced";
const RUNS = Number(process.argv[3] ?? 6);
const EXT = new URL(mode === "enforced" ? "./report-ext-enforced.ts" : "./report-ext.ts", import.meta.url).pathname;
const PROMPTS = [
	"Add a file todo.txt listing two chores.",
	"Create notes.txt with one line about the sky.",
	"Write hello.py that prints hi.",
	"Create a.txt with the text alpha and b.txt with the text beta.",
	"Make a file named list.txt with three fruit names, one per line.",
	"Create readme.md with a one-line title.",
];

function run(i) {
	return new Promise(async (resolve) => {
		const base = `/tmp/shepherd-spike-run3/${mode}-${i}`;
		rmSync(base, { recursive: true, force: true });
		mkdirSync(join(base, "work"), { recursive: true }); mkdirSync(join(base, "sessions"), { recursive: true });
		const child = spawn("pi", ["--mode", "rpc", "--session-dir", join(base, "sessions"), "--extension", EXT], { cwd: join(base, "work"), stdio: ["pipe", "pipe", "pipe"] });
		const events = []; let buf = "";
		child.stdout.on("data", (c) => {
			buf += c.toString("utf8"); let k;
			while ((k = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); if (l) try { events.push(JSON.parse(l)); } catch {} }
		});
		child.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: PROMPTS[i % PROMPTS.length] }) + "\n");
		const start = Date.now();
		while (!events.some((e) => e.type === "agent_settled") && Date.now() - start < 150000) await new Promise((r) => setTimeout(r, 100));
		const reports = events.filter((e) => e.type === "tool_execution_start" && e.toolName === "report");
		const sessionFile = readdirSync(join(base, "sessions")).map((f) => join(base, "sessions", f))[0];
		const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const reminders = entries.filter((e) => e.type === "custom_message" && e.customType === "shepherd.report-reminder").length;
		child.stdin.end(); setTimeout(() => child.kill("SIGKILL"), 2000);
		resolve({ run: i, reportCalls: reports.length, status: reports[0]?.args?.status, reminders, ms: Date.now() - start });
	});
}

const results = [];
for (let i = 0; i < RUNS; i++) results.push(await run(i));
console.log(`mode=${mode}`);
for (const r of results) console.log(" ", JSON.stringify(r));
console.log(`  reported ${results.filter((r) => r.reportCalls >= 1).length}/${results.length}; forced by reminder ${results.filter((r) => r.reminders > 0).length}; duplicate reports ${results.filter((r) => r.reportCalls > 1).length}`);
process.exit(0);
