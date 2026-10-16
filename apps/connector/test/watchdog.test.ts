// Stall watchdog (issue #13, ADR-0001): silent + cold-CPU workers get one in-place respawn
// with a continuation note, a second strike settles error:stall, and quiet-but-hot builds are
// never stalls. Unit tests drive StallWatchdog with scripted CPU samples; manager tests run
// fake-pi processes that genuinely go silent (a real sleeping node process really is cold, so
// even the real `ps` sampler would agree — but the tests inject samples for determinism).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { StallWatchdog, stallContinueNote, type WatchdogCandidate } from "../src/watchdog.ts";
import { fakePiAdapter, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario, type ScenarioStep } from "./helpers.ts";

// A run that answers the prompt RPC (that response is stdout!) and then goes silent: the
// sleeping process produces nothing further — the exact shape of the spike's stalls.
const stallRun = (ms = 20_000): ScenarioStep[] => [{ delayMs: ms }];

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
let cpuScript: Array<number | undefined> = [];
let cpuCalls = 0;

beforeEach(async () => {
  dir = tmpDir("shepherd-watchdog-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
  cpuScript = [];
  cpuCalls = 0;
});

afterEach(async () => {
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A deterministic CPU sampler consuming the script (last value repeats). */
function scriptedCpu(pid: number): Promise<number | undefined> {
  cpuCalls += 1;
  const value = cpuScript.length > 1 ? cpuScript.shift() : cpuScript[0];
  return Promise.resolve(value);
}

/** Manager + fake-pi with the watchdog shrunk to test scale and CPU scripted. */
function setup(runs: ScenarioStep[][], opts: { sharedRuns?: boolean } = {}): void {
  const scenario = writeScenario(dir, "scenario", runs);
  const runsFile = join(dir, "runs-shared.txt");
  if (opts.sharedRuns) writeFileSync(runsFile, "0");
  manager = new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario, opts.sharedRuns ? { FAKE_PI_RUNS_FILE: runsFile } : {}),
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
    watchdog: { stallMs: 400, tickMs: 80, cpuSampleGapMs: 10, sampleCpu: scriptedCpu },
  });
}

function args(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  const merged: StartWorkerArgs = {
    workerId: "w-stall-1",
    threadId: "fix-the-login-bug",
    repoId: repo,
    mode: "write",
    prompt: "Fix the login bug",
    ...overrides,
  };
  workerIds.add(merged.workerId);
  return merged;
}

const stallNotices = () => events.filter((e) => e.type === "progress" && e.tool === "stall-watchdog");
const resumedEvents = () => events.filter((e) => e.type === "resumed");
const settledEvent = () => events.find((e) => e.type === "settled");

// ---- StallWatchdog in isolation -------------------------------------------------------------------

describe("StallWatchdog (detection and strike policy)", () => {
  function harness(initial: WatchdogCandidate[] = [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }]) {
    let now = 10_000;
    const strikes: Array<{ workerId: string; strike: 1 | 2; why: string }> = [];
    let candidates = initial;
    const watchdog = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleCpu: scriptedCpu, now: () => now },
      {
        candidates: () => candidates,
        onStrike: async (workerId, strike, why) => {
          strikes.push({ workerId, strike, why });
        },
      },
    );
    return {
      watchdog,
      strikes,
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      set candidates(value: WatchdogCandidate[]) {
        candidates = value;
      },
    };
  }

  it("silent + two cold samples → strike 1, then strike 2 on the next stall", async () => {
    cpuScript = [1, 1];
    const h = harness();
    h.advance(1001); // past the threshold
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes).toEqual([expect.objectContaining({ workerId: "w-1", strike: 1 })]);
    // Silence counts from lastOutputAt (0) against now (11_001): 11 s, both samples cold.
    expect(h.strikes[0]!.why).toContain("no stdout for 11s");
    expect(h.strikes[0]!.why).toContain("1.0%/1.0%");

    // The respawned process is silent again: fresh pid, fresh lastOutputAt, then the clock
    // runs out a second time.
    h.candidates = [{ workerId: "w-1", pid: 12, lastOutputAt: h.now() }];
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes[1]).toMatchObject({ strike: 2 });
  });

  it("quiet-but-hot (either sample ≥ threshold) is not a stall, and the next check waits another window", async () => {
    cpuScript = [80, 1];
    const h = harness();
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(0);
    expect(h.strikes).toHaveLength(0);

    // The hot check pushed the consideration window: still nothing one threshold later…
    h.advance(1000);
    cpuScript = [80];
    expect(await h.watchdog.tick()).toBe(0);
    // …but after a full window past the hot check with cold samples, it strikes.
    h.advance(1);
    cpuScript = [0.5, 0.5];
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes[0]!.strike).toBe(1);
  });

  it("an unreadable CPU sample never declares a stall", async () => {
    cpuScript = [undefined, undefined];
    const h = harness();
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(0);
  });

  it("recent stdout output means no stall", async () => {
    cpuScript = [0, 0];
    const h = harness([{ workerId: "w-1", pid: 11, lastOutputAt: 9_500 }]);
    h.advance(400); // silent only 500ms < 1000ms
    expect(await h.watchdog.tick()).toBe(0);
  });

  it("forget() resets the strike count — a fresh run starts at strike 1 again", async () => {
    cpuScript = [0, 0];
    const h = harness();
    h.advance(1001);
    await h.watchdog.tick();
    expect(h.strikes[0]!.strike).toBe(1);
    h.watchdog.forget("w-1");
    h.advance(1001);
    await h.watchdog.tick();
    expect(h.strikes[1]!.strike).toBe(1);
  });
});

// ---- WorkerManager over fake-pi -------------------------------------------------------------------

describe("worker stalls through the manager (fake-pi)", () => {
  it("double stall: one respawn with a continuation note, then settles error:stall", async () => {
    setup([stallRun(), stallRun()], { sharedRuns: true });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: null });
    cpuScript = [0, 0];
    const result = await manager.startWorker("cmd-stall", args());
    expect(result.sessionId).toBe("w-stall-1");

    await waitFor(() => settledEvent(), 15_000, "settled error:stall");

    // The event story: detected (progress) → respawned (resumed) → detected again → error:stall.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.filter((t) => t === "progress")).toHaveLength(2);
    expect(stallNotices().map((e) => e.target?.toString())).toEqual([
      expect.stringContaining("no stdout for"),
      expect.stringContaining("no stdout for"),
    ]);
    expect(resumedEvents()).toEqual([expect.objectContaining({ reason: "stall", count: 1 })]);
    expect(settledEvent()).toMatchObject({ outcome: "error", errorClass: "stall" });
    expect(String(settledEvent()!.lastText)).toContain("still wedged after one automatic restart");

    // Terminal connector-side state: broken, and the error is classified for the ledger.
    const worker = store.getWorker("w-stall-1")!;
    expect(worker.state).toBe("broken");
    expect(worker.lastOutcome).toBe("error:stall");
  }, 30_000);

  it("single stall: the respawn continues the task in the same worktree and finishes it", async () => {
    const logFile = join(dir, "prompts.jsonl");
    const scenario = writeScenario(dir, "scenario", [
      stallRun(),
      reportRun({ status: "done", summary: "Recovered after the restart" }, { tool: "edit" }),
    ]);
    writeFileSync(join(dir, "runs-shared.txt"), "0");
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, {
        FAKE_PI_RUNS_FILE: join(dir, "runs-shared.txt"),
        FAKE_PI_LOG: logFile,
      }),
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
      watchdog: { stallMs: 400, tickMs: 80, cpuSampleGapMs: 10, sampleCpu: scriptedCpu },
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: null });
    cpuScript = [0, 0];

    const result = await manager.startWorker("cmd-stall", args());
    await waitFor(() => settledEvent(), 15_000, "settled after respawn");
    expect(settledEvent()).toMatchObject({ outcome: "reported" });
    expect(events.find((e) => e.type === "report")).toMatchObject({ summary: "Recovered after the restart" });
    expect(store.getWorker("w-stall-1")!.state).toBe("idle");

    // Two processes served the same session: the respawn ran in the SAME worktree and its
    // prompt was the original task plus the continuation note. (The child's cwd resolves
    // through macOS's /var → /private/var symlink, so compare the two fake-pi views.)
    const prompts = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.cwd).toBe(prompts[0]!.cwd);
    expect(String(prompts[1]!.cwd)).toContain(join("state", "worktrees"));
    expect(String(prompts[1]!.text)).toContain("Fix the login bug");
    expect(String(prompts[1]!.text)).toContain("stalled");
  }, 30_000);

  it("quiet-but-hot is not a stall: a silent, CPU-busy process is left alone", async () => {
    setup([stallRun(1_500)]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: null });
    cpuScript = [90];

    await manager.startWorker("cmd-hot", args());
    // Plenty of ticks pass the silence threshold while the sampler says "busy".
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(cpuCalls).toBeGreaterThan(1);
    expect(stallNotices()).toHaveLength(0);
    expect(resumedEvents()).toHaveLength(0);
    expect(store.getWorker("w-stall-1")!.state).toBe("running");
  }, 15_000);

  it("ongoing output keeps the watchdog quiet even with cold CPU samples", async () => {
    // A chatty run: every gap is under the stall threshold, so silence never accumulates.
    const chatter: ScenarioStep[] = [
      { emit: { type: "agent_start" } },
      { delayMs: 250 },
      { emit: { type: "turn_start" } },
      { delayMs: 250 },
      { emit: { type: "tool_execution_start", toolCallId: "c0", toolName: "report", args: { status: "done", summary: "Chatty but fine" } } },
      { emit: { type: "tool_execution_end", toolCallId: "c0", toolName: "report", result: {}, isError: false } },
      {
        emit: {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
        },
      },
      { emit: { type: "agent_settled", aborted: false } },
    ];
    setup([chatter]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: null });
    cpuScript = [0, 0];

    await manager.startWorker("cmd-chatty", args());
    await waitFor(() => settledEvent(), 15_000, "settled without watchdog interference");
    expect(settledEvent()).toMatchObject({ outcome: "reported" });
    expect(stallNotices()).toHaveLength(0);
    expect(resumedEvents()).toHaveLength(0);
  }, 30_000);
});

describe("stallContinueNote", () => {
  it("states the reason and instructs continuation, not a redo", () => {
    const note = stallContinueNote("no stdout for 480s with CPU 0.3%/0.4%");
    expect(note).toContain("no stdout for 480s");
    expect(note).toContain("continue");
    expect(note).toContain("Do not redo completed work");
  });
});
