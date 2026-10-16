// Issue #13, DO side: the §8.4 stall alarm (one template notice per silent stall, reset by
// the next event) and the reap sweep (running + offline 10 min, or online-but-silent 45 min
// → lost) — plus the ledger's handling of the connector watchdog's error:stall settle. Every
// threshold here is the production default; time is moved by backdating lastEventAt.
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  messageEvent,
  mockCalls,
  mockReset,
  ownerStub,
  pairDevice,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

const MIN = 60_000;

/** Dispatches a task, lets the (script-by-hand) connector accept it, and emits `started`. */
async function dispatchRunningWorker(prompt: string): Promise<{ fake: FakeConnector; workerId: string; threadId: string }> {
  const { deviceId, token } = await pairDevice("mac-studio");
  const fake = new FakeConnector({
    deviceId,
    token,
    repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    run: null,
    autorun: false,
  });
  await fake.connect();
  const res = await postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text: `/派发 repo-a ${prompt}` }));
  expect(res.status).toBe(200);
  const [cmd] = await fake.waitForCmds(1);
  const workerId = String((cmd!.args as Record<string, unknown>).workerId);
  const threadId = String((cmd!.args as Record<string, unknown>).threadId);
  await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a", branch: `shepherd/${threadId}-1` });
  return { fake, workerId, threadId };
}

/** Backdates the worker's lastEventAt (the alarm's clock) inside the DO. */
async function backdate(workerId: string, minutes: number): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_worker SET lastEventAt = ${Date.now() - minutes * MIN} WHERE workerId = '${workerId}'`);
  });
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
    const cardJson = JSON.parse(card!.payload as string) as { card: { header: unknown; elements: unknown[] } };
    expect(JSON.stringify(cardJson.card.header)).toContain("没有任何动静");
    expect(JSON.stringify(cardJson.card.header)).toContain("orange");
    expect(JSON.stringify(cardJson.card.elements)).toContain("mac-studio");
    expect(row!.thread.timeline.some((e) => e.kind === "stall" && e.text.includes("分钟没有任何动静"))).toBe(true);

    // The same stall never notifies twice — the dedupe key carries lastEventAt.
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await sentCards()).length).toBe(1);
    fake.close();
    void (await mockCalls());
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
    void (await mockCalls());
  }, 30_000);

  it("is driven by the real scheduled alarm, not just explicit calls", async () => {
    // Shrink the thresholds inside the DO BEFORE anything arms the alarm, then let the
    // SDK's alarm fire the sweep on its own.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const knobs = instance as unknown as { stallAlarmMs: number; workerSweepIntervalS: number };
      knobs.stallAlarmMs = 1_500;
      knobs.workerSweepIntervalS = 1;
    });
    const { fake, workerId } = await dispatchRunningWorker("等真实闹钟");
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
    fake.close();
    void (await mockCalls());
  }, 30_000);
});

describe("the reap sweep (running + offline 10 min, or online-but-silent 45 min → lost)", () => {
  it("reaps a worker whose machine went offline 11 minutes ago; no push, and hello reconciles it back", async () => {
    const { fake, workerId } = await dispatchRunningWorker("离线回收");
    fake.close();
    await runInDurableObject(ownerStub(), async (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE sh_machine SET online = 0");
    });

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
    void (await mockCalls());
  }, 30_000);

  it("keeps an offline worker that went silent less than 10 minutes ago", async () => {
    const { fake, workerId } = await dispatchRunningWorker("离线未到时");
    fake.close();
    await runInDurableObject(ownerStub(), async (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE sh_machine SET online = 0");
    });

    await backdate(workerId, 9);
    expect(await sweep()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("running");
    fake.close();
    void (await mockCalls());
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
    void (await mockCalls());
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
    void (await mockCalls());
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
    void (await mockCalls());
  }, 30_000);
});
