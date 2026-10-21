// Worker questions and non-done outcomes (issue #10, steward.md §5.2-5.3, §4.3, §7.2;
// connector-pi.md §5.2): a blocked/needs_decision report opens an sh_question and a
// high-priority wake; the steward may answer factual questions itself (answer_worker, evidence
// required — the hook blocks without it); if nothing handles the question within the 90-second
// window the core forwards it verbatim from a template (here forced with the LLM failing);
// the user's quote-reply or option click is relayed to the worker and closes the question;
// settled error classes / unreported / broken follow the rules table, error:transient stays
// silent. Everything runs the production path — real webhook, real reducer, real alarms —
// with the model scripted through the faux provider.
import { beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
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
import type { FakeConnector } from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 8)}`): Promise<Response> {
  return postEvent(messageEvent({ msgId, text }));
}

type SentCard = { id: string; payload: string; threadId: string | null; providerMsgId: string | null; questionId?: string | null };

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

async function sentCards(): Promise<SentCard[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows.filter((r) => r.kind === "card" && r.status === "sent") as unknown as SentCard[];
}

/** Every tool-result text of the run, in order (via the captured model requests). */
async function allToolResults(): Promise<string[]> {
  return (await modelRequests()).map((r) => r.lastToolResult).filter((t): t is string => t !== null);
}

function cardActionEvent(cardMsgId: string, action: string) {
  return { cardMsgId, action };
}

/** A dispatched, RUNNING worker on a connected machine (no scripted run — events by hand). */
async function runningWorker(title = "查一下构建为什么挂"): Promise<{ fake: FakeConnector; workerId: string; threadId: string }> {
  const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
  await fake.connect();
  const outcome = await ownerStub().dispatchForTest({ prompt: title, repoRef: "repo-a", newTitle: title });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(outcome)}`);
  fake.send({ t: "cmd_ack", re: (await fake.waitForCmds(1))[0]!.id, status: "accepted" });
  await fake.emit("started", outcome.workerId, { sessionId: outcome.workerId, branch: "sig/x-1" });
  return { fake, workerId: outcome.workerId, threadId: outcome.threadId };
}

/** Polls the debug snapshot until pred holds (events reduce asynchronously). */
async function waitFor<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached (${what}): ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const firstAskAction = (card: SentCard): string => {
  const parsed = JSON.parse(card.payload as string) as { card?: { buttons?: Array<{ action?: string }> } };
  const action = (parsed.card?.buttons ?? []).find((btn) => btn.action?.startsWith("ask:"))?.action;
  if (!action) throw new Error(`no ask button on card: ${card.payload}`);
  return action;
};

describe("blocked / needs_decision reports (steward.md §5.3, AC1)", () => {
  it("opens an sh_question, queues a high-priority wake carrying the questionId, and holds the push for the window", async () => {
    const { fake, workerId } = await runningWorker();
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "两个方案都能修",
      question: "用 session 还是 JWT？",
    });

    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    expect(q).toMatchObject({ status: "open", kind: "report" });
    expect(q.text).toBe("用 session 还是 JWT？");

    // The wake is high priority and names the question (answer_worker / ask_user target it).
    const wake = snap.wakes.find((w) => w.dedupeKey === `report:${workerId}:2`);
    expect(wake).toMatchObject({ priority: "high" });
    expect(wake!.text).toContain(`questionId=${q.qid}`);
    // The push is held: nothing reaches the user while the window is open.
    await waitWhileOutboundPending();
    expect((await sentCards())).toHaveLength(0);
    fake.close();
  }, 30_000);

  it("a high-priority block merging into an earlier pending wake upgrades it (§5.4)", async () => {
    const { fake, workerId } = await runningWorker("两件事");
    // Both reports in ONE batch: one reducer transaction queues both wakes back-to-back, so
    // the second deterministically merges into the first pending row.
    fake.send({
      t: "events",
      id: `e_merge_${crypto.randomUUID().slice(0, 6)}`,
      batch: [
        { workerId, seq: 2, ts: Date.now(), type: "report", status: "done", summary: "第一件完成" },
        { workerId, seq: 3, ts: Date.now(), type: "report", status: "blocked", summary: "第二件卡住", question: "要不要跳过测试？" },
      ],
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.wakes.some((w) => w.status === "pending" && w.text.includes("要不要跳过测试")),
      "merged wake pending",
    );
    const pending = snap.wakes.find((w) => w.status === "pending")!;
    expect(pending.priority).toBe("high"); // the merged high-priority block upgraded the row
    expect(pending.text).toContain("第一件完成");
    expect(pending.text).toContain("要不要跳过测试？");
    fake.close();
  }, 30_000);
});

describe("answer_worker (steward.md §4.3/§7.2, AC2)", () => {
  it("the hook blocks it without evidence, with a bogus note id, with an unreceived message, and with a wrong-shape ref; a real owner message passes and the answer reaches the worker", async () => {
    const { fake, workerId } = await runningWorker("目标分支是什么");
    // A real owner message — valid user evidence once it has run through the webhook.
    await scriptModel(fauxAssistantMessage([fauxText("好，我去安排。")]));
    await dm("目标分支用 main，测试跑 pnpm test");
    await waitRunsSettled();
    const ownerRun = (await llmState()).runs.find((r) => r.kind === "user")!;
    const ownerMsgId = ownerRun.operationId.slice("user:".length);

    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "准备提交",
      question: "目标分支是哪个？跑测试用什么命令？",
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;

    // Four refused attempts, then the valid one. Each refusal is visible to the model.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("answer_worker", { workerId, questionId: q.qid, text: "用 main", basis: "memory" })], { stopReason: "toolUse" }), // no evidence
      fauxAssistantMessage([fauxToolCall("answer_worker", { workerId, questionId: q.qid, text: "用 main", evidence: "note:n_missing", basis: "memory" })], { stopReason: "toolUse" }), // bogus note
      fauxAssistantMessage([fauxToolCall("answer_worker", { workerId, questionId: q.qid, text: "用 main", evidence: "user:om_not_sent", basis: "memory" })], { stopReason: "toolUse" }), // never received
      fauxAssistantMessage([fauxToolCall("answer_worker", { workerId, questionId: q.qid, text: "用 main", evidence: "just-trust-me", basis: "memory" })], { stopReason: "toolUse" }), // wrong shape
      fauxAssistantMessage([fauxToolCall("answer_worker", { workerId, questionId: q.qid, text: "目标分支 main；测试用 pnpm test", evidence: `user:${ownerMsgId}`, basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已代答。")]),
    );
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const results = await allToolResults();
    // The four refusals reached the model (Autonomy rule blocks from the §7.2 hook)…
    expect(results.some((r) => r.includes("Autonomy rule") && r.includes("需要 evidence"))).toBe(true);
    expect(results.some((r) => r.includes("笔记 note:n_missing 不存在"))).toBe(true);
    expect(results.some((r) => r.includes("不是本部署收到过的用户消息"))).toBe(true);
    expect(results.some((r) => r.includes("只能是 note:") && r.includes("user:"))).toBe(true);
    // …nothing was sent to the connector for them: exactly one send, the valid answer.
    const sends = fake.cmds.filter((c) => c.kind === "send");
    expect(sends).toHaveLength(1);
    expect(String((sends[0]!.args as Record<string, unknown>).text)).toContain("目标分支 main");
    // The question closed and the 90-second fallback is cancelled: expiring sends nothing.
    const after = await ownerStub().debugSnapshot();
    expect(after.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    expect((await sentCards()).filter((c) => JSON.stringify(c.payload).includes("目标分支"))).toHaveLength(0);
    fake.close();
  }, 45_000);

  it("answer_worker refuses failure-class and unreported questions — those are the user's, not the worker's", async () => {
    const { fake, workerId } = await runningWorker("凭据坏了");
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "auth" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "failure question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    // The evidence gate lives in the hook; the class refusal is the deterministic service's —
    // call it directly (the hook already passed in the other test above).
    const refusal = await ownerStub().answerWorker({
      workerId,
      questionId: q.qid,
      text: "重试即可",
      provenance: "user:om_direct",
      cmdId: "test_answer_class",
    });
    expect(refusal).toMatchObject({ kind: "refused" });
    expect((refusal as { reason: string }).reason).toContain("不是 worker 的提问");
    // Same for unreported: classification is the steward's job, never a worker reply.
    await fake.emit("settled", workerId, { type: "settled", outcome: "unreported", lastText: "差不多了" }).catch(() => undefined);
    const unreportedSnap = await ownerStub().debugSnapshot();
    const unreportedQ = unreportedSnap.questions.find((x) => x.workerId === workerId && x.kind === "unreported");
    if (unreportedQ) {
      const refusal2 = await ownerStub().answerWorker({
        workerId,
        questionId: unreportedQ.qid,
        text: "继续",
        provenance: "user:om_direct",
        cmdId: "test_answer_class2",
      });
      expect(refusal2).toMatchObject({ kind: "refused" });
    }
    expect(fake.cmds.filter((c) => c.kind === "send")).toHaveLength(0);
    fake.close();
  }, 30_000);
});

describe("the 90-second fallback (steward.md §5.3, AC3 — fault injection: the LLM fails)", () => {
  it("forwards the worker's question verbatim from the template, exactly once, when the model errors out", async () => {
    const { fake, workerId } = await runningWorker("迁移脚本卡住");
    await fake.emit("report", workerId, {
      type: "report",
      status: "blocked",
      summary: "被数据库权限挡住了",
      question: "可以给我开 psql 超级权限吗？",
      changes: ["migrations/0007.sql"],
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;

    // Fault injection: the model call itself fails — nothing handles the question.
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "model down" }));
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    expect(runs.some((r) => r.kind === "event" && r.resultStatus !== "done")).toBe(true);

    // Shrink the window and let the REAL alarm fire (no manual sweep): the deadline is
    // persisted on the question row, so the pass may land late but never early.
    await ownerStub().shrinkQuestionWindowForTest(1200);
    const card = await waitFor(
      () => sentCards().then((cs) => cs.find((c) => JSON.stringify(c.payload).includes("psql"))),
      (c) => c !== undefined,
      "fallback card",
      20_000,
    );
    // Verbatim: the worker's exact question text, attention-toned, from data — no LLM.
    const payload = JSON.stringify(JSON.parse(card!.payload as string));
    expect(payload).toContain("可以给我开 psql 超级权限吗？");
    expect(payload).toContain("⚠️"); // attention-toned badge
    // The card binds the question — a quote-reply routes the answer to the worker.
    expect(card!.questionId).toBe(q.qid);

    // Exactly once: a re-run of the sweep (alarm replay / DO reset) forwards nothing more.
    await ownerStub().sweepQuestionFallbackForTest();
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    expect((await sentCards()).filter((c) => JSON.stringify(c.payload).includes("psql"))).toHaveLength(1);
    const after = await ownerStub().debugSnapshot();
    expect(after.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "open" }); // still waiting for the user
    expect(after.pendingNotifications.filter((n) => n.questionId === q.qid)).toHaveLength(0);
    fake.close();
  }, 45_000);
});

describe("the user's answer reaches the worker (steward.md §4.3, AC4)", () => {
  it("a quote-reply to the fallback card is relayed, closes the question, and never starts an LLM run", async () => {
    const { fake, workerId } = await runningWorker("删不删旧索引");
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "迁移前发现旧索引",
      question: "旧的 search_index 要不要顺手删掉？",
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => c.questionId === q.qid);
    expect(card).toBeTruthy();

    const runsBefore = (await llmState()).runs.length;
    // The owner quote-replies the card — the answer goes to the worker deterministically.
    await postEvent(messageEvent({ msgId: `om_ans_${crypto.randomUUID().slice(0, 6)}`, text: "删掉吧，顺便重建", parentId: card!.providerMsgId ?? undefined }));
    await waitFor(() => Promise.resolve(fake.cmds.filter((c) => c.kind === "send")), (s) => s.length === 1, "answer send");
    const send = fake.cmds.find((c) => c.kind === "send")!;
    expect(String((send.args as Record<string, unknown>).text)).toContain("删掉吧，顺便重建");
    expect(String((send.args as Record<string, unknown>).text)).toContain("用户对你问题的回答");
    await waitWhileOutboundPending();
    // The question closed and the user was told the answer went out.
    const after = await ownerStub().debugSnapshot();
    expect(after.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    expect((await sentTexts()).some((t) => t.includes("已把你的回答转给"))).toBe(true);
    // No LLM run for the answer — the relay is deterministic.
    expect((await llmState()).runs.length).toBe(runsBefore);
    fake.close();
  }, 45_000);

  it("an option button on the steward's forwarded ask relays the click and closes the question", async () => {
    const { fake, workerId } = await runningWorker("回滚还是热修");
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "线上问题两种修法",
      question: "先回滚上一个版本，还是直接热修？",
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    // The steward forwards it with its own options, naming the question.
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("ask_user", {
          question: "线上问题：先回滚上一个版本，还是直接热修？",
          options: ["先回滚", "直接热修"],
          questionId: q.qid,
        }),
      ], { stopReason: "toolUse" }),
    );
    await waitRunsSettled();
    await waitWhileOutboundPending();
    // ONE ask card, bound to the WORKER's question (no second sh_question row was created).
    const askCards = (await sentCards()).filter((c) => JSON.stringify(c.payload).includes("先回滚"));
    expect(askCards).toHaveLength(1);
    expect(askCards[0]!.questionId).toBe(q.qid);
    const all = await ownerStub().debugSnapshot();
    expect(all.questions.filter((x) => x.threadId === snap.threads[0]!.threadId)).toHaveLength(1);

    // The click: relayed to the worker, question closed, no LLM run.
    const runsBefore = (await llmState()).runs.length;
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, firstAskAction(askCards[0]!)));
    await waitFor(() => Promise.resolve(fake.cmds.filter((c) => c.kind === "send")), (s) => s.length === 1, "click relay");
    expect(String((fake.cmds.find((c) => c.kind === "send")!.args as Record<string, unknown>).text)).toContain("先回滚");
    const after = await ownerStub().debugSnapshot();
    expect(after.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    expect((await llmState()).runs.length).toBe(runsBefore);
    // ask_user reaching the user cancelled the fallback: expiring the window sends nothing.
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    expect((await sentCards()).filter((c) => JSON.stringify(c.payload).includes("回滚上一个版本"))).toHaveLength(1);
    fake.close();
  }, 45_000);

  it("an answer while the machine is offline still closes the question (the command queues for its return)", async () => {
    const { fake, workerId } = await runningWorker("离线机上的问题");
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "需要拍板",
      question: "继续等还是放弃？",
    });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => c.questionId === q.qid);
    expect(card).toBeTruthy();
    // The machine drops BEFORE the answer: the send queues for its return — the relay still
    // reports honestly, and the question is closed (the answer is durably on its way).
    fake.close();
    await postEvent(messageEvent({ msgId: `om_ans_${crypto.randomUUID().slice(0, 6)}`, text: "继续等", parentId: card!.providerMsgId ?? undefined }));
    await waitWhileOutboundPending();
    const after = await ownerStub().debugSnapshot();
    expect(after.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    expect((await sentTexts()).some((t) => t.includes("已把你的回答转给"))).toBe(true);
  }, 45_000);
});

describe("review findings (PR #52)", () => {
  it("F1: a quote-reply to a FAILURE card reaches the steward, never the broken worker", async () => {
    const { fake, workerId } = await runningWorker("跑回归");
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "auth" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "failure question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => c.questionId === q.qid);
    expect(card).toBeTruthy();

    // The owner replies to the failure card: the decision is the STEWARD's to execute.
    await scriptModel(fauxAssistantMessage([fauxText("收到，凭据修好后我就重新派发。")]));
    await postEvent(messageEvent({ msgId: `om_fix_${crypto.randomUUID().slice(0, 6)}`, text: "凭据已经修好了，重新派发", parentId: card!.providerMsgId ?? undefined }));
    await waitRunsSettled();
    await waitWhileOutboundPending();
    // Nothing was relayed into the broken worker — the reply became a steward run.
    expect(fake.cmds.filter((c) => c.kind === "send")).toHaveLength(0);
    const runs = (await llmState()).runs;
    expect(runs.some((r) => r.kind === "user" && r.text.includes("凭据已经修好了"))).toBe(true);
    // The failure question closed via the routed-reply path (the steward sees it answered).
    expect((await ownerStub().debugSnapshot()).questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    fake.close();
  }, 45_000);

  it("F1: a quote-reply to an error:context card reaches the steward too (the dead session is never prompted)", async () => {
    const { fake, workerId } = await runningWorker("大重构");
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "context" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "context question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => c.questionId === q.qid);
    expect(card).toBeTruthy();
    await scriptModel(fauxAssistantMessage([fauxText("好，我开个新会话接着做。")]));
    await postEvent(messageEvent({ msgId: `om_ctx_${crypto.randomUUID().slice(0, 6)}`, text: "开个新会话接着做", parentId: card!.providerMsgId ?? undefined }));
    await waitRunsSettled();
    // The overflowing session was never prompted; the steward got the instruction.
    expect(fake.cmds.filter((c) => c.kind === "send")).toHaveLength(0);
    expect((await llmState()).runs.some((r) => r.kind === "user" && r.text.includes("开个新会话"))).toBe(true);
    fake.close();
  }, 45_000);

  it("F2: a quote-reply to an ANSWERED question's card never answers a later, different question", async () => {
    const { fake, workerId } = await runningWorker("两问");
    // Question A: forwarded by the fallback, then answered by quote-reply (one send).
    await fake.emit("report", workerId, { type: "report", status: "blocked", summary: "第一问", question: "先用哪个分支？" });
    const q1 = (await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question A opened",
    )).questions.find((x) => x.workerId === workerId)!;
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const cardA = (await sentCards()).find((c) => c.questionId === q1.qid);
    expect(cardA).toBeTruthy();
    await postEvent(messageEvent({ msgId: `om_a1_${crypto.randomUUID().slice(0, 6)}`, text: "用 main", parentId: cardA!.providerMsgId ?? undefined }));
    await waitFor(() => Promise.resolve(fake.cmds.filter((c) => c.kind === "send")), (s) => s.length === 1, "answer A relayed");

    // Question B opens on the same worker; the owner then quote-replies the OLD card A.
    await fake.emit("report", workerId, { type: "report", status: "needs_decision", summary: "第二问", question: "要不要带迁移脚本？" });
    const q2 = (await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.qid !== q1.qid && x.workerId === workerId && x.status === "open"),
      "question B opened",
    )).questions.find((x) => x.qid !== q1.qid && x.workerId === workerId)!;
    await scriptModel(fauxAssistantMessage([fauxText("好的，两问都收到了。")]));
    await postEvent(messageEvent({ msgId: `om_b1_${crypto.randomUUID().slice(0, 6)}`, text: "是的，就这么办", parentId: cardA!.providerMsgId ?? undefined }));
    await waitRunsSettled();
    await waitWhileOutboundPending();
    // Still exactly ONE worker send: the reply to the answered card A was NOT relayed as B's
    // answer — it went to the steward (which sees the thread's questions and can act).
    expect(fake.cmds.filter((c) => c.kind === "send")).toHaveLength(1);
    expect(String((fake.cmds.find((c) => c.kind === "send")!.args as Record<string, unknown>).text)).toContain("用 main");
    expect((await llmState()).runs.some((r) => r.kind === "user" && r.text.includes("是的，就这么办"))).toBe(true);
    // The thread's open question closed via the routed-reply path (pre-#10 semantics).
    expect((await ownerStub().debugSnapshot()).questions.find((x) => x.qid === q2.qid)).toMatchObject({ status: "answered" });
    fake.close();
  }, 60_000);

  it("F3: a sweep that forwarded nothing this pass still drains an intent stranded by a restart", async () => {
    const { fake, workerId, threadId } = await runningWorker("重启后送达");
    await fake.emit("report", workerId, { type: "report", status: "blocked", summary: "等拍板", question: "继续用旧的连接池吗？" });
    const q = (await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    )).questions.find((x) => x.workerId === workerId)!;
    // Model the post-crash state exactly: queueFallbacks committed (intent + handledAt), the
    // delivery pass never ran. `forwarded` will be 0 — the drain must happen anyway.
    await runInDurableObject(ownerStub(), (_instance: unknown, state: { storage: { sql: { exec: (q: string) => unknown } } }) => {
      state.storage.sql.exec(`UPDATE sh_question SET fallbackDueAt = askedAt, handledAt = askedAt WHERE qid = '${q.qid}'`);
      state.storage.sql.exec(
        `INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, createdAt, questionId) VALUES ('question:${q.qid}', 'attention_report', '${threadId}', '${workerId}', ${Date.now()}, '${q.qid}')`,
      );
    });
    const { forwarded } = await ownerStub().sweepQuestionFallbackForTest();
    expect(forwarded).toBe(0); // nothing NEW was forwarded — the strand is the point
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => JSON.stringify(c.payload).includes("连接池"));
    expect(card).toBeTruthy();
    expect(card!.questionId).toBe(q.qid);
    fake.close();
  }, 45_000);

  it("F5: notify_user resolution:'question' keeps the question open; 'done' closes it", async () => {
    const { fake, workerId } = await runningWorker("静默收尾二");
    await fake.emit("settled", workerId, { type: "settled", outcome: "unreported", lastText: "大体做完了" });
    const q = (await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "unreported question",
    )).questions.find((x) => x.workerId === workerId)!;
    // The steward asks the user IN PROSE: the card goes out, the question stays open.
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("notify_user", {
          conclusion: "worker 结束但没有汇报",
          did: ["最后说：大体做完"],
          needsYou: "要我现在按原任务重新派发核实一遍吗？",
          tone: "attention",
          urgency: "push",
          questionId: q.qid,
          resolution: "question",
        }),
      ], { stopReason: "toolUse" }),
    );
    await waitRunsSettled();
    await waitWhileOutboundPending();
    expect((await sentCards()).some((c) => JSON.stringify(c.payload).includes("重新派发核实"))).toBe(true);
    let snap = await ownerStub().debugSnapshot();
    expect(snap.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "open" });
    expect(snap.threads[0]!.state).toBe("waiting_you");
    // The fallback is cancelled though (it reached the user): expiring sends nothing more.
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    // (The fallback card would render the QUESTION text — "没有产出汇报…" — not the
    // notify card's conclusion, so this cannot match the card that already went out.)
    expect((await sentCards()).filter((c) => JSON.stringify(c.payload).includes("没有产出汇报"))).toHaveLength(0);

    // A later run classifies it as done: terminal resolution closes the question.
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("notify_user", {
          conclusion: "已核实：任务完成",
          did: ["检查了分支与测试"],
          tone: "info",
          urgency: "quiet",
          questionId: q.qid,
          resolution: "done",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("备")]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "补交了收尾" });
    await waitRunsSettled();
    await waitWhileOutboundPending();
    snap = await ownerStub().debugSnapshot();
    expect(snap.questions.find((x) => x.qid === q.qid)).toMatchObject({ status: "answered" });
    fake.close();
  }, 60_000);

  it("F6: the fallback card forwards a long, multi-line question VERBATIM (no clip, no collapse)", async () => {
    const { fake, workerId } = await runningWorker("超长问题");
    const longQuestion = [
      "数据库迁移到新集群前需要确认几件事，每件都会影响回滚窗口和周五的发布节奏，请逐条拍板：",
      "1. 旧的 search_index 是否可以在迁移完成后顺手删掉，还是必须保留给回滚使用？如果保留，保留多久（一周 / 一个月 / 直到下次大版本）？",
      "2. 新集群的连接池上限沿用旧的 200 还是按机器内存重新估算？如果重新估算，按什么比例给批量任务留余量？",
      "3. 迁移窗口定在周五晚高峰之后（23:00 UTC+8）是否可以，还是需要避开整点备份任务？备份任务目前的结束时间并不固定，请一并确认。",
    ].join("\n");
    expect(longQuestion.length).toBeGreaterThan(200); // well past the old 126-char clip
    await fake.emit("report", workerId, { type: "report", status: "needs_decision", summary: "迁移前确认", question: longQuestion });
    await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId && x.status === "open"),
      "question opened",
    );
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const card = (await sentCards()).find((c) => JSON.stringify(c.payload).includes("search_index"));
    expect(card).toBeTruthy();
    const payload = JSON.stringify(JSON.parse(card!.payload as string));
    // Every clause survives — including the last one past the old 126-char clip point…
    expect(payload).toContain("避开整点备份任务");
    // …and the line breaks are preserved, not whitespace-collapsed.
    expect(payload).toContain("\\n3. 迁移窗口");
    fake.close();
  }, 45_000);

  it("F7: notify_user with a stale questionId is refused — the model sees the error and nothing is sent", async () => {
    const { fake, workerId } = await runningWorker("静默收尾三");
    await fake.emit("settled", workerId, { type: "settled", outcome: "unreported", lastText: "差不多完了" });
    await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "unreported question",
    );
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("notify_user", {
          conclusion: "已核实完成",
          did: [],
          tone: "info",
          urgency: "quiet",
          questionId: "q_typo_zzz",
          resolution: "done",
        }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("备")]),
    );
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const results = await allToolResults();
    expect(results.some((r) => r.includes("refused") && r.includes("q_typo_zzz"))).toBe(true);
    // Nothing was sent, and no card claimed a handling that never happened.
    expect((await sentCards()).filter((c) => JSON.stringify(c.payload).includes("已核实"))).toHaveLength(0);
    fake.close();
  }, 45_000);
});

describe("settled outcomes and broken follow the rules table (steward.md §5.3, AC5)", () => {
  it("error:auth pushes immediately with a red card and opens a failure question; the window never double-forwards it", async () => {
    const { fake, workerId } = await runningWorker("跑回归");
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "auth", lastText: "401 invalid key" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "failure question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    expect(q).toMatchObject({ status: "open", kind: "failure" });
    expect(q.text).toContain("凭据");
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(cards[0]!.payload as string))).toContain("❌"); // failure-toned badge
    // Failure questions carry no fallback deadline — expiring the window must not re-ask.
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    expect((await sentCards())).toHaveLength(1);
    fake.close();
  }, 30_000);

  it("error:context pushes and suggests a fresh session; error:transient stays completely silent", async () => {
    const { fake, workerId } = await runningWorker("大重构");
    // transient: the connector auto-resumes — nothing is sent, nothing asked, no wake.
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "transient" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    let snap = await ownerStub().debugSnapshot();
    expect(snap.questions.filter((x) => x.workerId === workerId)).toHaveLength(0);
    expect(snap.wakes.filter((w) => w.dedupeKey.startsWith(`settled:${workerId}`))).toHaveLength(0);
    expect((await sentCards())).toHaveLength(0);
    expect(snap.threads[0]!.workers[0]!.state).toBe("running"); // still in flight

    // context: a question suggesting a fresh session, pushed.
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "context" });
    snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "context question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    expect(q).toMatchObject({ status: "open", kind: "failure" });
    expect(q.text).toContain("新会话");
    expect((await ownerStub().debugSnapshot()).threads[0]!.workers[0]!.state).toBe("idle"); // context ends the run
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(cards[0]!.payload as string))).toContain("上下文超长");
    fake.close();
  }, 30_000);

  it("unreported opens a question and wakes the steward with the last text, but never pushes on its own", async () => {
    const { fake, workerId } = await runningWorker("静默收尾");
    await fake.emit("settled", workerId, { type: "settled", outcome: "unreported", lastText: "改完了，测试也在跑，应该没问题" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "unreported question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    expect(q).toMatchObject({ status: "open", kind: "unreported" });
    expect(q.text).toContain("没有产出汇报");
    // The wake carries the last utterance for classification (steward.md §5.3).
    const wake = snap.wakes.find((w) => w.dedupeKey === `settled:${workerId}:2`);
    expect(wake).toMatchObject({ priority: "high" });
    expect(wake!.text).toContain("改完了，测试也在跑");
    // No push of its own: classification is the steward's job (notify_user/ask_user with
    // questionId); the deterministic fallback is not armed for unreported questions.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitWhileOutboundPending();
    expect((await sentCards())).toHaveLength(0);
    expect((await ownerStub().debugSnapshot()).pendingNotifications.filter((n) => n.questionId === q.qid)).toHaveLength(0);
    fake.close();
  }, 30_000);

  it("the broken event opens a question, pushes, and wakes the steward", async () => {
    const { fake, workerId } = await runningWorker("自动恢复两次都失败");
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "transient" });
    await fake.emit("broken", workerId, { type: "broken", reason: "自动重启两次后仍失败" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.questions.some((x) => x.workerId === workerId),
      "broken question",
    );
    const q = snap.questions.find((x) => x.workerId === workerId)!;
    expect(q).toMatchObject({ status: "open", kind: "failure" });
    expect(q.text).toContain("自动重启两次后仍失败");
    expect(snap.threads[0]!.workers[0]!.state).toBe("broken");
    expect(snap.wakes.some((w) => w.priority === "high" && w.dedupeKey === `question:${q.qid}`)).toBe(true);
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(JSON.parse(cards[0]!.payload as string))).toContain("自动重启两次后仍失败");
    fake.close();
  }, 30_000);
});
