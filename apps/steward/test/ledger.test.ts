// Reducer + machine-tracking tests (issue #5, steward.md §5): events flow in over the real
// transport after a real fixed-phrase dispatch, and the ledger is asserted through the debug
// snapshot. The deterministic rules under test: one transaction per drain, idempotent per
// (workerId, seq), Thread derived state running/waiting_you/idle, unread, notification intents.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  connectAndHello,
  messageEvent,
  mockCalls,
  mockReset,
  ownerStub,
  pairDevice,
  postEvent,
  resetLedgerState,
  sendCalls,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

/** Pairs a machine, connects it with repo-a registered, and returns the live socket. */
async function connectMachine() {
  const { deviceId, token } = await pairDevice("mac-studio");
  return connectAndHello(deviceId, token, 1, {
    machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
    agents: [{ kind: "pi", version: "1.2.0", capabilities: { steer: true } }],
    repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
    limits: { maxWorkers: 4, running: 0 },
  });
}

/** Dispatches via the webhook and resolves the workerId from the start_worker command. */
async function dispatchAndAwaitWorker(wsSend: { send: (data: string) => void }, reader: { nextWhere: (pred: (m: Record<string, unknown>) => boolean, t?: number) => Promise<Record<string, unknown>> }, text: string): Promise<string> {
  const res = await postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text }));
  expect(res.status).toBe(200);
  const cmd = await reader.nextWhere((m) => m.t === "cmd");
  expect(cmd.kind).toBe("start_worker");
  wsSend.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
  return String((cmd.args as Record<string, unknown>).workerId);
}

function event(workerId: string, seq: number, fields: Record<string, unknown>) {
  return { workerId, seq, ts: Date.now(), ...fields };
}

async function sendEvents(ws: WebSocket, batch: Array<Record<string, unknown>>): Promise<void> {
  ws.send(JSON.stringify({ t: "events", id: `e${Math.random()}`, batch }));
}

/** Polls the debug snapshot until the predicate holds (events reduce asynchronously). */
async function snapshotWhere(pred: (snap: Awaited<ReturnType<typeof ownerStubDebug>>) => boolean, what: string, timeoutMs = 5000) {
  const startedAt = Date.now();
  for (;;) {
    const snap = await ownerStubDebug();
    if (pred(snap)) return snap;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for: ${what}\n${JSON.stringify(snap, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function ownerStubDebug() {
  return ownerStub().debugSnapshot();
}

const cardPayloads = async () => {
  const rows = await ownerStub().outboundRows(20);
  return rows.filter((r) => r.kind === "card" && r.status === "sent").map((r) => JSON.parse(r.payload as string) as { card?: unknown });
};

describe("machine online state derives from connections (issue #5)", () => {
  it("hello upserts the machine with its repo snapshot and the connection marks it online", async () => {
    await connectMachine();
    const snap = await snapshotWhere((s) => s.machines.some((m) => m.name === "mac-studio" && m.online), "machine online");
    expect(snap.machines).toHaveLength(1);
    expect(snap.machines[0]).toMatchObject({ name: "mac-studio", online: true, maxWorkers: 4 });
  });

  it("the last connection closing takes the machine offline; a superseded close does not", async () => {
    // Two connections for the SAME device: epoch 2 supersedes epoch 1 (protocol §3.4).
    const { deviceId, token } = await pairDevice("mac-studio");
    const first = await connectAndHello(deviceId, token, 1, {});
    const second = await connectAndHello(deviceId, token, 2, {});
    await snapshotWhere((s) => s.machines.some((m) => m.online), "online before close");
    first.ws.close(); // the superseded socket dies: the machine must stay online
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await ownerStubDebug()).machines[0]!.online).toBe(true);
    second.ws.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "offline after last close");
  });
});

describe("the reducer: derived state, unread, notification intents (steward.md §5.2-5.3)", () => {
  it("started → running; done report → sh_report + unread + green card; settled → idle with unread kept", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader, "/派发 repo-a 修复登录 bug");

    let snap = await snapshotWhere((s) => s.threads.some((t) => t.state === "running"), "running after dispatch");
    expect(snap.threads[0]!.workers[0]).toMatchObject({ workerId, state: "starting" });

    await sendEvents(ws, [event(workerId, 1, { type: "started", sessionId: workerId, branch: "shepherd/t-1" })]);
    snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "running", "worker running");
    expect(snap.threads[0]!.state).toBe("running");
    expect(snap.threads[0]!.timeline.some((e) => e.kind === "started")).toBe(true);

    await sendEvents(ws, [
      event(workerId, 2, { type: "progress", phase: "tool", tool: "edit", target: "src/a.ts", turn: 1 }),
      event(workerId, 3, {
        type: "report",
        status: "done",
        summary: "登录 bug 修好",
        changes: ["auth/session.ts 补上刷新"],
        tests: { ran: true, passed: true },
        git: { branch: "shepherd/t-1", base: "main", ahead: 2, dirty: 0, filesChanged: 1, insertions: 5, deletions: 1, pushed: false },
      }),
    ]);
    snap = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.lastOutcome === "reported:done" && s.threads[0]?.unread === true,
      "done report recorded with unread",
    );
    // progress never reaches the timeline (§5.3)
    expect(snap.threads[0]!.timeline.some((e) => e.kind === "progress")).toBe(false);

    await waitWhileOutboundPending();
    const cards = await cardPayloads();
    expect(cards).toHaveLength(1);
    const card = JSON.stringify(cards[0]);
    expect(card).toContain("登录 bug 修好");
    expect(card).toContain("auth/session.ts 补上刷新");
    expect(card).toContain("shepherd/t-1");
    expect(card).toContain('"green"'); // tone by nature: done is a success

    await sendEvents(ws, [event(workerId, 4, { type: "settled", outcome: "reported" })]);
    snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "worker idle after settled");
    expect(snap.threads[0]!.state).toBe("idle"); // no open question, nothing running
    expect(snap.threads[0]!.unread).toBe(true); // unread clears only when the user replies
  });

  it("a blocked report opens a question → waiting_you once the run settles, and the card is attention-toned with the question verbatim", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader, "/派发 repo-a 查一下构建为什么挂");
    await sendEvents(ws, [
      event(workerId, 1, { type: "started", sessionId: workerId }),
      event(workerId, 2, { type: "report", status: "blocked", summary: "被 npm 权限挡住了", question: "可以给你开 sudo 吗？" }),
    ]);
    // While the worker still runs, the Thread stays running (§5.2: running wins over the open
    // question); the question is what flips it to waiting_you once the run ends.
    let snap = await snapshotWhere((s) => s.threads[0]?.questions.length === 1, "question recorded");
    expect(snap.threads[0]!.state).toBe("running");
    expect(snap.threads[0]!.questions[0]!.text).toBe("可以给你开 sudo 吗？");
    expect(snap.threads[0]!.unread).toBe(true);
    await waitWhileOutboundPending();
    const card = JSON.stringify((await cardPayloads())[0]);
    expect(card).toContain("可以给你开 sudo 吗？");
    expect(card).toContain('"orange"');

    await sendEvents(ws, [event(workerId, 3, { type: "settled", outcome: "reported" })]);
    snap = await snapshotWhere((s) => s.threads[0]?.state === "waiting_you", "waiting_you after settle");
    expect(snap.threads[0]!.questions[0]!.status).toBe("open");
  });

  it("settled error:auth breaks the worker, opens a question, and pushes a red card (steward.md §5.3)", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader, "/派发 repo-a 再跑一次回归");
    await sendEvents(ws, [
      event(workerId, 1, { type: "started", sessionId: workerId }),
      event(workerId, 2, { type: "settled", outcome: "error", errorClass: "auth" }),
    ]);
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "broken", "worker broken");
    expect(snap.threads[0]!.state).toBe("waiting_you");
    expect(snap.threads[0]!.questions[0]!.text).toContain("凭据");
    await waitWhileOutboundPending();
    const card = JSON.stringify((await cardPayloads())[0]);
    expect(card).toContain('"red"');
    expect(card).toContain("凭据");
  });

  it("re-delivered batches apply exactly once (idempotent per workerId+seq, protocol §4.3)", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader, "/派发 repo-a 修个分页");
    const batch = [
      event(workerId, 1, { type: "started", sessionId: workerId }),
      event(workerId, 2, { type: "report", status: "done", summary: "修好了" }),
      event(workerId, 3, { type: "settled", outcome: "reported" }),
    ];
    await sendEvents(ws, batch);
    const settled = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "first pass applied");
    await sendEvents(ws, batch); // re-delivery after a reconnect
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snap = await ownerStubDebug();
    // one report row, one card, no duplicated timeline entries
    expect(snap.threads[0]!.timeline.filter((e) => e.kind === "report")).toHaveLength(
      settled.threads[0]!.timeline.filter((e) => e.kind === "report").length,
    );
    expect(snap.threads[0]!.timeline.filter((e) => e.kind === "settled")).toHaveLength(1);
    await waitWhileOutboundPending();
    expect((await cardPayloads()).length).toBe(1);
  });

  it("events for a worker this deployment never dispatched are skipped and do not block the queue", async () => {
    const { ws } = await connectMachine();
    await sendEvents(ws, [event("w_ghost", 1, { type: "started" }), event("w_ghost", 2, { type: "report", status: "done", summary: "x" })]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const snap = await ownerStubDebug();
    expect(snap.threads).toHaveLength(0); // nothing was created from thin air
  });

  it("stops at a gap and applies in order once the gap fills (resync semantics, §4.3)", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader, "/派发 repo-a 补个测试");
    await sendEvents(ws, [event(workerId, 3, { type: "report", status: "done", summary: "补好了" })]); // 1 and 2 missing
    await new Promise((resolve) => setTimeout(resolve, 150));
    let snap = await ownerStubDebug();
    expect(snap.threads[0]!.workers[0]!.lastOutcome).toBeNull(); // nothing past the gap

    await sendEvents(ws, [
      event(workerId, 1, { type: "started", sessionId: workerId }),
      event(workerId, 2, { type: "progress", phase: "tool", tool: "edit" }),
    ]);
    snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.lastOutcome === "reported:done", "gap filled, all applied");
    expect(snap.threads[0]!.workers[0]!.state).toBe("running"); // started applied before the report
  });

  it("a rejected start_worker marks the worker broken and pushes a red failure card", async () => {
    const { ws, reader } = await connectMachine();
    const res = await postEvent(messageEvent({ msgId: "om_d1", text: "/派发 repo-a 修一下部署脚本" }));
    expect(res.status).toBe(200);
    const cmd = await reader.nextWhere((m) => m.t === "cmd");
    ws.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "rejected", code: "not_registered_repo" }));

    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "broken", "worker broken");
    expect(snap.threads[0]!.state).toBe("idle"); // broken does not count as running and no question was asked
    expect(snap.threads[0]!.unread).toBe(true);
    await waitWhileOutboundPending();
    const card = JSON.stringify((await cardPayloads())[0]);
    expect(card).toContain('"red"');
    expect(card).toContain("not_registered_repo");
    // the failure card still links the Thread, so a quote-reply routes back to it
    const rows = await ownerStub().outboundRows(10);
    expect(rows.some((r) => r.kind === "card" && r.threadId === snap.threads[0]!.threadId)).toBe(true);
    void (await mockCalls());
  });
});
