// The end-to-end loop with the steward LLM in it (issues #5 → #6): the owner talks natural
// language in Feishu → the scripted model calls start_worker → the (protocol-level fake-pi)
// worker runs → the deterministic three-part done-report card comes back → the event wake
// runs bookkeeping (update_thread) whose plain text is DISCARDED → quote-replying to the card
// routes back to the same Thread (relay, previous branch as base) → an offline machine queues
// until hello redelivers (spike bug 4). Every hop is the production code path; the model is
// the scripted faux provider and only the worker is faked.
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  FakeConnector,
  configureAndBind,
  messageEvent,
  modelRequests,
  llmState,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { ShOutboundRow } from "../src/steward.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function ownerDm(text: string, parentId?: string): Promise<Response> {
  return postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text, parentId }));
}

async function snapshot() {
  return ownerStub().debugSnapshot();
}

async function snapshotWhere(pred: (snap: Awaited<ReturnType<typeof snapshot>>) => boolean, what: string, timeoutMs = 10_000) {
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

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(30);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

describe("the happy loop: natural language → tool dispatch → done card → event bookkeeping", () => {
  it("a user message dispatches via start_worker; the reply is the model's final text", async () => {
    // autorun off: the worker's events are emitted by hand so the event wake happens after the
    // test has scripted the bookkeeping turn (the wake fires 3s after the report lands).
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();

    // The scripted steward: find the situation, dispatch, then answer the user.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已创建「修复登录 bug」并派给 mac-studio，完成后我会汇报。")]),
    );

    const res = await ownerDm("帮我把 repo-a 里那个登录 bug 修了");
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
    expect(cmd1!.id).toMatch(/^tool:/); // cmdId = tool:<taskId> (issue #6, protocol §7.1)
    const workerId = String((cmd1!.args as Record<string, unknown>).workerId);
    const threadId = String((cmd1!.args as Record<string, unknown>).threadId);

    await waitRunsSettled();
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("已创建") && t.includes("mac-studio"))).toBe(true); // §6.3: the run's final text is the reply

    // --- the worker runs and reports: a deterministic green three-part card comes back -------
    fake.send({ t: "cmd_ack", re: cmd1!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd1!.id, ok: true, data: { sessionId: workerId, branch: "sig/login-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/login-1" });
    await fake.emit("report", workerId, {
      type: "report",
      status: "done",
      summary: "登录 bug 修好，测试通过",
      changes: ["auth/session.ts 补上过期刷新"],
      tests: { ran: true, passed: true },
      git: { branch: "sig/login-1", base: "main", ahead: 1, dirty: 0, filesChanged: 1, insertions: 5, deletions: 1, pushed: false },
    });
    const doneSnap = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "running" && s.threads[0]?.unread === true,
      "report recorded with unread",
    );
    expect(doneSnap.threads[0]!.threadId).toBe(threadId);
    await waitWhileOutboundPending();
    const [card1] = await sentCards();
    expect(card1?.threadId).toBe(threadId);
    const cardJson = JSON.parse(card1!.payload as string) as { card: { text: string } };
    expect(cardJson.card.text).toContain("✅");
    expect(cardJson.card.text).toContain("登录 bug 修好，测试通过");

    // --- the event wake: the model does bookkeeping; its plain text never reaches the user ---
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("update_thread", { threadId, summary: "登录 bug 已修复：session 过期刷新补齐，测试通过，分支 sig/login-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("记账完成。（这行文字不应该发给用户）")]),
    );
    await waitRunsSettled(); // the wake fired after the 3s merge window and settled
    await waitWhileOutboundPending();

    const wakeRun = (await llmState()).runs.find((r) => r.kind === "event");
    expect(wakeRun).toBeDefined();
    expect(wakeRun!.status).toBe("settled");
    expect(wakeRun!.resultStatus).toBe("done");
    expect(wakeRun!.resultText).toContain("记账完成"); // kept for audit…
    const textsAfterWake = await sentTexts();
    expect(textsAfterWake.some((t) => t.includes("不应该发给用户"))).toBe(false); // …and NOT sent (§6.2)
    expect(wakeRun!.replyOutboundId).toBeNull(); // structural quiet: no reply was queued

    // The wake input carried the ⟦event⟧ marker and the thread's report facts.
    const requests = await modelRequests();
    const wakeRequest = requests.find((r) => r.userText.startsWith("⟦event⟧"));
    expect(wakeRequest).toBeDefined();
    expect(wakeRequest!.userText).toContain(threadId);
    expect(wakeRequest!.userText).toContain("登录 bug 修好");
    expect(wakeRequest!.userText).toContain("请做记账");

    // Bookkeeping landed: the summary the model wrote is on the Thread.
    const bookkept = await snapshot();
    expect(bookkept.threads[0]!.summary).toContain("session 过期刷新");

    // --- quote-reply to the card routes to the SAME Thread and resumes the session (§5.3) -
    await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "first run settled");
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再补几个单元测试", repoRef: "repo-a", threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已把「补单测」接到了之前的登录 bug 上（续用原会话）。")]),
    );
    const res2 = await ownerDm("再补几个单元测试", card1!.providerMsgId!);
    expect(res2.status).toBe(200);
    const resumed = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "starting" && s.threads[0]?.workers.length === 1,
      "resume pending on the same session",
    );
    expect(resumed.threads).toHaveLength(1); // no new Thread — signal 1 routed it
    expect(resumed.threads[0]!.workers).toHaveLength(1); // same session, no second worker (issue #8)
    expect(resumed.threads[0]!.unread).toBe(false); // the reply counts as read (§6.5)
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("send"); // resume: the task enters the existing session
    expect(cmd2!.args).toMatchObject({ workerId, text: "再补几个单元测试" });
    expect(cmd2!.args).not.toHaveProperty("base"); // nothing relayed — the session has its context

    // The model saw the quote-routing note with the resolved thread id (§3.1 signal 1).
    const quoteRequest = (await modelRequests()).filter((r) => r.userText.includes("再补几个单元测试")).at(-1);
    expect(quoteRequest!.userText).toContain("（系统注：");
    expect(quoteRequest!.userText).toContain(threadId);

    // The resumed run reports on the same worker; its card comes back on the same Thread.
    fake.send({ t: "cmd_ack", re: cmd2!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd2!.id, ok: true, data: { delivery: "prompt" } });
    await fake.emit("started", workerId, { sessionId: workerId }); // no branch → must not clobber
    await fake.emit("report", workerId, {
      type: "report",
      status: "done",
      summary: "单元测试补齐",
      changes: ["session.test.ts 新增 3 例"],
      git: { branch: "sig/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 2, insertions: 8, deletions: 0, pushed: false },
    });
    const after = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "running" && s.threads[0]?.workers[0]?.lastOutcome === "reported:done",
      "resumed run reported",
    );
    expect(after.threads[0]!.workers[0]!.branch).toBe("sig/login-1"); // branch survived the branchless started
    await waitWhileOutboundPending();
    const cards = await sentCards(2);
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(cards[1]!.payload as string))).toContain("单元测试补齐");
    expect(cards[1]!.threadId).toBe(threadId);
    fake.close();
  }, 45_000);
});

describe("offline machines (spike bug 4 → protocol §7.3): the Thread remembers its machine; the command waits for the owner", () => {
  it("a quote-reply continuation while offline parks a held resume; wait delivers it at the next hello", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: { status: "done", summary: "第一段完成", branch: "sig/leg-1" } });
    await fake.connect();

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "第一段任务", repoRef: "repo-a", newTitle: "第一段任务", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已创建并派发第一段。")]),
    );
    await ownerDm("开始第一段");
    await fake.waitForCmds(1);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "first leg done");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const [card1] = await sentCards();
    const threadId = (await snapshot()).threads[0]!.threadId;

    // --- the machine drops (isolate swap / network gone): last connection closes → offline --
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine offline");

    // --- quote-reply continuation: affinity keeps the machine, and the owner is asked -------
    // (#8) same agent + machine + repo ⇒ the continuation is a RESUME, and (issue #14) its
    // send parks HELD behind the offline ask instead of silently queueing.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "接着做第二段", repoRef: "repo-a", threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("mac-studio 不在线，我发卡片问你是等它还是换台机器。")]),
    );
    const res = await ownerDm("接着做第二段", card1!.providerMsgId!);
    expect(res.status).toBe(200);
    const heldSnap = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "starting" && s.threads[0]?.workers.length === 1,
      "resume pending behind the ask",
    );
    expect(heldSnap.threads[0]!.state).toBe("running"); // resume-pending while held (issue #8)
    const parkedCmdId = heldSnap.threads[0]!.workers[0]!.cmdId!;
    expect((await ownerStub().outboxRow(parkedCmdId))?.state).toBe("queued");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const [askCard] = (await ownerStub().outboundRows(20)).filter((r) => r.kind === "card" && r.status === "sent" && r.id === `offline:${parkedCmdId}`);
    expect(askCard).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fake.cmds).toHaveLength(1); // nothing was delivered to a dead socket

    // --- the owner waits: the deadline is cleared and the resume delivers at hello ---------
    const click = await postEvent({ cardMsgId: askCard!.providerMsgId!, action: "wait_online" });
    expect(click.status).toBe(200);
    await waitWhileOutboundPending();
    expect((await sentTexts()).some((t) => t.includes("已排队"))).toBe(true);
    expect((await ownerStub().outboxRow(parkedCmdId))?.notAfter).toBeNull();

    // --- the machine comes back: hello redelivers the waited resume, the run completes -----
    await fake.connect();
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2).toBeDefined();
    expect(cmd2!.kind).toBe("send"); // the parked continuation was the resume send
    expect(cmd2!.notAfter).toBeNull(); // "wait until online" (protocol §4.2)
    const workerId = heldSnap.threads[0]!.workers[0]!.workerId;
    fake.send({ t: "cmd_ack", re: cmd2!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd2!.id, ok: true, data: { delivery: "prompt", relaunched: true } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/leg-1" });
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "第二段接力完成" });
    await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "second leg done after reconnect");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBe(3); // leg-1 done + the ask card + leg-2 done
    fake.close();
  }, 30_000);
});

describe("the offline-ask card: buttons resolve the Thread via providerMsgId (§3.1)", () => {
  it("start_worker on an offline-only machine asks with buttons; wait_online clears the hold and it runs on return", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: { status: "done", summary: "排队后完成", branch: "sig/queued-1" } });
    await fake.connect();
    await snapshotWhere((s) => s.machines.some((m) => m.online), "machine checked in");
    fake.close();
    await snapshotWhere((s) => s.machines.every((m) => !m.online), "machine gone offline");

    // The model dispatches; the deterministic rule parks the command and asks.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("mac-studio 现在不在线，我发了一张卡片问你是等它还是取消。")]),
    );
    const res = await ownerDm("修个东西");
    expect(res.status).toBe(200);
    const snap = await snapshotWhere((s) => s.threads.length === 1, "thread created for the ask");
    // Held, not dispatched: the worker waits on the machine until the owner answers.
    expect(snap.threads[0]!.workers).toHaveLength(1);
    expect(snap.threads[0]!.workers[0]!.state).toBe("starting");
    expect(snap.threads[0]!.lastMachine).toBe(fake.deviceId); // affinity set at ask time
    const parkedCmdId = snap.threads[0]!.workers[0]!.cmdId!;
    const parkedRow = await ownerStub().outboxRow(parkedCmdId);
    expect(parkedRow?.state).toBe("queued");
    expect(parkedRow?.notAfter).not.toBeNull();
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const [askCard] = await sentCards();
    expect(askCard?.providerMsgId).toBeTruthy(); // ADR-0003: the row id (or merged uuid) is the message id
    const ask = JSON.stringify(JSON.parse(askCard!.payload as string));
    expect(ask).toContain("不在线");
    expect(ask).toContain("等它上线");

    // --- the click: the callback carries only open_message_id + action, no thread data ------
    const click = await postEvent({ cardMsgId: askCard!.providerMsgId!, action: "wait_online" });
    expect(click.status).toBe(200);
    expect((await ownerStub().outboxRow(parkedCmdId))?.notAfter).toBeNull(); // wait cleared the hold
    const queued = await snapshotWhere((s) => s.threads[0]?.workers.length === 1, "worker still parked");
    expect(queued.threads[0]!.unread).toBe(false); // the click counts as read (§6.5)

    await fake.connect(); // machine returns: hello redelivers the waited start_worker
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd).toBeDefined();
    expect(cmd!.notAfter).toBeNull();
    expect((cmd!.args as Record<string, unknown>).threadId).toBe(queued.threads[0]!.threadId);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "queued run finished");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    expect((await sentCards()).length).toBeGreaterThanOrEqual(2); // ask card + done card (+ waited-start notice)
    fake.close();
  }, 30_000);
});

describe("status questions answer from the situation, without dispatching", () => {
  it("the model reads the injected brief and answers; no worker is started", async () => {
    const fake = await pairFakeConnector();
    await fake.connect();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "跑个只读检查", repoRef: "repo-a", newTitle: "只读检查", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发只读检查。")]),
    );
    await ownerDm("跑个只读检查");
    await fake.waitForCmds(1);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "run done");
    await waitRunsSettled();
    fake.close();

    await scriptModel(fauxAssistantMessage([fauxText("目前有一件事在进行中：「只读检查」。机器 mac-studio 在线。")]));
    await ownerDm("现在什么情况？");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("只读检查"))).toBe(true);
    // The reply came from the model, not from any template:
    const runs = (await llmState()).runs;
    expect(runs.filter((r) => r.kind === "user")).toHaveLength(2);
    expect(runs.every((r) => r.status === "settled")).toBe(true);
    expect((await ownerStub().outboundRows(50)).some((r) => r.status === "sent")).toBe(true);
  }, 30_000);
});
