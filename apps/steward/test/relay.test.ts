// Relay through the DO (issue #8, spec §5.3): handoff.build from real ledger rows, the
// deterministic resume-vs-new-session decision at dispatch, base/parentWorker/brief on the
// relayed start_worker, the resume path (send into the old session) and its failure revert,
// and the summary-version machinery (600-char cap, last 5 kept, every-10th rewrite prompt).
// The connector-side half (worktree cut from base, plan file on disk) is
// apps/connector/test/e2e-relay.test.ts — together they close the AC loop.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  messageEvent,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
  type FakeConnector,
  type FakeRepo,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
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
  machine.send({ t: "cmd_result", re: cmd.id, ok: true, data: { sessionId: workerId, branch: "sig/leg-1-1" } });
  await machine.emit("started", workerId, { sessionId: workerId, branch: "sig/leg-1-1" });
  await machine.emit("report", workerId, {
    type: "report",
    status: "done",
    summary: "方案完成：PLAN.md 已提交",
    decisions: ["存储用 sqlite", "接口保持 REST"],
    leftovers: ["迁移 SQL 未生成"],
    changes: ["PLAN.md"],
    git: GIT("sig/leg-1-1"),
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
    expect(brief!.pointers).toMatchObject({ branch: "sig/leg-1-1", ahead: 2, commits: ["3e56dab13073fd2a79e04a2e36414891b2fba95f"] });
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
      git: GIT("sig/leg-1-2"),
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
      continuation: { action: "new_session", reason: "machine_switch", parentWorker: workerId, base: "sig/leg-1-1", brief: true, crossMachine: true },
    });
    const [cmd2] = await macB.waitForCmds(1);
    expect(cmd2!.kind).toBe("start_worker");
    // base = the thread's latest worker branch (spec §5.3 / spike-conclusions §2)
    expect((cmd2!.args as Record<string, unknown>).base).toBe("sig/leg-1-1");
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
      continuation: { action: "new_session", reason: "fresh_review", parentWorker: workerId, base: "sig/leg-1-1", brief: true },
    });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("start_worker");
    expect((cmd2!.args as Record<string, unknown>).base).toBe("sig/leg-1-1");
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
    await fake.emit("started", w2, { sessionId: w2, branch: "sig/leg-1-2" });
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
    expect(outcome).toMatchObject({ continuation: { action: "new_session", reason: "mode_switch", base: "sig/leg-1-1" } });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("start_worker");
    expect(cmd2!.args).toMatchObject({ mode: "readonly", base: "sig/leg-1-1" }); // base goes on the wire for readonly too
    fake.close();
  });

  it("an unusable previous session (broken, or context-overflowed idle) → new session, branch still relayed", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome1 = await ownerStub().dispatchForTest({ prompt: "跑一趟", repoRef: "repo-a", newTitle: "跑一趟" });
    if (outcome1.kind !== "dispatched") throw new Error("dispatch failed");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/pao-1" });
    // issue #10: error:auth lands `broken`; error:context lands `idle` ("suggest a new
    // session") — both are unresumable, the latter precisely because the connector said
    // the session cannot go on (the merge of #10 × #8).
    await fake.emit("settled", workerId, { type: "settled", outcome: "error", errorClass: "context" });
    await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "idle", "context-overflowed leg idle");

    const afterContext = await ownerStub().dispatchForTest({ prompt: "接着来（上下文溢出后）", repoRef: "repo-a", threadId: outcome1.threadId });
    expect(afterContext).toMatchObject({
      continuation: { action: "new_session", reason: "session_unusable", base: "sig/pao-1", brief: true },
    });

    // And the terminally broken shape (error:auth) behaves the same — note the middle leg
    // (the dispatch above, still un-started) is now the previous: no brief (the gate), but
    // the thread's latest branch still relays.
    await ownerStub().setWorkerStateForTest(workerId, "broken", "error:auth");
    const outcome2 = await ownerStub().dispatchForTest({ prompt: "换个新会话接着来", repoRef: "repo-a", threadId: outcome1.threadId });
    expect(outcome2).toMatchObject({
      continuation: { action: "new_session", reason: "session_unusable", base: "sig/pao-1", brief: false },
    });
    fake.close();
  }, 15_000);
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

/** A card-action event on one of our sent cards (the webhook shape the adapter parses). */
function cardActionEvent(cardMsgId: string, action: string) {
  return { cardMsgId, action };
}

describe("PR #54 review findings", () => {
  it("finding 1: retry after a cancelled queued start opens a NEW session, never a resume loop", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.close(); // offline: the only machine with the repo → ask card
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const asked = await ownerStub().dispatchForTest({ prompt: "任务 X", repoRef: "repo-a", newTitle: "任务 X" });
    expect(asked.kind).toBe("asked_offline");
    await waitWhileOutboundPending();
    const askCard = (await ownerStub().outboundRows(10)).find((r) => r.kind === "card" && r.status === "sent");
    expect(askCard?.providerMsgId).toBeTruthy();

    // wait_online: a queued start_worker registers a starting worker the connector never saw.
    expect((await postEvent(cardActionEvent(askCard!.providerMsgId!, "wait_online"))).status).toBe(200);
    const queued = await snapshotWhere((s) => s.threads[0]?.workers[0]?.state === "starting", "queued start pending");
    const neverRan = queued.threads[0]!.workers[0]!;
    expect(neverRan.sessionId).toBeNull();

    // cancel: the withdrawal settles the never-started worker (sessionId null → start path).
    expect((await postEvent(cardActionEvent(askCard!.providerMsgId!, "cancel"))).status).toBe(200);
    const cancelled = await snapshotWhere(
      (s) => s.threads[0]?.workers[0]?.state === "idle" && s.threads[0]?.workers[0]?.lastOutcome === "cancelled",
      "withdrawn start settled",
    );
    expect(cancelled.threads[0]!.workers[0]!.sessionId).toBeNull();

    // The machine returns; the re-dispatch must START a new worker (a send into the
    // never-started session would not_found at the connector and loop forever).
    await fake.connect();
    const retry = await ownerStub().dispatchForTest({ prompt: "任务 X（重试）", repoRef: "repo-a", threadId: cancelled.threads[0]!.threadId });
    expect(retry).toMatchObject({
      kind: "dispatched",
      continuation: { action: "new_session", reason: "session_unusable", brief: false },
    });
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker"); // NOT a send
    expect(String((cmd!.args as Record<string, unknown>).prompt)).not.toContain("【交接简报】"); // the never-ran leg briefs nothing
    fake.close();
  }, 30_000);

  it("finding 3: a same-machine repo switch is a fresh start — no foreign branch as base, no brief claim", async () => {
    const repos: FakeRepo[] = [
      { repoId: "/srv/repo-a", name: "repo-a" },
      { repoId: "/srv/repo-b", name: "repo-b" },
    ];
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false, repos });
    await fake.connect();
    const { threadId } = await runLeg1(fake);

    const switched = await ownerStub().dispatchForTest({ prompt: "在 repo-b 里做收尾", repoRef: "repo-b", threadId });
    expect(switched.kind).toBe("dispatched");
    expect((switched as { continuation?: { base?: string } }).continuation).toMatchObject({
      action: "new_session",
      reason: "repo_switch",
      brief: false,
      crossMachine: false,
    });
    expect((switched as { continuation?: { base?: string } }).continuation).not.toHaveProperty("base");
    const cmd2 = await waitForCmd(fake, (switched as { workerId: string }).workerId);
    expect(cmd2.args).not.toHaveProperty("base"); // repo-A's branch must not become repo-B's base
    expect(String((cmd2.args as Record<string, unknown>).prompt)).not.toContain("【交接简报】");
    // And the timeline does not claim a brief it did not attach.
    const snap = await ownerStub().debugSnapshot();
    const dispatchEntry = snap.threads[0]!.timeline.filter((e) => e.kind === "dispatch").at(-1)!;
    expect(dispatchEntry.text).not.toContain("交接简报");
    fake.close();
  });

  it("finding 4: after a readonly leg, the brief carries the predecessor's pointers", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId } = await runLeg1(fake);

    // A readonly review leg on the same machine: mode switch → new session, base relayed.
    const review = await ownerStub().dispatchForTest({ prompt: "只读评审", repoRef: "repo-a", threadId, mode: "readonly" });
    expect(review).toMatchObject({ continuation: { action: "new_session", reason: "mode_switch", base: "sig/leg-1-1" } });
    const cmd2 = await waitForCmd(fake, (review as { workerId: string }).workerId);
    fake.send({ t: "cmd_ack", re: cmd2.id, status: "accepted" });
    const roWorker = (review as { workerId: string }).workerId;
    await fake.emit("started", roWorker, { sessionId: roWorker, cwd: "/srv/repo-a" }); // no branch: readonly
    await fake.emit("report", roWorker, { type: "report", status: "done", summary: "评审通过" });
    await fake.emit("settled", roWorker, { type: "settled", outcome: "reported" });
    await snapshotWhere((s) => s.threads.some((t) => t.workers.some((w) => w.workerId === roWorker && w.state === "idle")), "review leg idle");

    // The next leg's brief: the readonly leg is the predecessor (no branch of its own), but
    // the pointers still name the write leg's branch and its facts — not null (finding 4).
    const brief = await ownerStub().handoffForTest(threadId);
    expect(brief).toMatchObject({ fromWorkerId: roWorker });
    expect(brief!.pointers).toMatchObject({ workerId: expect.any(String), branch: "sig/leg-1-1", ahead: 2 });
    expect(brief!.pointers!.changedFiles).toContain("PLAN.md");
    fake.close();
  });

  it("finding 8: a failed resume into a RUNNING worker records the lost task and pushes — it never evaporates", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome1 = await ownerStub().dispatchForTest({ prompt: "第一棒", repoRef: "repo-a", newTitle: "第一棒" });
    if (outcome1.kind !== "dispatched") throw new Error("dispatch failed");
    const cmd1 = await waitForCmd(fake, outcome1.workerId);
    fake.send({ t: "cmd_ack", re: cmd1.id, status: "accepted" });
    await fake.emit("started", outcome1.workerId, { sessionId: outcome1.workerId, branch: "sig/leg-1-1" });
    await snapshotWhere((s) => s.threads.some((t) => t.workers.some((w) => w.workerId === outcome1.workerId && w.state === "running")), "leg 1 running");

    // A continuation while running → resume with intent after; the send FAILS at the connector.
    const resume = await ownerStub().dispatchForTest({ prompt: "做完后接着写文档", repoRef: "repo-a", threadId: outcome1.threadId });
    expect(resume).toMatchObject({ continuation: { action: "resume" } });
    const sendCmd = fake.cmds.find((c) => c.kind === "send");
    expect(sendCmd).toBeTruthy();
    fake.send({ t: "cmd_ack", re: sendCmd!.id, status: "rejected", code: "not_running" });
    const noted = await snapshotWhere(
      (s) => s.threads.some((t) => t.timeline.some((e) => e.text.includes("接续指令未送达"))),
      "lost-task note on the timeline",
    );
    // The worker keeps running — only the queued-in task was lost, and the user hears it.
    const w = noted.threads[0]!.workers.find((x) => x.workerId === outcome1.workerId)!;
    expect(w.state).toBe("running");
    await waitWhileOutboundPending();
    const cards = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards.at(-1)?.payload)).toContain("接续原会话失败");
    fake.close();
  }, 30_000);

  it("blocker 3: the reap sweep reverts a resume-pending worker whose send failed — it never breaks the session", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const { threadId, workerId } = await runLeg1(fake);

    // Resume while the machine is offline (issue #14): the send parks HELD behind the ask
    // card — the resume decision itself is unchanged (same agent+machine+repo), only its
    // delivery waits for the owner's wait/switch answer instead of queueing silently.
    fake.close();
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const resume = await ownerStub().dispatchForTest({ prompt: "第二棒", repoRef: "repo-a", threadId });
    expect(resume).toMatchObject({ kind: "asked_offline" });
    const pending = await snapshotWhere(
      (s) => s.threads.some((t) => t.workers.some((w) => w.workerId === workerId && w.state === "starting")),
      "resume pending",
    );
    const sendCmdId = pending.threads[0]!.workers.find((w) => w.workerId === workerId)!.cmdId!;

    // The queued send times out into a terminal failure (the idle sweep's queue timeout),
    // and the worker goes silent long enough to enter the sweep's candidate set.
    await ownerStub().failQueuedForTest(sendCmdId, "idle");
    await ownerStub().backdateWorkerForTest(workerId, 11);
    // The reap sweep must route by the command KIND: a failed send on a resume-pending
    // worker reverts it to idle — markStartFailed would have broken a healthy session.
    await ownerStub().sweepWorkers();
    const reverted = await snapshotWhere(
      (s) => s.threads.some((t) => t.workers.some((w) => w.workerId === workerId && w.state === "idle")),
      "sweep reverted the resume-pending worker",
    );
    const w = reverted.threads[0]!.workers.find((x) => x.workerId === workerId)!;
    expect(w.state).toBe("idle");
    expect(w.lastOutcome).toContain("resume_failed");
    expect(w.lastOutcome).not.toContain("start_failed");
  }, 30_000);
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
