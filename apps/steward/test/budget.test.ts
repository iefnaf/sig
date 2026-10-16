// The daily budget soft cap (issue #28, steward.md §12, ADR-0001 decision 15). Usage is
// accumulated per UTC day from pi.usage (the commit listener and the serialized sweep);
// past the cap event/routine/follow-up wakes are skipped while their deterministic halves
// (done cards, fallback pushes, digest routines) still send; owner messages are still
// processed with the budget state noted exactly once per day; "/花费" answers from the
// counter with no model call. The model is the scripted faux provider, whose price is $0
// (models.ts) — token counting is exercised end-to-end, dollar spend through spendForTest.
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  configureAndBind,
  llmState,
  messageEvent,
  mockReset,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitForWorkerState,
  waitRunsSettled,
  waitWhileOutboundPending,
  type FakeConnector,
} from "./helpers.ts";
import { budgetDay, formatUsd } from "../src/budget.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
  await ownerStub().setBudgetForTest(undefined); // the deploy config (default $1) again
});

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 8)}`): Promise<Response> {
  return postEvent(messageEvent({ msgId, text }));
}

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

async function sentCards(): Promise<unknown[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows.filter((r) => r.kind === "card" && r.status === "sent").map((r) => JSON.parse(r.payload as string));
}

/** Polls an async getter until pred holds. */
async function waitFor<T>(get: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Pairs + connects a machine with repo-a, autorun off (events by hand). */
async function connectedMachine(name = "mac-studio"): Promise<FakeConnector> {
  const fake = await pairFakeConnector(name, { run: null, autorun: false });
  await fake.connect();
  return fake;
}

/** Dispatches one worker through the LLM tool path and returns (connector, workerId). */
async function dispatchOne(prompt = "修复登录 bug"): Promise<{ fake: FakeConnector; workerId: string }> {
  const fake = await connectedMachine();
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("start_worker", { prompt, repoRef: "repo-a", newTitle: prompt, basis: "user_explicit" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("已派发。")]),
  );
  await dm(`请处理：${prompt}`);
  const [cmd] = await fake.waitForCmds(1);
  const workerId = String((cmd!.args as Record<string, unknown>).workerId);
  fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
  fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "shepherd/x-1" } });
  await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/x-1" });
  await waitRunsSettled();
  return { fake, workerId };
}

describe("usage accumulation from pi usage data (steward.md §12)", () => {
  it("counts the model's tokens per day, monotonically and idempotently", async () => {
    await scriptModel(fauxAssistantMessage([fauxText("第一句。")]));
    await dm("你好", "om_b1");
    await waitRunsSettled();
    const first = await waitFor(() => ownerStub().budgetStatus(), (s) => s.tokens > 0);
    expect(first.day).toBe(budgetDay(Date.now()));
    expect(first.over).toBe(false);
    expect(first.costUsd).toBe(0); // faux's price is $0 — tokens only

    await scriptModel(fauxAssistantMessage([fauxText("第二句。")]));
    await dm("再说一句", "om_b2");
    await waitRunsSettled();
    const second = await waitFor(() => ownerStub().budgetStatus(), (s) => s.tokens > first.tokens);
    expect(second.costUsd).toBe(0);
    // A redundant sweep (the serialized syncUsage) changes nothing: the cursor holds.
    const status = await ownerStub().budgetStatus();
    expect(status.tokens).toBe(second.tokens);
  }, 30_000);

  it("treats pre-existing pi history as baseline, not today's spend", async () => {
    // One run happens; its tokens land in today's row. Then simulate the upgrade path: the
    // cursor is wiped while pi's history stays (armUsageMetering re-baselines on boot).
    await scriptModel(fauxAssistantMessage([fauxText("旧账。")]));
    await dm("hi", "om_base_1");
    await waitRunsSettled();
    await waitFor(() => ownerStub().budgetStatus(), (s) => s.tokens > 0);
    const before = (await ownerStub().budgetStatus()).tokens;
    await ownerStub().resetCursorsForTest();
    const after = await ownerStub().budgetStatus();
    expect(after.tokens).toBe(before); // re-baselined: history did not charge today again
  }, 30_000);
});

describe("over budget: wakes skipped, templates still send (steward.md §12)", () => {
  it("event wakes are skipped once the cap is hit, while done cards keep sending", async () => {
    const { fake, workerId } = await dispatchOne();
    await scriptModel(fauxAssistantMessage([fauxText("记账。")]));

    // Under budget: the first report wakes the model normally.
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "第一件完成" });
    await waitRunsSettled();
    await waitWhileOutboundPending();
    expect((await llmState()).runs.filter((r) => r.kind === "event")).toHaveLength(1);

    // Over budget (faux's cost is $0 — inject the dollar spend the counter gates on).
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "第二件完成" });
    // The card goes out regardless; the wake row settles as 'skipped' once the drain alarm
    // passes the merge window — wait for that exact state, never assume immediacy.
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.wakes.some((w) => w.text.includes("第二件完成") && w.status === "skipped"),
    );
    await waitWhileOutboundPending();

    // The done CARD still went out (template, no LLM, steward.md §0.2)…
    const cards = await sentCards();
    expect(JSON.stringify(cards)).toContain("第二件完成");
    const skipped = snap.wakes.filter((w) => w.status === "skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(snap.wakes.every((w) => w.status !== "pending")).toBe(true);
    expect((await llmState()).runs.filter((r) => r.kind === "event")).toHaveLength(1);
    expect((await ownerStub().budgetStatus()).skippedWakes).toBe(skipped.length);
    const logs = await ownerStub().channelLogEntries(20);
    expect(logs.some((l) => l.reason === "budget_skip_wake")).toBe(true);
    fake.close();
  }, 30_000);

  it("routine and follow-up fires are skipped with an auditable outcome (§8.6)", async () => {
    const created = await ownerStub().createRoutineForTest({
      instruction: "每个工作日汇总",
      kind: "instruction",
      cron: "0 9 * * 1-5",
    });
    expect(created.ok).toBe(true);
    const routineId = created.ok ? created.routineId : "";
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await ownerStub().fireRoutine({ routineId }, { id: "sched_manual", time: 1760000000 });
    await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.wakes.some((w) => w.operationId.startsWith(`routine:${routineId}:`) && w.status === "skipped"),
    );
    const snap = await ownerStub().debugSnapshot();
    const routine = snap.routines.find((r) => r.routineId === routineId)!;
    expect(routine.lastResult).toContain("skipped");
    expect(snap.timelineRecent.some((e) => e.text.includes("超出每日预算"))).toBe(true);
    expect((await llmState()).runs.filter((r) => r.kind === "routine")).toHaveLength(0);
  }, 30_000);

  it("digest routines never touch the budget — they are deterministic", async () => {
    const { fake, workerId } = await dispatchOne();
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总当前进展", kind: "digest", cron: "0 9 * * *" });
    expect(created.ok).toBe(true);
    const routineId = created.ok ? created.routineId : "";
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await ownerStub().fireRoutine({ routineId }, { id: "sched_d1", time: 1760000000 });
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(JSON.stringify(cards)).toContain("汇总");
    const snap = await ownerStub().debugSnapshot();
    expect(snap.wakes.filter((w) => w.kind === "routine").length).toBe(0); // digests never queue a wake
    fake.close();
  }, 30_000);

  it("fallback pushes (needs_decision) still reach the user over budget", async () => {
    const { fake, workerId } = await dispatchOne();
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await fake.emit("report", workerId, { type: "report", status: "needs_decision", summary: "卡住了", question: "回滚还是升级？" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.wakes.some((w) => w.status === "skipped"),
    );
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(JSON.stringify(cards)).toContain("回滚还是升级");
    fake.close();
  }, 30_000);
});

describe("owner messages over budget: processed, state noted once", () => {
  it("the note rides exactly one reply per day; the model still answers", async () => {
    await connectedMachine();
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);

    await scriptModel(fauxAssistantMessage([fauxText("第一条回复。")]));
    await dm("在吗", "om_over_1");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    let texts = await sentTexts();
    const withNote = texts.find((t) => t.includes("第一条回复。"))!;
    expect(withNote).toContain("每日预算");
    expect(withNote).toContain("不再唤醒总管");

    // The second reply the same day carries no second note.
    await scriptModel(fauxAssistantMessage([fauxText("第二条回复。")]));
    await dm("再问一句", "om_over_2");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    texts = await sentTexts();
    const second = texts.find((t) => t.includes("第二条回复。"))!;
    expect(second).not.toContain("每日预算");
    // The day row records the once.
    const days = await ownerStub().usageDaysForTest();
    expect(days[0]!.overNotedAt).not.toBeNull();
  }, 30_000);

  it("a new UTC day resets the counter and the note", async () => {
    await ownerStub().setBudgetForTest(0.5);
    const yesterday = Date.now() - 86_400_000;
    await ownerStub().spendForTest(0.9, 0, yesterday);
    await ownerStub().noteBudgetForTest(budgetDay(yesterday));
    const status = await ownerStub().budgetStatus();
    expect(status.over).toBe(false); // yesterday's spend is not today's
    expect(status.resetsAt).toBeGreaterThan(Date.now());
  }, 30_000);
});

describe('"How much have you spent today?" — answered from the counter', () => {
  it("replies deterministically, without a model call", async () => {
    await ownerStub().spendForTest(0.0123, 4567);
    await dm("/花费", "om_spend_1");
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    const answer = texts.find((t) => t.includes("总管模型花费"))!;
    expect(answer).toContain(formatUsd(0.0123));
    expect(answer).toContain("4,567 tokens");
    expect(answer).toContain("预算内");
    // No run was opened — the counter answered, not the model.
    expect((await llmState()).runs.filter((r) => r.operationId === "user:om_spend_1")).toHaveLength(0);
  }, 30_000);

  it("answers over budget too, with the skip count and cap", async () => {
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await dm("今天花了多少钱？", "om_spend_2");
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    const answer = texts.find((t) => t.includes("总管模型花费"))!;
    expect(answer).toContain(formatUsd(0.5));
    expect(answer).toContain("已达到每日软上限");
    // Asking is hearing: the explicit readout satisfies the daily note.
    const days = await ownerStub().usageDaysForTest();
    expect(days[0]!.overNotedAt).not.toBeNull();
    const again = await sentTexts();
    expect(again.filter((t) => t.includes("不再唤醒总管")).length).toBe(0);
  }, 30_000);
});
