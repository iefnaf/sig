#!/usr/bin/env node
// Sig's MCP server for Claude Code workers (issue #17, spike-conclusions §2 "Claude
// Code headless"): a minimal stdio MCP server exposing exactly one tool — `report` — with
// the connector-pi.md §7.2 fields. LF-delimited JSON-RPC 2.0; initialize → tools/list →
// tools/call is the whole conversation (~40 lines in the spike, kept that small here).
//
// The connector installs this file under <stateDir>/mcp/ and points Claude Code at it via
// `--mcp-config` (per-worker config naming this script plus an audit-file path in argv).
// Tool calls surface to the adapter through the stream-json `assistant` events — matched by
// the `__report` suffix of the namespaced tool name (spike: never match the bare name) —
// so this server stays a dumb acknowledge-and-persist endpoint: argv[2] receives the last
// report's args as JSON (best-effort audit trail; nothing reads it in anger).
//
// Like every agent child it gets no SIG_* env and no connector credentials, and it
// touches nothing on disk except argv[2].
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUDIT_FILE = process.argv[2] ?? null;
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "sig-report", version: "1.0.0" };

/** §7.2 (v1) — the same fields the pi extension's `report` tool takes. */
const REPORT_TOOL = {
  name: "report",
  description:
    "Report the outcome of this task to the user via Sig. This must be your LAST " +
    "action when the task is finished, blocked, or needs a user decision. Put questions " +
    "for the user in `question` (with status needs_decision); do not ask in plain text.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["done", "blocked", "needs_decision"],
        description: "done: task complete. blocked: cannot proceed. needs_decision: the user must choose.",
      },
      summary: { type: "string", description: "One-line conclusion." },
      changes: { type: "array", items: { type: "string" }, description: "What was done, including locations." },
      decisions: { type: "array", items: { type: "string" }, description: "Key decisions and reasons (handoff-brief material)." },
      leftovers: { type: "array", items: { type: "string" }, description: "Leftover issues." },
      tests: {
        type: "object",
        properties: { ran: { type: "boolean" }, passed: { type: "boolean" }, note: { type: "string" } },
        required: ["ran"],
      },
      question: { type: "string", description: "Required when status is blocked or needs_decision." },
      next: { type: "string", description: "Suggested next step." },
      answer: {
        type: "string",
        description:
          "The full answer or finding, when this task was informational (a question, an explanation, an investigation) rather than a code change. Use this instead of `changes` when nothing was modified.",
      },
    },
    required: ["status", "summary"],
  },
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Mirrors the pi extension's execute() checks so both agents police the same contract. */
function validateReport(args) {
  if (typeof args !== "object" || args === null) return "`arguments` must be an object.";
  if (args.status !== "done" && args.status !== "blocked" && args.status !== "needs_decision") {
    return "`status` must be one of done | blocked | needs_decision.";
  }
  if (typeof args.summary !== "string" || args.summary.trim().length === 0) {
    return "`summary` (a one-line conclusion) is required.";
  }
  if ((args.status === "blocked" || args.status === "needs_decision") && typeof args.question !== "string") {
    return "`question` is required when status is blocked or needs_decision.";
  }
  return null;
}

async function handle(request) {
  // Notifications (no id) — notifications/initialized and friends — get no response.
  if (request.id === undefined || request.id === null) return;
  switch (request.method) {
    case "initialize":
      reply(request.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case "ping":
      reply(request.id, {});
      return;
    case "tools/list":
      reply(request.id, { tools: [REPORT_TOOL] });
      return;
    case "tools/call": {
      const params = request.params ?? {};
      if (params.name !== "report") {
        replyError(request.id, -32602, `unknown tool: ${String(params.name)}`);
        return;
      }
      const invalid = validateReport(params.arguments);
      if (invalid) {
        // A tool-level error (isError), not a protocol error: the model sees it and retries.
        reply(request.id, { content: [{ type: "text", text: `Invalid report: ${invalid} Call report again with the fix.` }], isError: true });
        return;
      }
      if (AUDIT_FILE) {
        try {
          mkdirSync(dirname(AUDIT_FILE), { recursive: true });
          writeFileSync(AUDIT_FILE, JSON.stringify(params.arguments) + "\n");
        } catch {
          // Audit trail only — never fail the tool call over it.
        }
      }
      reply(request.id, {
        content: [{ type: "text", text: `Report received (status: ${params.arguments.status}). You can end your turn now.` }],
        isError: false,
      });
      return;
    }
    default:
      replyError(request.id, -32601, `method not found: ${String(request.method)}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    let line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      // An unparseable line is dropped, never fatal (§9.4 tolerance).
    }
  }
});
// The parent (Claude Code) closing stdin ends the server.
process.stdin.on("end", () => process.exit(0));
