// Issue #14, steward side: dispatching at an offline machine. The selection rule prefers a
// user-named or remembered machine; when that target (or the only machine with the repo) is
// offline, the command is written and HELD and the owner is asked with buttons — wait,
// switch, or cancel (protocol §7.3, spec §9, ADR-0001 decision 6). The card resolves to one
// command, never the Thread's latest worker.
import { beforeEach, describe, expect, it } from "vitest";
import { SELF, runInDurableObject } from "cloudflare:test";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { FakeConnector } from "./helpers.ts";
import type { ShOutboundRow } from "../src/steward.ts";

type DebugSnap = Awaited<ReturnType<typeof ownerStubDebug>>;

async function ownerStubDebug() {
  return ownerStub().debugSnapshot();
}

/** Polls the debug snapshot until the predicate holds (events/hello reduce asynchronously). */
async function snapshotWhere(pred: (snap: DebugSnap) => boolean, what: string, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    if (pred(snap)) return snap;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}\n${JSON.stringify(snap, null, 2)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function sentCards(): Promise<ShOutboundRow[]> {
  return (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent");
}

async function sentTexts(): Promise<string[]> {
  return (await ownerStub().outboundRows(30))
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

/** The offline ask card for a parked command (its outbound id is `offline:<cmdId>`). */
async function askCardOf(cmdId: string): Promise<ShOutboundRow | undefined> {
  return (await ownerStub().outboundRows(30)).find((r) => r.id === `offline:${cmdId}`);
}

/** Clicks a button on a message (POST /api/actions; the DO dedups on message+action). */
async function click(card: ShOutboundRow, action: string): Promise<Response> {
  return postEvent({ cardMsgId: card.providerMsgId!, action });
}

/** Machine A goes offline after registering repo-a; B is online with the same repo. */
async function twoMachines(): Promise<{ offline: FakeConnector; online: FakeConnector }> {
  const offline = await pairFakeConnector("studio-device", { run: null, machineName: "mac-studio", repos: [{ repoId: "/srv/repo-a", name: "repo-a" }] });
  const online = await pairFakeConnector("mini-device", { run: null, machineName: "mac-mini", repos: [{ repoId: "/srv2/repo-a", name: "repo-a" }] });
  await offline.connect();
  await online.connect();
  await new Promise((resolve) => setTimeout(resolve, 150));
  offline.close();
  await snapshotWhere((s) => !s.machines.find((m) => m.name === "mac-studio")?.online, "mac-studio offline");
  return { offline, online };
}

describe("dispatch at an offline machine: hold + ask (protocol §7.3)", () => {
  it("the named machine is offline: the command is held, the card offers wait/switch/cancel", async () => {
    const { offline } = await twoMachines();
    const outcome = await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    expect(outcome).toMatchObject({ kind: "asked_offline", machineName: "mac-studio" });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    const row = await ownerStub().outboxRow(cmdId);
    expect(row?.state).toBe("queued"); // written to outbox…
    expect(row?.notAfter).not.toBeNull(); // …with the 10-minute default expiry
    expect(offline.cmds).toHaveLength(0); // …and never sent while the ask is open
    await waitWhileOutboundPending();
    const card = await askCardOf(cmdId);
    expect(card).toBeDefined();
    const json = JSON.stringify(JSON.parse(card!.payload as string));
    expect(json).toContain("不在线");
    expect(json).toContain("换台机器"); // an online alternative exists → the switch button
    expect(card?.threadId).toBe(snap.threads[0]!.threadId);
  });

  it("wait clears the hold (notAfter null) — a reconnect then delivers with a notice", async () => {
    const { offline } = await twoMachines();
    await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    const card = (await askCardOf(cmdId))!;

    const clickRes = await click(card, "wait_online");
    expect(clickRes.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await ownerStub().outboxRow(cmdId))?.notAfter).toBeNull(); // held → wait-for-online
    expect((await sentTexts()).some((t) => t.includes("已排队"))).toBe(true);

    // A duplicate click (Feishu redelivery) does not double-handle the ask.
    const again = await click(card, "wait_online");
    expect(again.status).toBe(200);
    await waitWhileOutboundPending();

    offline.queueRun({ status: "done", summary: "排队后完成", branch: "sig/wait-1" });
    await offline.connect();
    const [cmd] = await offline.waitForCmds(1);
    expect(cmd!.notAfter).toBeNull(); // delivered because the wait cleared the deadline
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "waited run finished");
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(JSON.stringify(cards)).toContain("上线了"); // the deterministic waited-start notice
    await offline.close();
  });

  it("switch expires the held command and re-dispatches to the alternative", async () => {
    const { offline, online } = await twoMachines();
    const outcome = await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    expect(outcome.kind).toBe("asked_offline");
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const heldCmdId = snap.threads[0]!.workers[0]!.cmdId!;
    const threadId = snap.threads[0]!.threadId;
    await waitWhileOutboundPending();
    const card = (await askCardOf(heldCmdId))!;

    const clickRes = await click(card, "switch_machine");
    expect(clickRes.status).toBe(200);
    await waitWhileOutboundPending();

    // The held command is expired, its worker retired, and a fresh one runs on mac-mini.
    expect((await ownerStub().outboxRow(heldCmdId))?.state).toBe("expired");
    const after = await snapshotWhere((s) => s.threads[0]?.workers.length === 2, "second worker registered");
    expect(after.threads[0]!.workers[0]!.state).toBe("idle"); // withdrawn, never failed
    expect(after.threads[0]!.workers[0]!.lastOutcome).toBe("cancelled");
    const [cmd] = await online.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    expect((cmd!.args as Record<string, unknown>).threadId).toBe(threadId);
    expect(offline.cmds).toHaveLength(0); // nothing ever went to the offline machine
    expect((await sentTexts()).some((t) => t.includes("mac-mini"))).toBe(true); // "put it on X"
    await online.close();
    await offline.close();
  });

  it("switch with no alternative tells the owner the original stays held", async () => {
    const offline = await pairFakeConnector("mac-studio", { run: null });
    await offline.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    offline.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine gone offline");
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome.kind).toBe("asked_offline");
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    const card = (await ownerStub().outboundRows(20)).find((r) => r.id === `offline:${cmdId}`)!;
    expect(JSON.stringify(JSON.parse(card.payload as string))).not.toContain("换台机器"); // nothing to switch to

    const clickRes = await click(card as ShOutboundRow, "switch_machine");
    expect(clickRes.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("queued"); // still held
    expect((await sentTexts()).some((t) => t.includes("没有别的机器"))).toBe(true);
    const stillHeld = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "still held");
    expect(stillHeld.threads[0]!.workers).toHaveLength(1);
  });

  it("cancel withdraws the held command and retires its worker", async () => {
    const { offline } = await twoMachines();
    await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    const card = (await askCardOf(cmdId))!;

    const clickRes = await click(card, "cancel");
    expect(clickRes.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("expired"); // withdrawn before it ever left
    const after = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "worker retired");
    expect(after.threads[0]!.state).not.toBe("running"); // nothing wedged
    expect((await sentTexts()).some((t) => t.includes("已取消"))).toBe(true);
    await offline.close();
  });

  it("an unanswered ask lapses on its own alarm: failed/not_after, then the worker closes with a push (findings 2+3+10)", async () => {
    const offline = await pairFakeConnector("mac-studio", { run: null });
    await offline.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    offline.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine gone offline");
    await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;

    // Finding 2: enqueueing a HELD command arms the lapse alarm by itself — deliver()
    // refuses held rows, so nothing else would ever sweep them.
    const schedules = await ownerStub().maintenanceSchedulesForTest();
    expect(schedules.some((x) => x.callback === "sweepIdle")).toBe(true);
    expect(schedules.some((x) => x.callback === "sweepWorkers")).toBe(true);

    // The notAfter window lapses: sweepIdle writes main's terminal `failed/not_after`
    // (never `expired` — that is the user's withdrawal state), and sweepWorkers — armed
    // since the enqueue, the worker is `starting` — closes it with a failure push.
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as {
        sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
        sweepIdle: () => Promise<void>;
        sweepWorkers: () => Promise<unknown>;
      };
      const ago = Date.now() - 11 * 60_000; // the whole notAfter window has passed
      instance.sql`UPDATE outbox SET notAfter = ${Date.now() - 1} WHERE cmdId = ${cmdId}`;
      instance.sql`UPDATE sh_worker SET createdAt = ${ago}, lastEventAt = NULL WHERE cmdId = ${cmdId}`;
      await instance.sweepIdle();
      await instance.sweepWorkers();
    });
    const row = await ownerStub().outboxRow(cmdId);
    expect(row?.state).toBe("failed");
    expect(row?.failReason).toBe("not_after");
    const after = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "broken", "worker lapsed");
    expect(after.threads[0]!.state).not.toBe("running");
    expect(after.offlineDispatches.find((o) => o.cmdId === cmdId)?.status).toBe("cancelled"); // the ask settled too
    // (#10's failure handling may open its own follow-up question — only the ask itself
    // must be settled.)
    expect(after.questions.find((q) => q.qid === `offline:${cmdId}`)?.status).toBe("answered");
    await waitWhileOutboundPending();
    expect(JSON.stringify(await sentCards())).toContain("没有开始"); // the failure push
    await offline.close();
  });

  it("a reconnect after the window lapses marks the held row on the delivery path too (finding 2)", async () => {
    const offline = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await offline.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    offline.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine gone offline");
    await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await runInDurableObject(ownerStub(), async (raw) => {
      (raw as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
        UPDATE outbox SET notAfter = ${Date.now() - 1} WHERE cmdId = ${cmdId}
      `;
    });

    // The machine returns late: hello's redelivery attempt hits the lapsed window first —
    // failed/not_after, and nothing is sent to the connector.
    await offline.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(offline.cmds).toHaveLength(0);
    const late = await ownerStub().outboxRow(cmdId);
    expect(late?.state).toBe("failed");
    expect(late?.failReason).toBe("not_after");
    await offline.close();
  });

  it("a stale 算了 after the task left the DO admits it, instead of claiming a cancellation (finding 6)", async () => {
    const { offline } = await twoMachines();
    await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    const card = (await askCardOf(cmdId))!;
    await click(card, "wait_online");
    await waitWhileOutboundPending();

    // The machine returns and the start is actually delivered before the cancel tap.
    offline.queueRun({ status: "done", summary: "已完成", branch: "sig/late-1" });
    await offline.connect();
    await offline.waitForCmds(1);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const clickRes = await click(card, "cancel");
    expect(clickRes.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await sentTexts()).some((t) => t.includes("已经上路"))).toBe(true);
    const after = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "run completed");
    expect(after.threads[0]!.workers[0]!.lastOutcome).not.toBe("cancelled"); // the withdrawal did NOT touch it
    expect(after.offlineDispatches.find((o) => o.cmdId === cmdId)?.status).toBe("waiting"); // ask untouched
    await offline.close();
  });

  it("a refused switch re-opens the choice instead of stranding the offer (finding 8)", async () => {
    const { offline } = await twoMachines();
    // A second online alternative, so the picker (not a direct re-dispatch) shows.
    const third = await pairFakeConnector("mac-pro", { run: null, repos: [{ repoId: "/srv3/repo-a", name: "repo-a" }] });
    await third.connect();
    await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    const card = (await askCardOf(cmdId))!;
    await click(card, "switch_machine");
    await waitWhileOutboundPending();
    const picker = (await ownerStub().outboundRows(20)).find((r) => r.id === `switch:${cmdId}` && r.status === "sent");
    expect(picker).toBeDefined();

    // The alternatives' repo rows vanish before the tap: the re-dispatch is refused…
    const miniId = (await ownerStub().debugSnapshot()).machines.find((m) => m.name === "mac-mini")!.deviceId;
    await runInDurableObject(ownerStub(), async (raw) => {
      (raw as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
        DELETE FROM sh_repo WHERE deviceId != ${offline.deviceId}
      `;
    });
    const tap = await click(picker as ShOutboundRow, "machine:0");
    expect(tap.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await sentTexts()).some((t) => t.includes("没有仓库"))).toBe(true);
    let mid = await snapshotWhere((s) => (s.offlineDispatches.find((o) => o.cmdId === cmdId)?.status ?? "") === "switching", "re-opened");
    expect(mid.threads[0]!.workers.length).toBe(1); // nothing double-registered

    // …and when the world changes back, the same button answers again.
    await runInDurableObject(ownerStub(), async (raw) => {
      const instance = raw as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown };
      instance.sql`INSERT OR REPLACE INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
        VALUES ('/srv2/repo-a', ${miniId}, 'repo-a', '/srv2/repo-a', 'main', '', ${Date.now()})`;
    });
    const retry = await click(picker as ShOutboundRow, "machine:0");
    expect(retry.status).toBe(200);
    await waitWhileOutboundPending();
    mid = await snapshotWhere((s) => s.threads[0]!.workers.length === 2, "re-dispatched after retry");
    void mid;
    await third.close();
    await offline.close();
  });

  it("a replay after a crash before the card persisted re-sends the ask (finding 9)", async () => {
    const { offline } = await twoMachines();
    const first = await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio",
    });
    expect(first.kind).toBe("asked_offline");
    const snap = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "held worker");
    const cmdId = snap.threads[0]!.workers[0]!.cmdId!;
    await waitWhileOutboundPending();
    // Simulate the crash window: the command and worker rows exist, the card never did.
    await runInDurableObject(ownerStub(), async (raw) => {
      (raw as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
        DELETE FROM sh_outbound WHERE id = ${`offline:${cmdId}`}
      `;
    });

    const replay = await ownerStub().dispatchForTest({
      prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", machineHint: "mac-studio", cmdId,
    });
    expect(replay).toMatchObject({ kind: "asked_offline" });
    await waitWhileOutboundPending();
    expect((await ownerStub().outboundRows(20)).some((r) => r.id === `offline:${cmdId}` && r.status === "sent")).toBe(true);
    const after = await snapshotWhere((s) => s.threads.length === 1 && s.threads[0]!.workers.length === 1, "no dup thread/worker");
    expect(after.threads[0]!.workers[0]!.state).toBe("starting");
    await offline.close();
  });
});
