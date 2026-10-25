// Issue #16 (spec §11, connector-pi.md §8.2/§8.3/§13): read-only tasks run in the repo's own
// checkout with a restricted tool set; per repo the owner picks worktree (default) / serial /
// main checkout via the local CLI; approveProject is a connector-local setting that a command
// must never set; cleanup_worktree refuses dirty or unpushed worktrees unless forced, and
// nothing is ever auto-deleted.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAssets } from "../src/install.ts";
import { PiAdapter } from "../src/pi-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { CommandError, WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { EventLog } from "../src/events.ts";
import { lockPath } from "../src/locks.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
} from "./helpers.ts";
import { git } from "./helpers.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
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
  dir = tmpDir("sig-workspace-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
});

afterEach(async () => {
  // Take the manager out of service first (no queue pumps or launches may fire once the
  // store starts closing), then reclaim any fake-pi processes still holding a session.
  manager?.stop();
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function setup(runs: ScenarioStep[][], extraEnv: Record<string, string> = {}): void {
  const scenario = writeScenario(dir, "scenario", runs);
  manager = new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario, extraEnv),
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

// Legacy three-value vocabulary kept at the test's call sites (unrelated to this layer's
// scope); mapped here onto the isolation/concurrency axes it decomposes into.
function registerRepo(workspace?: "worktree" | "serial" | "main", approved = false): void {
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  if (workspace !== undefined) {
    const policy =
      workspace === "worktree"
        ? { isolation: "worktree" as const, concurrency: "parallel" as const }
        : workspace === "serial"
          ? { isolation: "worktree" as const, concurrency: "serial" as const }
          : { isolation: "in-place" as const, concurrency: "parallel" as const };
    store.setWritePolicy(repo, policy);
  }
  if (approved) store.setApproved(repo, true);
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  const merged: StartWorkerArgs = {
    workerId: "w-ws-test-1",
    threadId: "the-thread",
    repoId: repo,
    mode: "write",
    prompt: "Do the thing",
    ...overrides,
  };
  workerIds.add(merged.workerId);
  return merged;
}

const settledOf = (workerId: string) => events.find((e) => e.type === "settled" && e.workerId === workerId);
const startedOf = (workerId: string) => events.find((e) => e.type === "started" && e.workerId === workerId);

describe("buildArgs: the §4.2 command line", () => {
  // Built lazily inside each test: the shared `dir` fixture exists only after beforeEach.
  const base = { workerId: "w-x", threadId: "t", cwd: "/repo", prompt: "p", commandId: "c" };

  it("readonly runs with the §8.3 tool whitelist; write runs unrestricted", () => {
    const adapter = new PiAdapter({ stateDir });
    const assets = installAssets(join(dir, "assets"));
    const readonlyArgs = adapter.buildArgs({ ...base, mode: "readonly" }, assets);
    const writeArgs = adapter.buildArgs({ ...base, mode: "write" }, assets);
    expect(readonlyArgs).toContain("--tools");
    expect(readonlyArgs[readonlyArgs.indexOf("--tools") + 1]).toBe("read,grep,find,ls,report");
    expect(writeArgs).not.toContain("--tools");
  });

  it("--no-approve by default; --approve only via the repo's local approveProject flag (§13)", () => {
    const adapter = new PiAdapter({ stateDir });
    const assets = installAssets(join(dir, "assets"));
    expect(adapter.buildArgs({ ...base, mode: "write" }, assets)).toContain("--no-approve");
    expect(adapter.buildArgs({ ...base, mode: "readonly" }, assets)).not.toContain("--approve");
    const approved = adapter.buildArgs({ ...base, mode: "write", approveProject: true }, assets);
    expect(approved).toContain("--approve");
    expect(approved).not.toContain("--no-approve");
  });
});

describe("read-only tasks (spec §11, connector-pi.md §8.3)", () => {
  it("run in the repository's own checkout — no worktree — with the restricted tools", async () => {
    const argvLog = join(dir, "argv.jsonl");
    setup([reportRun({ status: "done", summary: "read everything" })], { FAKE_PI_ARGV_LOG: argvLog });
    registerRepo();

    const result = await manager.startWorker("cmd-ro-1", args({ mode: "readonly" }));
    await waitFor(() => settledOf("w-ws-test-1"), 15_000, "settled event");

    expect(result.cwd).toBe(repo); // §8.3: the original directory, never a worktree
    expect(result.worktree).toBeUndefined();
    expect(result.branch).toBeUndefined();
    expect(store.getWorker("w-ws-test-1")).toMatchObject({ mode: "readonly", worktree: null, branch: null });

    // The real spawn carried the §8.3 whitelist (research #16: no write/exec tools).
    const argv = JSON.parse(readFileSync(argvLog, "utf8")) as string[];
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls,report");
    // No worktree directory was created under the connector's state.
    expect(existsSync(join(stateDir, "worktrees"))).toBe(false);
  }, 30_000);
});

describe("per-repo workspace modes (spec §11, connector-pi.md §8.2)", () => {
  it("defaults to worktree: every write task gets its own worktree", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo(); // no explicit config

    const result = await manager.startWorker("cmd-wt-1", args());
    await waitFor(() => settledOf("w-ws-test-1"), 15_000, "settled event");
    expect(result.worktree).toMatch(/worktrees\/repo-a-[0-9a-f]{8}\/the-thread-1$/);
    expect(store.getRepo(repo)).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "parallel" }, approved: false });
  }, 30_000);

  it("main mode: write tasks run directly in the checkout, base is ignored", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo("main");
    await git(repo, ["branch", "some-other-base"]);

    const result = await manager.startWorker("cmd-main-1", args({ base: "some-other-base" }));
    await waitFor(() => settledOf("w-ws-test-1"), 15_000, "settled event");

    expect(result.cwd).toBe(repo);
    expect(result.worktree).toBeUndefined();
    expect(result.branch).toBeUndefined();
    // The checkout stayed where the owner left it — the connector never switches branches there.
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(existsSync(join(stateDir, "worktrees"))).toBe(false);
  }, 30_000);

  it("serial mode: a second write worker queues and starts when the first settles", async () => {
    const slowFirst: ScenarioStep[] = [
      { delayMs: 1500 },
      ...reportRun({ status: "done", summary: "first done" }, { shellBefore: "echo one > one.txt" }),
    ];
    setup([slowFirst]);
    registerRepo("serial");

    const first = await manager.startWorker("cmd-ser-1", args({ workerId: "w-ser-1" }));
    expect(first.queued).toBeUndefined();
    expect(store.getWorker("w-ser-1")?.state).toBe("running");

    // The second write task for the same repo queues (§8.2): FIFO, one at a time.
    const second = await manager.startWorker("cmd-ser-2", args({ workerId: "w-ser-2", threadId: "second-thread" }));
    expect(second).toMatchObject({ queued: true, cwd: repo });
    expect(second.worktree).toBeUndefined();
    expect(store.getWorker("w-ser-2")).toMatchObject({ state: "queued", mode: "write" });
    const queuedEvent = events.find((e) => e.type === "queued" && e.workerId === "w-ser-2");
    expect(queuedEvent).toMatchObject({ behind: "w-ser-1" });
    // Nothing started behind the steward's back: no started event, no worktree yet.
    expect(startedOf("w-ser-2")).toBeUndefined();

    await waitFor(() => startedOf("w-ser-2"), 25_000, "queued worker started after the first settled");
    expect(startedOf("w-ser-2")).toMatchObject({ branch: "sig/second-thread-1" });
    await waitFor(() => settledOf("w-ser-2"), 15_000, "second worker settled");

    // The queue row is gone once launched.
    expect(store.getQueuedStart("w-ser-2")).toBeNull();
    // Serial ≠ shared directory: each write task still got its own worktree branch, and the
    // shells ran there — the repo's own checkout was never touched.
    expect(existsSync(join(repo, "one.txt"))).toBe(false);
  }, 45_000);

  it("concurrent start_worker on a serial repo: exactly one launches, the other queues (review finding 1)", async () => {
    const slow: ScenarioStep[] = [{ delayMs: 2500 }, ...reportRun({ status: "done", summary: "done" })];
    setup([slow]);
    registerRepo("serial");

    // Commands run concurrently on the connector (client.runHandler is void-fired per cmd);
    // only the synchronous claim serializes them. Before the claim this raced: both saw an
    // empty slot, both created worktrees, both ran.
    const [a, b] = await Promise.all([
      manager.startWorker("cmd-conc-1", args({ workerId: "w-conc-1" })),
      manager.startWorker("cmd-conc-2", args({ workerId: "w-conc-2", threadId: "conc-thread" })),
    ]);
    const states = [store.getWorker("w-conc-1")?.state, store.getWorker("w-conc-2")?.state].sort();
    expect(states).toEqual(["queued", "running"]); // never running + running
    expect([a.queued, b.queued].filter(Boolean)).toHaveLength(1);

    // And the queue still drains: the queued one starts when the runner settles.
    const queuedId = store.getWorker("w-conc-1")?.state === "queued" ? "w-conc-1" : "w-conc-2";
    await waitFor(() => startedOf(queuedId), 25_000, "concurrently queued worker started");
    await waitFor(() => settledOf(queuedId), 15_000, "concurrently queued worker settled");
  }, 60_000);

  it("stopping the running serial worker settles it and releases the write slot (review finding 2)", async () => {
    setup([[{ delayMs: 60_000 }, ...reportRun({ status: "done", summary: "never reached" })]]);
    registerRepo("serial");
    await manager.startWorker("cmd-f2-run", args({ workerId: "w-f2-run" }));
    const second = await manager.startWorker("cmd-f2-q", args({ workerId: "w-f2-q", threadId: "f2-thread" }));
    expect(second.queued).toBe(true);

    await manager.stopProcess("w-f2-run");
    // The stop ends the run — no phantom `running` row holding the slot until a restart.
    expect(store.getWorker("w-f2-run")).toMatchObject({ state: "idle", lastOutcome: "stopped" });
    expect(events.some((e) => e.type === "settled" && e.workerId === "w-f2-run" && e.outcome === "aborted")).toBe(true);

    // The queued worker starts without a connector restart…
    await waitFor(() => startedOf("w-f2-q"), 20_000, "queue drained after the runner was stopped");

    // …and the same stop path frees the slot again, so a brand-new write task launches
    // instead of queueing behind a ghost holder.
    await manager.stopProcess("w-f2-q");
    await waitFor(() => store.getWorker("w-f2-q")?.state === "idle", 10_000, "drained worker stopped");
    const third = await manager.startWorker("cmd-f3", args({ workerId: "w-f3", threadId: "f3-thread" }));
    expect(third.queued).toBeUndefined();
    await waitFor(() => startedOf("w-f3"), 15_000, "post-stop write task launched");
  }, 60_000);

  it("a stop racing the pump never leaves a started-after-aborted worker (review finding 3)", async () => {
    // The runner settles after 5s; the victim (same scenario, fresh process) then spends its
    // first 5s in the opening delay — so a stop issued right after the runner settles always
    // lands inside the victim's launch window or its in-flight run, never after its settle.
    setup([[{ delayMs: 5000 }, ...reportRun({ status: "done", summary: "done" })]]);
    registerRepo("serial");
    const runnerId = "w-r3-run";
    const victimId = "w-r3-victim";
    workerIds.add(runnerId);
    workerIds.add(victimId);
    await manager.startWorker("cmd-r3-1", args({ workerId: runnerId }));
    await manager.startWorker("cmd-r3-2", args({ workerId: victimId, threadId: "r3-thread" }));
    expect(store.getWorker(victimId)?.state).toBe("queued");

    // The pump fires the moment the runner settles; stop the victim right after — wherever
    // in the launch window the stop lands, the abort must win.
    await waitFor(() => settledOf(runnerId), 15_000, "runner settled");
    await manager.stopProcess(victimId);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // let any rogue launch surface

    const victimEvents = events.filter((e) => e.workerId === victimId);
    const abortedAt = victimEvents.findIndex((e) => e.type === "settled" && e.outcome === "aborted");
    const startedAt = victimEvents.findIndex((e) => e.type === "started");
    expect(abortedAt).toBeGreaterThanOrEqual(0);
    // started may only precede the abort (stop of a fully launched run), never follow it.
    expect(startedAt === -1 || startedAt < abortedAt).toBe(true);
    expect(store.getWorker(victimId)?.state).toBe("idle");
    expect(store.getQueuedStart(victimId)).toBeNull();
    await waitFor(() => !existsSync(lockPath(stateDir, victimId)), 10_000, "victim lock released");
  }, 60_000);

  it("serial mode: readonly tasks neither queue nor get blocked by the write worker", async () => {
    setup([
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { delayMs: 300 },
        { emit: { type: "agent_settled", aborted: false } },
      ],
      reportRun({ status: "done", summary: "read-only answer" }),
    ]);
    registerRepo("serial");

    await manager.startWorker("cmd-ser-slow", args({ workerId: "w-ser-slow" }));
    const ro = await manager.startWorker("cmd-ser-ro", args({ workerId: "w-ser-ro", mode: "readonly" }));
    expect(ro.queued).toBeUndefined(); // §8.3: read-only tasks are not isolated → never queued
    expect(store.getWorker("w-ser-ro")?.state).toBe("running");
    await waitFor(() => settledOf("w-ser-ro"), 15_000, "readonly settled alongside the write worker");
    await waitFor(() => settledOf("w-ser-slow"), 15_000, "write worker settled");
  }, 30_000);

  it("a connector restart re-arms the queue from the persisted start", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const runnerId = `w-rst-run-${suffix}`;
    const queuedId = `w-rst-q-${suffix}`;
    workerIds.add(runnerId);
    workerIds.add(queuedId);
    // The runner's run stays in flight (long delay) so the second write task really queues.
    setup([[{ delayMs: 10_000 }, ...reportRun({ status: "done", summary: "never reached before the crash" })]]);
    registerRepo("serial");
    await manager.startWorker("cmd-rst-1", args({ workerId: runnerId }));
    await manager.startWorker("cmd-rst-2", args({ workerId: queuedId, threadId: "queued-thread" }));
    expect(store.getWorker(queuedId)?.state).toBe("queued");
    manager.simulateCrash(); // runner in flight, queued start persisted

    // Second boot over the same state. Issue #15 made the crash-window observable: the
    // runner's prompt is now ON DISK (fake-pi persists the §6.3 marker at prompt time), so
    // its tail adjudicates interrupted → lost (not "never began" → broken), and a lost
    // runner keeps the serial slot while its auto-resume is pending. The queued worker
    // therefore starts only after the runner's story resolves: with a fast backoff and a
    // resume that settles, the slot frees and the pump launches the persisted start — its
    // command result already went out with queued:true, so losing it would have stranded
    // the Thread at `starting` forever.
    const scenario = writeScenario(dir, "scenario-boot2", [reportRun({ status: "done", summary: "resumed runner" })]);
    const manager2 = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      recovery: { autoResumeBackoffMs: 200 },
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    manager = manager2;
    await manager2.reconcileStartup();
    await waitFor(() => startedOf(queuedId), 25_000, "queued worker started after restart");
    expect(store.getQueuedStart(queuedId)).toBeNull();
    await waitFor(() => settledOf(queuedId), 15_000, "restarted queue drained");
  }, 60_000);
});

describe("approveProject is local-only (connector-pi.md §13)", () => {
  it("rejects a start_worker command that carries it, no matter the value", async () => {
    setup([[]]);
    registerRepo();
    for (const key of ["approveProject", "approve"]) {
      await expect(
        manager.handleCommand(`cmd-bad-${key}`, "start_worker", {
          ...args({ workerId: `w-bad-${key}` }),
          [key]: true,
        }),
      ).rejects.toMatchObject({ code: "local_only_setting" });
    }
    expect(events.length).toBe(0); // rejected at the entrance: nothing ran
  });

  it("a repo approved via the local CLI runs pi with --approve", async () => {
    const argvLog = join(dir, "argv.jsonl");
    setup([reportRun({ status: "done", summary: "done" })], { FAKE_PI_ARGV_LOG: argvLog });
    registerRepo("worktree", true);

    await manager.startWorker("cmd-ap-1", args());
    await waitFor(() => settledOf("w-ws-test-1"), 15_000, "settled event");
    const spawns = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(spawns.length).toBe(1); // one spawn only — no hidden second process
    const flags = JSON.parse(spawns[0]!) as string[];
    expect(flags).toContain("--approve");
    expect(flags).not.toContain("--no-approve");
  }, 30_000);
});

describe("cleanup_worktree (connector-pi.md §6.1/§8.2)", () => {
  async function finishedWorker(dirty: boolean, pushed = false): Promise<string> {
    setup([
      reportRun(
        { status: "done", summary: "done" },
        // Uncommitted change (no commit): the dirty branch of the §8.2 refusal.
        { shellBefore: dirty ? "echo dirt > dirty.txt" : "" },
      ),
    ]);
    registerRepo();
    const workerId = `w-clean-${Math.random().toString(36).slice(2, 8)}`;
    workerIds.add(workerId);
    const result = await manager.startWorker(`cmd-${workerId}`, args({ workerId }));
    await waitFor(() => settledOf(workerId), 15_000, "settled event");
    // Reclaim the idle-hot process: cleanup must never delete under a live process.
    await manager.stopProcess(workerId);
    await waitFor(() => !existsSync(lockPath(stateDir, workerId)), 10_000, "lock released");
    if (pushed) {
      // Put HEAD inside a remote-tracking ref (shared object store) so it counts as pushed.
      const head = (await git(result.worktree!, ["rev-parse", "HEAD"])).trim();
      await git(repo, ["update-ref", `refs/remotes/origin/mirror-${workerId}`, head]);
    }
    return workerId;
  }

  it("refuses a dirty worktree; force removes it", async () => {
    const workerId = await finishedWorker(true);
    const worktree = store.getWorker(workerId)!.worktree!;
    await expect(manager.cleanupWorktree(workerId, false)).rejects.toMatchObject({ code: "worktree_dirty" });
    expect(existsSync(worktree)).toBe(true); // refused means untouched

    const removed = await manager.cleanupWorktree(workerId, true);
    expect(removed.removed).toBe(worktree);
    expect(existsSync(worktree)).toBe(false);
    expect(store.getWorker(workerId)).toMatchObject({ worktree: null, branch: null });
  }, 30_000);

  it("removes a clean, pushed worktree without force", async () => {
    const workerId = await finishedWorker(false, true);
    const worktree = store.getWorker(workerId)!.worktree!;
    await expect(manager.cleanupWorktree(workerId, false)).resolves.toMatchObject({ removed: worktree });
    expect(existsSync(worktree)).toBe(false);
  }, 30_000);

  it("refuses while the worker still runs — including settled-but-idle-hot — and has nothing to do for worktree-less workers", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo();
    const runningId = "w-still-running";
    workerIds.add(runningId);
    await manager.startWorker("cmd-run", args({ workerId: runningId }));
    const worktree = store.getWorker(runningId)!.worktree!;
    await expect(manager.cleanupWorktree(runningId, true)).rejects.toMatchObject({ code: "worker_running" });
    expect(existsSync(worktree)).toBe(true); // even force never deletes under a live run

    // Settled but idle-hot: the process still lives in the directory — still refused.
    await waitFor(() => settledOf(runningId), 15_000, "settled");
    await expect(manager.cleanupWorktree(runningId, true)).rejects.toMatchObject({ code: "worker_running" });
    expect(existsSync(worktree)).toBe(true);

    await expect(manager.cleanupWorktree("w-never-heard-of", false)).rejects.toMatchObject({ code: "not_found" });
  }, 30_000);

  it("readonly and main-checkout workers answer no_worktree", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo("main");
    const workerId = "w-main-run";
    workerIds.add(workerId);
    await manager.startWorker("cmd-main", args({ workerId }));
    await waitFor(() => settledOf(workerId), 15_000, "settled event");
    await expect(manager.cleanupWorktree(workerId, true)).rejects.toMatchObject({ code: "no_worktree" });
  }, 30_000);
});

describe("readonly relay legs continue from the previous branch (issue #8, spec §5.3)", () => {
  it("a readonly start_worker with base runs on a detached-HEAD worktree at that branch", async () => {
    setup([reportRun({ status: "done", summary: "reviewed" })]);
    registerRepo();
    // The write leg's branch: one commit with a plan file, on sig/write-1.
    await git(repo, ["checkout", "-b", "sig/write-1"]);
    const planPath = join(repo, "PLAN.md");
    writeFileSync(planPath, "# plan from leg 1\n");
    await git(repo, ["add", "PLAN.md"]);
    await git(repo, ["commit", "-m", "leg 1 plan"]);
    await git(repo, ["checkout", "main"]);
    expect(existsSync(join(repo, "PLAN.md"))).toBe(false); // main does not see it

    const workerId = "w-review-leg";
    workerIds.add(workerId);
    const result = await manager.startWorker("cmd-ro", args({ workerId, mode: "readonly", base: "sig/write-1" }));
    expect(result.branch).toBeUndefined(); // detached: no branch is created or moved
    expect(result.worktree).toBeTruthy();
    // The detached worktree sees leg 1's plan file; the owner's checkout stays on main.
    expect(existsSync(join(result.worktree!, "PLAN.md"))).toBe(true);
    expect((await git(result.worktree!, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("HEAD");
    expect((await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main");
    expect(result.base).toMatch(/^[0-9a-f]{40}$/);

    const started = startedOf(workerId) as { base?: string } | undefined;
    expect(started?.base).toBe(result.base); // the started event carries the pin
    await waitFor(() => settledOf(workerId), 15_000, "settled event");
  }, 30_000);

  it("a second readonly leg on the same thread+repo gets its own worktree (finding 2)", async () => {
    setup([reportRun({ status: "done", summary: "r1" }), reportRun({ status: "done", summary: "r2" })]);
    registerRepo();
    await git(repo, ["checkout", "-b", "sig/write-1"]);
    writeFileSync(join(repo, "PLAN.md"), "# plan\n");
    await git(repo, ["add", "PLAN.md"]);
    await git(repo, ["commit", "-m", "plan"]);
    await git(repo, ["checkout", "main"]);

    const first = await manager.startWorker("cmd-ro-a", args({ workerId: "w-ro-1", threadId: "relay-thread", mode: "readonly", base: "sig/write-1" }));
    await waitFor(() => settledOf("w-ro-1"), 15_000, "first readonly leg settled");
    // The leg went idle-hot (process alive, directory in use) — the second leg must not
    // reuse or delete that directory; it gets its own, and git's "missing but already
    // registered" never fires (PR #54 review finding 2).
    const second = await manager.startWorker("cmd-ro-b", args({ workerId: "w-ro-2", threadId: "relay-thread", mode: "readonly", base: "sig/write-1" }));
    expect(second.worktree).toBeTruthy();
    expect(second.worktree).not.toBe(first.worktree);
    expect(existsSync(join(second.worktree!, "PLAN.md"))).toBe(true);
    expect(existsSync(join(first.worktree!, "PLAN.md"))).toBe(true); // the live leg kept its checkout
    await waitFor(() => settledOf("w-ro-2"), 15_000, "second readonly leg settled");
  }, 30_000);

  it("an unknown base fails loudly instead of silently starting from the default branch", async () => {
    setup([]);
    registerRepo();
    const workerId = "w-review-missing";
    workerIds.add(workerId);
    await expect(
      manager.startWorker("cmd-ro-2", args({ workerId, mode: "readonly", base: "sig/never-pushed" })),
    ).rejects.toMatchObject({ code: "worktree_failed" });
  }, 30_000);

  it("a readonly base against a plain (non-Git) repo is rejected, not shelled into git (issue #88)", async () => {
    setup([]);
    const plainRepo = join(dir, "plain-repo");
    mkdirSync(plainRepo);
    store.addRepo({ repoId: plainRepo, name: "plain-repo", path: plainRepo, capability: { kind: "plain" } });
    const workerId = "w-review-plain";
    workerIds.add(workerId);
    await expect(
      manager.startWorker("cmd-ro-plain", args({ workerId, repoId: plainRepo, mode: "readonly", base: "main" })),
    ).rejects.toMatchObject({ code: "unsupported_base" });
  }, 30_000);
});

describe("LocalStore per-repo config and the queue tables (issue #16)", () => {
  it("persists write policy/approved per repo, defaulting to worktree/parallel/unapproved", () => {
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    expect(store.getRepo(repo)).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "parallel" }, approved: false });
    expect(store.setWritePolicy(repo, { concurrency: "serial" })).toBe(true);
    expect(store.setApproved(repo, true)).toBe(true);
    expect(store.getRepo(repo)).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "serial" }, approved: true });
    // Re-registering (add-repo again) never resets local settings.
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    expect(store.getRepo(repo)).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "serial" }, approved: true });
    expect(store.setWritePolicy("/no/such/repo", { isolation: "in-place" })).toBe(false);
    expect(store.setApproved("/no/such/repo", true)).toBe(false);
  });

  it("round-trips queued starts and clears worktree columns", async () => {
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    store.upsertWorker({ workerId: "w-q", threadId: "t", repoId: repo, mode: "write", state: "queued" });
    store.saveQueuedStart("w-q", "cmd-q", { prompt: "task", mode: "write" });
    expect(store.getQueuedStart("w-q")).toMatchObject({ commandId: "cmd-q" });
    store.deleteQueuedStart("w-q");
    expect(store.getQueuedStart("w-q")).toBeNull();

    store.upsertWorker({ workerId: "w-w", threadId: "t", repoId: repo, mode: "write", state: "idle", worktree: "/tmp/w", branch: "sig/t-1", base: "main" });
    store.clearWorkerWorktree("w-w");
    expect(store.getWorker("w-w")).toMatchObject({ worktree: null, branch: null, base: null });
  });

  it("listWorkers returns creation order (the serial queue's FIFO)", async () => {
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    for (const id of ["w-z-late-created-first", "w-a"]) {
      // createdAt comes from Date.now(); force ordering with a tiny sleep.
      store.upsertWorker({ workerId: id, threadId: "t", repoId: repo, mode: "write", state: "queued" });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const order = store.listWorkers().map((w) => w.workerId);
    expect(order.indexOf("w-z-late-created-first")).toBeLessThan(order.indexOf("w-a"));
  });
});

describe("CommandError surface for the new paths", () => {
  it("stop_process on a queued write worker drops it from the queue instead of no-op'ing", async () => {
    const slow: ScenarioStep[] = [{ delayMs: 8000 }, ...reportRun({ status: "done", summary: "slow" })];
    setup([slow]);
    registerRepo("serial");
    await manager.startWorker("cmd-sq-1", args({ workerId: "w-sq-runner" }));
    await manager.startWorker("cmd-sq-2", args({ workerId: "w-sq-victim", threadId: "victim-thread" }));
    expect(store.getWorker("w-sq-victim")?.state).toBe("queued");

    await manager.stopProcess("w-sq-victim");
    expect(store.getWorker("w-sq-victim")).toMatchObject({ state: "idle", lastOutcome: "stopped_while_queued" });
    expect(store.getQueuedStart("w-sq-victim")).toBeNull();
    expect(events.some((e) => e.type === "settled" && e.workerId === "w-sq-victim" && e.outcome === "aborted")).toBe(true);

    // When the runner settles, the stopped worker stays stopped — nothing starts behind the
    // user's back.
    await manager.stopProcess("w-sq-runner"); // end the slow runner without waiting it out
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(startedOf("w-sq-victim")).toBeUndefined();
  }, 30_000);

  it("a stop landing in the started-event window leaves no stale abort marker (review N1)", async () => {
    // The emit hook fires the stop exactly in the N1 window: the running upsert happened,
    // the launch's last marker check has passed, the finally has not. The stop must settle
    // the worker itself, and the marker must not outlive the launch to trap the next start
    // of the same workerId at `starting`.
    // The leading delay keeps the run OPEN when the stop lands: without it the scripted
    // report/settle (zero-delay steps) races the stop's close() and sometimes wins on a
    // loaded runner, leaving lastOutcome "reported" instead of "stopped" (same pattern as
    // the slow scenario above). The delay costs nothing on the passing path — the stop's
    // kill interrupts it — and only a regression ever waits out the waitFor.
    const scenario = writeScenario(dir, "scenario-n1", [
      [{ delayMs: 8000 }, ...reportRun({ status: "done", summary: "done" })],
    ]);
    const id = "w-n1";
    workerIds.add(id);
    let stopFired = false;
    const hooked = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
        if (fields.type === "started" && workerId === id && !stopFired) {
          stopFired = true;
          void hooked.stopProcess(id).catch(() => undefined);
        }
      },
    });
    manager = hooked;
    registerRepo("serial");

    const first = await hooked.startWorker("cmd-n1", args({ workerId: id }));
    expect(first.queued).toBeUndefined(); // the launch itself succeeded; the window-stop ended it after
    await waitFor(
      () => events.some((e) => e.workerId === id && e.type === "settled" && e.outcome === "aborted"),
      10_000,
      "window-stop settled the run",
    );
    expect(store.getWorker(id)).toMatchObject({ state: "idle", lastOutcome: "stopped" });
    // N3 post-start side: the worktree stayed reachable — cleanup_worktree(force) clears it.
    const worktree = store.getWorker(id)!.worktree;
    expect(worktree).toBeTruthy();
    await hooked.cleanupWorktree(id, true);
    expect(existsSync(worktree!)).toBe(false);

    // N1 core: the same workerId starts again; a stale marker would abort it silently and
    // strand the row (and the serial slot) at `starting` forever.
    const second = await hooked.startWorker("cmd-n1-again", args({ workerId: id }));
    expect(second.queued).toBeUndefined();
    await waitFor(() => store.getWorker(id)?.state === "running", 15_000, "same-id restart reached running");
  }, 45_000);

  it("a stop interrupting an in-flight automatic resume is the stop, not a resume failure (review N2)", async () => {
    // The run crashes mid-flight → lost → fast auto-resume; stop it while the resume is
    // relaunching. The stop's settle must be the final word — no broken row, no error event.
    // fake-pi replays run[0] in every fresh process, so the relaunched process crashes
    // again (exit 7) — the resume must never get that far: the stop settles it first.
    const scenario = writeScenario(dir, "scenario-n2", [
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { delayMs: 50 },
        { exit: 7 },
      ],
    ]);
    const id = "w-n2";
    workerIds.add(id);
    const mgr = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      recovery: { autoResumeBackoffMs: 120 },
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    manager = mgr;
    registerRepo();
    await mgr.startWorker("cmd-n2", args({ workerId: id }));
    await waitFor(() => store.getWorker(id)?.state === "lost", 15_000, "worker lost after crash");
    // Catch the resume while it is relaunching (state flips to recovering synchronously,
    // before the process handshake completes) — 5 ms polling keeps us inside the window.
    await waitFor(() => store.getWorker(id)?.state === "recovering", 15_000, "auto-resume in flight");
    await mgr.stopProcess(id);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const row = store.getWorker(id)!;
    expect(row).toMatchObject({ state: "idle", lastOutcome: "stopped" });
    const settles = events.filter((e) => e.workerId === id && e.type === "settled");
    expect(settles.length).toBeGreaterThan(0);
    expect(settles.every((e) => e.outcome !== "error")).toBe(true); // no resume_failed fabrication
  }, 45_000);

  it("an abort before the process ever spawns undoes the allocated worktree (review N3)", async () => {
    const scenario = writeScenario(dir, "scenario-n3", [reportRun({ status: "done", summary: "done" })]);
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario),
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
    });
    registerRepo("serial");
    const id = "w-n3-pre";
    workerIds.add(id);

    // The stop's synchronous chunk (marker + settle) lands while the launch is still in its
    // first await — the worktree creation. The launch must bail AND undo the allocation.
    const launch = manager.startWorker("cmd-n3-pre", args({ workerId: id }));
    const expectation = expect(launch).rejects.toMatchObject({ code: "aborted" });
    await manager.stopProcess(id);
    await expectation;

    expect(store.getWorker(id)).toMatchObject({ state: "idle", lastOutcome: "stopped" });
    expect(store.getWorker(id)?.worktree).toBeNull();
    // No orphan worktree directory remains under the connector's root (the repo-hash parent
    // may linger empty; a live worktree would carry its .git marker file).
    const root = join(stateDir, "worktrees");
    const entries = existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]) : [];
    expect(entries.filter((entry) => entry === ".git" || entry.endsWith("/.git"))).toHaveLength(0);
    // And the serial slot is free again: a new write task launches instead of queueing.
    const next = await manager.startWorker("cmd-n3-next", args({ workerId: "w-n3-next", threadId: "n3-thread" }));
    expect(next.queued).toBeUndefined();
    await waitFor(() => startedOf("w-n3-next"), 15_000, "next write task launched");
  }, 45_000);

  it("sends and manual resumes re-acquire the serial slot instead of double-running (issue #16 × #45 merge)", async () => {
    const run: ScenarioStep[] = [{ delayMs: 300 }, ...reportRun({ status: "done", summary: "done" })];
    setup([run]);
    registerRepo("serial");
    const aId = "w-mg-a";
    const bId = "w-mg-b";
    workerIds.add(aId);
    workerIds.add(bId);

    // A runs and settles; B (dispatched while A ran) takes the slot when it frees.
    await manager.startWorker("cmd-mg-a", args({ workerId: aId }));
    await manager.startWorker("cmd-mg-b", args({ workerId: bId, threadId: "mg-b-thread" }));
    expect(store.getWorker(bId)?.state).toBe("queued");
    await waitFor(() => settledOf(aId), 15_000, "A settled");
    await waitFor(() => startedOf(bId), 15_000, "B took the slot");
    expect(store.getWorker(aId)?.state).toBe("idle");

    // A manual resume while B holds the slot is refused (retriable) — not silently run.
    await expect(manager.handleCommand("cmd-mg-rs", "resume", { workerId: aId, reason: "manual" })).rejects.toMatchObject({
      code: "slot_busy",
    });

    // A send to the idle A parks (same pendingSends queue as lost/recovering sends) — it
    // must not relaunch A beside B in the repo the owner pinned to one write at a time.
    let sendResolved = false;
    const send = manager
      .handleCommand("cmd-mg-send", "send", { workerId: aId, text: "接着改", intent: "auto" })
      .then((result) => {
        sendResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sendResolved).toBe(false); // parked, not delivered
    expect(events.filter((e) => e.workerId === aId && e.type === "started")).toHaveLength(1); // no second run

    // When B settles, the serial pump drains the parked send: A relaunches with it.
    await waitFor(() => settledOf(bId), 15_000, "B settled");
    await waitFor(() => events.filter((e) => e.workerId === aId && e.type === "started").length === 2, 15_000, "A relaunched by the parked send");
    await send;
    expect(sendResolved).toBe(true);
  }, 60_000);

  it("resume on a queued worker explains the queue instead of resuming nothing", async () => {
    setup([[]]);
    registerRepo("serial");
    await manager.startWorker("cmd-hold", args({ workerId: "w-hold" }));
    await manager.startWorker("cmd-q", args({ workerId: "w-q-resume", threadId: "q-thread" }));
    await expect(manager.handleCommand("cmd-rs", "resume", { workerId: "w-q-resume", reason: "manual" })).rejects.toMatchObject(
      { code: "not_started" },
    );
  }, 30_000);

  it("cleanup_worktree is reachable through handleCommand with force in args", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo();
    const workerId = "w-cmd-clean";
    workerIds.add(workerId);
    const result = await manager.startWorker("cmd-cc", args({ workerId }));
    await waitFor(() => settledOf(workerId), 15_000, "settled event");
    await manager.stopProcess(workerId); // idle-hot process out of the way first
    await waitFor(() => !existsSync(lockPath(stateDir, workerId)), 10_000, "lock released");
    // dirty: the report committed nothing, but the branch is unpushed → refused without force
    await expect(manager.handleCommand("cmd-cw1", "cleanup_worktree", { workerId })).rejects.toBeInstanceOf(CommandError);
    await expect(manager.handleCommand("cmd-cw2", "cleanup_worktree", { workerId, force: true })).resolves.toMatchObject({
      removed: result.worktree,
    });
  }, 30_000);

  it("resume after cleanup_worktree refuses instead of running write-mode in the main checkout (review finding 5)", async () => {
    setup([reportRun({ status: "done", summary: "done" })]);
    registerRepo(); // worktree mode
    const workerId = "w-resume-after-cleanup";
    workerIds.add(workerId);
    await manager.startWorker("cmd-rac", args({ workerId }));
    await waitFor(() => settledOf(workerId), 15_000, "settled event");
    await manager.stopProcess(workerId);
    await waitFor(() => !existsSync(lockPath(stateDir, workerId)), 10_000, "lock released");
    await manager.cleanupWorktree(workerId, true);
    expect(store.getWorker(workerId)?.worktree).toBeNull();

    // A manual resume must not silently fall back to the owner's checkout with write tools.
    await expect(
      manager.handleCommand("cmd-rac-rs", "resume", { workerId, reason: "manual" }),
    ).rejects.toMatchObject({ code: "no_worktree" });
  }, 30_000);
});
