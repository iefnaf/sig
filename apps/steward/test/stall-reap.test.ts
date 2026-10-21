// Issue #13, DO side: the §8.4 stall alarm (one template notice per silent stall, reset by
// the next event) and the reap sweep (running + offline 10 min, or online-but-silent 45 min
// → lost) — plus the ledger's handling of the connector watchdog's error:stall settle. Every
// threshold here is the production default; time is moved by backdating lastEventAt.
// Dispatch goes through the deterministic dispatch service (the start_worker tool's code
// path — issue #6 replaced the old /派发 phrase with the LLM, whose faux provider is not
// scripted here).
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  messageEvent,
  ownerStub,
  pairDevice,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

const MIN = 60_000;

/** Pairs a machine, connects it with repo-a registered, and leaves the socket open. */
async function connectMachine(): Promise<FakeConnector> {
  const { deviceId, token } = await pairDevice("mac-studio");
  const fake = new FakeConnector({
    deviceId,
    token,
    repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    run: null,
    autorun: false,
  });
  await fake.connect();
  return fake;
}

/** Dispatches to an online machine and never emits `started` — a wedged connector's shape. */
async function dispatchCmdWithoutStart(): Promise<{ fake: FakeConnector; workerId: string }> {
  const fake = await connectMachine();
  const outcome = await ownerStub().dispatchForTest({ prompt: "卡在启动", repoRef: "repo-a", newTitle: "卡在启动" });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
  await fake.waitForCmds(1);
  return { fake, workerId: outcome.workerId };
}

/** Dispatches a task through the deterministic service, acks the command, and emits `started`. */
async function dispatchRunningWorker(prompt: string): Promise<{ fake: FakeConnector; workerId: string; threadId: string }> {
  const fake = await connectMachine();
  const outcome = await ownerStub().dispatchForTest({ prompt, repoRef: "repo-a", newTitle: prompt });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
  const [cmd] = await fake.waitForCmds(1);
  fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
  const { workerId, threadId } = outcome;
  await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a", branch: `sig/${threadId}-1` });
  // The frame is only queued when emit resolves — wait until the reducer has applied it,
  // or a later backdate races the event's own lastEventAt write.
  await waitForWorkerState(workerId, "running");
  return { fake, workerId, threadId };
}

/** Backdates the worker's lastEventAt (the alarm's clock) inside the DO. */
async function backdate(workerId: string, minutes: number): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_worker SET lastEventAt = ${Date.now() - minutes * MIN} WHERE workerId = '${workerId}'`);
  });
}

/** Marks the machine offline `minutes` ago (online=0 + lastSeen — the reap sweep's clock).
 * Waits for the connection's close event first: onClose rewrites lastSeen, so backdating
 * before it lands would be overwritten within milliseconds. */
async function setMachineOffline(minutesAgo: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    if (snap.machines.every((m) => !m.online)) break;
    if (Date.now() > deadline) throw new Error("machine never went offline");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_machine SET online = 0, lastSeen = ${Date.now() - minutesAgo * MIN}`);
  });
}

/** Restores the production sweep knobs and drops fast-cadence sweepWorkers rows — the
 * isolate (and its fields) outlives each test that shrinks them. */
async function restoreSweepMaintenance(): Promise<void> {
  await runInDurableObject(ownerStub(), async (instance: Steward) => {
    const knobs = instance as unknown as { stallAlarmMs: number; reapOfflineMs: number; reapSilentMs: number; workerSweepIntervalS: number };
    knobs.stallAlarmMs = 20 * 60_000;
    knobs.reapOfflineMs = 10 * 60_000;
    knobs.reapSilentMs = 45 * 60_000;
    knobs.workerSweepIntervalS = 60;
    for (const scheduleRow of await instance.listSchedules()) {
      if ((scheduleRow as unknown as { callback?: string }).callback === "sweepWorkers") {
        await instance.cancelSchedule(scheduleRow.id).catch(() => undefined);
      }
    }
  });
}

/** A card.action trigger for the ask card's buttons (the wait_online flow). */
function cardActionEvent(cardMsgId: string, action: string) {
  return { cardMsgId, action };
}

async function workerRow(workerId: string) {
  const snap = await ownerStub().debugSnapshot();
  for (const thread of snap.threads) {
    const worker = thread.workers.find((w) => w.workerId === workerId);
    if (worker) return { thread, worker };
  }
  return null;
}

async function sentCards() {
  return (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent");
}

/** fake.emit resolves when the frame is sent, not when the DO has applied it — poll the row. */
async function waitForWorkerState(workerId: string, state: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await workerRow(workerId);
    if (row?.worker.state === state) return row;
    if (Date.now() > deadline) throw new Error(`worker ${workerId} never reached "${state}" (stuck at "${row?.worker.state}")`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Same polling for an arbitrary worker-row predicate (timeline entries etc.). */
async function waitForRow(workerId: string, pred: (row: NonNullable<Awaited<ReturnType<typeof workerRow>>>) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await workerRow(workerId);
    if (row && pred(row)) return row;
    if (Date.now() > deadline) throw new Error(`worker ${workerId} never satisfied the predicate`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function sweep(): Promise<{ stalled: number; reaped: number }> {
  return ownerStub().sweepWorkers();
}

describe("the §8.4 stall alarm (online machine, lastEventAt + 20 min)", () => {
  it("emits exactly one template notice per stall, with a timeline entry", async () => {
    const { fake, workerId, threadId } = await dispatchRunningWorker("做个大重构");

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitWhileOutboundPending();

    // The run is still live — attention, not failure — and the worker stays running.
    const row = await workerRow(workerId);
    expect(row!.worker.state).toBe("running");
    expect(row!.thread.state).toBe("running");
    expect(row!.thread.unread).toBe(true);
    const [card] = await sentCards();
    expect(card?.threadId).toBe(threadId);
    const cardJson = JSON.parse(card!.payload as string) as { card: { text: string } };
    expect(cardJson.card.text).toContain("没有任何动静");
    expect(cardJson.card.text).toContain("⚠️");
    expect(cardJson.card.text).toContain("mac-studio");
    expect(row!.thread.timeline.some((e) => e.kind === "stall" && e.text.includes("分钟没有任何动静"))).toBe(true);

    // The same stall never notifies twice — the dedupe key carries lastEventAt.
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await sentCards()).length).toBe(1);
    fake.close();
  }, 30_000);

  it("resets on the next event: a second silent period notifies again", async () => {
    const { fake, workerId } = await dispatchRunningWorker("第二轮静默");

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitWhileOutboundPending();

    // The worker emits: the timer restarts (this is also what a connector watchdog respawn's
    // progress/resumed events do — they push the DO alarm out by a full window).
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "src/a.ts", turn: 2 });
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 }); // fresh clock, nothing due

    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(2);
    fake.close();
  }, 30_000);

  it("is driven by the real scheduled alarm, not just explicit calls", async () => {
    // Shrink the thresholds inside the DO BEFORE anything arms the alarm, then let the
    // SDK's alarm fire the sweep on its own. The knobs are restored afterwards — the
    // isolate (and its fields) outlives this test.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const knobs = instance as unknown as { stallAlarmMs: number; workerSweepIntervalS: number };
      knobs.stallAlarmMs = 1_500;
      knobs.workerSweepIntervalS = 1;
    });
    const { fake, workerId } = await dispatchRunningWorker("等真实闹钟");
    try {
      await backdate(workerId, 3);

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const row = await workerRow(workerId);
        if (row!.thread.timeline.some((e) => e.kind === "stall")) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await waitWhileOutboundPending();
      const row = await workerRow(workerId);
      expect(row!.thread.timeline.some((e) => e.kind === "stall")).toBe(true);
      expect((await sentCards()).length).toBe(1);
    } finally {
      fake.close();
      await restoreSweepMaintenance();
    }
  }, 30_000);
});

describe("the reap sweep (running + offline 10 min, or online-but-silent 45 min → lost)", () => {
  it("reaps a worker whose machine went offline 11 minutes ago; no push, and hello reconciles it back", async () => {
    const { fake, workerId } = await dispatchRunningWorker("离线回收");
    fake.close();
    await setMachineOffline(11); // offline for a REAL 11 minutes (lastSeen, not just the flag)

    await backdate(workerId, 11);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    const row = await workerRow(workerId);
    expect(row!.worker.state).toBe("lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle"); // the Thread no longer pretends to be running
    expect(row!.thread.timeline.some((e) => e.kind === "lost" && e.text.includes("机器离线"))).toBe(true);
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(0); // lost is not news worth a push (spec §9)

    // The machine returns with the worker actually running: hello reconciliation flips it
    // back to running — the sweep never wedges a live worker in `lost`.
    fake.workers = [
      { workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" },
    ];
    await fake.connect();
    const back = await workerRow(workerId);
    expect(back!.worker.state).toBe("running");
    expect(back!.thread.timeline.some((e) => e.kind === "resumed")).toBe(true);
  }, 30_000);

  it("keeps an offline worker that went silent less than 10 minutes ago", async () => {
    const { fake, workerId } = await dispatchRunningWorker("离线未到时");
    fake.close();
    await setMachineOffline(9);

    await backdate(workerId, 9);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("running");
    fake.close();
  }, 30_000);

  it("reaps an online-but-silent worker at 45 minutes (the connector forgot it)", async () => {
    const { fake, workerId } = await dispatchRunningWorker("在线但彻底静默");

    // At 44 minutes the stall notice has fired (one, deduped) but the worker is kept.
    await backdate(workerId, 44);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(1);
    expect((await workerRow(workerId))!.worker.state).toBe("running");

    // Two more silent minutes cross the reap line: lost, timeline only.
    await backdate(workerId, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    const row = await workerRow(workerId);
    expect(row!.worker.state).toBe("lost");
    expect(row!.thread.timeline.some((e) => e.kind === "lost" && e.text.includes("机器在线但"))).toBe(true);
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(1); // the stall notice, nothing new for the reap
    fake.close();
  }, 30_000);

  it("never touches workers outside active states (idle after settling)", async () => {
    const { fake, workerId } = await dispatchRunningWorker("跑完的任务");
    await fake.emit("report", workerId, { status: "done", summary: "完成了" });
    await fake.emit("settled", workerId, { outcome: "reported" });
    const settled = await waitForWorkerState(workerId, "idle");

    await backdate(workerId, 120);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("idle");
    fake.close();
  }, 30_000);
});

describe("the connector watchdog's events reaching the ledger (error:stall)", () => {
  it("a stall respawn is visible as activity; the second strike breaks the worker and asks the user", async () => {
    const { fake, workerId } = await dispatchRunningWorker("连接器看门狗场景");

    // Strike 1 on the connector: detection progress + respawn. Both rewrite lastEventAt —
    // the DO's own stall clock restarts, so 19 minutes later (just under the threshold)
    // the alarm is still quiet.
    await fake.emit("progress", workerId, { phase: "tool", tool: "stall-watchdog", target: "no stdout for 480s", turn: 1 });
    await fake.emit("resumed", workerId, { reason: "stall", count: 1 });
    await backdate(workerId, 19);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });

    // Strike 2: settled error:stall routes to the user deterministically.
    await fake.emit("settled", workerId, {
      outcome: "error",
      errorClass: "stall",
      lastText: "no stdout for 480s with CPU 0.3%/0.4%; still wedged after one automatic restart",
    });
    const row = await waitForWorkerState(workerId, "broken");
    expect(row!.worker.lastOutcome).toBe("error:stall");
    expect(row!.thread.state).toBe("waiting_you");
    const question = row!.thread.timeline.find((e) => e.kind === "question");
    expect(question?.text).toContain("自动重启一次后仍然挂死");
    await waitWhileOutboundPending();
    const [card] = await sentCards();
    expect(JSON.stringify(JSON.parse(card!.payload as string))).toContain("运行出错");
    fake.close();
  }, 30_000);
});

describe("a reaped worker that is alive recovers (issue #13 review finding 2)", () => {
  it("recovers on its next live event over the same connection — no hello needed", async () => {
    const { fake, workerId } = await dispatchRunningWorker("超长工具调用");
    await backdate(workerId, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    // The very long tool call finishes: live progress on the SAME connection proves life.
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "src/live-after-reap.ts", turn: 7 });
    const row = await waitForWorkerState(workerId, "running");
    expect(row!.worker.lastOutcome).toBeNull(); // the reaped marker is cleared
    expect(row!.thread.timeline.some((e) => e.kind === "resumed" && e.text.includes("回收后自动纠正"))).toBe(true);

    // Alive again means covered again: the next silent stretch gets a fresh stall notice.
    await backdate(workerId, 21);
    expect(await sweep()).toEqual({ stalled: 1, reaped: 0 });
    fake.close();
  }, 30_000);

  it("resumes via the parked connector snapshot once redelivery catches up (offline reap)", async () => {
    const { fake, workerId } = await dispatchRunningWorker("断连期间继续跑");
    fake.close();
    await setMachineOffline(11);
    await backdate(workerId, 11);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    // The machine returns; the connector says "running, lastSeq 3" while events 2..3 are
    // still in flight. The hello parks that verdict; the backfilled progress must not
    // resurrect on its own (it may predate the reap) — the snapshot decides once seq 3 lands.
    fake.workers = [{ workerId, agent: "pi", state: "running", lastSeq: 3, sessionId: workerId, lastOutcome: "" }];
    await fake.connect();
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "offline-1.ts", turn: 2 });
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "offline-2.ts", turn: 3 });
    const row = await waitForWorkerState(workerId, "running");
    expect(String(row!.worker.lastProgress)).toContain("offline-2");
    expect(row!.thread.timeline.some((e) => e.kind === "resumed" && e.text.includes("快照对账"))).toBe(true);
    fake.close();
  }, 30_000);

  it("a parked snapshot that says the run ended wins over backfilled progress", async () => {
    const { fake, workerId } = await dispatchRunningWorker("断连期间死了");
    fake.close();
    await setMachineOffline(11);
    await backdate(workerId, 11);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    // The connector reconnects reporting the worker LOST (it died during the outage), its
    // last events still in flight. Old progress alone must not resurrect the worker: once
    // the stream catches up, the snapshot's terminal verdict is applied.
    fake.workers = [{ workerId, agent: "pi", state: "lost", lastSeq: 3, sessionId: workerId, lastOutcome: "" }];
    await fake.connect();
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "dying-1.ts", turn: 2 });
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "dying-2.ts", turn: 3 });
    const row = await waitForRow(workerId, (r) => r.thread.timeline.some((e) => e.kind === "note" && e.text.includes("连接器报告运行已结束")));
    expect(row.worker.state).toBe("lost");
    expect(String(row.worker.lastProgress)).toContain("dying-2"); // the events were applied…
    fake.close();
  }, 30_000);
});

describe("offline duration is measured, not assumed (issue #13 review finding 4)", () => {
  it("a momentary connection blip does not reap a long-silent worker", async () => {
    const { fake, workerId } = await dispatchRunningWorker("长时间安静");
    await backdate(workerId, 11); // quiet, but under the 20-min alarm horizon
    fake.close(); // drops NOW: lastSeen ≈ the moment of the drop
    await setMachineOffline(0); // belt-and-braces: offline since right now

    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 }); // offline for ~0 s: keep it
    expect((await workerRow(workerId))!.worker.state).toBe("running");

    // Truly offline for 11 minutes → reaped.
    await setMachineOffline(11);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    expect((await workerRow(workerId))!.worker.state).toBe("lost");
  }, 30_000);
});

describe("a queued start_worker is never reaped into a duplicate dispatch (issue #13 review finding 3)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The Thread's worker count, straight from the snapshot. */
  async function threadWorkers(): Promise<Array<{ workerId: string; state: string }>> {
    const snap = await ownerStub().debugSnapshot();
    return snap.threads[0]?.workers ?? [];
  }

  it("keeps the wait_online queue intact through the reap window; the guard holds on the command", async () => {
    const fake = await connectMachine();
    fake.close(); // the machine goes offline before the dispatch
    // Wait for the DO's onClose to land: the dispatch below must SEE the machine offline,
    // or it legitimately dispatches-and-queues instead of asking (observed CI flake).
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await sleep(25);
    }

    // Dispatch through the deterministic service (the start_worker tool's path): the only
    // machine with the repo is offline → the offline ask card, exactly like the LLM flow.
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome.kind).toBe("asked_offline");
    await waitWhileOutboundPending();
    const [askCard] = await sentCards(); // the offline ask card
    expect(askCard?.providerMsgId).toBeTruthy();

    // 1st click 「排队等上线」: one worker `starting`, one queued start_worker.
    await postEvent(cardActionEvent(String(askCard!.providerMsgId), "wait_online"));
    let workerId = "";
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const workers = await threadWorkers();
      if (workers[0]?.workerId && (await workerRow(workers[0].workerId))?.worker.cmdId) {
        workerId = workers[0].workerId;
        break;
      }
      await sleep(50);
    }
    expect(workerId).not.toBe("");
    expect((await workerRow(workerId))!.worker.state).toBe("starting");

    // The guard works while queued: a 2nd click is refused.
    await postEvent(cardActionEvent(String(askCard!.providerMsgId), "wait_online"));
    await sleep(400);
    expect(await threadWorkers()).toHaveLength(1);

    // 11 minutes of silence on the offline machine — the old code reaped here, and a further
    // click duplicated the dispatch. Now: untouched (the command can still be delivered).
    await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE sh_worker SET createdAt = ${Date.now() - 11 * MIN} WHERE workerId = '${workerId}'`);
    });
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("starting");

    // A 3rd click is STILL refused — the queued command itself counts as live.
    await postEvent(cardActionEvent(String(askCard!.providerMsgId), "wait_online"));
    await sleep(400);
    expect(await threadWorkers()).toHaveLength(1);
    const outbox = await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) =>
      state.storage.sql.exec("SELECT cmdId FROM outbox WHERE kind = 'start_worker'").toArray(),
    );
    expect(outbox).toHaveLength(1);

    // The queue times out (idle fail at 30 min — simulated terminally): the sweep closes the
    // worker with a failure the owner hears about, freeing the Thread for a fresh dispatch.
    await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE outbox SET state = 'failed', failReason = 'idle' WHERE kind = 'start_worker'");
    });
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    const row = await waitForWorkerState(workerId, "broken");
    expect(row!.worker.lastOutcome).toMatch(/^start_failed:/);
    await waitWhileOutboundPending();
    // The ask card plus the failure push — exactly two cards, and no duplicate dispatch.
    expect((await sentCards()).length).toBe(2);
    fake.close();
  }, 40_000);

  it("reaps a delivered-but-never-started worker only at the online-silent horizon (cmd done)", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();

    // Delivered + acknowledged (outbox done), but no `started` ever arrives: 46 minutes of
    // silence keep the worker (the command might still be mid-flight)…
    await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE outbox SET state = 'done' WHERE workerId = '${workerId}'`);
      state.storage.sql.exec(`UPDATE sh_worker SET createdAt = ${Date.now() - 46 * MIN} WHERE workerId = '${workerId}'`);
    });
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    await waitForWorkerState(workerId, "lost");
    fake.close();
  }, 30_000);

  it("keeps a delivered-but-never-started worker while the command is still in flight (sent)", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();

    await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE outbox SET state = 'sent' WHERE workerId = '${workerId}'`);
      state.storage.sql.exec(`UPDATE sh_worker SET createdAt = ${Date.now() - 46 * MIN} WHERE workerId = '${workerId}'`);
    });
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 }); // sent = maybe delivering: wait
    expect((await workerRow(workerId))!.worker.state).toBe("starting");
    fake.close();
  }, 30_000);
});

describe("terminal start_worker verdicts close wedged starting workers (PR #41 review findings 1-2)", () => {
  /** Rewrites the worker's start_worker outbox row and backdates its silence clock. */
  async function setCommandAndClock(
    workerId: string,
    cmdSql: string,
    silentMinutes: number,
  ): Promise<void> {
    await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
      if (cmdSql) state.storage.sql.exec(cmdSql);
      state.storage.sql.exec(`UPDATE sh_worker SET createdAt = ${Date.now() - silentMinutes * MIN} WHERE workerId = '${workerId}'`);
    });
  }

  it("a lapsed notAfter delivery window is a queue timeout: broken + push, never \"已撤回\"", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();
    fake.close(); // the machine drops before the command is acked; the row stays `sent`

    // The ack deadline and the delivery window both lapse (the resendUnacked alarm path is
    // the writer in production — deliver() flips the row instead of re-sending).
    await setCommandAndClock(
      workerId,
      `UPDATE outbox SET notAfter = 1, ackDeadline = 1 WHERE workerId = '${workerId}'`,
      11,
    );
    await ownerStub().resendUnacked();
    const cmdRow = await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) =>
      state.storage.sql.exec(`SELECT state, failReason FROM outbox WHERE workerId = '${workerId}'`).toArray(),
    );
    expect(cmdRow[0]).toMatchObject({ state: "failed", failReason: "not_after" });

    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    const row = await waitForWorkerState(workerId, "broken");
    expect(row!.worker.lastOutcome).toMatch(/^start_failed:命令过期未送达/);
    // The timeline records a failed dispatch, NOT a user withdrawal (finding 1's lie).
    expect(row!.thread.timeline.some((e) => e.text.includes("派发失败"))).toBe(true);
    expect(row!.thread.timeline.some((e) => e.text.includes("已撤回"))).toBe(false);
    // Issue #10: the broken worker opens a question → waiting_you (nothing is running;
    // re-dispatch stays open once the question is answered).
    expect(row!.thread.state).toBe("waiting_you");
    await waitWhileOutboundPending();
    const [card] = await sentCards();
    expect(JSON.stringify(JSON.parse(card!.payload as string))).toContain("命令过期未送达");
  }, 30_000);

  it("an ambiguous start_worker closes as quiet lost+reaped at the silent horizon — and resurrects if alive", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();

    // The connector crashed mid-send (§4.2: terminal, never re-delivered, undecidable).
    await setCommandAndClock(workerId, `UPDATE outbox SET state = 'ambiguous' WHERE workerId = '${workerId}'`, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    const row = await waitForWorkerState(workerId, "lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle"); // no push: "it failed" might be a lie
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(0);

    // Undecidable means maybe-alive: a live event after the close brings the worker back.
    await fake.emit("progress", workerId, { phase: "tool", tool: "edit", target: "src/ambiguous.ts", turn: 1 });
    const back = await waitForWorkerState(workerId, "running");
    expect(back!.worker.lastOutcome).toBeNull();
    fake.close();
  }, 30_000);

  it("a worker whose command row never existed closes with a start-failure push", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();

    // Registration succeeded but setCmdId never ran (enqueue threw): no outbox row at all.
    await setCommandAndClock(workerId, `UPDATE sh_worker SET cmdId = NULL WHERE workerId = '${workerId}'`, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    const row = await waitForWorkerState(workerId, "broken");
    expect(row!.worker.lastOutcome).toMatch(/^start_failed:派发命令未能创建/);
    // Issue #10: the failure opens a question (rules table) → waiting_you, one push card.
    expect(row!.thread.state).toBe("waiting_you");
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(1);
    fake.close();
  }, 30_000);

  it("an accepted-but-never-resulted start_worker closes at the online-silent horizon (PR #46 review finding 1)", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();

    // The connector acked (accepted), then died or hung before any cmd_result — nothing
    // else ever transitions that row, and a hung connector keeps the machine reading online.
    await setCommandAndClock(workerId, `UPDATE outbox SET state = 'accepted' WHERE workerId = '${workerId}'`, 46);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });

    const row = await waitForWorkerState(workerId, "lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle"); // the Thread no longer wedges in running
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(0); // quiet: the run may be alive on the machine
    fake.close();
  }, 30_000);

  it("a serial-queued worker is reaped only when its machine measurably disappears, never by silence (merge with #16)", async () => {
    const { fake, workerId } = await dispatchRunningWorker("排队任务");
    // The connector parks the write worker behind a serial slot (issue #16).
    await fake.emit("queued", workerId, { behind: "w-other" });
    await waitForWorkerState(workerId, "queued");

    // Two hours "waiting" on an ONLINE machine: legitimate (a long task holds the slot) —
    // no reap, no stall notice, nothing.
    await backdate(workerId, 120);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("queued");

    // The machine measurably disappears: quiet lost{reaped}, same 10-min clock as running.
    fake.close();
    await setMachineOffline(11);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    const row = await waitForWorkerState(workerId, "lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle");
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(0);
  }, 30_000);

  it("a LONE queued worker keeps the sweep chain armed: the real alarm reaps it when the machine disappears (PR #46 review round 3, finding 1)", async () => {
    // The holder settled long ago; this queued worker is the only active row anywhere. Its
    // sole closure is the sweep's measured-offline reap, so the arming count must include
    // `queued` or the chain dies and the wedge this PR exists to close returns.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const knobs = instance as unknown as { workerSweepIntervalS: number; reapOfflineMs: number };
      knobs.workerSweepIntervalS = 1;
      knobs.reapOfflineMs = 3_000;
    });
    let fake: FakeConnector | null = null;
    try {
      const dispatched = await dispatchRunningWorker("只排队的任务");
      fake = dispatched.fake;
      await fake.emit("queued", dispatched.workerId, { behind: "w-other" });
      await waitForWorkerState(dispatched.workerId, "queued");
      fake.close();
      await setMachineOffline(0); // drops now; the offline clock matures ~3 s later

      // Deliberately NO sweep() call: the queued worker alone must keep the alarm armed and
      // the REAL scheduled alarm must perform the reap.
      const row = await waitForWorkerState(dispatched.workerId, "lost", 15_000);
      expect(row!.worker.lastOutcome).toBe("reaped");
      expect(row!.thread.state).toBe("idle");
    } finally {
      await restoreSweepMaintenance();
    }
  }, 30_000);

  it("a done start on a machine offline for a measured 11 minutes reaps at the offline clock, not 45 (PR #46 review finding 4)", async () => {
    const { fake, workerId } = await dispatchCmdWithoutStart();
    fake.close(); // the connector died right after the successful start
    await setMachineOffline(11);
    await setCommandAndClock(workerId, `UPDATE outbox SET state = 'done' WHERE workerId = '${workerId}'`, 11);

    expect(await sweep()).toEqual({ stalled: 0, reaped: 1 });
    const row = await waitForWorkerState(workerId, "lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle");
  }, 30_000);
});
