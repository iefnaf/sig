// In-chat intervention, connector half (issue #9, connector-pi.md §6.1–§6.2, §4.1):
// `send` maps intent → prompt/steer/follow_up per the §6.2 state table (including the
// idle-cold relaunch and queuing while starting/recovering); `interrupt` does clear_queue
// (→ `queue_returned`) → abort → wait for agent_settled{aborted:true} → optional `then`
// prompt, superseding connector-queued sends; and idle reclamation closes the process after
// the idle window while the session stays on disk. fake-pi models the pi side: steer/
// follow_up queue, clear_queue hands them back, abort ends the scripted run.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager, type RecoveryOptions } from "../src/worker-manager.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { isLockHeld, lockPath } from "../src/locks.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
} from "./helpers.ts";
import { ConnectorApp } from "../src/connector-app.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

/** A run that stays busy for ~`seconds` unless aborted: many short sleeps so an abort
 *  lands within one step (fake-pi checks the flag between steps). */
function longRun(seconds: number): ScenarioStep[] {
  const steps: ScenarioStep[] = [{ emit: { type: "agent_start" } }, { emit: { type: "turn_start" } }];
  for (let i = 0; i < seconds * 10; i++) steps.push({ delayMs: 100 });
  steps.push(
    { emit: { type: "tool_execution_start", toolCallId: "c1", toolName: "report", args: { status: "done", summary: "late" } } },
    { emit: { type: "agent_settled", aborted: false } },
  );
  return steps;
}

/** Entries fake-pi appended to FAKE_PI_LOG (prompts with their commandId, steer/follow_up/abort/clear_queue). */
function readPiLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let eventLog: EventLog;
let events: EmittedEvent[];
let manager: WorkerManager;
let adapter: import("../src/pi-adapter.ts").PiAdapter;
let piLog: string;
const workerIds = new Set<string>();

beforeEach(async () => {
  dir = tmpDir("sig-intervention-test");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  eventLog = new EventLog(store.database);
  events = [];
  piLog = join(dir, "pi.log");
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
});

afterEach(async () => {
  for (const workerId of workerIds) {
    await manager?.stopProcess(workerId).catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function setup(
  runs: ScenarioStep[][],
  recovery: RecoveryOptions = {},
  startup?: Record<string, unknown>,
  extra?: Record<string, unknown>,
): void {
  const scenario = writeScenario(dir, "scenario", runs, startup, extra);
  adapter = fakePiAdapter(stateDir, scenario, {
    FAKE_PI_LOG: piLog,
    FAKE_PI_SESSIONS_DIR: join(dir, "sessions"),
  });
  manager = new WorkerManager({
    store,
    stateDir,
    adapter,
    recovery,
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
}

async function startWorker1(): Promise<void> {
  workerIds.add("w-interv-1");
  // Through handleCommand (the transport's path): start_worker is a tracked transition, so
  // queued sends drain when startup completes and an interrupt can wait the start out.
  await manager.handleCommand("cmd-start-1", "start_worker", {
    workerId: "w-interv-1",
    threadId: "fix-login",
    repoId: repo,
    mode: "write",
    prompt: "Fix the login bug",
  });
}

const settledEvents = () => events.filter((e) => e.type === "settled");

// PR #45 review round 1: the three confirmed connector races — a send parked on a send-
// triggered cold relaunch that nothing drained, an interrupt {then} steered into a run that
// had already ended (the store lagging pi's closed run window), and interventions that
// killed the §4.1 idle timer with no settle to re-arm it.
describe("review round 1 regressions (races around the cold start and the settle lag)", () => {
  it("a send racing the idle-cold relaunch queues and drains when the relaunch settles (review #1)", async () => {
    // startup delayMs widens every spawn's get_state window — the cold relaunch included.
    setup(
      [reportRun({ status: "done", summary: "第一段完成" }), reportRun({ status: "done", summary: "第二段完成" })],
      {},
      { delayMs: 600 },
    );
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "first run settled");
    await manager.handleCommand("cmd-stop-1", "stop_process", { workerId: "w-interv-1" });
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "lock released");

    // Send A hits the idle-cold row and starts the relaunch (state → `starting`)…
    const sendA = manager.handleCommand("cmd-send-a", "send", {
      workerId: "w-interv-1",
      text: "冷启动期间的第一条",
      intent: "auto",
    });
    await waitFor(() => store.getWorker("w-interv-1")?.state === "starting", 5000, "relaunch in flight");
    // …send B lands inside the cold-start window: it must queue on the starting row (§6.2),
    // not error and not hang — the old code parked it forever: no transition drained it.
    const sendB = manager.handleCommand("cmd-send-b", "send", {
      workerId: "w-interv-1",
      text: "冷启动期间的第二条",
      intent: "now",
    });

    // The relaunch settles: A prompted the relaunched process, B drained as a steer into
    // the now-running worker (the state table applies at delivery time, §6.2).
    await expect(sendA).resolves.toEqual({ delivery: "prompt", relaunched: true });
    await expect(sendB).resolves.toEqual({ delivery: "steer", effect: "after_current_tools" });
    const log = readPiLog(piLog);
    expect(log.find((e) => e.commandId === "cmd-send-a")).toMatchObject({ text: "冷启动期间的第一条" });
    expect(log.find((e) => e.type === "steer")).toMatchObject({ text: "冷启动期间的第二条" });
    await waitFor(() => settledEvents().length === 2, 15_000, "relaunched run settled");
  }, 30_000);

  it("interrupt {then} in the settle-lag window prompts instead of steering a dead run (review #2)", async () => {
    // statsDelayMs holds get_session_stats back: pi's run window closed on agent_settled,
    // but the connector's store still says running — exactly the lag window in which the
    // old code delivered the then-text as a steer into a run that had already ended.
    // abortSettleTimeoutMs is pinned so the lag wait stays well inside it (round-2 nit).
    setup(
      [reportRun({ status: "done", summary: "第一段完成" }), reportRun({ status: "done", summary: "停后重做完成" })],
      { abortSettleTimeoutMs: 5000 },
      undefined,
      { statsDelayMs: 1500 },
    );
    await startWorker1();
    await waitFor(() => readPiLog(piLog).some((e) => e.type === "agent_settled"), 15_000, "pi-side settle");
    expect(store.getWorker("w-interv-1")!.state).toBe("running"); // the store lags behind

    const result = (await manager.handleCommand("cmd-interv-1", "interrupt", {
      workerId: "w-interv-1",
      then: { text: "停；改按新方案重做" },
    })) as { then?: { delivery: string; effect?: string } };
    // §6.2: then = prompt. A steer here would park the text in pi's queue with no run left
    // to apply it, while the outcome claimed after_current_tools.
    expect(result.then).toEqual({ delivery: "prompt" });
    const log = readPiLog(piLog);
    expect(log.filter((e) => e.type === "steer")).toHaveLength(0);
    expect(log.find((e) => e.commandId === "cmd-interv-1")).toMatchObject({ text: "停；改按新方案重做" });
    await waitFor(() => settledEvents().length === 2, 15_000, "then-run settled");
  }, 30_000);

  it("an interrupt on an idle-hot worker leaves the idle window armed — the process is still reclaimed (review #3)", async () => {
    setup([reportRun({ status: "done", summary: "完成" })], { idleReclaimMs: 400 });
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "run settled");

    // Nothing is running: the interrupt has no run to abort, so no settle will follow to
    // re-arm the timer cancelled on entry — the old code left the process hot forever.
    const result = (await manager.handleCommand("cmd-interv-1", "interrupt", {
      workerId: "w-interv-1",
    })) as { aborted: boolean; queueReturned: number };
    expect(result).toEqual({ aborted: true, queueReturned: 0 });
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "process reclaimed after idle window");
    expect(store.getWorker("w-interv-1")!.state).toBe("idle"); // session kept (§4.1)
  }, 30_000);

  it("a failed prompt-send on an idle-hot worker rolls back to idle and re-arms reclamation (review #3)", async () => {
    setup(
      [reportRun({ status: "done", summary: "完成" }), [{ fail: "pi is sad" }]],
      { idleReclaimMs: 400 },
    );
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "run settled");

    // The idle-hot prompt RPC fails at the pi boundary: the send rejects, the state rolls
    // back to idle, and the idle window re-arms (the timer was cancelled at accept-time).
    await expect(
      manager.handleCommand("cmd-send-1", "send", { workerId: "w-interv-1", text: "会让 pi 报错的指令", intent: "auto" }),
    ).rejects.toThrow(/pi is sad/);
    expect(store.getWorker("w-interv-1")!.state).toBe("idle");
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "process reclaimed after idle window");
    expect(events.some((e) => e.type === "process_exit")).toBe(true);
  }, 30_000);
});

describe("send: the §6.2 state table", () => {
  it("running + intent=now/auto → steer with effect after_current_tools", async () => {
    setup([longRun(6)]);
    await startWorker1();
    // The scripted run is playing (agent_start already emitted): the worker is running.
    await waitFor(() => events.some((e) => e.type === "progress"), 5000, "run started");

    const result = (await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "改用 pnpm，不要 npm",
      intent: "now",
    })) as { delivery: string; effect?: string };
    expect(result).toEqual({ delivery: "steer", effect: "after_current_tools" });

    const auto = (await manager.handleCommand("cmd-send-2", "send", {
      workerId: "w-interv-1",
      text: "顺便看下 lock 文件",
      intent: "auto",
    })) as { delivery: string; effect?: string };
    expect(auto).toEqual({ delivery: "steer", effect: "after_current_tools" });

    // Both landed in fake-pi's steer queue (queued, not delivered mid-tool — research #2).
    const steers = readPiLog(piLog).filter((e) => e.type === "steer");
    expect(steers.map((e) => e.text)).toEqual(["改用 pnpm，不要 npm", "顺便看下 lock 文件"]);
  }, 30_000);

  it("running + intent=after → follow_up", async () => {
    setup([longRun(6)]);
    await startWorker1();
    await waitFor(() => events.some((e) => e.type === "progress"), 5000, "run started");

    const result = (await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "跑完后再补几个测试",
      intent: "after",
    })) as { delivery: string; effect?: string };
    expect(result).toEqual({ delivery: "follow_up" });
    expect(readPiLog(piLog).find((e) => e.type === "follow_up")).toMatchObject({ text: "跑完后再补几个测试" });
  }, 30_000);

  it("idle(hot) → prompt starts the next run in the same session; a started event flips the DO-side state", async () => {
    setup([
      reportRun({ status: "done", summary: "第一段完成" }),
      reportRun({ status: "done", summary: "第二段完成" }),
    ]);
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "first run settled");
    expect(store.getWorker("w-interv-1")!.state).toBe("idle");

    const result = (await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "继续：把测试补上",
      intent: "auto",
    })) as { delivery: string; effect?: string };
    expect(result).toEqual({ delivery: "prompt" });
    expect(store.getWorker("w-interv-1")!.state).toBe("running");
    // The prompt carries the commandId marker (ADR-0001) and a `started` event tells the DO a
    // new run is live — without it the Thread would read idle while the worker runs.
    expect(readPiLog(piLog).find((e) => e.commandId === "cmd-send-1")).toMatchObject({ text: "继续：把测试补上" });
    await waitFor(() => settledEvents().length === 2, 15_000, "second run settled");
    const starts = events.filter((e) => e.type === "started");
    expect(starts).toHaveLength(2);
  }, 30_000);

  it("idle(cold) → relaunch with --session-id, prompt, session kept (§6.2 cold row)", async () => {
    const sessionEntry = { type: "message", message: { role: "user", content: "task", timestamp: 0 } };
    setup([
      [{ session: sessionEntry }, ...reportRun({ status: "done", summary: "第一段完成" })],
      reportRun({ status: "done", summary: "第二段完成" }),
    ]);
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "first run settled");
    const sessionFile = store.getWorker("w-interv-1")!.sessionFile!;
    const sessionId = store.getWorker("w-interv-1")!.sessionId!;
    // The §6.1 stop_process command reclaims the process (the same path idle reclamation uses).
    await manager.handleCommand("cmd-stop-1", "stop_process", { workerId: "w-interv-1" });
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "lock released");
    expect(existsSync(sessionFile)).toBe(true); // the session stays on disk (§4.1)

    const result = (await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "机器冷启动后的追加指令",
      intent: "now",
    })) as { delivery: string; relaunched?: boolean };
    expect(result).toEqual({ delivery: "prompt", relaunched: true });
    // Same pi session id: the conversation continues, a fresh process.
    expect(store.getWorker("w-interv-1")!.sessionId).toBe(sessionId);
    expect(readPiLog(piLog).find((e) => e.commandId === "cmd-send-1")).toMatchObject({ text: "机器冷启动后的追加指令" });
    await waitFor(() => settledEvents().length === 2, 15_000, "relaunched run settled");
  }, 30_000);

  it("starting → queue; delivered per the state table once startup completes", async () => {
    setup([longRun(6)], {}, { delayMs: 500 });
    workerIds.add("w-interv-1");
    const start = manager.handleCommand("cmd-start-1", "start_worker", {
      workerId: "w-interv-1",
      threadId: "fix-login",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    // The worker row says `starting` while get_state is held back (§6.2 queue row).
    await waitFor(() => store.getWorker("w-interv-1")?.state === "starting", 5000, "worker starting");
    const send = manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "改用 pnpm",
      intent: "now",
    });
    await start;

    // Startup completed and the initial run is live: the queued message steers it (§6.2's
    // running row applies at delivery time — a bare prompt into a busy agent is rejected by pi).
    await expect(send).resolves.toEqual({ delivery: "steer", effect: "after_current_tools" });
    expect(readPiLog(piLog).find((e) => e.type === "steer")).toMatchObject({ text: "改用 pnpm" });
  }, 30_000);

  it("lost → queue; delivered after the automatic resume completes (§6.2 lost/recovering row)", async () => {
    // The process is SIGKILLed mid-run (unexpected exit → lost, §9.1); the automatic resume
    // (§9.2, backoff shrunk) relaunches with the same session id — the queued send steers the
    // resumed run the moment the resume transition completes.
    setup([longRun(8)], { autoResumeBackoffMs: 100 });
    await startWorker1();
    await waitFor(() => events.some((e) => e.type === "progress"), 5000, "run started");
    const pid = adapter.workerPids().find((p) => p.workerId === "w-interv-1")!.pid;
    process.kill(pid, "SIGKILL");
    await waitFor(() => store.getWorker("w-interv-1")?.state === "lost", 10_000, "worker lost");
    const send = manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "恢复后改用 pnpm",
      intent: "now",
    });
    await expect(send).resolves.toEqual({ delivery: "steer", effect: "after_current_tools" });
    expect(events.some((e) => e.type === "resumed")).toBe(true);
    expect(readPiLog(piLog).some((e) => e.type === "steer" && e.text === "恢复后改用 pnpm")).toBe(true);
  }, 30_000);

  it("unknown worker → not_found; empty text → bad_request", async () => {
    setup([]);
    await expect(
      manager.handleCommand("cmd-x", "send", { workerId: "w-nope", text: "hi", intent: "auto" }),
    ).rejects.toMatchObject({ code: "not_found" });
    workerIds.add("w-interv-1");
    await manager.handleCommand("cmd-start-1", "start_worker", {
      workerId: "w-interv-1",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "x",
    });
    await expect(
      manager.handleCommand("cmd-x", "send", { workerId: "w-interv-1", text: "", intent: "auto" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  }, 30_000);
});

describe("interrupt: clear_queue → abort → settle → optional then (§6.2)", () => {
  it("returns queued texts as queue_returned, aborts, and the worker lands idle", async () => {
    setup([longRun(10)]);
    await startWorker1();
    await waitFor(() => events.some((e) => e.type === "progress"), 5000, "run started");
    await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "改用 pnpm",
      intent: "now",
    });

    const result = (await manager.handleCommand("cmd-interv-1", "interrupt", { workerId: "w-interv-1" })) as {
      aborted: boolean;
      queueReturned: number;
    };
    expect(result).toEqual({ aborted: true, queueReturned: 1 });

    // Wire order: the undelivered steer surfaces as queue_returned, then the aborted settle.
    const types = events.map((e) => e.type);
    expect(types.indexOf("queue_returned")).toBeLessThan(types.lastIndexOf("settled"));
    expect(events.find((e) => e.type === "queue_returned")).toMatchObject({ texts: ["改用 pnpm"] });
    expect(settledEvents().at(-1)).toMatchObject({ outcome: "aborted" });
    // Idle-hot: the process stays for the idle window; the session is intact.
    expect(store.getWorker("w-interv-1")).toMatchObject({ state: "idle", lastOutcome: "aborted" });
    expect(isLockHeld(stateDir, "w-interv-1")).toBe(true);
    // The clear_queue happened before the abort (§6.2 order), and the steer never delivered.
    const log = readPiLog(piLog);
    expect(log.findIndex((e) => e.type === "clear_queue")).toBeLessThan(log.findIndex((e) => e.type === "abort"));
  }, 30_000);

  it("then: after the abort settles, the follow-up instruction prompts a new run", async () => {
    setup([longRun(10), reportRun({ status: "done", summary: "按新方向完成" })]);
    await startWorker1();
    await waitFor(() => events.some((e) => e.type === "progress"), 5000, "run started");

    const result = (await manager.handleCommand("cmd-interv-1", "interrupt", {
      workerId: "w-interv-1",
      then: { text: "停；改用 pnpm install 重来" },
    })) as { aborted: boolean; queueReturned: number; then?: { delivery: string } };
    expect(result.aborted).toBe(true);
    expect(result.then).toMatchObject({ delivery: "prompt" });

    // The then-text reached pi as the next prompt, carrying the interrupt's commandId marker.
    expect(readPiLog(piLog).find((e) => e.commandId === "cmd-interv-1")).toMatchObject({
      text: "停；改用 pnpm install 重来",
    });
    await waitFor(() => settledEvents().length === 2, 15_000, "then-run settled");
    expect(settledEvents().at(-1)).toMatchObject({ outcome: "reported" });
    expect(store.getWorker("w-interv-1")!.state).toBe("idle");
  }, 30_000);

  it("supersedes connector-queued sends ahead of it (protocol §7.4)", async () => {
    setup([longRun(10)], {}, { delayMs: 500 });
    workerIds.add("w-interv-1");
    const start = manager.handleCommand("cmd-start-1", "start_worker", {
      workerId: "w-interv-1",
      threadId: "fix-login",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => store.getWorker("w-interv-1")?.state === "starting", 5000, "worker starting");
    const send = manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "queued while starting",
      intent: "auto",
    });
    send.catch(() => {}); // handled below; silences the pre-assertion rejection window
    const interrupt = manager.handleCommand("cmd-interv-1", "interrupt", { workerId: "w-interv-1" });
    await start;

    // The queued send never delivered: the interrupt pulled it out of the queue.
    await expect(send).rejects.toMatchObject({ code: "superseded" });
    await expect(interrupt).resolves.toMatchObject({ aborted: true, queueReturned: 0 });
    expect(readPiLog(piLog).some((e) => e.type === "steer" && e.text === "queued while starting")).toBe(false);
  }, 30_000);

  it("interrupt with no live process: nothing to abort, then still reaches the session", async () => {
    setup([reportRun({ status: "done", summary: "第一段完成" }), reportRun({ status: "done", summary: "补做完成" })]);
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "first run settled");
    await manager.stopProcess("w-interv-1");
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "lock released");

    const result = (await manager.handleCommand("cmd-interv-1", "interrupt", {
      workerId: "w-interv-1",
      then: { text: "其实停下来后请补做这个" },
    })) as { aborted: boolean; queueReturned: number; then?: { delivery: string; relaunched?: boolean } };
    expect(result.aborted).toBe(false);
    expect(result.then).toMatchObject({ delivery: "prompt", relaunched: true });
    await waitFor(() => settledEvents().length === 2, 15_000, "cold then-run settled");
  }, 30_000);
});

describe("idle reclamation (§4.1)", () => {
  it("stops the process after the idle window; the session stays and a send cold-starts it", async () => {
    setup([reportRun({ status: "done", summary: "完成" }), reportRun({ status: "done", summary: "再跑一段" })], {
      idleReclaimMs: 400,
    });
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "run settled");
    expect(isLockHeld(stateDir, "w-interv-1")).toBe(true); // hot idle holds the lock…

    // …past the idle window the process is reclaimed (graceful close → lock released).
    await waitFor(() => !existsSync(lockPath(stateDir, "w-interv-1")), 10_000, "process reclaimed");
    expect(store.getWorker("w-interv-1")!.state).toBe("idle"); // session kept, state idle
    expect(events.some((e) => e.type === "process_exit")).toBe(true);

    // And the next send relaunches it (§6.2 idle-cold row).
    const result = (await manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "回收后再来一条",
      intent: "auto",
    })) as { delivery: string; relaunched?: boolean };
    expect(result).toMatchObject({ delivery: "prompt", relaunched: true });
    await waitFor(() => settledEvents().length === 2, 15_000, "post-reclaim run settled");
  }, 30_000);

  it("a send inside the window cancels reclamation (the process stays)", async () => {
    // The second run is a long silent stretch: it must not settle, so the only idle-reclaim
    // timer that could fire is the one the send has to cancel.
    setup([reportRun({ status: "done", summary: "完成" }), [{ delayMs: 5000 }]], { idleReclaimMs: 500 });
    await startWorker1();
    await waitFor(() => settledEvents().length === 1, 15_000, "run settled");
    // §6.2: idle(hot) row delivers a prompt — and the worker must not be reaped under it.
    const send = manager.handleCommand("cmd-send-1", "send", {
      workerId: "w-interv-1",
      text: "窗口内的追加",
      intent: "auto",
    });
    await expect(send).resolves.toMatchObject({ delivery: "prompt" });
    await new Promise((resolve) => setTimeout(resolve, 900)); // past the original window
    expect(existsSync(lockPath(stateDir, "w-interv-1"))).toBe(true);
  }, 30_000);
});

describe("intervention over the real transport (mock steward)", () => {
  let mock: MockSteward;
  let app: ConnectorApp;

  afterEach(async () => {
    for (const workerId of workerIds) {
      await app?.manager.stopProcess(workerId).catch(() => undefined);
    }
    app?.stop();
    await mock?.close();
  });

  it("send → interrupt → then → send flow on the wire", async () => {
    mock = startMockSteward();
    const port = await mock.listen();
    store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
    const scenario = writeScenario(dir, "transport", [
      longRun(10),
      reportRun({ status: "done", summary: "then 之后完成" }),
      reportRun({ status: "done", summary: "idle 后补跑完成" }),
    ]);
    const piLog2 = join(dir, "pi-transport.log");
    app = new ConnectorApp({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, {
        FAKE_PI_LOG: piLog2,
        FAKE_PI_SESSIONS_DIR: join(dir, "sessions"),
      }),
    });
    await app.start();
    await mock.waitConnected();

    const startId = mock.sendCmd("start_worker", {
      workerId: "w-interv-1",
      threadId: "fix-login",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    workerIds.add("w-interv-1");
    await waitFor(() => mock.resultsFor(startId), 15_000, "start cmd_result");
    await waitFor(() => mock.events().some((e) => e.type === "progress"), 10_000, "run live");

    const sendId = mock.sendCmd("send", { workerId: "w-interv-1", text: "改用 pnpm", intent: "now" });
    await waitFor(() => mock.resultsFor(sendId), 10_000, "send cmd_result");
    expect(mock.resultsFor(sendId)).toMatchObject({ ok: true, data: { delivery: "steer", effect: "after_current_tools" } });

    const interruptId = mock.sendCmd("interrupt", { workerId: "w-interv-1", then: { text: "停，改用 pnpm install" } });
    await waitFor(() => mock.resultsFor(interruptId), 15_000, "interrupt cmd_result");
    expect(mock.resultsFor(interruptId)).toMatchObject({
      ok: true,
      data: { aborted: true, queueReturned: 1, then: { delivery: "prompt" } },
    });

    // Events ride their own 250 ms batch, so poll the wire rather than snapshotting it.
    await waitFor(
      () => mock.events().some((e) => e.type === "queue_returned" && e.workerId === "w-interv-1"),
      10_000,
      "queue_returned on the wire",
    );
    expect(mock.events().find((e) => e.type === "queue_returned")).toMatchObject({ texts: ["改用 pnpm"] });
    await waitFor(
      () => mock.events().some((e) => e.workerId === "w-interv-1" && e.type === "settled" && e.outcome === "reported"),
      15_000,
      "then-run settled",
    );

    // An idle-hot send after all that starts one more run in the same session.
    const send2Id = mock.sendCmd("send", { workerId: "w-interv-1", text: "再补一小段", intent: "auto" });
    await waitFor(() => mock.resultsFor(send2Id), 10_000, "second send cmd_result");
    expect(mock.resultsFor(send2Id)).toMatchObject({ ok: true, data: { delivery: "prompt" } });
  }, 60_000);
});
