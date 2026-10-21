#!/usr/bin/env node
// fake-claude: a deterministic `claude -p --output-format stream-json` stand-in for
// connector tests (issue #17, connector-pi.md §14 "fake pi" pattern applied to the second
// agent). It enforces the two contract points the spike hit live:
//
// 1. The stdin prompt is only processed on EOF: nothing happens until stdin ends — a
//    connector that writes the prompt and forgets stdin.end() hangs forever here too.
// 2. Stream events are LF-delimited JSON: system/init first, assistant messages with
//    content blocks (tool_use names arrive MCP-namespaced, e.g. mcp__sig__report),
//    and a final `result` event that ends the run and the process.
//
// Env:
//   FAKE_CLAUDE_SCRIPT    path to the JSON scenario file (required)
//   FAKE_CLAUDE_LOG       path to append consumed prompts as JSON lines (assertions)
//   FAKE_CLAUDE_ARGV_LOG  path to append the child argv at startup (invocation-shape tests)
//
// Scenario file:
//   {
//     "startup": { "delayMs": 300, "exit": 9, "mcpStatus": "connected" },
//     "runs": [ [ <step>, ... ], ... ]   // runs[k] plays on the k-th invocation
//   }
//   The run index lives in `<script>.runs` (a plain counter file) so successive PROCESSES
//   consume successive runs — every claude run is a fresh process, unlike fake-pi.
// Step:
//   { "delayMs": 20 }                // pause
//   { "emit": { ... } }              // one verbatim stream-json event
//   { "shell": "git add -A" }        // run in cwd, ignore failures
//   { "result": { ... } }            // override the final result event's fields
//   { "noResult": true }             // suppress the final result (crash shapes; pair with exit)
//   { "exit": 7 }                    // crash the fake process
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error("fake-claude: FAKE_CLAUDE_SCRIPT is required");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scriptPath, "utf8"));

if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(process.argv) + "\n");
}

const argv = process.argv;
function argValue(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : null;
}
const sessionId = argValue("--session-id") ?? argValue("--resume") ?? "00000000-0000-4000-8000-000000000001";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeLine(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function logPrompt(entry) {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
}

/** Shared cross-process run counter: `<script>.runs`. */
function nextRunIndex() {
  const counterFile = `${scriptPath}.runs`;
  const current = Number.parseInt(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0", 10) || 0;
  writeFileSync(counterFile, String(current + 1));
  return current;
}

async function playRun(steps) {
  const merged = Array.isArray(steps) ? steps : [];
  let resultOverride = null;
  let noResult = false;
  for (const step of merged) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.emit) writeLine(step.emit);
    if (step.shell) await new Promise((r) => exec(step.shell, () => r(undefined)));
    if (step.result) resultOverride = step.result;
    if (step.noResult) noResult = true;
    if (step.exit !== undefined) process.exit(step.exit);
  }
  if (!noResult) {
    writeLine({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1200,
      result: "Task complete.",
      session_id: sessionId,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0 },
      total_cost_usd: 0.012,
      ...(resultOverride ?? {}),
    });
  }
  process.exit(0);
}

async function main() {
  const startup = scenario.startup ?? {};
  if (startup.delayMs) await sleep(startup.delayMs);
  if (startup.exit !== undefined) process.exit(startup.exit);
  writeLine({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    mcp_servers: [{ name: "sig", status: startup.mcpStatus ?? "connected" }],
  });
  const run = scenario.runs?.[nextRunIndex()] ?? [];
  await playRun(run);
}

// The prompt is consumed only on stdin EOF (spike-conclusions §2) — this is the assertion.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  logPrompt({ prompt, argv: process.argv, sessionId, cwd: process.cwd(), pid: process.pid, stdinEnded: true, at: Date.now() });
  main().catch((err) => {
    console.error("fake-claude:", err);
    process.exit(3);
  });
});
