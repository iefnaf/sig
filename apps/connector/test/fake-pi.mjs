#!/usr/bin/env node
// fake-pi: a deterministic `pi --mode rpc` stand-in for connector tests (connector-pi.md §14).
// Implements the RPC subset the connector uses — get_state, prompt, steer, follow_up, abort,
// clear_queue, get_session_stats, get_entries — and plays a scripted event sequence per
// prompt, with deliberate delays, shells, raw lines, and deliberate crashes.
//
// Env:
//   FAKE_PI_SCRIPT       path to the JSON scenario file (required)
//   FAKE_PI_LOG          path to append delivered prompts as JSON lines (assertions)
//   FAKE_PI_ENV_LOG       path to append one JSON snapshot of the child env at startup
//                       (issue #27: the connector must not pass its credentials through)
//   FAKE_PI_ARGV_LOG      path to append the child argv at startup (issue #16: --tools
//                       read-only whitelist and --approve/--no-approve assertions)
//   FAKE_PI_SESSIONS_DIR directory for session JSONL files (default /tmp/fake-sessions);
//                       `session` steps append real entries so the connector's §9.1
//                       session-tail reconciliation has true pi-shaped files to read
//   FAKE_PI_RUNS_FILE    share the run index across processes (a plain file holding the
//                       next run number): with it, runs[k] plays on the k-th prompt ANY
//                       process receives — exactly what the stall-watchdog tests need,
//                       since a respawn spawns a FRESH process that would otherwise
//                       replay runs[0] (default: per-process counter)
//
// Scenario file:
//   {
//     "startup": { "exit": 9, "delayMs": 300 },  // optional: exit before answering get_state,
//                                               // or hold the get_state answer (a `starting` window)
//     "statsDelayMs": 1500,                 // optional: hold get_session_stats back — models the
//                                             // settle lag where pi's run window is closed but the
//                                             // connector still says running
//     "runs": [ [ <step>, ... ], ... ]     // runs[k] plays on the k-th prompt
//   }
// Step:
//   { "delayMs": 20 }                      // pause
//   { "emit": { "type": "agent_start" } }  // one JSON session event
//   { "raw": "..." }                       // verbatim stdout chunk (framing tests)
//   { "shell": "git add -A" }              // run in cwd, ignore failures
//   { "session": { ... } }                 // append one entry to the session JSONL
//   { "fail": "reason" }                   // fail that prompt's RPC with `reason` (no run plays)
//   { "exit": 7 }                          // crash the fake pi process
//
// steer/follow_up messages queue like real pi ( disposition "queued"); clear_queue hands
// them back; abort stops the scripted run and emits agent_settled{aborted:true} — the
// §6.2 intervention surface the connector drives. An abort with no run in flight is a
// no-op (real pi has nothing to abort on an idle process); the next prompt runs normally.
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
if (process.env.FAKE_PI_ARGV_LOG) {
  appendFileSync(process.env.FAKE_PI_ARGV_LOG, JSON.stringify(process.argv) + "\n");
}

// Pull --session-id <id> from argv so get_state echoes what the connector expects.
const argv = process.argv;
let sessionId = "w-fake-session";
const sessionIdx = argv.indexOf("--session-id");
if (sessionIdx !== -1 && argv[sessionIdx + 1]) sessionId = argv[sessionIdx + 1];

const sessionsDir = process.env.FAKE_PI_SESSIONS_DIR ?? "/tmp/fake-sessions";
const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);
let entrySeq = 0;
let lastEntryId = null;

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
  // Like real pi, entries chain onto the current leaf; the spread lets a scripted entry
  // pin its own parentId (branch fixtures), defaulting to the live leaf.
  const parentId = "parentId" in entry ? entry.parentId : lastEntryId;
  appendFileSync(sessionFile, JSON.stringify({ id, parentId, timestamp: new Date().toISOString(), ...entry }) + "\n");
  lastEntryId = id;
  return id;
}

/** Reads the session file's entries (header included) in file order — real get_entries shape. */
function readSessionEntries() {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
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

// The run index: per process by default, shared across processes via FAKE_PI_RUNS_FILE so a
// respawned process consumes the NEXT scripted run instead of replaying run 0.
const sharedRunsFile = process.env.FAKE_PI_RUNS_FILE ?? null;
function nextRunIndex() {
  if (!sharedRunsFile) return promptCount++;
  const current = Number.parseInt(readFileSync(sharedRunsFile, "utf8") || "0", 10) || 0;
  writeFileSync(sharedRunsFile, String(current + 1));
  return current;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True while a scripted run is playing — aborts only take effect inside a run (PR #45
 *  review #7: an abort on an idle process must not derail the next prompt's run). */
let runInFlight = false;

async function playRun(steps) {
  runInFlight = true;
  try {
    for (const step of steps ?? []) {
      if (step.delayMs) await sleep(step.delayMs);
      // abort() takes effect between steps: the run ends and agent_settled{aborted:true}
      // fires (research #3: abort responds in ~3 ms and the process accepts new commands).
      if (aborting) break;
      if (step.emit) {
        writeLine(step.emit);
        // Tests synchronize on pi-side settles (the settle-lag window): log it like the
        // intervention commands so a test can wait for exactly this moment.
        if (step.emit.type === "agent_settled") logPrompt({ type: "agent_settled", aborted: step.emit.aborted === true, at: Date.now() });
      }
      if (step.raw) process.stdout.write(step.raw);
      if (step.session) appendSessionEntry(step.session);
      if (step.shell) await new Promise((r) => exec(step.shell, () => r(undefined)));
      if (step.exit !== undefined) process.exit(step.exit);
    }
    if (aborting) {
      aborting = false;
      writeLine({ type: "agent_settled", aborted: true });
    }
  } finally {
    runInFlight = false;
  }
}

let buffer = "";
let promptCount = 0;
let aborting = false;
/** Queued steer/follow_up texts — what clear_queue hands back (real pi queues strings). */
let steeringQueue = [];
let followUpQueue = [];

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
  const messageText = () => (typeof command.message === "string" ? command.message : "");
  switch (command.type) {
    case "get_state": {
      if (scenario.startup?.exit !== undefined) process.exit(scenario.startup.exit);
      if (scenario.startup?.delayMs) await sleep(scenario.startup.delayMs);
      respond(id, "get_state", {
        sessionId,
        sessionFile,
        isStreaming: false,
      });
      return;
    }
    case "prompt": {
      let text = command.message ?? "";
      // Simulate the sig extension's /sig command (ADR-0001 marker): unwrap
      // `/sig <commandId>\n<text>` and record the marker as a custom session entry,
      // then send the clean text as the user message.
      let commandId = null;
      if (typeof text === "string" && text.startsWith("/sig ")) {
        const nl = text.indexOf("\n");
        commandId = text.slice("/sig ".length, nl);
        text = text.slice(nl + 1);
        appendSessionEntry({ type: "custom", customType: "sig.command", data: { commandId, at: Date.now() } });
        appendSessionEntry({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
      }
      logPrompt({ commandId, text, cwd: process.cwd(), sessionId, pid: process.pid, at: Date.now() });
      const run = scenario.runs?.[nextRunIndex()] ?? [];
      const failure = run.find((step) => typeof step.fail === "string");
      if (failure) {
        // The prompt RPC fails at the pi boundary (a wedged/broken pi): no run plays.
        respondError(id, "prompt", failure.fail);
        return;
      }
      respond(id, "prompt", { disposition: commandId !== null ? "handled" : "started" });
      await playRun(run);
      return;
    }
    case "steer":
    case "follow_up": {
      const text = messageText();
      // The sig extension's input handler (§6.3 marker for queued deliveries): strip
      // the `[sig:command <id>]` preamble and persist it as the same custom entry at
      // the moment the message enters pi's queue — like real pi, the entry is appended when
      // the message is delivered, so the session tail answers "was it delivered?".
      let delivered = text;
      const marker = /^\[sig:command ([^\]\r\n]+)\]\n?/;
      if (typeof delivered === "string" && marker.test(delivered)) {
        const commandId = delivered.match(marker)[1];
        delivered = delivered.replace(marker, "");
        appendSessionEntry({ type: "custom", customType: "sig.command", data: { commandId, at: Date.now() } });
        appendSessionEntry({ type: "message", message: { role: "user", content: delivered, timestamp: Date.now() } });
        (command.type === "steer" ? steeringQueue : followUpQueue).push(delivered);
        logPrompt({ type: command.type, text: delivered, at: Date.now() });
        respond(id, command.type, { disposition: "queued" });
        return;
      }
      (command.type === "steer" ? steeringQueue : followUpQueue).push(text);
      logPrompt({ type: command.type, text, at: Date.now() });
      respond(id, command.type, { disposition: "queued" });
      return;
    }
    case "abort": {
      // Real pi only aborts an in-flight run; on an idle process the RPC succeeds as a
      // no-op and a later prompt runs normally (review #7) — the dangling-abort model.
      if (runInFlight) aborting = true;
      logPrompt({ type: "abort", at: Date.now() });
      respond(id, "abort", {});
      return;
    }
    case "clear_queue": {
      const returned = { steering: steeringQueue, followUp: followUpQueue };
      steeringQueue = [];
      followUpQueue = [];
      logPrompt({ type: "clear_queue", returned, at: Date.now() });
      respond(id, "clear_queue", returned);
      return;
    }
    case "get_session_stats": {
      if (scenario.statsDelayMs) await sleep(scenario.statsDelayMs);
      respond(id, "get_session_stats", {
        sessionId,
        tokens: { input: 1200, output: 300, totalTokens: 1500 },
        cost: 0.0042,
        contextUsage: { tokens: 4000, contextWindow: 200000, percent: 2 },
      });
      return;
    }
    case "get_entries": {
      // Research §3: `since` = "everything after a given entry"; the response is the session's
      // entries in file order. Like real pi, `limit` is ignored.
      const entries = readSessionEntries();
      const sinceIdx = typeof command.since === "string" ? entries.findIndex((e) => e.id === command.since) : -1;
      respond(id, "get_entries", { sessionId, sessionFile, entries: sinceIdx === -1 ? entries : entries.slice(sinceIdx + 1) });
      return;
    }
    default: {
      respondError(id, String(command.type), `fake-pi: unknown command ${command.type}`);
    }
  }
}
