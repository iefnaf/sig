// The LLM-free end-to-end loop (issue #5): a fixed command phrase in Feishu → Thread created →
// start_worker over the real transport → the (protocol-level fake-pi) worker runs → a
// deterministic three-part done-report card back → quote-replying to that card routes back to
// the same Thread (relay, previous branch as base) → an offline machine queues until hello
// redelivers (spike bug 4) → the offline-ask card's buttons resolve the Thread via
// providerMsgId. Every hop in here is the production code path; only the worker is faked.
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeConnector,
  configureAndBind,
  messageEvent,
  mockCalls,
  mockReset,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  sendCalls,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { ShOutboundRow } from "../src/steward.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

async function ownerDm(text: string, parentId?: string): Promise<Response> {
  return postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text, parentId }));
}

async function snapshot() {
  return ownerStub().debugSnapshot();
}

async function snapshotWhere(pred: (snap: Awaited<ReturnType<typeof snapshot>>) => boolean, what: string, timeoutMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    const snap = await snapshot();
    if (pred(snap)) return snap;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for: ${what}\n${JSON.stringify(snap, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sentCards(minCount = 1, timeoutMs = 8000): Promise<ShOutboundRow[]> {
  // The worker flips to idle before the outbound queue finishes sending the card, so a
  // single read races the sender on slow runners — poll like snapshotWhere does.
  const startedAt = Date.now();
  for (;;) {
    const rows = (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent");
    if (rows.length >= minCount || Date.now() - startedAt > timeoutMs) return rows; // caller asserts on timeout
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function cardActionEvent(cardMsgId: string, action: string, eventId = `evt_card_${crypto.randomUUID().slice(0, 8)}`) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "card.action.trigger",
      create_time: String(Date.now()),
      token: "verify-token",
      app_id: "cli_test_app",
    },
    event: {
      operator: { open_id: "ou_owner" },
      action: { value: { action } }, // identity never rides in the button (§3.1)
      context: { open_message_id: cardMsgId },
    },
  };
}

describe("the happy loop: fixed phrase → worker → done card → quote-reply continuation", () => {
  it("runs a write task and reports back, and a quote-reply attaches to the same Thread with the branch relayed", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "登录 bug 修好，测试通过", changes: ["auth/session.ts 补上过期刷新", "新增 1 个测试"], tests: { ran: true, passed: true }, branch: "shepherd/login-1" },
    });
    fake.queueRun({ status: "done", summary: "单元测试补齐", changes: ["session.test.ts 新增 3 例"], branch: "shepherd/login-2" });
    await fake.connect();

    // --- dispatch: fixed phrase naming a repo and a prompt -------------------------------
    const res = await ownerDm("/派发 repo-a 修复登录 bug");
    expect(res.status).toBe(200);
    const [cmd1] = await fake.waitForCmds(1);
    expect(cmd1).toBeDefined();
    expect(cmd1!.kind).toBe("start_worker");
    expect(cmd1!.args).toMatchObject({
      threadId: expect.stringMatching(/^t_/),
      repoId: "/srv/repo-a",
      mode: "write",
      prompt: "修复登录 bug",
    });
    expect(cmd1!.args).not.toHaveProperty("base"); // first leg: nothing to relay from
    await waitWhileOutboundPending();
    const ackTexts = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "text" && r.status === "sent");
    expect(JSON.stringify(ackTexts)).toContain("已创建");
    expect(JSON.stringify(ackTexts)).toContain("mac-studio");

    // --- the worker runs and reports: a deterministic green three-part card comes back -----
    const doneSnap = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "idle" && s.threads[0]?.unread === true,
      "worker settled, thread idle+unread",
    );
    const threadId = doneSnap.threads[0]!.threadId;
    expect(doneSnap.threads[0]!.state).toBe("idle");
    const [card1] = await sentCards();
    expect(card1?.threadId).toBe(threadId);
    const cardJson = JSON.parse(card1!.payload as string) as { card: { header: unknown; elements: unknown[] } };
    expect(JSON.stringify(cardJson.card.header)).toContain("green");
    expect(JSON.stringify(cardJson.card.header)).toContain("登录 bug 修好，测试通过");
    const parts = JSON.stringify(cardJson.card.elements);
    expect(parts).toContain("做了什么");
    expect(parts).toContain("auth/session.ts 补上过期刷新");
    expect(parts).toContain("分支 shepherd/login-1");
    expect(parts).toContain("Thread「修复登录 bug」");

    // --- quote-reply to the card routes to the SAME Thread and relays the branch (spec §5.3)
    const res2 = await ownerDm("/派发 repo-a 再补几个单元测试", card1!.providerMsgId!);
    expect(res2.status).toBe(200);
    const sameThread = await snapshotWhere((s) => s.threads[0]?.workers.length === 2, "second worker on the same thread");
    expect(sameThread.threads).toHaveLength(1); // no new Thread — signal 1 routed it
    expect(sameThread.threads[0]!.unread).toBe(false); // the reply counts as read (§6.5)
    const [, cmd2] = await fake.waitForCmds(2);
    expect((cmd2!.args as Record<string, unknown>).threadId).toBe(threadId);
    expect((cmd2!.args as Record<string, unknown>).base).toBe("shepherd/login-1"); // relay base

    await snapshotWhere((s) => s.threads[0]?.workers.length === 2 && s.threads[0]?.workers[1]?.state === "idle", "second run settled");
    await waitWhileOutboundPending();
    const cards = await sentCards(2);
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(cards[1]!.payload as string))).toContain("单元测试补齐");
    expect(cards[1]!.threadId).toBe(threadId);
    fake.close();
    void (await mockCalls());
  }, 30_000);
});

describe("offline machines (spike bug 4): a Thread remembers its machine and queues", () => {
  it("a quote-reply dispatch while offline queues (notAfter null) and runs at the next hello", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: { status: "done", summary: "第一段完成", branch: "shepherd/leg-1" } });
    fake.queueRun({ status: "done", summary: "第二段接力完成", branch: "shepherd/leg-2" });
    await fake.connect();

    await ownerDm("/派发 repo-a 第一段任务");
    await fake.waitForCmds(1);
    const firstDone = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "first leg done");
    await waitWhileOutboundPending();
    const [card1] = await sentCards();

    // --- the machine drops (isolate swap / network gone): last connection closes → offline --
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine offline");

    // --- quote-reply continuation: the Thread keeps its machine and the command queues ------
    const res = await ownerDm("/派发 repo-a 接着做第二段", card1!.providerMsgId!);
    expect(res.status).toBe(200);
    const queuedSnap = await snapshotWhere((s) => s.threads[0]?.workers.length === 2, "second worker registered");
    expect(queuedSnap.threads[0]!.state).toBe("running"); // starting while queued
    await waitWhileOutboundPending();
    const texts = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "text" && r.status === "sent");
    expect(JSON.stringify(texts)).toContain("不在线");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.cmds).toHaveLength(1); // nothing was delivered to a dead socket

    // --- the machine comes back: hello redelivers the queued command, the run completes -----
    await fake.connect();
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2).toBeDefined();
    expect(cmd2!.notAfter).toBeNull(); // "wait until online" (protocol §4.2)
    await snapshotWhere((s) => s.threads[0]?.workers[1]?.state === "idle", "second leg done after reconnect");
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(2);
    fake.close();
    void (await mockCalls());
  }, 30_000);
});

describe("the offline-ask card: buttons resolve the Thread via providerMsgId (§3.1)", () => {
  it("asks wait-or-cancel when the only machine with the repo is offline; wait_online queues and runs on return", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: { status: "done", summary: "排队后完成", branch: "shepherd/queued-1" } });
    // The machine must have said hello once: repos are known only from hello (protocol §6.1).
    await fake.connect();
    await snapshotWhere((s) => s.machines.some((m) => m.online), "machine checked in");
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine gone offline");

    const res = await ownerDm("/派发 repo-a 修个东西");
    expect(res.status).toBe(200);
    const snap = await snapshotWhere((s) => s.threads.length === 1, "thread created for the ask");
    expect(snap.threads[0]!.workers).toHaveLength(0); // nothing dispatched yet: ask, don't decide (spec §9)
    expect(snap.threads[0]!.lastMachine).toBe(fake.deviceId); // affinity set at ask time
    await waitWhileOutboundPending();
    const [askCard] = await sentCards();
    expect(askCard?.providerMsgId).toMatch(/^om_mock_/);
    const ask = JSON.stringify(JSON.parse(askCard!.payload as string));
    expect(ask).toContain("不在线");
    expect(ask).toContain("排队等上线");

    // --- the click: the callback carries only open_message_id + action, no thread data ------
    const click = await postEvent(cardActionEvent(askCard!.providerMsgId!, "wait_online"));
    expect(click.status).toBe(200);
    const queued = await snapshotWhere((s) => s.threads[0]?.workers.length === 1, "worker registered on click");
    expect(queued.threads[0]!.state).toBe("running");
    expect(queued.threads[0]!.unread).toBe(false); // the click counts as read (§6.5)

    await fake.connect(); // machine returns: hello redelivers the queued start_worker
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd).toBeDefined();
    expect(cmd!.notAfter).toBeNull();
    expect((cmd!.args as Record<string, unknown>).threadId).toBe(queued.threads[0]!.threadId);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "queued run finished");
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(2); // ask card + done card
    fake.close();
    void (await mockCalls());
  }, 30_000);

  it("cancel leaves the Thread idle with nothing dispatched", async () => {
    const fake = await pairFakeConnector();
    await fake.connect(); // hello first so the repo is known, then drop offline
    await snapshotWhere((s) => s.machines.some((m) => m.online), "machine checked in");
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine offline");

    await ownerDm("/派发 repo-a 算个账");
    await snapshotWhere((s) => s.threads.length === 1, "thread created");
    await waitWhileOutboundPending();
    const [askCard] = await sentCards();

    const click = await postEvent(cardActionEvent(askCard!.providerMsgId!, "cancel"));
    expect(click.status).toBe(200);
    const snap = await snapshotWhere((s) => !!s.threads[0]?.timeline.some((e) => e.text.includes("撤回")), "cancel recorded");
    expect(snap.threads[0]!.workers).toHaveLength(0);
    expect(snap.threads[0]!.state).toBe("idle");
    await waitWhileOutboundPending();
    const texts = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "text" && r.status === "sent");
    expect(JSON.stringify(texts)).toContain("已取消");
    void (await mockCalls());
  }, 30_000);
});

describe("the rest of the M1 phrase surface", () => {
  it("unknown text gets the fixed help reply, /状态 lists machines and threads", async () => {
    const fake = await pairFakeConnector();
    await fake.connect();
    await ownerDm("/派发 repo-a 跑个只读检查");
    await fake.waitForCmds(1);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "run done");
    fake.close();

    await ownerDm("帮我把那个 bug 修了吧");
    await ownerDm("/状态");
    await waitWhileOutboundPending();
    const texts = (await ownerStub().outboundRows(20)).filter((r) => r.kind === "text" && r.status === "sent");
    const bodies = texts.map((r) => JSON.parse(r.payload as string) as { text?: string }).map((p) => p.text ?? "");
    expect(bodies.some((t) => t.includes("/派发"))).toBe(true); // help
    const status = bodies.find((t) => t.includes("机器："));
    expect(status).toContain("mac-studio");
    expect(status).toContain("跑个只读检查"); // the thread from the dispatch above
    expect(sendCalls(await mockCalls()).length).toBeGreaterThan(0);
  }, 30_000);
});
