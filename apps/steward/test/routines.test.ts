// Routines and follow-ups (issue #20, steward.md §8, spec §8): creation needs the owner's
// explicit words (repeat back → confirm → create_routine; suggestions only ever send a
// button), schedules ride the Agents SDK with operationId = routine:<id>:<fireTime> so
// duplicate fires process once, digest routines render deterministically with NO LLM and
// stay silent with nothing to say, follow-ups carry a verified sourceRef and submit
// ⟦followup F⟧ when due, and every fire leaves lastResult plus a timeline entry (§8.6).
// The model is the scripted faux provider; everything else is the production path.
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  configureAndBind,
  llmState,
  messageEvent,
  modelRequests,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { Steward } from "../src/steward.ts";
import { digestCard, digestIsEmpty } from "../src/report-template.ts";
import { describeSchedule, parseAtIso, validateRoutineSpec } from "../src/routines.ts";
import { followupWakeText, routineWakeText } from "../src/wake-text.ts";
import type { FakeConnector } from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
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

async function sentCards(): Promise<Array<{ id: string; threadId: string | null; payload: string }>> {
  const rows = await ownerStub().outboundRows(50);
  return rows.filter((r) => r.kind === "card" && r.status === "sent").map((r) => ({ id: r.id, threadId: r.threadId, payload: JSON.stringify(r.payload) }));
}

/** The RPC stub collapses generic method returns to `never` (helpers.ts's LlmStateView note). */
interface ScheduleView {
  id: string;
  callback: string;
  type: string;
  time: number;
  payload: { routineId?: string; followupId?: string };
}

async function routineSchedules(): Promise<ScheduleView[]> {
  return (await ownerStub().routineSchedulesForTest()) as unknown as ScheduleView[];
}

async function snapshot() {
  return ownerStub().debugSnapshot();
}

async function waitFor<T>(get: () => Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached: ${what} (last: ${JSON.stringify(value)})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A card.action.trigger callback on the card the DO sent with `providerMsgId`. */
function cardActionEvent(providerMsgId: string, action: string) {
  return { cardMsgId: providerMsgId, action };
}

/** Pairs + connects a machine (repo-a) with autorun off — the digest's "running" fodder. */
async function connectedMachine(name = "mac-studio"): Promise<FakeConnector> {
  const fake = await pairFakeConnector(name, { run: null, autorun: false });
  await fake.connect();
  return fake;
}

/**
 * Drops a thread into a chosen digest state without driving the whole event pipeline (the
 * digest only READS state; the pipeline itself is events.test.ts's business): `running`
 * dispatches a real worker; `idleUnread` retires it and flips the unread flag.
 */
async function threadInState(state: "running" | "idleUnread", title: string): Promise<string> {
  const outcome = await ownerStub().dispatchForTest({ prompt: title, repoRef: "repo-a", newTitle: title });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(outcome)}`);
  const threadId = outcome.threadId;
  if (state === "running") return threadId;
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    // `.bind` matters: the SDK's sql tagged template reads `this.ctx` (helpers.ts's note).
    const sql = ((instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql).bind(instance);
    sql`UPDATE sh_worker SET state = 'idle' WHERE threadId = ${threadId}`;
    sql`UPDATE sh_thread SET unread = 1, state = 'idle' WHERE threadId = ${threadId}`;
  });
  return threadId;
}

describe("pure helpers (routines.ts, wake-text.ts, report-template.ts)", () => {
  it("validateRoutineSpec: exactly one trigger, 5-field cron, sane instruction", () => {
    const now = Date.now();
    expect(validateRoutineSpec({ instruction: "汇总进展", kind: "digest", cron: "0 9 * * 1-5" }, now)).toBeNull();
    expect(validateRoutineSpec({ instruction: "查依赖", kind: "instruction", onceAt: now + 60_000 }, now)).toBeNull();
    expect(validateRoutineSpec({ instruction: "", kind: "digest", cron: "0 9 * * *" }, now)).toContain("instruction");
    expect(validateRoutineSpec({ instruction: "x", kind: "digest", cron: "0 9 * * *", onceAt: now + 60_000 }, now)).toContain("二选一");
    expect(validateRoutineSpec({ instruction: "x", kind: "digest" }, now)).toContain("二选一");
    expect(validateRoutineSpec({ instruction: "x", kind: "digest", cron: "0 9 * *" }, now)).toContain("5 段");
    expect(validateRoutineSpec({ instruction: "x", kind: "digest", onceAt: now - 5 * 60_000 }, now)).toContain("未来");
    expect(parseAtIso("not-a-date").ok).toBe(false);
    expect(parseAtIso("2030-01-01T00:00:00Z")).toMatchObject({ ok: true, onceAt: Date.parse("2030-01-01T00:00:00Z") });
  });

  it("describeSchedule and the digest card render from data only", () => {
    expect(describeSchedule({ scheduleKind: "cron", cron: "0 9 * * 1-5", onceAt: null })).toContain("0 9 * * 1-5");
    expect(describeSchedule({ scheduleKind: "once", cron: null, onceAt: Date.parse("2030-01-01T09:00:00Z") })).toContain("2030-01-01 09:00");
    const empty = { running: [], waiting: [], unreadIdle: [] };
    expect(digestIsEmpty(empty)).toBe(true);
    const card = JSON.stringify(
      digestCard(
        {
          running: [{ threadId: "t_1", title: "登录 bug", machineName: "mac-studio", agent: "pi" }],
          waiting: [{ threadId: "t_2", title: "依赖升级", question: "继续还是回滚？" }],
          unreadIdle: [],
        },
        "例行任务 r_x · 测试",
      ),
    );
    expect(card).toContain("1 个在跑、1 个等你");
    expect(card).toContain("「登录 bug」在 mac-studio 上跑");
    expect(card).toContain("等你：继续还是回滚");
  });

  it("more than 4 digest lines: the overflow count survives in the footer, never a silent drop (review #47-1)", () => {
    const mk = (i: number) => ({ threadId: `t_${i}`, title: `任务 ${i}`, machineName: "mac-studio", agent: "pi" });
    const card = digestCard({ running: [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)], waiting: [], unreadIdle: [] }, "例行任务 r_x");
    const cardJson = JSON.stringify(card);
    expect(cardJson).toContain("6 个在跑");
    expect(cardJson).toContain("另有 2 件未列出"); // 6 lines, 4 shown — the count is stated
    const didLines = card.text.split("\n");
    expect(didLines.filter((l) => l.startsWith("- 「任务")).length).toBe(4); // renderReportCard's cap held
    expect(didLines.some((l) => l.includes("任务 5") || l.includes("任务 6"))).toBe(false); // …and the cut is counted
  });

  it("routine/follow-up wake texts carry the marker, the provenance rule, and the context", () => {
    const routine = routineWakeText("r_9", "汇总昨晚进展", {
      schedule: "cron 0 9 * * 1-5（UTC）",
      createdFromMsg: "om_1",
      thread: { threadId: "t_1", title: "登录 bug" },
    });
    expect(routine.startsWith("⟦routine r_9⟧")).toBe(true);
    expect(routine).toContain("汇总昨晚进展");
    expect(routine).toContain("provenanceRef=routine:r_9");
    expect(routine).toContain("no_action");
    expect(routine).toContain("om_1");
    const followup = followupWakeText("f_3", "看看修好没有", {
      thread: { threadId: "t_1", title: "登录 bug" },
      sourceRef: "user:om_2",
      createdBy: "steward",
    });
    expect(followup.startsWith("⟦followup f_3⟧")).toBe(true);
    expect(followup).toContain("user:om_2");
    expect(followup).toContain("no_action");
  });
});

describe("create_routine: repeat back → confirm → save (spec §8.3, steward.md §8.2)", () => {
  it("the confirming user message is the source; the SDK holds the cron schedule", async () => {
    // Turn 1: the steward repeats the request back — nothing is saved yet.
    await scriptModel(fauxAssistantMessage([fauxText("确认一下：每个工作日 09:00（UTC）汇总各机器昨晚进展，做成一张卡片，对吗？")]));
    await dm("每个工作日早上9点帮我汇总昨晚的进展", "om_routine_1");
    await waitRunsSettled();
    expect((await snapshot()).routines).toHaveLength(0); // consent not given yet

    // Turn 2: the owner confirms; create_routine runs inside THAT user message's run.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("create_routine", { instruction: "汇总各机器昨晚进展", kind: "digest", cron: "0 9 * * 1-5", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已创建，每个工作日 09:00（UTC）会给你一张汇总卡片。")]),
    );
    await dm("对", "om_routine_2");
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const snap = await snapshot();
    expect(snap.routines).toHaveLength(1);
    const routine = snap.routines[0]!;
    expect(routine).toMatchObject({
      kind: "digest",
      status: "active",
      scheduleKind: "cron",
      cron: "0 9 * * 1-5",
      instruction: "汇总各机器昨晚进展",
      createdFromMsg: "om_routine_2", // the authorizing message, NOT NULL (§8.1)
    });
    // Schedules ride the Agents SDK (§8.2)…
    const schedules = await routineSchedules();
    const mine = schedules.filter((s) => s.callback === "fireRoutine" && s.payload.routineId === routine.routineId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.type).toBe("cron");
    // …and the creation left a timeline entry (§8.6).
    expect(snap.timelineRecent.some((e) => e.kind === "routine" && e.text.includes("创建例行任务") && e.text.includes(routine.routineId))).toBe(true);
    // The reply told the user what was saved.
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("每个工作日 09:00"))).toBe(true);
  });

  it("refuses outside user runs, bad triggers, and a missing basis stays impossible (§7.2)", async () => {
    await connectedMachine();
    // A user run with a malformed trigger (4-field cron): the tool refuses, nothing saved.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("create_routine", { instruction: "查依赖", kind: "instruction", cron: "0 9 * *", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("cron 格式不对，我重新问一下触发时间。")]),
    );
    await dm("每天九点查依赖", "om_bad_1");
    await waitRunsSettled();
    const requests = await modelRequests();
    expect(requests.some((r) => r.lastToolResult.includes("refused") && r.lastToolResult.includes("5 段"))).toBe(true);
    expect((await snapshot()).routines).toHaveLength(0);

    // Inside a routine-triggered run (an instruction routine exists) creation is refused too.
    await ownerStub().createRoutineForTest({ instruction: "查一遍依赖", kind: "instruction", cron: "0 9 * * *", createdFromMsg: "om_bad_1" });
    const routineId = (await snapshot()).routines[0]!.routineId;
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("create_routine", { instruction: "再建一个", kind: "instruction", cron: "0 10 * * *", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("no_action", { reason: "创建被拒" })], { stopReason: "toolUse" }),
    );
    await ownerStub().fireRoutine({ routineId }, { id: "sched_manual", time: 1760000000 });
    await waitRunsSettled();
    const requests2 = await modelRequests();
    expect(requests2.some((r) => r.lastToolResult.includes("refused") && r.lastToolResult.includes("只能在用户消息的运行里"))).toBe(true);
    expect((await snapshot()).routines).toHaveLength(1); // still just the one
  });
});

describe("digest routines: deterministic, no LLM, silent when nothing to say (spike §2)", () => {
  it("renders running/waiting/unread into one card without a single model request", async () => {
    await connectedMachine();
    await threadInState("running", "登录 bug");
    await threadInState("idleUnread", "依赖升级");
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总进展", kind: "digest", cron: "0 9 * * 1-5" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const requestsBefore = (await modelRequests()).length;

    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_d1", time: 1760000000 });
    await waitWhileOutboundPending();

    // No LLM anywhere on the digest path.
    expect((await modelRequests()).length).toBe(requestsBefore);
    const cards = await sentCards();
    const digest = cards.find((c) => c.id.startsWith(`digest:routine:${created.routineId}:`));
    expect(digest).toBeTruthy();
    expect(digest!.payload).toContain("1 个在跑、1 个未读汇报");
    expect(digest!.payload).toContain("「登录 bug」在 mac-studio 上跑");
    expect(digest!.payload).toContain("「依赖升级」有未读汇报");

    const snap = await snapshot();
    const routine = snap.routines[0]!;
    expect(routine.lastRunAt).not.toBeNull();
    expect(routine.lastResult).toMatch(/^card:/);
    expect(snap.timelineRecent.some((e) => e.kind === "routine" && e.text.includes("已发送汇总卡片"))).toBe(true);
  });

  it("stays silent when there is nothing to say — but still leaves lastResult + a timeline entry", async () => {
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总进展", kind: "digest", cron: "0 9 * * 1-5" });
    if (!created.ok) throw new Error(created.reason);
    const requestsBefore = (await modelRequests()).length;
    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_d2", time: 1760000001 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await modelRequests()).length).toBe(requestsBefore); // silence costs no model call
    expect((await sentCards()).filter((c) => c.id.startsWith(`digest:routine:${created.routineId}:`))).toHaveLength(0);
    const snap = await snapshot();
    expect(snap.routines[0]!.lastResult).toContain("silent");
    expect(snap.timelineRecent.some((e) => e.kind === "routine" && e.text.includes("保持沉默"))).toBe(true);
  });

  it("a duplicate fire (same fireTime) is processed once; the next day is a new fire", async () => {
    await connectedMachine();
    await threadInState("running", "登录 bug");
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总进展", kind: "digest", cron: "0 9 * * 1-5" });
    if (!created.ok) throw new Error(created.reason);

    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_d3", time: 1760000000 });
    await waitWhileOutboundPending();
    // The SDK re-dispatched the same job (retry/alarm replay): same operationId → no-op.
    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_d3", time: 1760000000 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const cards = (await sentCards()).filter((c) => c.id === `digest:routine:${created.routineId}:1760000000`);
    expect(cards).toHaveLength(1);
    const snap = await snapshot();
    expect(snap.timelineRecent.filter((e) => e.kind === "routine" && e.text.includes("已发送汇总卡片"))).toHaveLength(1);
    expect((await llmState()).runs.filter((r) => r.kind === "routine")).toHaveLength(0); // digests never wake the LLM

    // The next day's fireTime is a different operationId → a fresh card.
    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_d3", time: 1760086400 });
    await waitWhileOutboundPending();
    const cards2 = (await sentCards()).filter((c) => c.id.startsWith(`digest:routine:${created.routineId}:`));
    expect(cards2).toHaveLength(2);
  });
});

describe("instruction routines: ⟦routine⟧ wakes with provenance and no_action default (§8.2/§8.6)", () => {
  it("fires submit ⟦routine R⟧; start_worker needs a real provenanceRef; no_action lands in lastResult", async () => {
    const fake = await connectedMachine();
    const created = await ownerStub().createRoutineForTest({
      instruction: "检查 repo-a 的依赖有没有更新，有就说一声",
      kind: "instruction",
      cron: "0 9 * * 1-5",
      createdFromMsg: "om_src_1",
    });
    if (!created.ok) throw new Error(created.reason);
    const routineId = created.routineId;

    // The routine run: a bogus provenance is refused, the routine's own id works.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "检查依赖更新", repoRef: "repo-a", newTitle: "检查依赖更新", provenanceRef: "routine:r_nope", basis: "routine" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("no_action", { reason: "没有可派发的内容" })], { stopReason: "toolUse" }),
    );
    await ownerStub().fireRoutine({ routineId }, { id: "sched_i1", time: 1760000000 });
    await waitRunsSettled();

    const state = await llmState();
    const routineRun = state.runs.find((r) => r.kind === "routine");
    expect(routineRun).toMatchObject({ operationId: `routine:${routineId}:1760000000`, status: "settled" });
    expect(state.inputs.filter((i) => i.text.startsWith(`⟦routine ${routineId}⟧`))).toHaveLength(1);
    const requests = await modelRequests();
    expect(requests.some((r) => r.lastToolResult.includes("refused") && r.lastToolResult.includes("routine:r_nope"))).toBe(true);

    const snap = await snapshot();
    expect(snap.routines[0]!.lastResult).toContain("no_action: 没有可派发的内容"); // §8.6: the default outcome is visible
    expect(snap.timelineRecent.some((e) => e.kind === "routine" && e.text.includes("已交给总管执行"))).toBe(true);
    fake.close();
  });

  it("a routine run can dispatch with provenanceRef=routine:<id> and it reaches the connector", async () => {
    const fake = await connectedMachine();
    const created = await ownerStub().createRoutineForTest({ instruction: "跑一遍测试", kind: "instruction", cron: "0 9 * * *", createdFromMsg: "om_src_2" });
    if (!created.ok) throw new Error(created.reason);
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "跑一遍测试", repoRef: "repo-a", newTitle: "例行测试", provenanceRef: `routine:${created.routineId}`, basis: "routine" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发。")]),
    );
    await ownerStub().fireRoutine({ routineId: created.routineId }, { id: "sched_i2", time: 1760000000 });
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    await waitRunsSettled();
    const snap = await snapshot();
    expect(snap.routines[0]!.lastResult).toContain("done"); // the settle fallback recorded the outcome
    fake.close();
  }, 20_000);
});

describe("provenance liveness: revoked/stale routine and follow-up ids authorize nothing (§7.2, review #47-5)", () => {
  it("a fresh once-routine fire still authorizes its own run; a cancelled routine never does", async () => {
    const fake = await connectedMachine();
    // A once-routine: firing flips it to `done` — the run it spawns must still be able to cite it.
    const once = await ownerStub().createRoutineForTest({ instruction: "跑一遍构建", kind: "instruction", onceAt: Date.now() + 3_600_000 });
    if (!once.ok) throw new Error(once.reason);
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "跑一遍构建", repoRef: "repo-a", newTitle: "例行构建", provenanceRef: `routine:${once.routineId}`, basis: "routine" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发。")]),
    );
    await ownerStub().fireRoutine({ routineId: once.routineId }, { id: "sched_once", time: 1760000000 });
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker"); // fresh done → its fire's run could dispatch
    await waitRunsSettled();

    // A cancelled routine id is the owner's revocation — refused even in another routine's run.
    const cancelled = await ownerStub().createRoutineForTest({ instruction: "已取消的那个", kind: "instruction", cron: "0 9 * * *" });
    if (!cancelled.ok) throw new Error(cancelled.reason);
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = ((instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql).bind(instance);
      sql`UPDATE sh_routine SET status = 'cancelled' WHERE routineId = ${cancelled.routineId}`;
    });
    const active = await ownerStub().createRoutineForTest({ instruction: "活着的例行", kind: "instruction", cron: "0 9 * * *" });
    if (!active.ok) throw new Error(active.reason);
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再试一次", repoRef: "repo-a", newTitle: "再试一次", provenanceRef: `routine:${cancelled.routineId}`, basis: "routine" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("no_action", { reason: "授权被拒" })], { stopReason: "toolUse" }),
    );
    await ownerStub().fireRoutine({ routineId: active.routineId }, { id: "sched_active", time: 1760000100 });
    await waitRunsSettled();
    const requests = await modelRequests();
    expect(requests.some((r) => r.lastToolResult.includes("refused") && r.lastToolResult.includes(cancelled.routineId))).toBe(true);
    expect((await fake.cmds).length).toBe(1); // no second dispatch ever left the DO
    fake.close();
  }, 25_000);

  it("a stale fired follow-up and an open (never-fired) one authorize nothing", async () => {
    await connectedMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修 bug", repoRef: "repo-a", newTitle: "修 bug" });
    if (outcome.kind !== "dispatched") throw new Error(JSON.stringify(outcome));
    const { runInDurableObject } = await import("cloudflare:test");
    const check = (ref: string) =>
      runInDurableObject(ownerStub(), async (instance: Steward) => {
        const ctx = (instance as unknown as {
          stewardToolContext: () => { checkProvenanceRef: (r: string) => Promise<boolean> };
        }).stewardToolContext();
        return await ctx.checkProvenanceRef(ref);
      });
    const hourAgo = Date.now() - 3_600_000;
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = ((instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql).bind(instance);
      sql`
        INSERT INTO sh_followup (followupId, threadId, dueAt, reason, createdBy, sourceRef, status, firedAt, createdAt)
        VALUES ('f_stale', ${outcome.threadId}, ${hourAgo}, '旧的', 'steward', 'user:om_x', 'fired', ${hourAgo}, ${hourAgo})
      `;
      sql`
        INSERT INTO sh_followup (followupId, threadId, dueAt, reason, createdBy, sourceRef, status, createdAt)
        VALUES ('f_open', ${outcome.threadId}, ${Date.now() + 3_600_000}, '没到期的', 'user', 'user:om_x', 'open', ${Date.now()})
      `;
    });
    expect(await check("followup:f_stale")).toBe(false); // fired an hour ago — long dead
    expect(await check("followup:f_open")).toBe(false); // never fired — authorizes nothing
    expect(await check("followup:f_nope")).toBe(false);
  });
});

describe("follow-ups: set_followup with sourceRef; due ones submit ⟦followup F⟧ (§8.3)", () => {
  it("a user-run follow-up fires on time, wakes the steward, and records the outcome", async () => {
    await connectedMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修登录 bug", repoRef: "repo-a", newTitle: "修登录 bug" });
    if (outcome.kind !== "dispatched") throw new Error(JSON.stringify(outcome));
    const threadId = outcome.threadId;

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("set_followup", { threadId, afterMinutes: 0.03, reason: "看看修好没有" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好的，一会儿我再看一眼。")]),
      // The ⟦followup⟧ run's step: nothing to do yet.
      fauxAssistantMessage([fauxToolCall("no_action", { reason: "worker 还在跑" })], { stopReason: "toolUse" }),
    );
    await dm("过一会儿帮我看看修好没", "om_fu_1");
    await waitRunsSettled();

    let snap = await snapshot();
    expect(snap.followups).toHaveLength(1);
    expect(snap.followups[0]).toMatchObject({
      threadId,
      createdBy: "user",
      sourceRef: "user:om_fu_1", // §8.3: traceable to something the owner said
      status: "open",
    });

    // The SDK one-shot fires (~2s); the wake becomes a followup run.
    snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.followups[0]?.status === "fired" && (s.runs.some((r) => r.kind === "followup" && r.status === "settled")),
      "followup fired and settled",
    );
    const state = await llmState();
    const followupId = snap.followups[0]!.followupId;
    expect(state.runs.find((r) => r.kind === "followup")).toMatchObject({ operationId: `followup:${followupId}` });
    const input = state.inputs.find((i) => i.text.startsWith(`⟦followup ${followupId}⟧`));
    expect(input).toBeTruthy();
    expect(input!.text).toContain("看看修好没有");
    expect(snap.followups[0]!.lastResult).toContain("no_action: worker 还在跑");
    expect(snap.threads[0]!.timeline.some((e) => e.kind === "followup" && e.text.includes("到期"))).toBe(true);
  }, 20_000);

  it("a steward-set follow-up (event run) resolves its sourceRef from the Thread's origin message; bogus ones are refused", async () => {
    // Dispatch through the LLM path so the thread carries a real createdFromMsg.
    const fake = await connectedMachine();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修登录 bug", repoRef: "repo-a", newTitle: "修登录 bug", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发。")]),
    );
    await dm("修一下登录 bug", "om_fu_src");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    const threadId = String((cmd!.args as Record<string, unknown>).threadId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "sig/x-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/x-1" });
    await waitRunsSettled();

    // The report wake's run: first a bogus sourceRef (refused), then none at all — which
    // resolves from the thread's createdFromMsg (the message that started this work).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("set_followup", { threadId, afterMinutes: 30, reason: "回看", sourceRef: "user:om_never_received" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("set_followup", { threadId, afterMinutes: 30, reason: "两小时后回看修的情况" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("记好了。")]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "修好了" });
    await waitRunsSettled();

    const requests = await modelRequests();
    expect(requests.some((r) => r.lastToolResult.includes("refused") && r.lastToolResult.includes("om_never_received"))).toBe(true);
    const snap = await snapshot();
    expect(snap.followups).toHaveLength(1); // only the resolved one exists
    expect(snap.followups[0]).toMatchObject({ createdBy: "steward", sourceRef: "user:om_fu_src", threadId });
    fake.close();
  }, 25_000);
});

describe("routine suggestions: a button, nothing else (spec §8.3, steward.md §8.5)", () => {
  it("suggest_routine only sends a card; the tap creates with the original message as source", async () => {
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("suggest_routine", { instruction: "每周五 17:00 查一遍依赖", kind: "instruction", cron: "0 17 * * 5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("我发了张建议卡，你点「创建」才会保存。")]),
    );
    await dm("最近每周五都让你查依赖，要不固定下来？", "om_sugg_1");
    await waitRunsSettled();
    await waitWhileOutboundPending();

    // A button card went out; NOTHING was created.
    expect((await snapshot()).routines).toHaveLength(0);
    const rows = await ownerStub().outboundRows(20);
    const offer = rows.find((r) => r.id.startsWith("offer:") && r.status === "sent");
    expect(offer).toBeTruthy();
    expect(JSON.stringify(offer!.payload)).toContain("routine_accept");

    // The owner taps 创建: the offer's stored spec becomes a routine, traced to om_sugg_1.
    await postEvent(cardActionEvent(offer!.providerMsgId!, "routine_accept"));
    await waitWhileOutboundPending();
    let snap = await snapshot();
    expect(snap.routines).toHaveLength(1);
    expect(snap.routines[0]).toMatchObject({ createdFromMsg: "om_sugg_1", kind: "instruction", cron: "0 17 * * 5", status: "active" });
    expect(snap.offers[0]).toMatchObject({ status: "accepted" });
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("已创建例行任务"))).toBe(true);
    expect((await routineSchedules()).some((s) => s.callback === "fireRoutine")).toBe(true);

    // A second tap changes nothing.
    await postEvent(cardActionEvent(offer!.providerMsgId!, "routine_accept"));
    await waitWhileOutboundPending();
    snap = await snapshot();
    expect(snap.routines).toHaveLength(1);
  });

  it("the decline tap dismisses the offer without creating anything", async () => {
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("suggest_routine", { instruction: "每天 22 点跑一遍测试", kind: "instruction", cron: "0 22 * * *" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("建议卡已发。")]),
    );
    await dm("要不要每天晚上跑测试？", "om_sugg_2");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const rows = await ownerStub().outboundRows(20);
    const offer = rows.find((r) => r.id.startsWith("offer:") && r.status === "sent");
    expect(offer).toBeTruthy();

    await postEvent(cardActionEvent(offer!.providerMsgId!, "routine_decline"));
    await waitWhileOutboundPending();
    const snap = await snapshot();
    expect(snap.routines).toHaveLength(0);
    expect(snap.offers[0]).toMatchObject({ status: "dismissed" });
    expect((await sentTexts()).some((t) => t.includes("没有创建"))).toBe(true);
  });
});

describe("list / pause / cancel by conversation (spec §8.3, steward.md §8.6)", () => {
  it("list_schedules shows everything; pause stops fires and cancels the schedule; resume re-arms; cancel is final", async () => {
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总进展", kind: "digest", cron: "0 9 * * 1-5" });
    if (!created.ok) throw new Error(created.reason);
    const routineId = created.routineId;
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(true);

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("list_schedules", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("pause_schedule", { scheduleId: routineId, paused: true })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已暂停。")]),
    );
    await dm("暂停那个汇总的例行任务", "om_pause_1");
    await waitRunsSettled();

    const requests = await modelRequests();
    const listed = requests.find((r) => r.lastToolResult.includes(routineId) && r.lastToolResult.includes("0 9 * * 1-5"));
    expect(listed).toBeTruthy(); // list_schedules showed id + trigger + status

    let snap = await snapshot();
    expect(snap.routines[0]).toMatchObject({ status: "paused" });
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(false);

    // A paused routine does not fire.
    await ownerStub().fireRoutine({ routineId }, { id: "sched_p", time: 1760000000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    snap = await snapshot();
    expect(snap.routines[0]!.lastRunAt).toBeNull();
    expect((await sentCards()).filter((c) => c.id.startsWith(`digest:routine:${routineId}:`))).toHaveLength(0);

    // Resume re-arms the cron (idempotent insert).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("pause_schedule", { scheduleId: routineId, paused: false })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已恢复。")]),
    );
    await dm("恢复它", "om_resume_1");
    await waitRunsSettled();
    snap = await snapshot();
    expect(snap.routines[0]).toMatchObject({ status: "active" });
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(true);

    // Cancel is final: no more fires, and firing a cancelled routine is a no-op.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("cancel_schedule", { scheduleId: routineId })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已取消。")]),
    );
    await dm("还是取消吧", "om_cancel_1");
    await waitRunsSettled();
    snap = await snapshot();
    expect(snap.routines[0]).toMatchObject({ status: "cancelled" });
    await ownerStub().fireRoutine({ routineId }, { id: "sched_c", time: 1760000900 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await snapshot()).routines[0]!.lastRunAt).toBeNull();
  });
});

describe("onStart reconciliation (§11: rows ↔ SDK schedules survive crashes)", () => {
  it("re-arms an active routine whose schedule was lost, and cancels a paused routine's", async () => {
    const created = await ownerStub().createRoutineForTest({ instruction: "汇总", kind: "digest", cron: "0 9 * * *" });
    if (!created.ok) throw new Error(created.reason);
    const routineId = created.routineId;
    // Simulate the crash window: the row exists, the schedule does not.
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const schedules = await instance.routineSchedulesForTest();
      const mine = schedules.find((s) => (s.payload as { routineId?: string }).routineId === routineId);
      if (mine) await instance.cancelSchedule(mine.id).catch(() => {});
    });
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(false);

    await ownerStub().reconcileRoutineSchedules();
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(true);

    // Paused rows get their lingering schedules cancelled on the next reconcile.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = ((instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql).bind(instance);
      sql`UPDATE sh_routine SET status = 'paused' WHERE routineId = ${routineId}`;
    });
    await ownerStub().reconcileRoutineSchedules();
    expect((await routineSchedules()).some((s) => s.payload.routineId === routineId)).toBe(false);
  });

  it("a stranded overdue open follow-up (schedule lost, dueAt long past) is re-armed, not wedged open (review #47-3)", async () => {
    await connectedMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修 bug", repoRef: "repo-a", newTitle: "修 bug" });
    if (outcome.kind !== "dispatched") throw new Error(JSON.stringify(outcome));
    // An open follow-up whose schedule vanished and whose dueAt is an hour in the past —
    // exactly the crash window reconcile owns. Cancel the schedule via the raw row id.
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      const sql = ((instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql).bind(instance);
      sql`
        INSERT INTO sh_followup (followupId, threadId, dueAt, reason, createdBy, sourceRef, status, createdAt)
        VALUES ('f_stranded', ${outcome.threadId}, ${Date.now() - 3_600_000}, '回看', 'steward', 'user:om_any', 'open', ${Date.now() - 3_900_000})
      `;
      const schedules = await instance.routineSchedulesForTest();
      const mine = schedules.find((s) => (s.payload as { followupId?: string }).followupId === "f_stranded");
      if (mine) await instance.cancelSchedule(mine.id).catch(() => {});
    });
    expect((await routineSchedules()).some((s) => s.payload.followupId === "f_stranded")).toBe(false);

    await ownerStub().reconcileRoutineSchedules();
    // Late is better than stranded: the schedule exists again (at the past dueAt → fires now).
    expect((await routineSchedules()).some((s) => s.payload.followupId === "f_stranded")).toBe(true);
    const snap = await waitFor(() => ownerStub().debugSnapshot(), (s) => s.followups.some((f) => f.followupId === "f_stranded" && f.status === "fired"), "stranded follow-up fired late", 10_000);
    // It fired as a real ⟦followup⟧ wake (the model has no steps → the faux default reply
    // settles it harmlessly; beforeEach resets the script either way).
    expect(snap.followups.find((f) => f.followupId === "f_stranded")!.firedAt).not.toBeNull();
  }, 20_000);
});
