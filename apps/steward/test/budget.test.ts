// The daily budget soft cap (issue #28, steward.md §12, ADR-0001 decision 15). pi.usage is
// cumulative, so the day's spend is the growth between observations: the counter must equal
// pi's own total after every run (never twice), keep agreeing across a pi reopen (what a
// restarted isolate sees), and treat pre-existing history as baseline. Past the cap,
// event/routine/follow-up wakes are skipped while their deterministic halves (done cards,
// fallback pushes, digest routines) still send; owner messages are still processed with the
// budget state noted exactly once per day; "/花费" answers from the counter with no model
// call. The model is the scripted faux provider, whose price is $0 (models.ts) — token
// counting is exercised end-to-end, dollar spend through the cursor arithmetic below.
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  configureAndBind,
  llmState,
  messageEvent,
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
import { budgetDay, createBudget, formatUsd, renderSpendStatus, resolveBudgetConfig, sumUsage, type BudgetState } from "../src/budget.ts";
import type { Steward } from "../src/steward.ts";
import type { Ledger } from "../src/ledger.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await ownerStub().setBudgetForTest(undefined); // the deploy config (default $1) again
  await ownerStub().resetBudgetForTest(); // every test starts from a virgin counter
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
async function dispatchOne(prompt = "修复登录 bug"): Promise<{ fake: FakeConnector; workerId: string; threadId: string }> {
  const fake = await connectedMachine();
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("start_worker", { prompt, repoRef: "repo-a", newTitle: prompt, basis: "user_explicit" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("已派发。")]),
  );
  await dm(`请处理：${prompt}`);
  const [cmd] = await fake.waitForCmds(1);
  const workerId = String((cmd!.args as Record<string, unknown>).workerId);
  const threadId = String((cmd!.args as Record<string, unknown>).threadId);
  fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
  fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "sig/x-1" } });
  await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
  await waitRunsSettled();
  return { fake, workerId, threadId };
}

/** The persisted counter as a decision would read it — deliberately NOT through budgetStatus(),
 *  which syncs first and would hide a meter that is not running. */
async function persistedTokens(): Promise<number> {
  return (await ownerStub().usageDaysForTest())[0]?.tokens ?? 0;
}

async function runOneUserMessage(text: string, reply: string, msgId: string): Promise<void> {
  await scriptModel(fauxAssistantMessage([fauxText(reply)]));
  await dm(text, msgId);
  await waitRunsSettled();
  await waitWhileOutboundPending();
}

describe("the counter agrees with pi's own ledger without anyone asking it to sync", () => {
  it("after a run settles, today's tokens equal pi.usage's total — once, not twice", async () => {
    await runOneUserMessage("你好", "第一句。", "om_eq_1");
    const pi = await ownerStub().piUsageForTest();
    expect(pi.tokens).toBeGreaterThan(0);
    expect(await persistedTokens()).toBe(pi.tokens);
    // What /花费 and the wake gate do (an explicit sync) must add nothing on top.
    expect((await ownerStub().budgetStatus()).tokens).toBe(pi.tokens);
    expect(await persistedTokens()).toBe(pi.tokens);
  }, 30_000);

  it("keeps agreeing after pi is reopened — what an evicted-and-restarted isolate does", async () => {
    await runOneUserMessage("你好", "第一句。", "om_re_1");
    const afterFirst = await ownerStub().piUsageForTest();
    expect(await persistedTokens()).toBe(afterFirst.tokens);

    // pi's in-memory session goes away (listeners and all); the root conversation already
    // exists in storage, so reopening does NOT create it again.
    await runInDurableObject(ownerStub(), (instance: Steward) => instance.piHarness.dispose());

    await runOneUserMessage("再说一句", "第二句。", "om_re_2");
    const afterSecond = await ownerStub().piUsageForTest();
    expect(afterSecond.tokens).toBeGreaterThan(afterFirst.tokens);
    expect(await persistedTokens()).toBe(afterSecond.tokens);
  }, 30_000);
});

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
    // cursor is wiped while pi's history stays (the next sync re-seeds from it).
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

// ---- the cursor arithmetic, in dollars, straight against the DO's own SQLite -------------
// (The end-to-end path above is token-only because faux's price is $0; these run the real
// ledger.budget against synthetic dollar readings, plus the pure config/summation rules.)

/** The DO's own live budget handle — run assertions right where the SQLite is. Call
 *  resetCursorForTest() first when a test needs the never-seen (baseline) state. */
async function budgetOnTheDo(): Promise<(t: (budget: Ledger["budget"]) => void) => Promise<unknown>> {
  return (fn) =>
    runInDurableObject(ownerStub(), (instance: Steward) => {
      const budget = ((instance as unknown as { ledger: Ledger }).ledger).budget;
      return fn(budget);
    });
}

describe("the cursor arithmetic (budget.ts observe)", () => {
  it("the first-ever reading only seeds the cursor — upgrade-day history is not today's spend", async () => {
    await ownerStub().resetCursorForTest();
    const run = await budgetOnTheDo();
    await run((budget) => budget.observe({ costUsd: 37.5, tokens: 1_000_000 }, Date.now()));
    await run((budget) =>
      expect(budget.state({ usd: 1 }, Date.now())).toMatchObject({ costUsd: 0, tokens: 0, over: false }),
    );
  });

  it("charges only the growth; repeated and stale readings add nothing and never roll it back", async () => {
    const run = await budgetOnTheDo();
    await run((budget) => budget.observe({ costUsd: 0.1, tokens: 100 }, Date.now())); // +0.1 / +100
    await run((budget) => budget.observe({ costUsd: 0.2, tokens: 200 }, Date.now())); // +0.1 / +100
    await run((budget) => budget.observe({ costUsd: 0.2, tokens: 200 }, Date.now())); // repeat: nothing
    await run((budget) => budget.observe({ costUsd: 0.15, tokens: 150 }, Date.now())); // stale: ignored
    await run((budget) => budget.observe({ costUsd: 0.35, tokens: 400 }, Date.now())); // +0.15 / +200 more
    await run((budget) =>
      expect(budget.state({ usd: 1 }, Date.now())).toMatchObject({ costUsd: 0.35, tokens: 400 }),
    ); // 0.1 + 0.1 + 0.15 exactly — the repeat and the stale reading contributed nothing
  });

  it("spend after UTC midnight lands on the new day — the cap resets, yesterday keeps its row", async () => {
    const lateNight = Date.parse("2026-10-17T23:59:30Z");
    const afterMidnight = Date.parse("2026-10-18T00:00:30Z");
    const run = await budgetOnTheDo();
    await run((budget) => budget.observe({ costUsd: 1.4, tokens: 1_400 }, lateNight)); // +1.4 on the 17th
    await run((budget) => budget.observe({ costUsd: 1.6, tokens: 1_600 }, afterMidnight)); // +$0.20 on the NEW day
    const newDay = (await run((budget) => budget.state({ usd: 1 }, afterMidnight))) as BudgetState;
    expect(newDay).toMatchObject({ day: "2026-10-18", over: false, resetsAt: Date.parse("2026-10-19T00:00:00Z") });
    expect(newDay.costUsd).toBeCloseTo(0.2, 10);
    const days = await ownerStub().usageDaysForTest();
    expect(days.find((d) => d.day === "2026-10-17")!.costUsd).toBeCloseTo(1.4, 10);
    expect(days.find((d) => d.day === "2026-10-18")!.costUsd).toBeCloseTo(0.2, 10);
  });

  it("the cap is inclusive; a $0 cap is over from the first reading; markNoted is first-win", async () => {
    const run = await budgetOnTheDo();
    await run((budget) => budget.observe({ costUsd: 0.9999, tokens: 10 }, Date.parse("2026-10-17T12:00:00Z")));
    await run((budget) => {
      const state = budget.state({ usd: 1 }, Date.parse("2026-10-17T12:00:01Z"));
      expect(state.over).toBe(false); // just under
      budget.add({ costUsd: 0.0001, tokens: 0 }, Date.parse("2026-10-17T12:00:02Z"));
      const atCap = budget.state({ usd: 1 }, Date.parse("2026-10-17T12:00:03Z"));
      expect(atCap.costUsd).toBeGreaterThanOrEqual(1); // AT the cap counts as over
      expect(atCap.over).toBe(true);
      expect(budget.state({ usd: 0 }, Date.parse("2026-10-17T12:00:03Z")).over).toBe(true); // $0 cap
      budget.markNoted("2026-10-17", Date.parse("2026-10-17T12:00:04Z"));
      budget.markNoted("2026-10-17", Date.parse("2026-10-17T13:00:00Z"));
      expect(budget.state({ usd: 1 }, Date.parse("2026-10-17T14:00:00Z")).overNotedAt).toBe(
        Date.parse("2026-10-17T12:00:04Z"),
      );
    });
  });
});

describe("config and summation (budget.ts, pure)", () => {
  it("resolveBudgetConfig: unset → default, valid numbers pass through, junk falls back loudly", () => {
    expect(resolveBudgetConfig(undefined)).toEqual({ usd: 1 });
    expect(resolveBudgetConfig("")).toEqual({ usd: 1 });
    expect(resolveBudgetConfig("0")).toEqual({ usd: 0 }); // owner messages only
    expect(resolveBudgetConfig(0.5)).toEqual({ usd: 0.5 });
    expect(resolveBudgetConfig("12.5")).toEqual({ usd: 12.5 });
    const junk = resolveBudgetConfig("lots");
    expect(junk.usd).toBe(1);
    expect(junk.error).toBeTruthy();
    expect(resolveBudgetConfig(-1).error).toBeTruthy();
  });

  it("sumUsage adds dollars and tokens across the models and tools buckets, dropping garbage", () => {
    const usage = (cost: number, tokens: number) => ({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    });
    expect(
      sumUsage({
        models: { "deepseek/deepseek-flash": usage(0.012, 3_000), "anthropic/x": usage(0.03, 2_000) },
        tools: { lookup: usage(0.001, 500) },
      }),
    ).toEqual({ costUsd: 0.043, tokens: 5_500 });
    expect(sumUsage({ models: {}, tools: {} })).toEqual({ costUsd: 0, tokens: 0 });
  });
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

  it("the §5.3 fallback still forwards a blocked question over budget (window expiry, no LLM)", async () => {
    const { fake, workerId, threadId } = await dispatchOne();
    await ownerStub().setBudgetForTest(0.5);
    await ownerStub().spendForTest(0.5);
    await fake.emit("report", workerId, { type: "report", status: "needs_decision", summary: "卡住了", question: "回滚还是升级？" });
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.wakes.some((w) => w.status === "skipped"),
    );
    expect(snap.questions.some((q) => q.workerId === workerId && q.status === "open")).toBe(true);
    // #10's 90-second window (§5.3): over budget the steward never runs, so the window can
    // only expire — expire it now (main's worker-questions tests do the same) and sweep.
    // The deterministic fallback forwards the worker's question verbatim; no LLM anywhere.
    await runInDurableObject(
      ownerStub(),
      (_instance: Steward, state: { storage: { sql: { exec: (q: string) => unknown } } }) => {
        state.storage.sql.exec(
          `UPDATE sh_question SET fallbackDueAt = askedAt WHERE workerId = '${workerId}' AND status = 'open'`,
        );
      },
    );
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const cards = await sentCards();
    expect(JSON.stringify(cards)).toContain("回滚还是升级");
    // And the model was never woken for it.
    expect((await llmState()).runs.filter((r) => r.kind === "event")).toHaveLength(0);
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
    await ownerStub().spendForTest(0.0123, 0);
    await dm("/花费", "om_spend_1");
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    const answer = texts.find((t) => t.includes("总管模型花费"))!;
    expect(answer).toContain(formatUsd(0.0123));
    expect(answer).toContain("预算内");
    // No run was opened — the counter answered, not the model.
    expect((await llmState()).runs.filter((r) => r.operationId === "user:om_spend_1")).toHaveLength(0);
  }, 30_000);

  it("renderSpendStatus says when the model's reported price is $0 — the cap cannot trip", () => {
    const state = { day: "2026-10-17", costUsd: 0, tokens: 7797, budgetUsd: 1, over: false, resetsAt: 0, skippedWakes: 0, overNotedAt: null };
    expect(renderSpendStatus(state)).toContain("价格为 $0");
    expect(renderSpendStatus({ ...state, tokens: 0 })).not.toContain("价格为 $0");
    expect(renderSpendStatus({ ...state, costUsd: 0.5 })).not.toContain("价格为 $0");
  });

  it("a $0 cap is over from the first reading — the readout says so, still no model call", async () => {
    await ownerStub().setBudgetForTest(0);
    await dm("/花费", "om_spend_0");
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    const answer = texts.find((t) => t.includes("总管模型花费"))!;
    expect(answer).toContain("已达到每日软上限");
    expect((await llmState()).runs.filter((r) => r.operationId === "user:om_spend_0")).toHaveLength(0);
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
