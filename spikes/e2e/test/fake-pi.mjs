// Fake pi for deterministic connector tests (connector-pi.md §14). Speaks the RPC subset
// over stdin/stdout JSONL and runs a scripted event sequence per scenario, so the
// connector's adjudication, progress throttling, and lost-detection can be tested without
// tokens. Scenario comes from FAKE_PI_SCENARIO; --session-id is parsed from argv.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sessionId = (() => {
	const i = process.argv.indexOf("--session-id");
	return i >= 0 ? process.argv[i + 1] : `fake_${Date.now()}`;
})();
const markerPath = join(process.cwd(), ".stall-once-marker");
const SCENARIO = process.env.FAKE_PI_SCENARIO ?? "happy";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const respond = (cmd, extra = {}) => send({ type: "response", id: cmd.id, command: cmd.type, success: true, ...extra });

// ---- scripted runs: each step is [delayMs, event]; "EXIT" kills the process ----
const runs = {
	happy: [
		[50, { type: "agent_start" }],
		[80, { type: "tool_execution_start", toolName: "bash", args: { command: "ls -la" } }],
		[300, { type: "tool_execution_end", toolName: "bash" }],
		[50, { type: "tool_execution_start", toolName: "edit", args: { path: "src/a.ts" } }],
		[200, { type: "tool_execution_end", toolName: "edit" }],
		[50, { type: "tool_execution_start", toolName: "report", args: { status: "done", summary: "改好了", changes: ["src/a.ts"], tests: { ran: true, passed: true } } }],
		[50, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "完成，已汇报。" }], stopReason: "stop" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "completed" }],
	],
	unreported: [
		[50, { type: "agent_start" }],
		[100, { type: "tool_execution_start", toolName: "bash", args: { command: "make test" } }],
		[200, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "我认为已经完成了，测试都通过。" }], stopReason: "stop" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "completed" }],
	],
	error_auth: [
		[50, { type: "agent_start" }],
		[80, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Error: 401 Unauthorized (invalid api key)" }], stopReason: "error" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "error" }],
	],
	error_transient: [
		[50, { type: "agent_start" }],
		[80, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Error: 429 rate limit exceeded, retry later" }], stopReason: "error" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "error" }],
	],
	error_context: [
		[50, { type: "agent_start" }],
		[80, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Error: prompt too long, maximum context length exceeded" }], stopReason: "error" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "error" }],
	],
	aborted: [
		[50, { type: "agent_start" }],
		[100, { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 30" } }],
		[400, { type: "agent_settled", aborted: true, outcome: "aborted" }],
	],
	crash: [
		[50, { type: "agent_start" }],
		[100, { type: "tool_execution_start", toolName: "bash", args: { command: "npm test" } }],
		[300, "EXIT"],
	],
	// same tool repeatedly: the connector must throttle to one progress per 15s
	throttle: [
		[50, { type: "agent_start" }],
		...Array.from({ length: 6 }, (_, i) => [300, { type: "tool_execution_start", toolName: "bash", args: { command: `cmd ${i}` } }]),
		[300, { type: "tool_execution_start", toolName: "report", args: { status: "done", summary: "throttle run done" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "completed" }],
	],
	// stays busy until stdin closes (concurrency-cap tests)
	slow: [
		[50, { type: "agent_start" }],
		[2500, { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 2" } }],
		[2500, { type: "tool_execution_start", toolName: "report", args: { status: "done", summary: "slow run done" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "completed" }],
	],
	// wedged after a tool start: no further output ever (stall-watchdog tests)
	stall: [
		[50, { type: "agent_start" }],
		[80, { type: "tool_execution_start", toolName: "bash", args: { command: "sleep 600" } }],
	],
	// stalls on the first invocation only; the respawn (same worktree) sees the marker and runs clean
	stall_once: [
		[50, { type: "agent_start" }],
		[80, { type: "tool_execution_start", toolName: "report", args: { status: "done", summary: "recovered after stall" } }],
		[50, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "已恢复并汇报。" }], stopReason: "stop" } }],
		[20, { type: "agent_settled", aborted: false, outcome: "completed" }],
	],
};

let running = false;
async function runScenario() {
	if (running) return; // steer/follow_up during a run: ignored by the fake
	running = true;
	if (SCENARIO === "stall_once" && !existsSync(markerPath)) {
		writeFileSync(markerPath, "1");
		send({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep 600" } });
		return; // wedged: no further output; the watchdog kills and respawns
	}
	for (const [delay, ev] of runs[SCENARIO] ?? runs.happy) {
		await sleep(delay);
		if (ev === "EXIT") process.exit(1);
		send(ev);
	}
	running = false;
}

let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i).trim();
		buf = buf.slice(i + 1);
		if (!line) continue;
		let cmd;
		try { cmd = JSON.parse(line); } catch { continue; }
		switch (cmd.type) {
			case "get_state":
				respond(cmd, { data: { sessionId, sessionFile: `/tmp/fake-sessions/${sessionId}.jsonl` } });
				break;
			case "prompt":
				respond(cmd, { data: { disposition: "started" } });
				void runScenario();
				break;
			case "abort":
				respond(cmd, { data: { aborted: true } });
				if (running) { running = false; send({ type: "agent_settled", aborted: true, outcome: "aborted" }); }
				break;
			default:
				respond(cmd, { data: {} });
		}
	}
});
process.stdin.on("end", () => process.exit(0));
send({ type: "ready", sessionId, scenario: SCENARIO });
