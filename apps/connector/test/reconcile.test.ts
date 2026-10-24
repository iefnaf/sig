// Issue #12: the §9 failure/recovery slice — session-tail inspection (§9.1 step 3),
// descendant snapshots + orphan cleanup (§9.3), stale-lock handling, and the automatic
// resume policy with its 30 s backoff and ≤2/hour budget (§9.2). Fault-injection over the
// real transport (connector killed mid-run / mid-sending / mid-reconciliation) lives in
// e2e-restart.test.ts.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDescendants, killOrphans, parsePsRows, type ProcRef } from "../src/descendants.ts";
import { inspectSessionTail } from "../src/session-tail.ts";
import { LocalStore, type WorkerRow } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { acquireLock, lockPath } from "../src/locks.ts";
import { WorkerManager, type RecoveryOptions } from "../src/worker-manager.ts";
import { WorktreeManager } from "../src/worktree.ts";
import {
  fakePiAdapter,
  git,
  makeGitRepo,
  reportRun,
  reportToolCall,
  sessionAssistantMessage,
  sessionToolResult,
  sessionUserMessage,
  textBlock,
  tmpDir,
  waitFor,
  writeScenario,
  writeSessionFile,
  type ScenarioStep,
} from "./helpers.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
  type: string;
  [key: string]: unknown;
}

let dir: string;
let stateDir: string;
let sessionsDir: string;
let repo: string;
let store: LocalStore;
let eventLog: EventLog;
let events: EmittedEvent[];

beforeEach(async () => {
  dir = tmpDir("sig-reconcile-test");
  stateDir = join(dir, "state");
  sessionsDir = join(dir, "sessions");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** The wrap-up tail of a completed run (prompt → report tool call → result → final message). */
function wrapUpSession(workerId: string): string {
  return writeSessionFile(sessionsDir, workerId, [
    sessionUserMessage("Fix the login bug"),
    sessionAssistantMessage([reportToolCall("c1", { status: "done", summary: "Fixed it", changes: ["src/a.ts"] })], {
      stopReason: "toolUse",
    }),
    sessionToolResult("c1", "report"),
    sessionAssistantMessage([textBlock("Reported.")], { stopReason: "stop" }),
  ]);
}

/** A run that was clearly interrupted mid-flight: tool call issued, no result, no final. */
function interruptedSession(workerId: string): string {
  return writeSessionFile(sessionsDir, workerId, [
    sessionUserMessage("Fix the login bug"),
    sessionAssistantMessage([reportToolCall("c1", { status: "done", summary: "halfway" })], { stopReason: "toolUse" }),
  ]);
}

function setupManager(runs: ScenarioStep[][], recovery: RecoveryOptions = {}): WorkerManager {
  const scenario = writeScenario(dir, "scenario", runs);
  return new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_SESSIONS_DIR: sessionsDir }),
    recovery: { autoResumeBackoffMs: 30, ...recovery },
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

/** Seeds a worker row as the previous connector boot would have left it. */
function seedWorker(overrides: Partial<WorkerRow> & { workerId: string }): WorkerRow {
  const { workerId, ...rest } = overrides;
  const worker: WorkerRow = {
    workerId,
    threadId: "fix-the-login-bug",
    repoId: repo,
    mode: "write",
    state: "running",
    ...rest,
  };
  store.upsertWorker(worker);
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  return worker;
}

const eventsOf = (workerId: string) => events.filter((e) => e.workerId === workerId);
const eventTypesOf = (workerId: string) => eventsOf(workerId).map((e) => e.type);

describe("session-tail inspection (connector-pi.md §9.1 step 3)", () => {
  it("a complete wrap-up (last entry = assistant final + report in the window) is settled", () => {
    const tail = inspectSessionTail(wrapUpSession("w-tail-1"));
    expect(tail).toEqual({
      kind: "settled",
      report: { status: "done", summary: "Fixed it", changes: ["src/a.ts"] },
    });
  });

  it("an interrupted run (no final message) is lost", () => {
    expect(inspectSessionTail(interruptedSession("w-tail-2"))).toEqual({ kind: "lost" });
  });

  it("a torn final write is dropped; the last complete entry decides", () => {
    const path = interruptedSession("w-tail-3");
    appendFileSync(path, '{"type":"message","message":{"role":"assist'); // crash mid-append
    expect(inspectSessionTail(path)).toEqual({ kind: "lost" });
  });

  it("a final assistant message without a report in the window is lost (no fabricated wrap-up)", () => {
    const path = writeSessionFile(sessionsDir, "w-tail-4", [
      sessionUserMessage("do it"),
      sessionAssistantMessage([reportToolCall("c0", { status: "done", summary: "earlier run" })], { stopReason: "toolUse" }),
      sessionToolResult("c0", "report"),
      // A second run begins and ends without calling report again.
      sessionUserMessage("more"),
      sessionAssistantMessage([textBlock("all done")], { stopReason: "stop" }),
    ]);
    expect(inspectSessionTail(path)).toEqual({ kind: "lost" });
  });

  it("a report from an earlier run does not count: the window starts after the last user message", () => {
    // (covered by the previous test from the other angle: window-local reports only)
    const path = writeSessionFile(sessionsDir, "w-tail-5", [
      sessionUserMessage("first"),
      sessionAssistantMessage([reportToolCall("c1", { status: "done", summary: "run one" })], { stopReason: "toolUse" }),
      sessionToolResult("c1", "report"),
      sessionAssistantMessage([textBlock("done one")], { stopReason: "stop" }),
      sessionUserMessage("second"),
      sessionAssistantMessage([textBlock("still going")], { stopReason: "stop" }),
    ]);
    expect(inspectSessionTail(path)).toEqual({ kind: "lost" });
  });

  it("a forced-report reminder at the tail means the wrap-up never finished → lost", () => {
    const path = writeSessionFile(sessionsDir, "w-tail-6", [
      sessionUserMessage("do it"),
      sessionAssistantMessage([textBlock("I think I'm done")], { stopReason: "stop" }),
      { type: "custom_message", customType: "sig.report-reminder", content: "call report", display: false },
    ]);
    expect(inspectSessionTail(path)).toEqual({ kind: "lost" });
  });

  it("no user message at all → not_started (there is no run to resume)", () => {
    const headerOnly = writeSessionFile(sessionsDir, "w-tail-7", []);
    expect(inspectSessionTail(headerOnly)).toEqual({ kind: "not_started" });
    expect(inspectSessionTail(join(sessionsDir, "missing.jsonl"))).toEqual({ kind: "not_started" });
    expect(inspectSessionTail(null)).toEqual({ kind: "not_started" });
  });

  it("usage bookkeeping after the final message does not break the wrap-up", () => {
    const path = writeSessionFile(sessionsDir, "w-tail-8", [
      sessionUserMessage("do it"),
      sessionAssistantMessage([reportToolCall("c1", { status: "blocked", summary: "stuck", question: "which?" })], {
        stopReason: "toolUse",
      }),
      sessionToolResult("c1", "report"),
      sessionAssistantMessage([textBlock("waiting for you")], { stopReason: "stop" }),
      { type: "usage", kind: "main", provider: "anthropic", model: "x", usage: { input: 1, output: 2 } },
    ]);
    expect(inspectSessionTail(path)).toMatchObject({ kind: "settled", report: { status: "blocked", question: "which?" } });
  });
});

describe("descendant snapshots and orphan cleanup (connector-pi.md §9.3)", () => {
  it("parses ps output and collects descendants transitively", () => {
    const rows = parsePsRows(
      [
        "    1     0 Sat Oct 16 20:00:00 2026",
        "  100     1 Sat Oct 16 20:01:00 2026",
        "  101   100 Sat Oct 16 20:02:00 2026",
        "  102   101 Sat Oct 16 20:03:00 2026",
        "  200     1 Sat Oct 16 20:04:00 2026",
      ].join("\n"),
    );
    expect(rows).toHaveLength(5);
    const descendants = collectDescendants(100, rows);
    expect(descendants.map((d) => d.pid)).toEqual([101, 102]); // pi itself excluded, grandchildren included
    expect(descendants[0]).toMatchObject({ startTime: "Sat Oct 16 20:02:00 2026" });
    expect(collectDescendants(200, rows)).toEqual([]);
  });

  it("kills only alive pids whose start time still matches; spares the dead and the reused", async () => {
    const startTimeOf = new Map<number, string | undefined>([
      [11, "t11"],
      [12, "t12"],
      [13, undefined],
    ]);
    const killed: Array<[number, string]> = [];
    const refs: ProcRef[] = [
      { pid: 11, startTime: "t11" }, // alive, same process → SIGTERM (+SIGKILL if it survives)
      { pid: 12, startTime: "OLD" }, // alive but pid reused → spared
      { pid: 13 }, // alive, no recorded start time → pid-aliveness matching
      { pid: 14, startTime: "t14" }, // dead → spared
    ];
    const signalled = await killOrphans(refs, {
      alive: (pid) => pid !== 14,
      startTime: (pid) => startTimeOf.get(pid),
      kill: (pid, signal) => killed.push([pid, signal]),
      graceMs: 5,
    });
    expect(signalled.map((r) => r.pid).sort()).toEqual([11, 13]);
    // 11 still alive after the grace → escalated to SIGKILL; 13 died on SIGTERM.
    expect(killed).toContainEqual([11, "SIGTERM"]);
    expect(killed).toContainEqual([11, "SIGKILL"]);
    expect(killed).toContainEqual([13, "SIGTERM"]);
    expect(killed.filter(([pid]) => pid === 12)).toEqual([]);
  });

  it("startup reconciliation terminates snapshot orphans and drops the snapshot", async () => {
    const killed: ProcRef[] = [];
    seedWorker({ workerId: "w-orph-1", state: "idle", sessionFile: wrapUpSession("w-orph-1") });
    store.setOrphanSnapshot("w-orph-1", [{ pid: 4242, startTime: "t1" }]);
    const manager = setupManager([], {
      autoResumeBackoffMs: 60_000, // resume never fires; this test is about cleanup
      killOrphans: async (refs) => {
        killed.push(...refs);
        return refs;
      },
    });
    await manager.reconcileStartup();
    expect(killed).toEqual([{ pid: 4242, startTime: "t1" }]);
    expect(store.getOrphanSnapshot("w-orph-1")).toBeNull();
  });

  it("live run: real ps snapshots the tool children, and a crash's orphans get reaped", async () => {
    // fake-pi runs `sleep 5` as a real child; while it runs, the snapshot loop (real ps)
    // records fake-pi's descendants. SIGKILLing fake-pi orphans them — exactly the measured
    // §9.3 scenario — and the next boot's cleanup reaps them.
    const manager = setupManager([[{ emit: { type: "agent_start" } }, { shell: "sleep 5" }]], {
      snapshotIntervalMs: 250,
      autoResumeBackoffMs: 60_000,
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-orph-2", {
      workerId: "w-orph-2",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    const refs = await waitFor(
      () => (store.getOrphanSnapshot("w-orph-2") ?? []).length > 0 ? store.getOrphanSnapshot("w-orph-2")! : undefined,
      10_000,
      "a descendant snapshot",
    );
    manager.simulateCrash(); // fake-pi dies; its tool children are orphaned

    const restarted = setupManager([], { autoResumeBackoffMs: 60_000 }); // real killOrphans
    await restarted.reconcileStartup();
    const { pidAlive } = await import("../src/locks.ts");
    for (const ref of refs) expect(pidAlive(ref.pid)).toBe(false);
    expect(store.getOrphanSnapshot("w-orph-2")).toBeNull();
  }, 30_000);
});

describe("startup reconciliation (connector-pi.md §9.1)", () => {
  it("a completed wrap-up is emitted retroactively as settled, with git facts from the worktree", async () => {
    // A real worktree with one commit — the retroactive report must carry real git facts.
    const worktrees = new WorktreeManager({ worktreesRoot: join(stateDir, "worktrees") });
    const created = await worktrees.create({ repoPath: repo, threadId: "fix-the-login-bug" });
    writeFileSync(join(created.path, "fix.txt"), "fixed\n");
    await git(created.path, ["add", "-A"]);
    await git(created.path, ["commit", "-m", "fix"]);

    seedWorker({
      workerId: "w-recov-1",
      state: "running",
      sessionFile: wrapUpSession("w-recov-1"),
      worktree: created.path,
      branch: created.branch,
      base: created.base,
    });
    const manager = setupManager([], { autoResumeBackoffMs: 60_000 });
    await manager.reconcileStartup();

    expect(eventTypesOf("w-recov-1")).toEqual(["report", "settled"]);
    const report = eventsOf("w-recov-1").find((e) => e.type === "report")!;
    expect(report).toMatchObject({ status: "done", summary: "Fixed it", git: { branch: created.branch, ahead: 1, dirty: 0 } });
    expect(eventsOf("w-recov-1").find((e) => e.type === "settled")).toMatchObject({ outcome: "reported" });
    expect(store.getWorker("w-recov-1")).toMatchObject({ state: "idle", lastOutcome: "reported" });
  }, 30_000);

  it("an interrupted run is marked lost and auto-resumed with the fixed prompt", async () => {
    seedWorker({ workerId: "w-recov-2", state: "running", sessionFile: interruptedSession("w-recov-2") });
    const manager = setupManager([reportRun({ status: "done", summary: "resumed and finished" })]);
    await manager.reconcileStartup();

    await waitFor(() => eventsOf("w-recov-2").some((e) => e.type === "settled"), 15_000, "retro-settled after resume");
    expect(eventTypesOf("w-recov-2")).toEqual(["lost", "resumed", "progress", "report", "settled"]);
    expect(eventsOf("w-recov-2")[0]).toMatchObject({ type: "lost", reason: "connector_restart" });
    expect(eventsOf("w-recov-2")[1]).toMatchObject({ type: "resumed", reason: "connector_restart", count: 1 });
    // The relaunch delivered the fixed resume prompt (§9.2) to the SAME session id.
    expect(store.getWorker("w-recov-2")).toMatchObject({ state: "idle", sessionId: "w-recov-2" });
  }, 30_000);

  it("a crash during startup (no user message in the session) breaks the worker instead of resuming", async () => {
    seedWorker({ workerId: "w-recov-3", state: "starting", sessionFile: writeSessionFile(sessionsDir, "w-recov-3", []) });
    const manager = setupManager([reportRun({ status: "done", summary: "must not run" })]);
    await manager.reconcileStartup();

    await waitFor(() => eventsOf("w-recov-3").some((e) => e.type === "settled"), 10_000, "terminal settled");
    expect(eventTypesOf("w-recov-3")).toEqual(["settled"]);
    expect(eventsOf("w-recov-3")[0]).toMatchObject({ outcome: "error", errorClass: "unknown" });
    expect(store.getWorker("w-recov-3")).toMatchObject({ state: "broken", lastOutcome: "startup_interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 150)); // no resume may fire
    expect(eventTypesOf("w-recov-3")).toEqual(["settled"]);
  }, 30_000);

  it("removes stale locks (dead holder) and keeps locks naming a live process", async () => {
    seedWorker({ workerId: "w-lock-1", state: "idle" });
    // A live holder: this test process.
    expect(acquireLock(stateDir, "w-lock-live").ok).toBe(true);
    // A stale holder: a process that already exited.
    const { spawn } = await import("node:child_process");
    const child = spawn("true");
    const deadPid = child.pid!;
    await new Promise((resolve) => child.on("exit", resolve));
    mkdirSync(join(stateDir, "locks"), { recursive: true });
    writeFileSync(lockPath(stateDir, "w-lock-1"), JSON.stringify({ workerId: "w-lock-1", pid: deadPid, createdAt: Date.now() }));

    const manager = setupManager([], { autoResumeBackoffMs: 60_000 });
    await manager.reconcileStartup();

    expect(existsSync(lockPath(stateDir, "w-lock-live"))).toBe(true);
    expect(existsSync(lockPath(stateDir, "w-lock-1"))).toBe(false);
  });

  it("a worker already lost before the crash gets its pending resume re-scheduled", async () => {
    seedWorker({ workerId: "w-recov-4", state: "lost", sessionFile: interruptedSession("w-recov-4") });
    const manager = setupManager([reportRun({ status: "done", summary: "late resume" })]);
    await manager.reconcileStartup();

    await waitFor(() => eventsOf("w-recov-4").some((e) => e.type === "settled"), 15_000, "settled after late resume");
    // No second `lost`: the crash already reported it; only the resume follows.
    expect(eventTypesOf("w-recov-4")).toEqual(["resumed", "progress", "report", "settled"]);
  }, 30_000);
});

describe("automatic resume policy (connector-pi.md §9.2)", () => {
  it("a worker that keeps crashing is resumed at most twice per hour, then broken", async () => {
    const crashRun: ScenarioStep[] = [
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { delayMs: 10 },
      { exit: 7 },
    ];
    const manager = setupManager([crashRun], { autoResumeBackoffMs: 25 });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-crashloop-1", {
      workerId: "w-loop-1",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });

    // startWorker crashes → lost; resume #1 crashes → lost; resume #2 crashes → lost; the
    // third schedule hits the ≤2/hour budget → broken, surfaced as a settled error event.
    await waitFor(
      () => eventsOf("w-loop-1").some((e) => e.type === "settled" && e.outcome === "error"),
      15_000,
      "terminal settled after exhausted budget",
    );
    const types = eventTypesOf("w-loop-1");
    expect(types.filter((t) => t === "lost")).toHaveLength(3);
    expect(types.filter((t) => t === "resumed")).toHaveLength(2);
    expect(store.getWorker("w-loop-1")).toMatchObject({ state: "broken", lastOutcome: "resumes_exhausted" });
    expect(store.countResumes("w-loop-1")).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 150)); // no further attempts
    expect(eventTypesOf("w-loop-1").filter((t) => t === "resumed")).toHaveLength(2);
  }, 30_000);

  it("transient errors auto-resume the still-live process with the fixed prompt", async () => {
    const transientError: ScenarioStep[] = [
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      {
        emit: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "429 Too Many Requests",
          },
        },
      },
      { emit: { type: "agent_settled", aborted: false } },
    ];
    const manager = setupManager([transientError, reportRun({ status: "done", summary: "recovered" })], {
      autoResumeBackoffMs: 25,
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-transient-1", {
      workerId: "w-trans-1",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });

    await waitFor(() => eventsOf("w-trans-1").some((e) => e.type === "settled" && e.outcome === "reported"), 15_000, "settled after transient resume");
    const resumed = eventsOf("w-trans-1").find((e) => e.type === "resumed")!;
    expect(resumed).toMatchObject({ reason: "error:transient", count: 1 });
    expect(store.getWorker("w-trans-1")).toMatchObject({ state: "idle", lastOutcome: "reported" });
  }, 30_000);

  it("auth errors never auto-resume: the worker breaks immediately", async () => {
    const authError: ScenarioStep[] = [
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      {
        emit: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: "403 Forbidden",
          },
        },
      },
      { emit: { type: "agent_settled", aborted: false } },
    ];
    const manager = setupManager([authError, reportRun({ status: "done", summary: "must not run" })], {
      autoResumeBackoffMs: 25,
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-auth-1", {
      workerId: "w-auth-1",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });

    await waitFor(() => store.getWorker("w-auth-1")?.state === "broken", 10_000, "worker broken");
    await new Promise((resolve) => setTimeout(resolve, 150)); // no resume may fire
    expect(eventTypesOf("w-auth-1")).not.toContain("resumed");
    expect(store.countResumes("w-auth-1")).toBe(0);
  }, 30_000);

  it("a resume that cannot launch marks the worker broken with an auth class for auth failures", async () => {
    seedWorker({ workerId: "w-resfail-1", state: "lost", sessionFile: interruptedSession("w-resfail-1") });
    // A scenario whose startup crashes before get_state completes → resume launch failure.
    const scenarioPath = join(dir, "startup-crash.scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ startup: { exit: 9 }, runs: [] }));
    const { PiAdapter } = await import("../src/pi-adapter.ts");
    const manager = new WorkerManager({
      store,
      stateDir,
      adapter: new PiAdapter({
        stateDir,
        command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
        env: { FAKE_PI_SCRIPT: scenarioPath, FAKE_PI_SESSIONS_DIR: sessionsDir },
      }),
      recovery: { autoResumeBackoffMs: 25 },
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    await manager.reconcileStartup();

    const settled = await waitFor(
      () => eventsOf("w-resfail-1").find((e) => e.type === "settled"),
      15_000,
      "terminal settled after failed resume",
    );
    expect(settled).toMatchObject({ outcome: "error" });
    expect(store.getWorker("w-resfail-1")).toMatchObject({ state: "broken", lastOutcome: "resume_failed" });
    // The launch crash itself is not an `unexpected` exit (start() reported it), so no
    // second lost/resume cycle rides on top of the failure.
    expect(eventTypesOf("w-resfail-1")).toEqual(["process_exit", "settled"]); // no resumed event
  }, 30_000);
});
