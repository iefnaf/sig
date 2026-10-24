import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { VERSION } from "../src/version.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { isLockHeld, lockPath } from "../src/locks.ts";
import {
  assistantTurn,
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
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
const workerIds = new Set<string>();

beforeEach(async () => {
  dir = tmpDir("sig-worker-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
});

afterEach(async () => {
  // Reclaim any fake-pi processes still holding a session (they wait on stdin), then let
  // in-flight event microtasks settle before the store goes away.
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** Builds a manager wired to fake-pi with the given scenario. Events go through a real
 * EventLog (the same persist-and-send ConnectorClient.emit performs), so seq assignment and
 * the "persisted before send" ordering (§11.3) are exercised structurally. */
function setup(runs: ScenarioStep[][]): void {
  const scenario = writeScenario(dir, "scenario", runs);
  manager = new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario),
    emit: (workerId, fields) => {
      // Persist first (this is what client.emit does before batching to the wire)…
      const stored = eventLog.append(workerId, fields);
      // …then the wire side sees the durable payload.
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  const merged: StartWorkerArgs = {
    workerId: "w-test-worker-1",
    threadId: "fix-the-login-bug",
    repoId: repo,
    mode: "write",
    prompt: "Fix the login bug",
    ...overrides,
  };
  workerIds.add(merged.workerId);
  return merged;
}

const settled = () => events.find((e) => e.type === "settled");
const reportEvent = () => events.find((e) => e.type === "report");
const eventTypes = () => events.map((e) => e.type);

describe("WorkerManager over fake-pi (connector-pi.md §4–§8, §11)", () => {
  it("happy path: started, throttled progress, report merged with git facts, settled", async () => {
    setup([
      reportRun(
        { status: "done", summary: "Fixed the login bug", changes: ["src/auth/login.ts"] },
        { shellBefore: "echo fix > fix.txt && git add -A && git commit -m fix", tool: "edit" },
      ),
    ]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });

    const result = await manager.startWorker("cmd-happy-1", args());
    await waitFor(() => settled(), 15_000, "settled event");

    // start_worker resolves once running (§6.3), with the worktree facts.
    expect(result.sessionId).toBe("w-test-worker-1");
    expect(result.branch).toBe("sig/fix-the-login-bug-1");
    expect(result.cwd).toMatch(/state\/worktrees\/repo-a-[0-9a-f]{8}\/fix-the-login-bug-1$/);
    expect(result.worktree).toBe(result.cwd);
    expect(existsSync(join(result.cwd!, "fix.txt"))).toBe(true);

    // Event order: started … progress … report … settled (§11.1).
    expect(events[0]).toMatchObject({ type: "started", seq: 1, sessionId: "w-test-worker-1", branch: result.branch, cwd: result.cwd });
    expect(eventTypes().indexOf("report")).toBeLessThan(eventTypes().indexOf("settled"));

    // The report event merges the model's report with git facts (§7.2) — the fake committed
    // one change on the worktree branch.
    expect(reportEvent()).toMatchObject({
      type: "report",
      status: "done",
      summary: "Fixed the login bug",
      changes: ["src/auth/login.ts"],
      git: { branch: "sig/fix-the-login-bug-1", ahead: 1, dirty: 0, filesChanged: 1, pushed: false },
    });

    expect(settled()).toMatchObject({
      type: "settled",
      outcome: "reported",
      usage: { tokens: { input: 1200 }, cost: 0.0042 },
    });

    // Events persisted with contiguous per-worker seqs; worker state updated.
    const stored = eventLog.pending("w-test-worker-1").map((e) => JSON.parse(e.payload) as { seq: number });
    expect(stored.map((e) => e.seq)).toEqual(stored.map((_, i) => i + 1));
    expect(store.getWorker("w-test-worker-1")).toMatchObject({ state: "idle", lastOutcome: "reported" });
    // §4.1: after settling the process stays for the idle window (idle-hot), so the lock is
    // still held; stop_process reclaims it and releases the lock.
    expect(isLockHeld(stateDir, "w-test-worker-1")).toBe(true);
    await manager.stopProcess("w-test-worker-1");
    await waitFor(() => !existsSync(lockPath(stateDir, "w-test-worker-1")), 10_000, "lock released");
  }, 30_000);

  it("throttles progress: repeated same-tool activity emits one event", async () => {
    const manyTools: ScenarioStep[] = [];
    for (let i = 0; i < 5; i++) {
      manyTools.push({ emit: { type: "tool_execution_start", toolCallId: `t${i}`, toolName: "bash", args: { command: `echo ${i}` } } });
      manyTools.push({ emit: { type: "tool_execution_end", toolCallId: `t${i}`, toolName: "bash", result: {}, isError: false } });
    }
    setup([
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        ...manyTools,
        { emit: { type: "agent_settled", aborted: false } },
      ],
    ]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-prog-1", args());
    await waitFor(() => settled(), 15_000, "settled event");

    const progress = events.filter((e) => e.type === "progress") as unknown as { tool: string; target?: string }[];
    // The thinking event emits immediately; every bash event within the next 5 seconds is
    // suppressed by the absolute cap (§11.2: "never more than one per 5 seconds in any case",
    // which wins over "emit immediately when the tool type changes").
    expect(progress.length).toBe(1);
    expect(progress[0]).toMatchObject({ phase: "thinking", turn: 1 });
    expect(settled()).toMatchObject({ outcome: "unreported" });
  }, 30_000);

  it("unreported: no report call → settled carries the last assistant text", async () => {
    setup([assistantTurn("I think the fix is done now.")]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-unrep-1", args());
    await waitFor(() => settled(), 15_000, "settled event");

    expect(reportEvent()).toBeUndefined();
    expect(settled()).toMatchObject({ outcome: "unreported", lastText: "I think the fix is done now." });
    expect(store.getWorker("w-test-worker-1")?.lastOutcome).toBe("unreported");
  }, 30_000);

  it("error after three retries: settled outcome error with the auth class", async () => {
    const errorRun: ScenarioStep[] = [
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { emit: { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } } },
      { emit: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "403 Forbidden" } },
      { emit: { type: "auto_retry_end", success: true, attempt: 1 } },
      { emit: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 0, errorMessage: "403 Forbidden" } },
      { emit: { type: "auto_retry_end", success: true, attempt: 2 } },
      { emit: { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "403 Forbidden" } },
      {
        emit: {
          type: "auto_retry_end",
          success: false,
          attempt: 3,
          finalError: "403 Forbidden after 3 attempts",
        },
      },
      {
        emit: {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "403 Forbidden" },
        },
      },
      { emit: { type: "agent_end", willRetry: false } },
      { emit: { type: "agent_settled", aborted: false } },
    ];
    setup([errorRun]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-err-1", args());
    await waitFor(() => settled(), 15_000, "settled event");

    expect(settled()).toMatchObject({ outcome: "error", errorClass: "auth" });
    // No report event may mask the failure (§5.2 ordering).
    expect(reportEvent()).toBeUndefined();
    // §9.2: auth errors never auto-resume — the connector is done with this worker.
    expect(store.getWorker("w-test-worker-1")).toMatchObject({ state: "broken", lastOutcome: "error:auth" });
  }, 30_000);

  it("aborted: settled outcome aborted", async () => {
    setup([
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { emit: { type: "agent_settled", aborted: true } },
      ],
    ]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-abort-1", args());
    await waitFor(() => settled(), 15_000, "settled event");

    expect(settled()).toMatchObject({ outcome: "aborted" });
  }, 30_000);

  it("crash: unexpected exit mid-run emits process_exit and marks the worker lost", async () => {
    setup([
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { delayMs: 30 },
        { exit: 7 },
      ],
    ]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-crash-1", args());
    await waitFor(() => events.some((e) => e.type === "lost"), 15_000, "lost event");

    expect(events.some((e) => e.type === "process_exit" && e.code === 7)).toBe(true);
    expect(settled()).toBeUndefined(); // no fabricated outcome for a crash
    expect(store.getWorker("w-test-worker-1")).toMatchObject({ state: "lost", lastOutcome: "crash" });
    await waitFor(() => !isLockHeld(stateDir, "w-test-worker-1"), 10_000, "lock released after crash");
  }, 30_000);

  it("rejects images over the 4 MB base64 entrance check (§6.2)", async () => {
    setup([assistantTurn("x")]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    const big = "A".repeat(4 * 1024 * 1024 + 1);
    await expect(
      manager.startWorker("cmd-img-1", args({ images: [{ data: big, mimeType: "image/png" }] })),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(events.length).toBe(0);
  });

  it("rejects unregistered repos with not_registered_repo (§8.1)", async () => {
    setup([assistantTurn("x")]);
    await expect(manager.startWorker("cmd-repo-1", args({ repoId: "/definitely/not/registered" }))).rejects.toMatchObject({
      code: "not_registered_repo",
    });
    expect(events.length).toBe(0);
  }, 30_000);

  it("rejects with lock_held while the lock names a live process (§4.3)", async () => {
    setup([assistantTurn("x")]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    // Hold the lock from a live process (this test process).
    const { acquireLock } = await import("../src/locks.ts");
    const held = acquireLock(stateDir, "w-test-worker-1");
    expect(held.ok).toBe(true);

    await expect(manager.startWorker("cmd-lock-1", args())).rejects.toMatchObject({ code: "lock_held" });
  }, 30_000);

  it("startup failure: worker broken, command failed, lock released (§5.1)", async () => {
    const scenarioPath = join(dir, "startup-crash.scenario.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(scenarioPath, JSON.stringify({ startup: { exit: 9 }, runs: [] }));
    const { PiAdapter } = await import("../src/pi-adapter.ts");
    const adapter = new PiAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
      env: { FAKE_PI_SCRIPT: scenarioPath },
      getStateTimeoutMs: 5000,
    });
    manager = new WorkerManager({
      store,
      stateDir,
      adapter,
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });

    await expect(manager.startWorker("cmd-startup-1", args())).rejects.toMatchObject({ code: "startup_failed" });
    expect(store.getWorker("w-test-worker-1")?.state).toBe("broken");
    expect(isLockHeld(stateDir, "w-test-worker-1")).toBe(false);
  }, 30_000);

  it("readonly mode: no worktree, cwd is the repository itself", async () => {
    setup([reportRun({ status: "done", summary: "read only" })]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    const result = await manager.startWorker("cmd-ro-1", args({ mode: "readonly" }));
    await waitFor(() => settled(), 15_000, "settled event");

    expect(result.cwd).toBe(repo);
    expect(result.worktree).toBeUndefined();
    expect(result.branch).toBeUndefined();
    // No git facts on readonly reports (facts are worktree write-task territory).
    expect(reportEvent()).not.toHaveProperty("git");
  }, 30_000);

  it("delivers the prompt through the /sig commandId wrapper (ADR-0001)", async () => {
    const logPath = join(dir, "prompts.log");
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "s" })]);
    const { PiAdapter } = await import("../src/pi-adapter.ts");
    const adapter = new PiAdapter({
      stateDir,
      command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
      env: { FAKE_PI_SCRIPT: scenario, FAKE_PI_LOG: logPath },
    });
    manager = new WorkerManager({
      store,
      stateDir,
      adapter,
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });

    await manager.startWorker("cmd-marker-1", args({ prompt: "Fix the login bug" }));
    await waitFor(() => settled(), 15_000, "settled event");

    const logged = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { commandId?: string; text?: string; type?: string })
      // FAKE_PI_LOG also records pi-side settles (the settle-lag sync point); this test
      // cares only about the prompt delivery and its ADR-0001 marker. The log now also
      // carries cwd/sessionId/pid (issue #13's watchdog tests compare the two respawned
      // processes' cwds), so match on the fields this test cares about.
      .filter((entry) => entry.commandId !== undefined);
    expect(logged).toEqual([
      expect.objectContaining({ commandId: "cmd-marker-1", text: "Fix the login bug", at: expect.any(Number) }),
    ]);
  }, 30_000);

  it("writes the sig extension into the state dir, not referencing the repo (§4.2)", async () => {
    setup([reportRun({ status: "done", summary: "s" })]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    await manager.startWorker("cmd-assets-1", args());
    await waitFor(() => settled(), 15_000, "settled event");
    const ext = join(stateDir, "ext", `sig-pi-${VERSION}.ts`);
    const prompt = join(stateDir, "prompts", `worker-${VERSION}.md`);
    expect(existsSync(ext)).toBe(true);
    expect(existsSync(prompt)).toBe(true);
    expect(readFileSync(ext, "utf8")).toContain("sig.report-reminder");
    expect(readFileSync(prompt, "utf8")).toContain("report");
  }, 30_000);

});
