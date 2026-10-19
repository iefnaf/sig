// Issue #12, DO side: `hello.workers` + `bootId` let the DO reconcile after a connector
// restart (connector-pi.md §9.1 step 4 / protocol §6.1). The ledger's workers sync with the
// snapshot only when the event stream cannot tell the story anymore (lastSeq <=
// processedUpTo); `lost`/`resumed` land on the timeline WITHOUT pushing, and a
// connector-reported resume failure (settled error + lastText) reaches the user as a
// question that carries the connector's detail.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  connectAndHello,
  ownerStub,
  pairDevice,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

/** Pairs a machine and connects it with repo-a registered; the socket stays open. */
async function connectMachine() {
  const { deviceId, token } = await pairDevice("mac-studio");
  return {
    deviceId,
    token,
    ...(await connectAndHello(deviceId, token, 1, {
      bootId: "boot-a",
      machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
      agents: [{ kind: "pi", version: "1.2.0", capabilities: { steer: true } }],
      repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
      limits: { maxWorkers: 4, running: 0 },
    })),
  };
}

/** Dispatches through the deterministic service (the start_worker tool's code path — issue #6
 *  replaced the fixed phrases with the LLM) and resolves the workerId from the command. */
async function dispatchAndAwaitWorker(
  wsSend: { send: (data: string) => void },
  reader: { nextWhere: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>> },
): Promise<string> {
  const outcome = await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
  expect(outcome.kind).toBe("dispatched");
  const cmd = await reader.nextWhere((m) => m.t === "cmd");
  wsSend.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
  return String((cmd.args as Record<string, unknown>).workerId);
}

async function sendEvents(ws: { send: (data: string) => void }, batch: Array<Record<string, unknown>>): Promise<void> {
  ws.send(JSON.stringify({ t: "events", id: `e${Math.random()}`, batch }));
}

/** The connector restarts: a new connection whose hello carries a fresh bootId + snapshot. */
async function reconnectWithSnapshot(
  deviceId: string,
  token: string,
  connEpoch: number,
  workers: Array<Record<string, unknown>>,
) {
  return connectAndHello(deviceId, token, connEpoch, { bootId: "boot-b", workers });
}

function snapshotEntry(workerId: string, state: string, lastSeq: number) {
  return { workerId, agent: "pi", state, lastSeq, sessionId: workerId, lastOutcome: "" };
}

/** Polls the debug snapshot until the predicate holds (events/hello reduce asynchronously). */
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

const threadOf = (snap: Awaited<ReturnType<typeof ownerStubDebug>>, workerId: string) =>
  snap.threads.find((t) => t.workers.some((w) => w.workerId === workerId))!;
const workerIn = (snap: Awaited<ReturnType<typeof ownerStubDebug>>, workerId: string) =>
  threadOf(snap, workerId).workers.find((w) => w.workerId === workerId)!;

/** The local channel's "pushes": sent outbound rows (ADR-0003). */
async function sentOutbound(): Promise<string[]> {
  return (await ownerStub().outboundRows(50)).filter((r) => r.status === "sent").map((r) => String(r.payload));
}

describe("machine bootId (protocol §6.1)", () => {
  it("hello stores the connector's bootId, so a restart is distinguishable from a blip", async () => {
    const { deviceId, token } = await pairDevice("boot-machine");
    await connectAndHello(deviceId, token, 1, { bootId: "boot-a" });
    await connectAndHello(deviceId, token, 2, { bootId: "boot-b" });
    const snap = await ownerStubDebug();
    expect(snap.machines[0]).toMatchObject({ deviceId, bootId: "boot-b" });
  });
});

describe("hello.workers reconciliation (issue #12, connector-pi.md §9.1 step 4)", () => {
  it("a ledger-running worker the connector reports lost is reconciled: timeline, no push", async () => {
    const { deviceId, token, ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId }]);
    await snapshotWhere((s) => workerIn(s, workerId)?.state === "running", "worker running");
    const sendsBefore = (await sentOutbound()).length;

    // The connector restarts: new bootId, snapshot lost with lastSeq 1 (fully processed).
    await reconnectWithSnapshot(deviceId, token, 2, [snapshotEntry(workerId, "lost", 1)]);

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "lost", "worker reconciled lost");
    expect(threadOf(snap, workerId).timeline.some((t) => t.kind === "lost" && t.text.includes("对账"))).toBe(true);
    // The Thread left `running` (lost is not active), and nothing was pushed (spec §9).
    expect(threadOf(snap, workerId).state).toBe("idle");
    expect(snap.pendingNotifications).toHaveLength(0);
    expect((await sentOutbound()).length).toBe(sendsBefore); // nothing new was pushed
  });

  it("a lost worker the connector reports running again is reconciled back to running", async () => {
    const { deviceId, token, ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [
      { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId },
      { workerId, seq: 2, ts: Date.now(), type: "lost", reason: "connector_restart" },
    ]);
    await snapshotWhere((s) => workerIn(s, workerId)?.state === "lost", "worker lost");

    // The auto-resume already succeeded on the machine, but its events were lost: the
    // snapshot (lastSeq 2 == processed) is the only witness.
    await reconnectWithSnapshot(deviceId, token, 2, [snapshotEntry(workerId, "running", 2)]);

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "running", "worker reconciled running");
    expect(threadOf(snap, workerId).timeline.some((t) => t.kind === "resumed" && t.text.includes("对账"))).toBe(true);
    expect(threadOf(snap, workerId).state).toBe("running");
    expect(snap.pendingNotifications).toHaveLength(0);
  });

  it("is gated: while the worker's event stream is still in flight, the snapshot does not write", async () => {
    const { deviceId, token, ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId }]);
    await snapshotWhere((s) => workerIn(s, workerId)?.state === "running", "worker running");

    // lastSeq 5 >> processedUpTo 1: the connector still owes events 2..5 — wait for them.
    await reconnectWithSnapshot(deviceId, token, 2, [snapshotEntry(workerId, "lost", 5)]);

    const snap = await ownerStubDebug();
    expect(workerIn(snap, workerId).state).toBe("running");
    expect(threadOf(snap, workerId).timeline.some((t) => t.kind === "lost")).toBe(false);
  });

  it("repeated identical hellos never duplicate timeline entries (idempotent reconcile)", async () => {
    const { deviceId, token, ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId }]);
    await snapshotWhere((s) => workerIn(s, workerId)?.state === "running", "worker running");

    await reconnectWithSnapshot(deviceId, token, 2, [snapshotEntry(workerId, "lost", 1)]);
    await reconnectWithSnapshot(deviceId, token, 3, [snapshotEntry(workerId, "lost", 1)]);

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "lost", "worker reconciled lost");
    expect(threadOf(snap, workerId).timeline.filter((t) => t.kind === "lost")).toHaveLength(1);
  });

  it("a snapshot reporting the worker broken after lost closes the loop on the timeline", async () => {
    const { deviceId, token, ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [
      { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId },
      { workerId, seq: 2, ts: Date.now(), type: "lost", reason: "connector_restart" },
    ]);
    await snapshotWhere((s) => workerIn(s, workerId)?.state === "lost", "worker lost");

    // Budget exhausted without any event surviving (log eviction): snapshot-only broken.
    await reconnectWithSnapshot(deviceId, token, 2, [snapshotEntry(workerId, "broken", 2)]);

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "broken", "worker reconciled broken");
    expect(threadOf(snap, workerId).timeline.some((t) => t.text.includes("自动恢复未成功"))).toBe(true);
    // Issue #10 (rules table + review finding 4): a broken verdict asks the user how to
    // handle it, and the push is DELIVERED right at the reconnect — even though the event
    // stream was fully caught up (no applied>0 pass would have drained it; the drain may
    // already have consumed the intent by the time the broken state is observed).
    expect(snap.questions.some((q) => q.workerId === workerId && q.status === "open" && q.kind === "failure")).toBe(true);
    await waitWhileOutboundPending();
    const pushes = await sentOutbound();
    expect(pushes.some((c) => c.includes("自动恢复未成功"))).toBe(true);
  });
});

describe("lost/resumed events and resume failures (spec §9, connector-pi.md §9.2)", () => {
  it("lost → resumed lands on the timeline and returns the Thread to running, without pushing", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    const sendsBefore = (await sentOutbound()).length;
    await sendEvents(ws, [
      { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId },
      { workerId, seq: 2, ts: Date.now(), type: "lost", reason: "connector_restart" },
      { workerId, seq: 3, ts: Date.now(), type: "resumed", reason: "connector_restart", count: 1 },
    ]);

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "running", "worker running again");
    const kinds = threadOf(snap, workerId).timeline.map((t) => t.kind);
    expect(kinds).toContain("lost");
    expect(kinds).toContain("resumed");
    expect(snap.pendingNotifications).toHaveLength(0);
    expect((await sentOutbound()).length).toBe(sendsBefore); // nothing new was pushed
  });

  it("a settled error with connector detail opens a question carrying that detail and pushes", async () => {
    const { ws, reader } = await connectMachine();
    const workerId = await dispatchAndAwaitWorker(ws, reader);
    await sendEvents(ws, [
      { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId },
      { workerId, seq: 2, ts: Date.now(), type: "lost", reason: "connector_restart" },
      {
        workerId,
        seq: 3,
        ts: Date.now(),
        type: "settled",
        outcome: "error",
        errorClass: "unknown",
        lastText: "Automatic resume budget exhausted (2 per hour); the worker needs a human decision.",
      },
    ]);
    await waitWhileOutboundPending();

    const snap = await snapshotWhere((s) => workerIn(s, workerId)?.state === "broken", "worker broken");
    const question = threadOf(snap, workerId).questions.find((q) => q.status === "open")!;
    expect(question.text).toContain("budget exhausted");
    // Only failed resumes reach the user (§9.2 product decision): a push did go out.
    expect((await sentOutbound()).length).toBeGreaterThanOrEqual(1);
  });
});
