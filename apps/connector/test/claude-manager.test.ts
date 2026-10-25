// WorkerManager × ClaudeAdapter (issue #17): the steward targets an agent by kind, the
// honest capabilities degrade at the manager (readonly/images refused, mid-run sends
// deferred past run end and reported as such, deferred texts come back on interrupt), and
// hello.agents / workers snapshots carry the per-agent truth.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { ClaudeAdapter, claudeSessionId } from "../src/claude-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import {
  claudeReportRun,
  claudeToolUse,
  type ClaudeStep,
  fakeClaudeAdapter,
  fakePiAdapter,
  makeGitRepo,
  type ScenarioStep,
  reportRun,
  tmpDir,
  waitFor,
  writeClaudeScenario,
  writeScenario,
} from "./helpers.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let eventLog: EventLog;
let events: EmittedEvent[];
let manager: WorkerManager;

beforeEach(async () => {
  dir = tmpDir("sig-claude-manager-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
});

afterEach(async () => {
  for (const workerId of ["w-claude-m1", "w-claude-m2"]) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** A manager with BOTH agents wired (pi via fake-pi, claude-code via fake-claude). */
const CLAUDE_PROMPT_LOG = () => join(dir, "claude-prompts.log");

function setup(piRuns: ScenarioStep[][], claudeRuns: ClaudeStep[][]): void {
  const piScenario = writeScenario(dir, "pi-scenario", piRuns);
  const claudeScenario = writeClaudeScenario(dir, "claude-scenario", claudeRuns);
  manager = new WorkerManager({
    store,
    stateDir,
    adapters: [fakePiAdapter(stateDir, piScenario), fakeClaudeAdapter(stateDir, claudeScenario, { FAKE_CLAUDE_LOG: CLAUDE_PROMPT_LOG() })],
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  return {
    workerId: "w-claude-m1",
    threadId: "cross-agent",
    repoId: repo,
    mode: "write",
    prompt: "Implement the thing",
    agent: "claude-code",
    ...overrides,
  };
}


/** handleCommand takes the raw wire shape; a typed literal needs the index signature. */
function cmdArgs(a: StartWorkerArgs): Record<string, unknown> {
  return { ...a } as Record<string, unknown>;
}

const eventsOf = (workerId: string, type: string) => events.filter((e) => e.workerId === workerId && e.type === type);

describe("hello.agents and worker identity (issue #17 AC)", () => {
  it("advertises every wired agent and defaults unknown kinds loudly", async () => {
    setup([], []);
    expect(manager.agents.map((a) => a.kind)).toEqual(["pi", "claude-code"]);
    await expect(manager.handleCommand("c1", "start_worker", { ...args(), agent: "codex" }, undefined)).rejects.toMatchObject({
      code: "unknown_agent",
    });
  });

  it("records the agent on the worker row; the snapshot says which agent owns it", async () => {
    setup([], [[...claudeReportRun({ status: "done", summary: "ok" })]]);
    await manager.handleCommand("c2", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "claude settle");
    expect(store.getWorker("w-claude-m1")!.agent).toBe("claude-code");
    expect(manager.agents.find((a) => a.kind === "claude-code")!.capabilities.steer).toBe(false);
  });
});

describe("capability degradation at the manager (§3, issue #17 AC)", () => {
  it("refuses readonly tasks and images for an agent that honestly cannot do them", async () => {
    setup([], []);
    await expect(
      manager.handleCommand("c3", "start_worker", { ...args(), mode: "readonly" }, undefined),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(
      manager.handleCommand(
        "c4",
        "start_worker",
        { ...args(), images: [{ data: "aGk=", mimeType: "image/png" }] },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it(
    "defers a mid-run send past run end, tells the steward, then delivers it as the next prompt",
    async () => {
      setup(
        [],
        [
          // Run 1: long enough for the send to land mid-run.
          [{ delayMs: 1500 }, ...claudeReportRun({ status: "done", summary: "run one" })],
          // Run 2: the deferred text's run.
          [...claudeReportRun({ status: "done", summary: "run two" })],
        ],
      );
      await manager.handleCommand("c5", "start_worker", cmdArgs(args()), undefined);
      // The worker is running (state flips at launch; the fake run holds the window open).
      const result = (await manager.handleCommand(
        "c6",
        "send",
        { workerId: "w-claude-m1", text: "Also add tests", intent: "now" },
        undefined,
      )) as { delivery: string; effect?: string; degraded?: string };
      expect(result.delivery).toBe("queued");
      expect(result.effect).toBe("after_run_end");
      expect(result.degraded).toContain("cannot steer mid-run");

      // Run 1 settles → the deferred text is delivered as run 2's prompt → it settles too.
      await waitFor(() => eventsOf("w-claude-m1", "settled").length >= 2, 30_000, "both runs settle");
      const started = eventsOf("w-claude-m1", "started");
      expect(started.length).toBeGreaterThanOrEqual(2);
      const prompts = readPrompts();
      expect(prompts.some((p) => p.prompt === "Also add tests")).toBe(true);
    },
    60_000,
  );

  it(
    "returns deferred texts as queue_returned when an interrupt supersedes them",
    async () => {
      setup(
        [],
        [[{ delayMs: 60_000 }, ...claudeReportRun({ status: "done", summary: "never lands" })]],
      );
      await manager.handleCommand("c7", "start_worker", cmdArgs(args()), undefined);
      const sendResult = await manager.handleCommand(
        "c8",
        "send",
        { workerId: "w-claude-m1", text: "never delivered", intent: "auto" },
        undefined,
      );
      expect(sendResult).toMatchObject({ delivery: "queued" });
      const outcome = (await manager.handleCommand("c9", "interrupt", { workerId: "w-claude-m1" }, undefined)) as {
        aborted: boolean;
        queueReturned: number;
      };
      expect(outcome.aborted).toBe(true);
      expect(outcome.queueReturned).toBe(1);
      await waitFor(() => eventsOf("w-claude-m1", "queue_returned").length > 0, 10_000, "queue_returned");
      const returned = eventsOf("w-claude-m1", "queue_returned")[0] as unknown as { texts: string[] };
      expect(returned.texts).toContain("never delivered");
      // The interrupt settled the run as aborted and left the worker idle.
      await waitFor(() => store.getWorker("w-claude-m1")!.state === "idle", 10_000, "idle after abort");
      expect(eventsOf("w-claude-m1", "settled").some((e) => e.outcome === "aborted")).toBe(true);
    },
    60_000,
  );

  it(
    "a stopped run flushes its deferred texts instead of silently relaunching the worker",
    async () => {
      setup(
        [],
        [[{ delayMs: 60_000 }, ...claudeReportRun({ status: "done", summary: "never lands" })]],
      );
      await manager.handleCommand("c10", "start_worker", cmdArgs(args()), undefined);
      await manager.handleCommand(
        "c11",
        "send",
        { workerId: "w-claude-m1", text: "parked text", intent: "auto" },
        undefined,
      );
      await manager.handleCommand("c12", "stop_process", { workerId: "w-claude-m1" }, undefined);
      await waitFor(() => eventsOf("w-claude-m1", "queue_returned").length > 0, 10_000, "queue_returned after stop");
      const returned = eventsOf("w-claude-m1", "queue_returned")[0] as unknown as { texts: string[] };
      expect(returned.texts).toContain("parked text");
      expect(store.getWorker("w-claude-m1")!.state).toBe("idle");
      // …and no new run ever started with the parked text.
      expect(readPrompts().some((p) => p.prompt === "parked text")).toBe(false);
    },
    60_000,
  );
});

describe("mixed-fleet lifecycle", () => {
  it(
    "pi and claude-code workers run side by side on the same manager",
    async () => {
      setup(
        [[...reportRun({ status: "done", summary: "pi done" })]],
        [[...claudeReportRun({ status: "done", summary: "claude done" })]],
      );
      await manager.handleCommand("c13", "start_worker", cmdArgs(args()), undefined);
      await manager.handleCommand(
        "c14",
        "start_worker",
        { ...args(), workerId: "w-claude-m2", agent: undefined },
        undefined,
      );
      await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "claude settle");
      await waitFor(() => eventsOf("w-claude-m2", "settled").length > 0, 15_000, "pi settle");
      expect(store.getWorker("w-claude-m1")!.agent).toBe("claude-code");
      expect(store.getWorker("w-claude-m2")!.agent).toBe("pi");
      const claudeReport = eventsOf("w-claude-m1", "report")[0] as unknown as { summary: string };
      expect(claudeReport.summary).toBe("claude done");
    },
    60_000,
  );

  it(
    "namespaced tool names other than __report are plain tools (unreported path)",
    async () => {
      setup(
        [],
        [
          [
            { emit: claudeToolUse("mcp__other_server__report_check", { q: "x" }) },
            { emit: { type: "assistant", message: { content: [{ type: "text", text: "plain turn" }], stop_reason: "end_turn" } } },
          ],
        ],
      );
      await manager.handleCommand("c15", "start_worker", cmdArgs(args()), undefined);
      await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "settle");
      const settled = eventsOf("w-claude-m1", "settled")[0]!;
      expect(settled.outcome).toBe("unreported");
    },
    60_000,
  );
});

/** fake-claude's prompt log: every consumed (stdin-ended) prompt. */
function readPrompts(): Array<{ prompt: string }> {
  try {
    return readFileSync(CLAUDE_PROMPT_LOG(), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { prompt: string });
  } catch {
    return [];
  }
}

describe("restart reconciliation for claude workers (§9.1 via issue #17)", () => {
  it(
    "a mid-run crash marks the worker lost and auto-resumes with --resume (no session file to tail)",
    async () => {
      const argvLog = join(dir, "claude-restart-argv.log");
      const mkScenario = (runs: ClaudeStep[][]) => {
        const scenario = writeClaudeScenario(dir, `claude-restart-${Math.random().toString(36).slice(2, 6)}`, runs);
        return new ClaudeAdapter({
          stateDir,
          command: [process.execPath, join(import.meta.dirname, "fake-claude.mjs")],
          env: {
            FAKE_CLAUDE_SCRIPT: scenario,
            FAKE_CLAUDE_ARGV_LOG: argvLog,
            FAKE_CLAUDE_LOG: CLAUDE_PROMPT_LOG(),
          },
          initTimeoutMs: 10_000,
        });
      };
      // Boot A: the run holds mid-stream when the connector dies.
      manager = new WorkerManager({
        store,
        stateDir,
        adapters: [mkScenario([[{ delayMs: 60_000 }]])],
        emit: (workerId, fields) => {
          events.push(JSON.parse(eventLog.append(workerId, fields).payload) as EmittedEvent);
        },
      });
      await manager.handleCommand("r1", "start_worker", cmdArgs(args()), undefined);
      await waitFor(() => eventsOf("w-claude-m1", "started").length > 0, 15_000, "started");
      manager.simulateCrash();

      // Boot B over the same store: reconciliation runs at construction-less start — here,
      // directly — and the auto-resume relaunches the claude session.
      const managerB = new WorkerManager({
        store,
        stateDir,
        adapters: [mkScenario([[...claudeReportRun({ status: "done", summary: "resumed" })]])],
        recovery: { autoResumeBackoffMs: 300 },
        emit: (workerId, fields) => {
          const stored = eventLog.append(workerId, fields);
          events.push(JSON.parse(stored.payload) as EmittedEvent);
        },
      });
      await managerB.reconcileStartup();
      await waitFor(() => eventsOf("w-claude-m1", "lost").length > 0, 10_000, "lost after restart");
      await waitFor(() => eventsOf("w-claude-m1", "resumed").length > 0, 20_000, "auto-resumed");
      await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 20_000, "resumed run settled");
      expect(events.find((e) => e.type === "resumed")).toMatchObject({ reason: "connector_restart" });

      // The resume relaunched the SAME session: argv carried --resume <derived uuid>.
      const argvs = readFileSync(argvLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as string[]);
      expect(argvs.length).toBe(2);
      expect(argvs[0]!.includes("--session-id")).toBe(true);
      const resumeIdx = argvs[1]!.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(argvs[1]![resumeIdx + 1]).toBe(claudeSessionId("w-claude-m1"));
      expect(store.getWorker("w-claude-m1")).toMatchObject({ state: "idle", lastOutcome: "reported" });
      for (const workerId of ["w-claude-m1"]) await managerB.stopProcess(workerId).catch(() => undefined);
    },
    90_000,
  );
});

// PR #59 review findings: the honest-degradation gates must cover EVERY delivery path, a
// workerId is pinned to its agent for life, and an interrupt landing in claude's
// post-result window must not claim it aborted a completed run.
describe("PR #59 review fixes", () => {
  it("refuses send.images for a no-images agent — every delivery path, not just start_worker (finding 2)", async () => {
    setup([], [[...claudeReportRun({ status: "done", summary: "ok" })]]);
    await manager.handleCommand("f1", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "settle");
    // idle → the prompt path; running would hit the steer path; both must refuse alike.
    await expect(
      manager.handleCommand(
        "f2",
        "send",
        { workerId: "w-claude-m1", text: "look at this", intent: "auto", images: [{ data: "aGk=", mimeType: "image/png" }] },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("refuses mid-run image sends on the deferral path too (finding 2)", async () => {
    setup([], [[{ delayMs: 60_000 }]]);
    await manager.handleCommand("f3", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "started").length > 0, 15_000, "started");
    await expect(
      manager.handleCommand(
        "f4",
        "send",
        { workerId: "w-claude-m1", text: "and this", intent: "now", images: [{ data: "aGk=", mimeType: "image/png" }] },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(store.getWorker("w-claude-m1")!.state).toBe("running"); // nothing deferred
  });

  it("a workerId is pinned to its agent: a re-start under another agent is refused (finding 3)", async () => {
    setup([], [[...claudeReportRun({ status: "done", summary: "ok" })]]);
    await manager.handleCommand("f5", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "settle");
    await expect(
      manager.handleCommand("f6", "start_worker", cmdArgs({ ...args(), agent: undefined }), undefined),
    ).rejects.toMatchObject({ code: "agent_mismatch" });
    // The same agent re-starts fine (a fresh task on a reused id keeps its agent).
    const again = (await manager.handleCommand("f7", "start_worker", cmdArgs(args()), undefined)) as unknown;
    expect(again).toBeTruthy();
  });

  it("an interrupt in claude's post-result window reports aborted:false (finding 4)", async () => {
    // Run 1 settles, but the process lingers in its exiting window (delayMs on a second
    // hold-back step is not possible post-result — model it with a long-running run that
    // we let FINISH, then interrupt before the idle reclaim).
    setup([], [
      [...claudeReportRun({ status: "done", summary: "finished" })],
    ]);
    await manager.handleCommand("f8", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "settle");
    // The process may already be gone (fast exit) — the finding only bites while it is
    // alive; either way the command must never claim aborted for a settled run.
    const outcome = (await manager.handleCommand("f9", "interrupt", { workerId: "w-claude-m1" }, undefined)) as {
      aborted: boolean;
    };
    expect(outcome.aborted).toBe(false);
    expect(eventsOf("w-claude-m1", "settled").filter((e) => e.outcome === "aborted")).toHaveLength(0);
  });

  it("stop_process settles a stranded row whose agent is no longer wired (finding 6)", async () => {
    setup([], [[...claudeReportRun({ status: "done", summary: "ok" })]]);
    await manager.handleCommand("g1", "start_worker", cmdArgs(args()), undefined);
    await waitFor(() => eventsOf("w-claude-m1", "settled").length > 0, 15_000, "settle");
    // A manager with ONLY pi wired — the shape after "claude uninstalled" + reboot.
    const managerB = new WorkerManager({
      store,
      stateDir,
      adapters: [fakePiAdapter(stateDir, writeScenario(dir, "pi-only", []))],
      emit: (workerId, fields) => {
        events.push(JSON.parse(eventLog.append(workerId, fields).payload) as EmittedEvent);
      },
    });
    // Send (idle-cold relaunch) fails honestly — the text cannot be delivered.
    await expect(
      managerB.handleCommand("g2", "send", { workerId: "w-claude-m1", text: "hi", intent: "auto" }, undefined),
    ).rejects.toMatchObject({ code: "unknown_agent" });
    // But the operator can still settle the row (a `lost` strand, the post-reboot shape)
    // instead of being locked out until claude is reinstalled.
    store.setWorkerState("w-claude-m1", "lost", "crash");
    await managerB.handleCommand("g3", "stop_process", { workerId: "w-claude-m1" }, undefined);
    expect(store.getWorker("w-claude-m1")!.state).toBe("idle");
    managerB.stop();
  });
});
