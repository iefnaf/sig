// Issue #14, steward side: machine drop notices. A drop mid-task is reported — debounced
// two minutes, only when in-flight work is affected — and the affected workers are marked
// unreachable, never failed (spec §9, steward.md §5.3). Online habits land on
// sh_machine.reliability as a record (spec §10.1). The 2-minute windows are backdated in
// tests; drainNotifications is the same alarm-driven pass production uses.
import { beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { ShOutboundRow } from "../src/steward.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

type DebugSnap = Awaited<ReturnType<typeof ownerStubDebug>>;

async function ownerStubDebug() {
  return ownerStub().debugSnapshot();
}

async function snapshotWhere(pred: (snap: DebugSnap) => boolean, what: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const snap = await ownerStubDebug();
    if (pred(snap)) return snap;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for: ${what}\n${JSON.stringify(snap, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Backdates every pending machine-status intent past its debounce window, then drains. */
async function drainPastDebounce(): Promise<void> {
  await runInDurableObject(ownerStub(), async (raw) => {
    const instance = raw as unknown as {
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
      drainNotifications: () => Promise<void>;
    };
    instance.sql`UPDATE sh_notify SET dueAt = ${Date.now() - 1} WHERE dueAt IS NOT NULL`;
    await instance.drainNotifications();
  });
  await waitWhileOutboundPending();
}

async function machineCards(): Promise<ShOutboundRow[]> {
  return (await ownerStub().outboundRows(40)).filter(
    (r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).match(/联系不上|回来了|上线了/),
  );
}

async function allSent(): Promise<string> {
  const rows = await ownerStub().outboundRows(40);
  return JSON.stringify(rows.filter((r) => r.status === "sent").map((r) => r.payload));
}

describe("a machine drops mid-task (spec §9: lost contact, not failed)", () => {
  it("marks the running worker unreachable — never broken — and nothing is sent immediately", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "跑着", repoRef: "repo-a", newTitle: "跑着" });
    expect(outcome.kind).toBe("dispatched");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "running", "worker running");

    fake.close(); // the connection dies
    const dropped = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.unreachable === true,
      "worker marked unreachable",
    );
    // Finding 4: the debounce has a wake source — a drainNotifications alarm is scheduled
    // for the intents' due date, so the notice does not wait for an unrelated event.
    expect((await ownerStub().maintenanceSchedulesForTest()).some((x) => x.callback === "drainNotifications")).toBe(true);
    const worker = dropped.threads[0]!.workers[0]!;
    expect(worker.state).toBe("running"); // execution state untouched — not failed, not lost
    expect(dropped.threads[0]!.timeline.some((t) => t.kind === "machine_status" && t.text.includes("离线"))).toBe(true);
    // The 2-minute debounce: the notice is intent-shaped only, nothing sent yet.
    expect((await machineCards())).toHaveLength(0);
    expect(dropped.threads[0]!.unread).toBe(true); // the timeline entry flipped unread
  });

  it("after the debounce the owner gets one offline card; recovery later reports back", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await ownerStub().dispatchForTest({ prompt: "跑着", repoRef: "repo-a", newTitle: "跑着" });
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "running", "worker running");

    fake.close();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === true, "unreachable");
    await drainPastDebounce();
    const [offlineCard] = await machineCards();
    expect(offlineCard).toBeDefined();
    expect(JSON.stringify(offlineCard!.payload)).toContain("联系不上");
    expect(JSON.stringify(offlineCard!.payload)).toContain("未按失败处理");
    // Sending the notice does not change the worker: still running + unreachable.
    const snap = await ownerStubDebug();
    expect(snap.threads[0]!.workers[0]!.state).toBe("running");
    expect(snap.threads[0]!.workers[0]!.unreachable).toBe(true);

    // The machine returns with a running snapshot: reconcile restores it, the online card
    // follows the same debounced path.
    fake.workers = [{ workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" }];
    await fake.connect();
    const restored = await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === false, "restored");
    expect(restored.threads[0]!.workers[0]!.state).toBe("running");
    await drainPastDebounce();
    const sent = await allSent();
    expect(sent).toContain("回来了");
    expect(sent).toContain("已恢复运行");
  });

  it("a blip shorter than the debounce produces no notice at all", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await ownerStub().dispatchForTest({ prompt: "跑着", repoRef: "repo-a", newTitle: "跑着" });
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "running", "worker running");

    fake.close();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === true, "unreachable");
    fake.workers = [{ workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" }];
    await fake.connect(); // back before the window closes
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === false, "restored");

    await drainPastDebounce(); // even with the windows forced open: both intents drop
    expect((await machineCards())).toHaveLength(0);
    fake.close();
  });

  it("a later blip cannot ride an earlier outage's offline notice (finding 7)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await ownerStub().dispatchForTest({ prompt: "跑着", repoRef: "repo-a", newTitle: "跑着" });
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "running", "worker running");

    // Outage 1: long enough to be announced, then recovered.
    fake.close();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === true, "unreachable");
    await drainPastDebounce();
    fake.workers = [{ workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" }];
    await fake.connect();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === false, "restored");
    await drainPastDebounce();
    const afterFirstOutage = (await machineCards()).length;
    expect(afterFirstOutage).toBeGreaterThanOrEqual(2); // offline + recovery were both sent

    // Blip 2: shorter than the debounce — its offline intent is dropped as healed, so the
    // recovery that follows must stay quiet no matter that outage 1 WAS announced.
    fake.close();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === true, "unreachable again");
    fake.workers = [{ workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" }];
    await fake.connect();
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.unreachable === false, "restored again");
    await drainPastDebounce(); // even with the windows forced open
    expect((await machineCards())).toHaveLength(afterFirstOutage); // nothing new for the blip
    fake.close();
  });

  it("a drop with no in-flight work stays silent (notices exist only for affected work)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await snapshotWhere((s) => s.machines.some((m) => m.online), "machine online");
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine offline");
    await drainPastDebounce();
    expect((await machineCards())).toHaveLength(0);
  });
});

describe("one notice per affected worker, not per machine (finding 5)", () => {
  it("two running threads on a dropped machine both get offline + recovery notices", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    for (const title of ["任务一", "任务二"]) {
      await ownerStub().dispatchForTest({ prompt: title, repoRef: "repo-a", newTitle: title });
    }
    const cmds = await fake.waitForCmds(2);
    for (const cmd of cmds) {
      const workerId = String((cmd!.args as Record<string, unknown>).workerId);
      fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
      await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    }
    await snapshotWhere((s) => s.threads.length === 2 && s.threads.every((t) => t.workers[0]?.state === "running"), "both running");

    fake.close();
    const dropped = await snapshotWhere(
      (s) => s.threads.every((t) => t.workers[0]?.unreachable === true),
      "both workers unreachable",
    );
    // Per-worker intents (the old key collapsed them to the first INSERT). pending()
    // hides debounced intents by design, so count the raw rows.
    const intents = await runInDurableObject(ownerStub(), async (raw) => {
      const sql = (raw as unknown as { sql: <T = Record<string, unknown>>(s: TemplateStringsArray, ...v: unknown[]) => T[] }).sql.bind(raw);
      return sql<{ kind: string; n: number }>`SELECT kind, COUNT(*) AS n FROM sh_notify WHERE sentAt IS NULL GROUP BY kind`;
    });
    expect(intents.find((r) => r.kind === "machine_offline")?.n).toBe(2);
    void dropped;
    await drainPastDebounce();
    const sent = await allSent();
    for (const title of ["任务一", "任务二"]) expect(sent).toContain(title);

    fake.workers = cmds.map((cmd) => {
      const workerId = String((cmd!.args as Record<string, unknown>).workerId);
      return { workerId, agent: "pi", state: "running", lastSeq: 1, sessionId: workerId, lastOutcome: "" };
    });
    await fake.connect();
    await snapshotWhere((s) => s.threads.every((t) => t.workers[0]?.unreachable === false), "both restored");
    await drainPastDebounce();
    const sentAfter = await allSent();
    for (const title of ["任务一", "任务二"]) expect(sentAfter.match(new RegExp(title, "g"))?.length).toBeGreaterThanOrEqual(2); // offline + recovery each
    fake.close();
  });
});

describe("online habits recorded on sh_machine.reliability (spec §10.1, record-only)", () => {
  it("accumulates stretches and transitions across connect/drop cycles", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await snapshotWhere((s) => s.machines.some((m) => m.online), "machine online");
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine offline");
    await fake.connect();
    const settled = await snapshotWhere(
      (s) => (s.machines[0]?.reliability?.transitions ?? 0) >= 2,
      "two transitions tallied",
    );
    const reliability = settled.machines[0]!.reliability!;
    expect(reliability.onlineMs).toBeGreaterThan(0);
    expect(reliability.offlineMs).toBeGreaterThanOrEqual(0);
    expect(reliability.observedSince).toBeGreaterThan(0);
    // Record-only: nothing in the reliability blob feeds any dispatch decision.
    fake.close();
  });
});
