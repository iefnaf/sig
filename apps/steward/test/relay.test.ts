// Relay through the DO (issue #8, spec §5.3): handoff.build from real ledger rows, the
// deterministic resume-vs-new-session decision at dispatch, base/parentWorker/brief on the
// relayed start_worker, the resume path (send into the old session) and its failure revert,
// and the summary-version machinery (600-char cap, last 5 kept, every-10th rewrite prompt).
// The connector-side half (worktree cut from base, plan file on disk) is
// apps/connector/test/e2e-relay.test.ts — together they close the AC loop.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  mockReset,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitWhileOutboundPending,
  type FakeConnector,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

/** Polls the debug snapshot until the predicate holds. */
async function snapshot() {
  return ownerStub().debugSnapshot();
}
async function snapshotWhere(pred: (s: Awaited<ReturnType<typeof snapshot>>) => boolean, what: string, timeoutMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    if (pred(snap)) return snap;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for: ${what}\n${JSON.stringify(snap, null, 2)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const GIT = (branch: string) => ({
  branch,
  base: "b464a0f8c355115c1212b0f019b4a65d2bb44e3",
  ahead: 2,
  dirty: 0,
  filesChanged: 2,
  insertions: 30,
  deletions: 4,
  pushed: false,
  head: "3e56dab13073fd2a79e04a2e36414891b2fba95f",
  commits: ["3e56dab13073fd2a79e04a2e36414891b2fba95f"],
  changedFiles: ["PLAN.md"],
  pointersTruncated: false,
});

/** Dispatches leg 1 on `machine` with autorun off, walks it to a done idle state. */
async function runLeg1(machine: FakeConnector, prompt = "第一棒：写方案"): Promise<{ threadId: string; workerId: string; cmdId: string }> {
  const outcome = await ownerStub().dispatchForTest({ prompt, repoRef: "repo-a", newTitle: prompt });
  if (outcome.kind !== "dispatched") throw new Error(`leg 1 dispatch failed: ${JSON.stringify(outcome)}`);
  const workerId = outcome.workerId;
  // Find THIS dispatch's command (earlier dispatches in the same test may already be on the wire).
  const cmd = await waitForCmd(machine, workerId);
  machine.send({ t: "cmd_ack", re: cmd.id, status: "accepted" });
  machine.send({ t: "cmd_result", re: cmd.id, ok: true, data: { sessionId: workerId, branch: "shepherd/leg-1-1" } });
  await machine.emit("started", workerId, { sessionId: workerId, branch: "shepherd/leg-1-1" });
  await machine.emit("report", workerId, {
    type: "report",
    status: "done",
    summary: "方案完成：PLAN.md 已提交",
    decisions: ["存储用 sqlite", "接口保持 REST"],
    leftovers: ["迁移 SQL 未生成"],
    changes: ["PLAN.md"],
    git: GIT("shepherd/leg-1-1"),
  });
  await machine.emit("settled", workerId, {
    type: "settled",
    outcome: "reported",
    usage: { tokens: { input: 100 }, cost: 0.001, contextUsage: { tokens: 4000, contextWindow: 200_000, percent: 2 } },
  });
  const snap = await snapshotWhere(
    (s) => s.threads.some((t) => t.workers.some((w) => w.workerId === workerId && w.state === "idle")),
    "leg 1 idle",
  );
  expect(snap.threads.find((t) => t.workers.some((w) => w.workerId === workerId))!.workers).toBeDefined();
  return { threadId: outcome.threadId, workerId, cmdId: String(cmd.id) };
}

/** Waits for the start_worker command addressing this worker. */
async function waitForCmd(machine: FakeConnector, workerId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  for (;;) {
    const cmd = machine.cmds.find(
      (c) => c.kind === "start_worker" && String((c.args as Record<string, unknown>).workerId) === workerId,
    );
    if (cmd) return cmd;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`no start_worker for ${workerId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("handoff.build (steward.md §2.6, from real ledger rows)", () => {
  it("assembles goal, current state, deduped decisions with source worker, latest leftovers, git pointers", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);
    // The thread's summary (the steward's bookkeeping) is the "current state" line.
    await ownerStub().updateThreadForTest?.(threadId, { summary: "方案已定，SQL 未生成" });

    const brief = await ownerStub().handoffForTest(threadId);
    expect(brief).toMatchObject({
      threadId,
      fromWorkerId: workerId,
      goal: "第一棒：写方案",
      state: "方案已定，SQL 未生成",
      decisions: [
        { text: "存储用 sqlite", workerId },
        { text: "接口保持 REST", workerId },
      ],
      leftovers: ["迁移 SQL 未生成"],
    });
    expect(brief!.pointers).toMatchObject({ branch: "shepherd/leg-1-1", ahead: 2, commits: ["3e56dab13073fd2a79e04a2e36414891b2fba95f"] });
    fake.close();
  });

  it("returns null without a thread; a never-started leg yields an empty brief", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    expect(await ownerStub().handoffForTest("t_nope")).toBeNull();
    const created = await ownerStub().dispatchForTest({ prompt: "空跑", repoRef: "repo-a", newTitle: "空跑" });
    expect(created.kind).toBe("dispatched");
    // The worker row exists (registered at dispatch) but never ran: the brief is well-formed
    // and empty — and the dispatcher never attaches one to a first leg (no previous worker).
    const empty = await ownerStub().handoffForTest((created as { threadId: string }).threadId);
    expect(empty).toMatchObject({ decisions: [], leftovers: [], pointers: null });

    const { threadId, workerId } = await runLeg1(fake, "第一棒：写方案 2");
    // A second leg repeating one decision verbatim: one entry, first reporter keeps it.
    const second = await ownerStub().dispatchForTest({ prompt: "第二棒", repoRef: "repo-a", threadId, freshReview: true });
    if (second.kind !== "dispatched") throw new Error("leg 2 dispatch failed");
    const cmd2 = await waitForCmd(fake, second.workerId);
    const worker2 = second.workerId;
    fake.send({ t: "cmd_ack", re: cmd2!.id, status: "accepted" });
    await fake.emit("report", worker2, {
      type: "report",
      status: "done",
      summary: "第二棒完成",
      decisions: ["存储用 sqlite", "新增决定 B"],
      git: GIT("shepherd/leg-1-2"),
    });
    await fake.emit("settled", worker2, { type: "settled", outcome: "reported" });
    const snap = await snapshotWhere(
      (s) => s.threads.some((t) => t.workers.some((w) => w.workerId === worker2 && w.lastOutcome === "reported:done")),
      "leg 2 report recorded",
    );
    expect(snap.threads.find((t) => t.threadId === threadId)!.workers).toHaveLength(2);
    const brief = await ownerStub().handoffForTest(threadId);
    expect(brief!.decisions.map((d) => d.text)).toEqual(["存储用 sqlite", "接口保持 REST", "新增决定 B"]);
    expect(brief!.decisions[0]!.workerId).toBe(workerId); // attributed to the first reporter
    fake.close();
  });
});

describe("the resume-vs-new-session decision at dispatch (spec §5.3, issue #8)", () => {
  it("same agent + same machine → resume: a send into the old session, no new worker", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);
    const outcome = await ownerStub().dispatchForTest({ prompt: "第二棒：按方案实现", repoRef: "repo-a", threadId });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      continuation: { action: "resume", brief: false },
    });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("send");
    expect(cmd2!.args).toMatchObject({ workerId, text: "第二棒：按方案实现" });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers).toHaveLength(1); // the same session continues
    fake.close();
  });

  it("machine switch → new session on the previous branch, with the brief and parentWorker", async () => {
    const macA = await pairFakeConnector("mac-a", { run: null, autorun: false });
    await macA.connect();
    // Leg 1 runs while mac-a is the ONLY online machine (a deterministic pick); mac-b joins
    // afterwards — otherwise two online machines with the repo is an ask_which, not a pick.
    const { threadId, workerId } = await runLeg1(macA);
    const macB = await pairFakeConnector("mac-b", { run: null, autorun: false, repos: [{ repoId: "/srv/repo-a", name: "repo-a" }] });
    await macB.connect();

    const outcome = await ownerStub().dispatchForTest({
      prompt: "第二棒：按方案实现",
      repoRef: "repo-a",
      threadId,
      machineHint: macB.deviceId, // the user names the other machine
    });
    expect(outcome).toMatchObject({
      kind: "dispatched",
      continuation: { action: "new_session", reason: "machine_switch", parentWorker: workerId, base: "shepherd/leg-1-1", brief: true, crossMachine: true },
    });
    const [cmd2] = await macB.waitForCmds(1);
    expect(cmd2!.kind).toBe("start_worker");
    // base = the thread's latest worker branch (spec §5.3 / spike-conclusions §2)
    expect((cmd2!.args as Record<string, unknown>).base).toBe("shepherd/leg-1-1");
    // The brief is prefixed to the task; the task text itself comes last (§2.6).
    const prompt = String((cmd2!.args as Record<string, unknown>).prompt);
    expect(prompt.startsWith("【交接简报】")).toBe(true);
    expect(prompt).toContain("目标：第一棒：写方案");
    expect(prompt).toContain("关键决定");
    expect(prompt).toContain("存储用 sqlite");
    expect(prompt.endsWith("本次任务：第二棒：按方案实现")).toBe(true);
    // parentWorker records the relay relationship.
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers[1]).toMatchObject({ parentWorker: workerId });
    macA.close();
    macB.close();
  });

  it("an explicit fresh-review request → new session even on the same machine", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);
    const outcome = await ownerStub().dispatchForTest({
      prompt: "独立复核这个方案",
      repoRef: "repo-a",
      threadId,
      freshReview: true,
    });
    expect(outcome).toMatchObject({
      continuation: { action: "new_session", reason: "fresh_review", parentWorker: workerId, base: "shepherd/leg-1-1", brief: true },
    });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("start_worker");
    expect((cmd2!.args as Record<string, unknown>).base).toBe("shepherd/leg-1-1");
    fake.close();
  });

  it("high context usage → new session; below the threshold → resume", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);
    await ownerStub().setWorkerContextForTest(workerId, 85);
    const high = await ownerStub().dispatchForTest({ prompt: "继续", repoRef: "repo-a", threadId });
    expect(high).toMatchObject({ continuation: { action: "new_session", reason: "context_high", parentWorker: workerId } });
    const [, cmdHigh] = await fake.waitForCmds(2);
    expect(cmdHigh!.kind).toBe("start_worker");

    // Walk the new session to idle, then a modest context resumes it.
    const w2 = String((cmdHigh!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmdHigh!.id, status: "accepted" });
    await fake.emit("started", w2, { sessionId: w2, branch: "shepherd/leg-1-2" });
    await fake.emit("settled", w2, { type: "settled", outcome: "reported", usage: { contextUsage: { tokens: 10_000, contextWindow: 200_000 } } });
    await snapshotWhere((s) => s.threads[0]?.workers[1]?.state === "idle", "second leg idle");
    const snap = await snapshot();
    expect(snapWorker(snap, w2)?.contextPercent).toBe(5); // derived from tokens/window

    const low = await ownerStub().dispatchForTest({ prompt: "再继续", repoRef: "repo-a", threadId });
    expect(low).toMatchObject({ continuation: { action: "resume" } });
    fake.close();
  });

  it("a mode switch (write → readonly) → new session, and readonly relays the branch too", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId } = await runLeg1(fake);
    const outcome = await ownerStub().dispatchForTest({
      prompt: "只读评审这版方案",
      repoRef: "repo-a",
      threadId,
      mode: "readonly",
    });
    expect(outcome).toMatchObject({ continuation: { action: "new_session", reason: "mode_switch", base: "shepherd/leg-1-1" } });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("start_worker");
    expect(cmd2!.args).toMatchObject({ mode: "readonly", base: "shepherd/leg-1-1" }); // base goes on the wire for readonly too
    fake.close();
  });

  it("a broken previous session → new session (session_unusable), the branch still relayed", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome1 = await ownerStub().dispatchForTest({ prompt: "跑一趟", repoRef: "repo-a", newTitle: "跑一趟" });
    if (outcome1.kind !== "dispatched") throw new Error("dispatch failed");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/pao-1" });
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "context" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "broken", "worker broken");

    const outcome2 = await ownerStub().dispatchForTest({ prompt: "换个新会话接着来", repoRef: "repo-a", threadId: outcome1.threadId });
    expect(outcome2).toMatchObject({
      continuation: { action: "new_session", reason: "session_unusable", base: "shepherd/pao-1", brief: true },
    });
    fake.close();
  });
});

function snapWorker(snap: Awaited<ReturnType<typeof snapshot>>, workerId: string) {
  for (const t of snap.threads) {
    const w = t.workers.find((x) => x.workerId === workerId);
    if (w) return w;
  }
  return null;
}

describe("the resume send failing reverts the worker and tells the user", () => {
  it("a rejected resume send → idle again, a red failure card, no ghost starting", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);
    const outcome = await ownerStub().dispatchForTest({ prompt: "第二棒", repoRef: "repo-a", threadId });
    expect(outcome).toMatchObject({ continuation: { action: "resume" } });
    const [, cmd2] = await fake.waitForCmds(2);
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "resume pending");

    fake.send({ t: "cmd_ack", re: cmd2!.id, status: "rejected", code: "broken_worker" });
    const reverted = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "reverted to idle");
    expect(reverted.threads[0]!.workers[0]!.lastOutcome).toContain("resume_failed");
    await waitWhileOutboundPending();
    const cards = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards.at(-1)?.payload)).toContain("接续原会话失败");
    fake.close();
  });
});

describe("thread summaries: capped, versioned, rewritten from scratch (§2.6, issue #8)", () => {
  it("keeps the last 5 versions and counts cumulative updates; the every-10th is a from-scratch rewrite", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    if (outcome.kind !== "dispatched") throw new Error("dispatch failed");
    const threadId = outcome.threadId;

    // 12 real updates (blank and unchanged rewrites do not count).
    await ownerStub().updateThreadForTest(threadId, { summary: "第 1 版摘要" });
    for (let i = 2; i <= 12; i++) {
      await ownerStub().updateThreadForTest(threadId, { summary: `第 ${i} 版摘要` });
      // An identical re-save between real updates moves nothing:
      await ownerStub().updateThreadForTest(threadId, { summary: `第 ${i} 版摘要` });
    }
    const state = await ownerStub().summaryStateForTest(threadId);
    expect(state.status.updates).toBe(12);
    expect(state.versions.map((v) => v.version)).toEqual([12, 11, 10, 9, 8]); // newest first, last 5 kept
    expect(state.versions[0]!.summary).toBe("第 12 版摘要");

    // The rewrite window: after 9 updates, the NEXT (10th) must be from scratch.
    const nine = await ownerStub().summaryStateForTest(threadId);
    expect(nine.status.rewriteDue).toBe(false); // 12th landed already — next boundary is the 20th
    expect((await ownerStub().summaryStateForTest(threadId)).status.rewriteDue).toBe(false);

    // Over-length still refused outright (the 600-char cap, existing behavior).
    const tooLong = await ownerStub().updateThreadForTest(threadId, { summary: "长".repeat(601) });
    expect(tooLong).toBe(false);
    fake.close();
  });

  it("reports the rewrite window per-version: due after 9, not after 10", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    if (outcome.kind !== "dispatched") throw new Error("dispatch failed");
    const threadId = outcome.threadId;

    for (let i = 1; i <= 9; i++) await ownerStub().updateThreadForTest(threadId, { summary: `S${i}` });
    let state = await ownerStub().summaryStateForTest(threadId);
    expect(state.status).toEqual({ updates: 9, rewriteDue: true }); // the 10th is next

    await ownerStub().updateThreadForTest(threadId, { summary: "S10 (from scratch)" });
    state = await ownerStub().summaryStateForTest(threadId);
    expect(state.status).toEqual({ updates: 10, rewriteDue: false }); // boundary passed; next at 20
    fake.close();
  });
});
