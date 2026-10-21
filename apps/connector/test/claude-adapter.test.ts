// ClaudeAdapter contract tests (issue #17): the headless invocation shape, stdin-ended
// prompt delivery, the `__report` suffix match, stop_reason mapping, the shared adjudication
// path, resume with `--resume <uuid>`, and the kill-based interrupt — all against
// fake-claude (connector-pi.md §14's fake-agent strategy, second agent).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter, claudeSessionId, isReportTool, mapStopReason } from "../src/claude-adapter.ts";
import type { RawAdapterEvent, StartSpec } from "../src/agent.ts";
import {
  claudeAssistantText,
  claudeReportRun,
  claudeToolUse,
  tmpDir,
  waitFor,
  writeClaudeScenario,
} from "./helpers.ts";

let dir: string;
let stateDir: string;
let adapter: ClaudeAdapter;
let events: RawAdapterEvent[];
let logs: { prompt: string; argv: string[]; stdinEnded: boolean }[];
const scenarioRuns: Array<Array<Record<string, unknown>>> = [];

const LOG = () => join(dir, "claude-prompt.log");
const ARGV_LOG = () => join(dir, "claude-argv.log");

beforeEach(() => {
  dir = tmpDir("sig-claude-test");
  stateDir = join(dir, "state");
  events = [];
  logs = [];
});

afterEach(async () => {
  await adapter?.stopProcess("w-claude-1").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** Builds the adapter against fake-claude; `runs` indexes per process (fresh per run). */
function setup(runs: Array<Array<Record<string, unknown>>>, startup?: Record<string, unknown>): void {
  scenarioRuns.length = 0;
  const scenario = writeClaudeScenario(
    dir,
    "scenario",
    runs as never,
    startup,
  );
  adapter = new ClaudeAdapter({
    stateDir,
    command: [process.execPath, join(import.meta.dirname, "fake-claude.mjs")],
    env: { FAKE_CLAUDE_SCRIPT: scenario, FAKE_CLAUDE_LOG: LOG(), FAKE_CLAUDE_ARGV_LOG: ARGV_LOG() },
    initTimeoutMs: 10_000,
  });
  adapter.on("worker-event", (event) => events.push(event));
}

function readLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function promptLogs() {
  logs = readLog(LOG()) as never;
  return logs;
}

function spec(overrides: Partial<StartSpec> = {}): StartSpec {
  return {
    workerId: "w-claude-1",
    threadId: "t-1",
    cwd: dir,
    mode: "write",
    prompt: "Do the task",
    commandId: "cmd-1",
    ...overrides,
  };
}

const settledOf = (workerId = "w-claude-1") =>
  events.filter((e) => e.type === "settled" && e.workerId === workerId) as Array<{
    type: "settled";
    outcome: string;
    errorClass?: string;
    lastText?: string;
    report?: Record<string, unknown>;
    usage?: Record<string, unknown>;
  }>;

describe("invocation contract (spike-conclusions §2)", () => {
  it(
    "runs the headless shape with permission bypass and ends stdin after the prompt",
    async () => {
      setup([[{ emit: claudeAssistantText("done") }]]);
      const handle = await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");

      const argv = readLog(ARGV_LOG()).map((l) => l as unknown as string[])[0]!;
      for (const flag of ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]) {
        expect(argv).toContain(flag);
      }
      // --mcp-config points at a file the connector wrote (server + per-worker config).
      const cfgIdx = argv.indexOf("--mcp-config");
      expect(cfgIdx).toBeGreaterThan(-1);
      expect(existsSync(argv[cfgIdx + 1]!)).toBe(true);
      const config = JSON.parse(readFileSync(argv[cfgIdx + 1]!, "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      const server = config.mcpServers.sig!;
      expect(server).toBeDefined();
      expect(existsSync(server.args[0]!)).toBe(true);
      // --append-system-prompt carries the §7.3 reporting conventions (text, not a path).
      const sysIdx = argv.indexOf("--append-system-prompt");
      expect(sysIdx).toBeGreaterThan(-1);
      expect(String(argv[sysIdx + 1])).toContain("report");
      // First run pins the deterministic session id.
      const sidIdx = argv.indexOf("--session-id");
      expect(argv[sidIdx + 1]).toBe(handle.sessionId);
      expect(handle.sessionId).toBe(claudeSessionId("w-claude-1"));

      // The spike's hang: the prompt is processed only on EOF — fake-claude logs exactly
      // then, so a present log line proves stdin was ended after the write.
      const entries = promptLogs();
      expect(entries[0]!.stdinEnded).toBe(true);
      expect(entries[0]!.prompt).toBe("Do the task");
    },
    30_000,
  );

  it("declares its capabilities honestly: no steer, no follow-up, no images, no readonly", () => {
    setup([]);
    expect(adapter.capabilities).toMatchObject({
      steer: false,
      followUp: false,
      interrupt: true,
      resume: true,
      history: false,
      images: false,
      structuredReport: true,
      readonly: false,
    });
    expect(adapter.kind).toBe("claude-code");
  });
});

describe("stream mapping and shared adjudication (§5.2 via the pi path)", () => {
  it(
    "matches the namespaced MCP report tool by __report suffix and settles reported",
    async () => {
      setup([
        [
          { emit: claudeToolUse("mcp__sig__report", { status: "done", summary: "all good", decisions: ["used sqlite"] }) },
          { emit: claudeAssistantText("Reported.", "end_turn") },
        ],
      ]);
      await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");
      const settled = settledOf()[0]!;
      expect(settled.outcome).toBe("reported");
      expect(settled.report).toMatchObject({ status: "done", summary: "all good", decisions: ["used sqlite"] });
      // Progress saw the tool (normalized to the bare display name).
      const tool = events.find((e) => e.type === "progress" && e.tool === "report");
      expect(tool).toBeDefined();
    },
    30_000,
  );

  it(
    "a tool merely NAMED report is not the sig report (suffix match only)",
    async () => {
      setup([
        [
          { emit: claudeToolUse("report", { status: "done", summary: "fake" }) },
          { emit: claudeAssistantText("Plain turn.", "end_turn") },
        ],
      ]);
      await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");
      expect(settledOf()[0]!.outcome).toBe("unreported");
      expect(settledOf()[0]!.lastText).toBe("Plain turn.");
    },
    30_000,
  );

  it(
    "maps stop_reasons to pi's vocabulary and hands lastText to the steward (unreported)",
    async () => {
      setup([[{ emit: claudeAssistantText("I asked a question.", "end_turn") }]]);
      await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");
      expect(settledOf()[0]!.outcome).toBe("unreported");
      expect(settledOf()[0]!.lastText).toBe("I asked a question.");
      expect(mapStopReason("end_turn")).toBe("stop");
      expect(mapStopReason("tool_use")).toBe("tool_use");
      expect(mapStopReason("max_tokens")).toBe("length");
      expect(isReportTool("mcp__sig__report")).toBe(true);
      expect(isReportTool("report")).toBe(false);
    },
    30_000,
  );

  it(
    "a result with is_error settles error, classified through the shared rules",
    async () => {
      setup([
        [
          { emit: claudeAssistantText("halfway", "tool_use") },
          { result: { subtype: "error_during_execution", is_error: true, result: "API Error 401 invalid api key" } },
        ],
      ]);
      await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");
      expect(settledOf()[0]!.outcome).toBe("error");
      expect(settledOf()[0]!.errorClass).toBe("auth");
    },
    30_000,
  );

  it(
    "carries usage from the result envelope",
    async () => {
      setup([[{ emit: claudeAssistantText("done") }]]);
      await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "settle");
      expect(settledOf()[0]!.usage).toMatchObject({
        tokens: { input: 900, output: 120, totalTokens: 1020 },
        cost: 0.012,
      });
    },
    30_000,
  );
});

describe("continuation and interruption", () => {
  it(
    "delivers the next prompt as a new process resuming the same session id",
    async () => {
      setup([
        [{ emit: claudeAssistantText("first run done") }],
        [{ emit: claudeToolUse("mcp__sig__report", { status: "done", summary: "second run" }) }],
      ]);
      const handle = await adapter.start(spec());
      await waitFor(() => settledOf()[0], 10_000, "run 1 settle");
      await adapter.send("w-claude-1", { text: "And now the second part" }, "prompt");
      await waitFor(() => settledOf()[1], 15_000, "run 2 settle");

      const argvLogs = readLog(ARGV_LOG()).map((l) => l as unknown as string[]);
      expect(argvLogs.length).toBe(2);
      expect(argvLogs[0]!.includes("--session-id")).toBe(true);
      const resumeIdx = argvLogs[1]!.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(argvLogs[1]![resumeIdx + 1]).toBe(handle.sessionId);
      expect(promptLogs()[1]!.prompt).toBe("And now the second part");
      expect(settledOf()[1]!.outcome).toBe("reported");
    },
    30_000,
  );

  it(
    "interrupt kills the run and settles aborted; the exit is expected",
    async () => {
      setup([[{ delayMs: 60_000 }, { emit: claudeAssistantText("eventually") }]]);
      await adapter.start(spec());
      const result = await adapter.interrupt("w-claude-1");
      expect(result.returned).toEqual([]);
      await waitFor(
        () => events.find((e) => e.type === "settled" && e.outcome === "aborted"),
        10_000,
        "aborted settle",
      );
      const exit = events.find((e) => e.type === "process_exit") as { unexpected: boolean } | undefined;
      expect(exit?.unexpected).toBe(false);
    },
    30_000,
  );

  it(
    "a mid-run crash without result is an unexpected exit (lost/auto-resume is the manager's)",
    async () => {
      setup([[{ delayMs: 200 }, { exit: 1 }]]);
      await adapter.start(spec()).catch(() => undefined);
      await waitFor(
        () => events.find((e) => e.type === "process_exit"),
        10_000,
        "process exit",
      );
      const exit = events.find((e) => e.type === "process_exit") as { unexpected: boolean } | undefined;
      expect(exit?.unexpected).toBe(true);
      expect(settledOf().length).toBe(0); // no synthetic settle — §9.1 handles it
    },
    30_000,
  );
});

describe("startup failures", () => {
  it("fails loudly when the MCP report server did not connect", async () => {
    setup([], { mcpStatus: "error" });
    await expect(adapter.start(spec())).rejects.toMatchObject({ code: "startup_failed" });
  });

  it("fails loudly when the CLI dies before init", async () => {
    setup([], { exit: 9 });
    await expect(adapter.start(spec())).rejects.toMatchObject({ code: "startup_failed" });
  });
});

describe("claudeSessionId", () => {
  it("derives a stable RFC-4122-shaped UUID from the workerId", () => {
    const a = claudeSessionId("w-relay-2");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claudeSessionId("w-relay-2")).toBe(a);
    expect(claudeSessionId("w-relay-3")).not.toBe(a);
  });
});

describe("detectClaude / defaultAdapters (hello.agents advertises only what is installed)", () => {
  it("detects an installed claude and records its version; a missing one is not advertised", async () => {
    const { detectClaude } = await import("../src/claude-adapter.ts");
    const { defaultAdapters } = await import("../src/connector-app.ts");
    // A stand-in "claude" binary that answers --version like the real CLI.
    const fakeBin = join(dir, "fake-claude-bin.mjs");
    writeFileSync(fakeBin, "console.log('1.0.42 (Claude Code)');\n");
    const found = detectClaude([process.execPath, fakeBin]);
    expect(found).toMatchObject({ installed: true, version: "1.0.42 (Claude Code)" });
    expect(detectClaude([process.execPath, join(dir, "no-such-bin.mjs")]).installed).toBe(false);

    const adapters = defaultAdapters(stateDir, [process.execPath, fakeBin]);
    expect(adapters.map((a) => a.kind)).toEqual(["pi", "claude-code"]);
    expect(adapters[1]!.version).toBe("1.0.42 (Claude Code)");
    // Not installed → hello.agents carries pi only.
    expect(defaultAdapters(stateDir, [process.execPath, join(dir, "no-such-bin.mjs")]).map((a) => a.kind)).toEqual([
      "pi",
    ]);
  });
});
