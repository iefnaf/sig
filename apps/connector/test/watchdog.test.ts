// Stall watchdog (issue #13, ADR-0001): silent + cold-CPU workers get one in-place respawn
// with a continuation note, a second strike settles error:stall, and quiet-but-hot builds are
// never stalls. CPU is measured as the delta of cumulative CPU time over the worker's WHOLE
// process tree (pi idles while its tool children work), so "hot" means the tree accumulated
// CPU during the sample window. Unit tests drive StallWatchdog with scripted tree samples;
// manager tests run fake-pi processes that genuinely go silent, and one test exercises the
// REAL sampler against a CPU-bound tool child — the shape the original %cpu-of-pi sampler
// got wrong (PR #41 review finding 1).
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type StartWorkerArgs } from "../src/worker-manager.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import {
  StallWatchdog,
  parseCpuTimeMs,
  parseProcStatCpuMs,
  stallContinueNote,
  type TreeCpuSample,
  type WatchdogCandidate,
} from "../src/watchdog.ts";
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
let treeScript: Array<TreeCpuSample | undefined> = [];
let errors: unknown[] = [];

beforeEach(async () => {
  dir = tmpDir("sig-watchdog-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
  treeScript = [];
  errors = [];
});

afterEach(async () => {
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A deterministic tree sampler consuming the script (last value repeats). */
function scriptedTree(pid: number): Promise<TreeCpuSample | undefined> {
  const value = treeScript.length > 1 ? treeScript.shift() : treeScript[0];
  return Promise.resolve(value === undefined ? undefined : { ...value, members: value.members.map((m) => m.replace("PID", String(pid))) });
}

/** A permanently cold tree: identical members, zero accumulated CPU between samples. */
const coldTree = (): TreeCpuSample => ({ totalCpuMs: 0, members: ["PID@t0"] });

/** A permanently hot tree: every sample adds 10 s of cumulative CPU (utilization ≫ threshold). */
function hotTreeSampler() {
  let calls = 0;
  return (pid: number): Promise<TreeCpuSample | undefined> =>
    Promise.resolve({ totalCpuMs: calls++ * 10_000, members: [`${pid}@t0`] });
}

/** Manager + fake-pi with the watchdog shrunk to test scale and the tree sampler scripted. */
function setup(runs: ScenarioStep[][], opts: { sharedRuns?: boolean; sample?: (pid: number) => Promise<TreeCpuSample | undefined> } = {}): void {
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
    watchdog: {
      stallMs: 400,
      tickMs: 80,
      cpuSampleGapMs: 10,
      sampleTreeCpu: opts.sample ?? scriptedTree,
      onError: (err) => errors.push(err),
    },
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

// ---- cputime parsing (macOS ps / procps / Linux /proc) --------------------------------------------

describe("cputime parsing", () => {
  it("parses the formats ps actually prints", () => {
    expect(parseCpuTimeMs("0:04.26")).toBe(4260); // macOS: MM:SS.cc
    expect(parseCpuTimeMs("37:24")).toBe(2_244_000); // procps under an hour: MM:SS
    expect(parseCpuTimeMs("1:02:03")).toBe(3_723_000); // procps: HH:MM:SS
    expect(parseCpuTimeMs("2-01:00:00")).toBe(176_400_000); // days prefix
    expect(parseCpuTimeMs("0.94")).toBe(940); // sub-minute seconds
    expect(parseCpuTimeMs("garbage")).toBeUndefined();
    expect(parseCpuTimeMs("1:2:3:4")).toBeUndefined();
  });

  it("parses /proc/<pid>/stat cumulative CPU (utime+stime)", () => {
    // comm with spaces and parens is why parsing starts after the last ')'.
    const stat = "1234 (a b(c)) S 1 1234 1234 0 -1 4194624 200 0 30 10 500 700 0 0 20 0 1 0";
    expect(parseProcStatCpuMs(stat, 100)).toBe(12_000); // (500+700) ticks at 100 Hz
    expect(parseProcStatCpuMs("no closing paren")).toBeUndefined();
  });
});

// ---- StallWatchdog in isolation -------------------------------------------------------------------

describe("StallWatchdog (detection and strike policy)", () => {
  function harness(initial: WatchdogCandidate[] = [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }]) {
    let now = 10_000;
    const strikes: Array<{ workerId: string; strike: 1 | 2; why: string }> = [];
    let candidates = initial;
    const watchdog = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleTreeCpu: scriptedTree, now: () => now },
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

  it("silent + two cold tree samples → strike 1, then strike 2 on the next stall", async () => {
    treeScript = [coldTree()];
    const h = harness();
    h.advance(1001); // past the threshold
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes).toEqual([expect.objectContaining({ workerId: "w-1", strike: 1 })]);
    // Silence counts from lastOutputAt (0) against now (11_001): 11 s, zero tree CPU.
    expect(h.strikes[0]!.why).toContain("no stdout for 11s");
    expect(h.strikes[0]!.why).toContain("+0ms");

    // The respawned process is silent again: fresh pid, fresh lastOutputAt, then the clock
    // runs out a second time.
    h.candidates = [{ workerId: "w-1", pid: 12, lastOutputAt: h.now() }];
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes[1]).toMatchObject({ strike: 2 });
  });

  it("quiet-but-hot (the tree accumulated CPU) is not a stall, and the next check waits another window", async () => {
    treeScript = [{ totalCpuMs: 0, members: ["PID@t0"] }, { totalCpuMs: 5_000, members: ["PID@t0"] }];
    const h = harness();
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(0);
    expect(h.strikes).toHaveLength(0);

    // The hot check pushed the consideration window: still nothing one threshold later…
    h.advance(1000);
    treeScript = [{ totalCpuMs: 20_000, members: ["PID@t0"] }];
    expect(await h.watchdog.tick()).toBe(0);
    // …but after a full window past the hot check with a cold tree, it strikes.
    h.advance(1);
    treeScript = [coldTree()];
    expect(await h.watchdog.tick()).toBe(1);
    expect(h.strikes[0]!.strike).toBe(1);
  });

  it("an unreadable tree sample never declares a stall", async () => {
    treeScript = [undefined];
    const h = harness();
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(0);
  });

  it("tree membership changing between the samples (a churning build) never declares a stall", async () => {
    treeScript = [
      { totalCpuMs: 0, members: ["PID@t0"] },
      { totalCpuMs: 0, members: ["PID@t0", "99@t1"] }, // a tool child spawned during the gap
    ];
    const h = harness();
    h.advance(1001);
    expect(await h.watchdog.tick()).toBe(0);
    expect(h.strikes).toHaveLength(0);
  });

  it("recent stdout output means no stall", async () => {
    treeScript = [coldTree()];
    const h = harness([{ workerId: "w-1", pid: 11, lastOutputAt: 9_500 }]);
    h.advance(400); // silent only 500ms < 1000ms
    expect(await h.watchdog.tick()).toBe(0);
  });

  it("a worker that speaks (or is replaced) during the sample window is not struck", async () => {
    // Freshness re-check (PR #41 review): output arriving between the two samples must
    // cancel the strike. The second sampler call simulates that mid-window output.
    let candidates: WatchdogCandidate[] = [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }];
    let calls = 0;
    let now = 10_000;
    const spokeMidWindow = (pid: number): Promise<TreeCpuSample | undefined> => {
      calls += 1;
      if (calls === 2) candidates = [{ workerId: "w-1", pid, lastOutputAt: now }];
      return Promise.resolve({ totalCpuMs: 0, members: [`${pid}@t0`] });
    };
    const watchdog = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleTreeCpu: spokeMidWindow, now: () => now },
      {
        candidates: () => candidates,
        onStrike: async () => {
          throw new Error("must not strike");
        },
      },
    );
    now += 1001; // past the threshold when the check starts
    expect(await watchdog.tick()).toBe(0);
    expect(calls).toBe(2); // both samples really were taken

    // Same shape, but the process was REPLACED mid-window (different pid): also no strike.
    candidates = [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }];
    calls = 0;
    const replacedMidWindow = (pid: number): Promise<TreeCpuSample | undefined> => {
      calls += 1;
      if (calls === 2) candidates = [{ workerId: "w-1", pid: 99, lastOutputAt: 0 }];
      return Promise.resolve({ totalCpuMs: 0, members: [`${pid}@t0`] });
    };
    const watchdog2 = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleTreeCpu: replacedMidWindow, now: () => now },
      {
        candidates: () => candidates,
        onStrike: async () => {
          throw new Error("must not strike");
        },
      },
    );
    expect(await watchdog2.tick()).toBe(0);
  });

  it("forget() resets the strike count — a fresh run starts at strike 1 again", async () => {
    treeScript = [coldTree()];
    const h = harness();
    h.advance(1001);
    await h.watchdog.tick();
    expect(h.strikes[0]!.strike).toBe(1);
    h.watchdog.forget("w-1");
    h.advance(1001);
    await h.watchdog.tick();
    expect(h.strikes[1]!.strike).toBe(1);
  });

  it("a failed strike handler does not consume the strike, and the error is reported, not thrown", async () => {
    treeScript = [coldTree()];
    const errors: unknown[] = [];
    let calls = 0;
    const watchdog = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleTreeCpu: scriptedTree, now: () => 10_000 + 1001, onError: (err) => errors.push(err) },
      {
        candidates: () => [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }],
        onStrike: async () => {
          calls += 1;
          if (calls === 1) throw new Error("emit failed");
        },
      },
    );
    expect(await watchdog.tick()).toBe(0);
    expect(errors).toHaveLength(1);
    // The strike was not counted: the retry strikes 1 again (its respawn), not 2.
    expect(await watchdog.tick()).toBe(1);
    expect(calls).toBe(2);
  });

  it("stop() cancels an in-flight check", async () => {
    let releaseSamples!: (sample: TreeCpuSample | undefined) => void;
    const gated = () =>
      new Promise<TreeCpuSample | undefined>((resolve) => {
        releaseSamples = resolve;
      });
    let struck = false;
    const watchdog = new StallWatchdog(
      { stallMs: 1000, cpuSampleGapMs: 0, sampleTreeCpu: () => gated(), now: () => 10_000 + 1001 },
      {
        candidates: () => [{ workerId: "w-1", pid: 11, lastOutputAt: 0 }],
        onStrike: async () => {
          struck = true;
        },
      },
    );
    const ticking = watchdog.tick();
    watchdog.stop(); // stopped while the first sample is still pending
    releaseSamples({ totalCpuMs: 0, members: ["11@t0"] });
    expect(await ticking).toBe(0);
    expect(struck).toBe(false);
  });
});

// ---- WorkerManager over fake-pi -------------------------------------------------------------------

describe("worker stalls through the manager (fake-pi)", () => {
  it("double stall: one respawn with a continuation note, then settles error:stall", async () => {
    setup([stallRun(), stallRun()], { sharedRuns: true });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    treeScript = [coldTree()];
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
      watchdog: { stallMs: 400, tickMs: 80, cpuSampleGapMs: 10, sampleTreeCpu: scriptedTree },
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    treeScript = [coldTree()];

    const result = await manager.startWorker("cmd-stall", args());
    await waitFor(() => settledEvent(), 15_000, "settled after respawn");
    expect(settledEvent()).toMatchObject({ outcome: "reported" });
    expect(events.find((e) => e.type === "report")).toMatchObject({ summary: "Recovered after the restart" });
    expect(store.getWorker("w-stall-1")!.state).toBe("idle");

    // Two processes served the same session: the respawn ran in the SAME worktree and its
    // prompt was the original task plus the continuation note. (The child's cwd resolves
    // through macOS's /var → /private/var symlink, so compare the two fake-pi views. The
    // log also carries pi-side settle records since #16's settle-lag sync point — filter.)
    const prompts = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.commandId !== undefined);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.cwd).toBe(prompts[0]!.cwd);
    expect(String(prompts[1]!.cwd)).toContain(join("state", "worktrees"));
    expect(String(prompts[1]!.text)).toContain("Fix the login bug");
    expect(String(prompts[1]!.text)).toContain("stalled");
  }, 30_000);

  it("quiet-but-hot is not a stall: a silent process whose tree burns CPU is left alone", async () => {
    setup([stallRun(1_500)], { sample: hotTreeSampler() });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });

    await manager.startWorker("cmd-hot", args());
    // Plenty of ticks pass the silence threshold while the tree keeps accumulating CPU.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(stallNotices()).toHaveLength(0);
    expect(resumedEvents()).toHaveLength(0);
    expect(store.getWorker("w-stall-1")!.state).toBe("running");
    expect(errors).toEqual([]);
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
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    treeScript = [coldTree()];

    await manager.startWorker("cmd-chatty", args());
    await waitFor(() => settledEvent(), 15_000, "settled without watchdog interference");
    expect(settledEvent()).toMatchObject({ outcome: "reported" });
    expect(stallNotices()).toHaveLength(0);
    expect(resumedEvents()).toHaveLength(0);
  }, 30_000);
});

// ---- Strike-window interactions (PR #46 review round 3, finding 2) -------------------------------

describe("the strike window vs sends and stops (PR #46 review round 3)", () => {
  /** Manager + fake-pi whose stall-respawn spawn is held at a gate: the test controls the
   *  recovering-to-running window deterministically. */
  function setupGatedRespawn(runs: ScenarioStep[][], stallMs = 300): { releaseSpawn: () => void } {
    const scenario = writeScenario(dir, "scenario", runs);
    const runsFile = join(dir, "runs-shared.txt");
    writeFileSync(runsFile, "0");
    const adapter = fakePiAdapter(stateDir, scenario, { FAKE_PI_RUNS_FILE: runsFile });
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const origStart = adapter.start.bind(adapter);
    adapter.start = (spec) =>
      spec.commandId.startsWith("stall-respawn-") ? spawnGate.then(() => origStart(spec)) : origStart(spec);
    manager = new WorkerManager({
      store,
      stateDir,
      adapter,
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
      watchdog: { stallMs, tickMs: 60, cpuSampleGapMs: 10, sampleTreeCpu: scriptedTree, onError: (err) => errors.push(err) },
    });
    return { releaseSpawn };
  }

  const strikeFired = () => waitFor(() => events.find((e) => e.type === "progress" && e.tool === "stall-watchdog"), 10_000, "strike 1");

  it("a send parked on the strike's recovering drains the moment the respawn lands", async () => {
    // stallMs 5000: the strike must fire on run 0's silence, but the respawned run's own
    // 800 ms tool delay may not be struck itself (at the default 300 ms it was).
    const { releaseSpawn } = setupGatedRespawn(
      [
        stallRun(20_000),
        // A slow first step keeps the respawned run `running` when the drain lands, so the
        // parked message deterministically steers (a fast run would settle first and the
        // send would legitimately prompt instead — both drain, this pins the steer cell).
        [{ delayMs: 800 }, ...reportRun({ status: "done", summary: "resumed and finished" })],
      ],
      5_000,
    );
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    treeScript = [coldTree()];
    await manager.startWorker("cmd-window", args());
    await strikeFired(); // state is `recovering`, the respawn's spawn is gated

    const send = manager.handleCommand("cmd-window-send", "send", {
      workerId: "w-stall-1",
      text: "use pnpm",
      intent: "auto",
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // let it park on recovering
    releaseSpawn();

    // The respawn lands -> withTransition drains the parked send -> it steers the fresh run.
    await expect(send).resolves.toMatchObject({ effect: "after_current_tools" });
    await waitFor(() => settledEvent(), 15_000, "resumed run settles");
    expect(settledEvent()).toMatchObject({ outcome: "reported" });
    expect(resumedEvents()).toEqual([expect.objectContaining({ reason: "stall", count: 1 })]);
  }, 30_000);

  it("a stop landing mid-respawn wins: no resumed, no error:stall on top of the aborted settle", async () => {
    const { releaseSpawn } = setupGatedRespawn([stallRun(), stallRun()]);
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    treeScript = [coldTree()];
    await manager.startWorker("cmd-window-2", args());
    await strikeFired();

    // The user stops the wedged task while the respawn's spawn is still gated: the stop
    // settles the run (idle + settled:aborted) and that verdict must survive.
    await manager.handleCommand("cmd-window-2-stop", "stop_process", { workerId: "w-stall-1" });
    releaseSpawn();

    await new Promise((resolve) => setTimeout(resolve, 400)); // let the respawn lose the race
    const settledEvents = events.filter((e) => e.type === "settled");
    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0]).toMatchObject({ outcome: "aborted" });
    expect(resumedEvents()).toHaveLength(0); // the respawn never announced itself
    expect(store.getWorker("w-stall-1")).toMatchObject({ state: "idle", lastOutcome: "stopped" });
  }, 30_000);
});

// ---- The REAL sampler vs a CPU-bound tool child (PR #41 review finding 1) -------------------------

describe("the production sampler under a busy tool child (fake-pi, real ps)", () => {
  // The bug this pins: pi itself idles at ~2% CPU while its tool child burns 80%+. Measuring
  // only the parent declared a stall and killed a healthy build. The tree sampler must see
  // the child. Marker-matched cleanup only — never a broad pkill.
  afterEach(() => {
    try {
      execFileSync("pkill", ["-f", "sig-wd-busy"]);
    } catch {
      // none left
    }
  });

  it("a silent parent with a CPU-bound child is hot, never a stall", async () => {
    const busy = `node -e "/*sig-wd-busy*/ const e=Date.now()+9000; while(Date.now()<e){Math.sqrt(Math.random())}"`;
    const scenario = writeScenario(dir, "scenario", [[{ shell: busy }], [{ delayMs: 60_000 }]]);
    const runsFile = join(dir, "runs-shared.txt");
    writeFileSync(runsFile, "0");
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_RUNS_FILE: runsFile }),
      emit: (workerId, fields) => {
        const stored = eventLog.append(workerId, fields);
        events.push(JSON.parse(stored.payload) as EmittedEvent);
      },
      // NO sampler injection: the production listDescendants + ps/proc path runs for real.
      watchdog: { stallMs: 500, tickMs: 100, cpuSampleGapMs: 300 },
    });
    store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });

    await manager.startWorker("cmd-busy-child", args());
    // The child spins for ~9 s; the watchdog becomes eligible at 500 ms of silence. Watch
    // well past that: no detection, no respawn, the worker stays running.
    await new Promise((resolve) => setTimeout(resolve, 7_500));
    expect(stallNotices()).toHaveLength(0);
    expect(resumedEvents()).toHaveLength(0);
    expect(store.getWorker("w-stall-1")!.state).toBe("running");
    expect(errors).toEqual([]);
  }, 40_000);
});

describe("stallContinueNote", () => {
  it("states the reason and instructs continuation, not a redo", () => {
    const note = stallContinueNote("no stdout for 480s with tree CPU +0ms over 2500ms (0.0%)");
    expect(note).toContain("no stdout for 480s");
    expect(note).toContain("continue");
    expect(note).toContain("Do not redo completed work");
  });
});
