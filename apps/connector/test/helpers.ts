// Shared helpers for connector tests: real git fixtures, fake-pi wiring, and polling waits.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { PiAdapter } from "../src/pi-adapter.ts";
import { ClaudeAdapter } from "../src/claude-adapter.ts";

export const exec = promisify(execFile);

export function tmpDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

/** Creates a real git repository with one commit on `main`. */
export async function makeGitRepo(parent: string, name = "repo-a"): Promise<string> {
  const repo = join(parent, name);
  mkdirSync(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@sig.local"]);
  await git(repo, ["config", "user.name", "Sig Test"]);
  writeFileSync(join(repo, "README.md"), `# ${basename(repo)}\n`);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** The fake-pi argv prefix for PiAdapterOptions.command. */
export function fakePiCommand(): string[] {
  return [process.execPath, join(import.meta.dirname, "fake-pi.mjs")];
}

export function fakePiAdapter(stateDir: string, scenarioPath: string, extra: Record<string, string> = {}): PiAdapter {
  return new PiAdapter({
    stateDir,
    command: fakePiCommand(),
    env: { FAKE_PI_SCRIPT: scenarioPath, ...extra },
  });
}

/** The fake-claude argv prefix for ClaudeAdapterOptions.command (issue #17). */
export function fakeClaudeCommand(): string[] {
  return [process.execPath, join(import.meta.dirname, "fake-claude.mjs")];
}

export function fakeClaudeAdapter(
  stateDir: string,
  scenarioPath: string,
  extra: Record<string, string> = {},
): ClaudeAdapter {
  return new ClaudeAdapter({
    stateDir,
    command: fakeClaudeCommand(),
    env: { FAKE_CLAUDE_SCRIPT: scenarioPath, ...extra },
    initTimeoutMs: 10_000,
  });
}

export interface ScenarioStep {
  delayMs?: number;
  emit?: Record<string, unknown>;
  raw?: string;
  shell?: string;
  /** Append one entry to the session JSONL (pi-shaped) for §9.1 tail-reconciliation tests. */
  session?: Record<string, unknown>;
  /** Fail this prompt's RPC with this error (fake-pi): no run plays — a broken pi boundary. */
  fail?: string;
  exit?: number;
}

/** Writes a fake-pi scenario file and returns its path. `startup` models a held-back or
 *  crashing get_state (the connector's `starting` window), e.g. `{ delayMs: 500 }`;
 *  `extra` merges any other top-level scenario knobs (e.g. `statsDelayMs`). */
export function writeScenario(
  dir: string,
  name: string,
  runs: ScenarioStep[][],
  startup?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  const path = join(dir, `${name}.scenario.json`);
  writeFileSync(path, JSON.stringify({ ...(startup ? { startup } : {}), ...(extra ?? {}), runs }));
  return path;
}

/** Polls until the predicate returns a truthy value; rejects on timeout. */
export function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000, what = "condition"): Promise<T> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const value = predicate();
      if (value !== undefined && value !== null && value !== false) {
        resolve(value as T);
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timed out waiting for ${what}`));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

// ---- session JSONL entries (pi research “Sessions”: header + tree entries) -----------------

export function sessionUserMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

export function sessionAssistantMessage(
  content: unknown[],
  extra: { stopReason?: string; errorMessage?: string } = {},
): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: "assistant",
      content,
      stopReason: extra.stopReason ?? "stop",
      ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
      timestamp: Date.now(),
    },
  };
}

export function sessionToolResult(toolCallId: string, toolName: string): Record<string, unknown> {
  return {
    type: "message",
    message: { role: "toolResult", toolCallId, toolName, content: [], isError: false, timestamp: Date.now() },
  };
}

export function textBlock(text: string) {
  return { type: "text", text };
}

export function reportToolCall(toolCallId: string, args: Record<string, unknown>) {
  return { type: "toolCall", id: toolCallId, name: "report", arguments: args };
}

/** Writes a complete session JSONL (header + entries) — the tail-inspection fixture. */
export function writeSessionFile(dir: string, workerId: string, entries: Array<Record<string, unknown>>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${workerId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: workerId, timestamp: new Date().toISOString(), cwd: dir }),
    ...entries.map((entry) => JSON.stringify(entry)),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** A run whose steps stream a normal assistant turn. */
export function assistantTurn(text: string): ScenarioStep[] {
  return [
    { emit: { type: "agent_start" } },
    { emit: { type: "turn_start" } },
    {
      emit: {
        type: "message_end",
        message: { role: "user", content: "task", timestamp: 0 },
      },
    },
    {
      emit: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
      },
    },
    { emit: { type: "agent_settled", aborted: false } },
  ];
}

/** A run that calls the report tool, optionally after a shell step. */
export function reportRun(
  report: Record<string, unknown>,
  opts: { shellBefore?: string; tool?: string } = {},
): ScenarioStep[] {
  return [
    { emit: { type: "agent_start" } },
    { emit: { type: "turn_start" } },
    ...(opts.shellBefore ? [{ shell: opts.shellBefore }] : []),
    ...(opts.tool
      ? [
          { emit: { type: "tool_execution_start", toolCallId: "c0", toolName: opts.tool, args: { file_path: "src/a.ts" } } },
          { emit: { type: "tool_execution_end", toolCallId: "c0", toolName: opts.tool, result: {}, isError: false } },
        ]
      : []),
    { emit: { type: "tool_execution_start", toolCallId: "c1", toolName: "report", args: report } },
    { emit: { type: "tool_execution_end", toolCallId: "c1", toolName: "report", result: {}, isError: false } },
    {
      emit: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Reported." }], stopReason: "stop" },
      },
    },
    { emit: { type: "agent_settled", aborted: false } },
  ];
}

// ---- fake-claude scenarios (issue #17) ----------------------------------------------------

export interface ClaudeStep {
  delayMs?: number;
  /** One verbatim stream-json event (system/assistant/user/result shapes). */
  emit?: Record<string, unknown>;
  shell?: string;
  /** Override fields of the final default `result` event. */
  result?: Record<string, unknown>;
  /** Suppress the default result event (crash shapes; pair with `exit`). */
  noResult?: boolean;
  exit?: number;
}

/** Writes a fake-claude scenario and returns its path; `startup` models init behavior
 *  (`delayMs`, `exit`, `mcpStatus`). The run counter file lives next to the script. */
export function writeClaudeScenario(
  dir: string,
  name: string,
  runs: ClaudeStep[][],
  startup?: Record<string, unknown>,
): string {
  const path = join(dir, `${name}.claude.json`);
  writeFileSync(path, JSON.stringify({ ...(startup ? { startup } : {}), runs }));
  return path;
}

/** One assistant message with a text block (stream-json shape). */
export function claudeAssistantText(text: string, stopReason = "end_turn"): Record<string, unknown> {
  return {
    type: "assistant",
    message: { id: "msg_1", content: [{ type: "text", text }], stop_reason: stopReason, role: "assistant" },
    session_id: "-",
  };
}

/** One assistant message with a tool_use block — MCP tools arrive NAMESPACED
 *  (mcp__sig__report); the connector must suffix-match, never bare-match. */
export function claudeToolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "assistant",
    message: { id: "msg_2", content: [{ type: "tool_use", id: "toolu_1", name, input }], stop_reason: "tool_use", role: "assistant" },
    session_id: "-",
  };
}

/** A fake-claude run that reports via the MCP tool, optionally after a shell step. */
export function claudeReportRun(
  report: Record<string, unknown>,
  opts: { shellBefore?: string; tool?: { name: string; input: Record<string, unknown> } } = {},
): ClaudeStep[] {
  return [
    ...(opts.shellBefore ? [{ shell: opts.shellBefore }] : []),
    ...(opts.tool ? [{ emit: claudeToolUse(opts.tool.name, opts.tool.input) }] : []),
    { emit: claudeToolUse("mcp__sig__report", report) },
    { emit: claudeAssistantText("Reported.", "end_turn") },
  ];
}
