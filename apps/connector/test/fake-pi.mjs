#!/usr/bin/env node
// fake-pi: a deterministic `pi --mode rpc` stand-in for connector tests (connector-pi.md §14).
// Implements the RPC subset the connector uses — get_state, prompt, steer, follow_up, abort,
// clear_queue, get_session_stats — and plays a scripted event sequence per prompt, with
// deliberate delays, shells, raw lines, and deliberate crashes.
//
// Env:
//   FAKE_PI_SCRIPT       path to the JSON scenario file (required)
//   FAKE_PI_LOG          path to append delivered prompts as JSON lines (assertions)
//   FAKE_PI_ENV_LOG       path to append one JSON snapshot of the child env at startup
//                       (issue #27: the connector must not pass its credentials through)
//   FAKE_PI_SESSIONS_DIR directory for session JSONL files (default /tmp/fake-sessions);
//                       `session` steps append real entries so the connector's §9.1
//                       session-tail reconciliation has true pi-shaped files to read
//
// Scenario file:
//   {
//     "startup": { "exit": 9 },            // optional: exit before answering get_state
//     "runs": [ [ <step>, ... ], ... ]     // runs[k] plays on the k-th prompt
//   }
// Step:
//   { "delayMs": 20 }                      // pause
//   { "emit": { "type": "agent_start" } }  // one JSON session event
//   { "raw": "..." }                       // verbatim stdout chunk (framing tests)
//   { "shell": "git add -A" }              // run in cwd, ignore failures
//   { "session": { ... } }                 // append one entry to the session JSONL
//   { "exit": 7 }                          // crash the fake pi process
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { join } from "node:path";

const scriptPath = process.env.FAKE_PI_SCRIPT;
if (!scriptPath) {
  console.error("fake-pi: FAKE_PI_SCRIPT is required");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(scriptPath, "utf8"));

if (process.env.FAKE_PI_ENV_LOG) {
  appendFileSync(process.env.FAKE_PI_ENV_LOG, JSON.stringify(process.env) + "\n");
}

// Pull --session-id <id> from argv so get_state echoes what the connector expects.
const argv = process.argv;
let sessionId = "w-fake-session";
const sessionIdx = argv.indexOf("--session-id");
if (sessionIdx !== -1 && argv[sessionIdx + 1]) sessionId = argv[sessionIdx + 1];

const sessionsDir = process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp/fake-sessions";
const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
let entrySeq = 0;

/** Appends one entry like real pi's session JSONL (header first, then tree entries). */
function appendSessionEntry(entry) {
  if (!existsSync(sessionFile)) {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n",
    );
  }
  const id = typeof entry.id === "string" ? entry.id : `e${++entrySeq}`;
  appendFileSync(sessionFile, JSON.stringify({ id, parentId: null, timestamp: new Date().toISOString(), ...entry }) + "\n");
}

function writeLine(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function respond(id, command, data) {
  writeLine({ type: "response", id, command, success: true, data });
}

function respondError(id, command, error) {
  writeLine({ type: "response", id, command, success: false, error });
}

function logPrompt(entry) {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(entry) + "\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playRun(steps) {
  for (const step of steps ?? []) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.emit) writeLine(step.emit);
    if (step.raw) process.stdout.write(step.raw);
    if (step.session) appendSessionEntry(step.session);
    if (step.shell) await new Promise((r) => exec(step.shell, () => r(undefined)));
    if (step.exit !== undefined) process.exit(step.exit);
  }
}

let buffer = "";
let promptCount = 0;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    handle(JSON.parse(line)).catch((err) => {
      console.error("fake-pi:", err);
      process.exit(3);
    });
  }
});
process.stdin.on("end", () => {
  // Connector closed stdin: mirror real pi and exit promptly.
  process.exit(0);
});

async function handle(command) {
  const id = command.id;
  switch (command.type) {
    case "get_state": {
      if (scenario.startup?.exit !== undefined) process.exit(scenario.startup.exit);
      respond(id, "get_state", {
        sessionId,
        sessionFile,
        isStreaming: false,
      });
      return;
    }
    case "prompt": {
      let text = command.message ?? "";
      // Simulate the shepherd extension's /shepherd command (ADR-0001 marker): unwrap
      // `/shepherd <commandId>\n<text>` and record the marker.
      let commandId = null;
      if (typeof text === "string" && text.startsWith("/shepherd ")) {
        const nl = text.indexOf("\n");
        commandId = text.slice("/shepherd ".length, nl);
        text = text.slice(nl + 1);
      }
      logPrompt({ commandId, text, at: Date.now() });
      respond(id, "prompt", { disposition: commandId !== null ? "handled" : "started" });
      const run = scenario.runs?.[promptCount] ?? [];
      promptCount += 1;
      await playRun(run);
      return;
    }
    case "steer":
    case "follow_up": {
      respond(id, command.type, { disposition: "queued" });
      return;
    }
    case "abort": {
      respond(id, "abort", {});
      return;
    }
    case "clear_queue": {
      respond(id, "clear_queue", { steering: [], followUp: [] });
      return;
    }
    case "get_session_stats": {
      respond(id, "get_session_stats", {
        sessionId,
        tokens: { input: 1200, output: 300, totalTokens: 1500 },
        cost: 0.0042,
        contextUsage: { tokens: 4000, contextWindow: 200000, percent: 2 },
      });
      return;
    }
    default: {
      respondError(id, String(command.type), `fake-pi: unknown command ${command.type}`);
    }
  }
}
