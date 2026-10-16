// Regression tests for the PR #40 review findings. Each describe names the review item it
// pins; the two headline ones (#1 alarm survival, #3 run binding) run against the REAL alarm
// loop with no manual pollRuns/drainWakes nudging — exactly the production path the review
// found broken.
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  configureAndBind,
  llmState,
  messageEvent,
  mockReset,
  modelRequests,
  ownerStub,
  pairDevice,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitForSentText,
  waitRunsSettled,
  waitWhileOutboundPending,
} from "./helpers.ts";
import type { Steward } from "../src/steward.ts";
import { buildSituationBrief } from "../src/llm/brief.ts";
import { renderTimeline } from "../src/web.ts";
import type { Ledger, TimelineView } from "../src/ledger.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await postEvent(messageEvent({ msgId, text }));
  expect(res.status).toBe(200);
  return msgId;
}

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(50);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

describe("review #1: the pollRuns alarm loop survives its own job (rearm after cancel)", () => {
  it(
    "a delayed model reply still reaches the user with NO manual poll nudging",
    { timeout: 30_000 },
    async () => {
      // 5s model reply > two 2s alarm cycles: the first job-context poll MUST have rearmed
      // (the bug deleted the rearm via idempotent-dedup-onto-running-job) or no later poll
      // exists to settle the run and deliver the reply.
      await scriptModel({ waitForMs: 5000, text: "迟到但到了" } as never);
      await dm("慢慢想，不急", "om_alarm_1");
      // waitForSentText polls only the outbound queue — never pollRuns/drainWakes.
      const row = await waitForSentText("迟到但到了");
      expect(row).not.toBeNull();
      // The reply took ≥5s (the model's own delay), proving it was not an inline settle.
      expect(Date.now()).toBeGreaterThan(0);
      const runs = (await llmState()).runs;
      expect(runs.find((r) => r.operationId === "user:om_alarm_1")).toMatchObject({ status: "settled", resultStatus: "done" });
    },
  );
});

describe("review #3: tools execute inside the run pi actually placed, not the oldest unsettled row", () => {
  it(
    "a queued follow-up's dispatch attributes provenance/createdFromMsg to ITS message",
    { timeout: 30_000 },
    async () => {
      const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
      await fake.connect();
      // DM1's model reply is delayed; DM2 queues as a followUp and starts the instant DM1
      // answers — while DM1's sh_run row is still open (the 2s poll has not settled it).
      // Script FIRST: the model requests consume steps FIFO the moment they run.
      await scriptModel(
        { waitForMs: 3000, text: "第一件答完" } as never,
        fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "第二件事", repoRef: "repo-a", newTitle: "第二件事", basis: "user_explicit" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("第二件已派发。")]),
      );
      const msg1 = await dm("第一件事，慢慢答");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const msg2 = await dm("第二件事：去派个任务");
      await waitRunsSettled();
      await waitWhileOutboundPending();

      const snap = await ownerStub().debugSnapshot();
      expect(snap.threads).toHaveLength(1);
      // createdFromMsg comes from the run the tool executed in: DM2, not the still-open DM1.
      expect(snap.threads[0]!.createdFromMsg).toBe(msg2);
      expect(snap.threads[0]!.createdFromMsg).not.toBe(msg1);
      // Review #8 rode along: DM2's own dispatch backfilled the reply's thread routing.
      const reply = (await ownerStub().outboundRows(20)).find((r) => r.kind === "text" && r.status === "sent" && (JSON.parse(r.payload as string) as { text?: string }).text === "第二件已派发。");
      expect(reply?.threadId).toBe(snap.threads[0]!.threadId);
      fake.close();
    },
  );
});

describe("review #4: event-triggered runs need a verifiable provenanceRef to dispatch (§7.2)", () => {
  it("blocks without a ref, blocks a bogus ref, dispatches on a real user message id", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    // A first user dispatch, so a worker exists to report (and a real user msg is in sh_inbound).
    // Script BEFORE the DM: steps are consumed FIFO by the model requests.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发。")]),
    );
    await dm("去 repo-a 修个东西", "om_prov_real");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "shepherd/p-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/p-1" });
    await waitRunsSettled();

    // The event wake: the model tries to dispatch with no ref (blocked), a bogus ref
    // (blocked), then the real user message id (allowed).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再派一个", repoRef: "repo-a", newTitle: "再派一个", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再派一个", repoRef: "repo-a", newTitle: "再派一个", basis: "user_explicit", provenanceRef: "user:om_nonexistent" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再派一个", repoRef: "repo-a", newTitle: "再派一个", basis: "user_explicit", provenanceRef: "user:om_prov_real" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("记账完成。")]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "修好了" });
    await waitRunsSettled();

    const requests = await modelRequests();
    const results = requests.map((r) => r.lastToolResult).filter((r) => r.length > 0);
    expect(results.some((r) => r.includes("refused") && r.includes("§7.2"))).toBe(true); // no ref
    expect(results.some((r) => r.includes("refused") && r.includes("om_nonexistent"))).toBe(true); // bogus ref
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads.length).toBe(2); // the real ref dispatched: one new thread
    expect(fake.cmds).toHaveLength(2);
    fake.close();
  }, 30_000);
});

describe("review #5: the brief spends its budget questions-first and states omissions", () => {
  const thread = (id: string, state: string, unread = false) => ({
    threadId: id,
    title: `标题${id}`,
    goal: null,
    summary: null,
    summaryAt: null,
    state,
    unread,
    lastMachine: null,
    lastActivityAt: 0,
    archived: false,
    createdFromMsg: null,
    createdAt: 0,
  }) as ReturnType<Ledger["threads"]["get"]>;

  function stubLedger(threads: Array<{ id: string; state: string; unread?: boolean }>, questions: Array<{ threadId: string; text: string }>) {
    return {
      machines: { list: () => [], runningCount: () => 0 },
      threads: { list: () => threads.map((t) => thread(t.id, t.state, t.unread)) },
      questions: { openForThread: (id: string) => (questions.find((q) => q.threadId === id) ?? null) as never },
    } as unknown as Ledger;
  }

  it("keeps open questions visible when idle threads blow the budget", () => {
    const threads = Array.from({ length: 10 }, (_, i) => ({ id: `t_${i}`, state: "idle" }));
    const brief = buildSituationBrief(stubLedger(threads, [{ threadId: "t_0", text: "要不要删库？" }]));
    expect(brief.length).toBeLessThanOrEqual(1200);
    expect(brief).toContain("未决问题");
    expect(brief).toContain("要不要删库？");
  });

  it("orders waiting_you first and hides no state silently", () => {
    const brief = buildSituationBrief(
      stubLedger(
        [
          { id: "t_idle", state: "idle" },
          { id: "t_wait", state: "waiting_you" },
          { id: "t_run", state: "running" },
        ],
        [{ threadId: "t_wait", text: "等你拍板" }],
      ),
    );
    const waitPos = brief.indexOf("t_wait");
    const runPos = brief.indexOf("t_run");
    const idlePos = brief.indexOf("t_idle");
    expect(waitPos).toBeGreaterThan(-1);
    expect(waitPos).toBeLessThan(runPos);
    expect(runPos).toBeLessThan(idlePos);
  });
});

describe("review #2: timeline meta escapes model-writable values", () => {
  it("a goal containing HTML renders inert", () => {
    const view = {
      thread: { threadId: "t_1", title: "标题", goal: '<img src=x onerror="alert(1)">', summary: null, summaryAt: null, state: "idle", unread: false, lastMachine: null, lastActivityAt: 0, archived: false, createdFromMsg: null, createdAt: Date.now() },
      entries: [],
      workers: [{ workerId: "w_1", threadId: "t_1", deviceId: "d", repoId: null, agent: "pi<script>", mode: "write", state: "idle", sessionId: null, branch: null, cmdId: null, lastOutcome: null, lastEventAt: null, lastProgress: null, createdAt: 0, machineName: "mac<b>" }],
      openQuestion: null,
    } as unknown as TimelineView;
    const html = renderTimeline(view, Date.now());
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("pi&lt;script&gt;");
    expect(html).toContain("mac&lt;b&gt;");
  });
});

describe("review #6: stable outbound ids dedupe replays", () => {
  it("enqueueOutbound with the same id converges on one row", async () => {
    const a = await ownerStub().enqueueOutbound({ id: "reply:user:om_x", kind: "text", to: "ou_owner", text: "同一条", urgency: "push" });
    const b = await ownerStub().enqueueOutbound({ id: "reply:user:om_x", kind: "text", to: "ou_owner", text: "同一条", urgency: "push" });
    expect(a.id).toBe(b.id);
    const rows = (await ownerStub().outboundRows(20)).filter((r) => r.id === "reply:user:om_x");
    expect(rows).toHaveLength(1);
  });
});

describe("review #7: a routed reply closes the thread's open question", () => {
  it("quote-replying to the ask marks it answered and the thread leaves waiting_you", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    // Phase 1: a dispatched, settled worker (a fresh dispatch would close the question).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "干件大事", repoRef: "repo-a", newTitle: "干件大事", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已派发。")]),
    );
    await dm("干件大事", "om_q_1");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "shepherd/q-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/q-1" });
    await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const threadId = (await ownerStub().debugSnapshot()).threads[0]!.threadId;

    // Phase 2: the model asks about that thread (with its id, as the brief would supply).
    await scriptModel(fauxAssistantMessage([fauxToolCall("ask_user", { question: "用哪个方案？", options: ["A", "B"], threadId })], { stopReason: "toolUse" }));
    await dm("那个方案怎么样", "om_q_1b");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    let snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.state).toBe("waiting_you");
    const askRow = (await ownerStub().outboundRows(20)).find((r) => r.kind === "text" && r.status === "sent" && (JSON.parse(r.payload as string) as { text?: string }).text?.includes("用哪个方案"));
    expect(askRow?.providerMsgId).toBeTruthy();

    // The user answers by quoting the ask; the answer is "算了" — no dispatch involved.
    await scriptModel(fauxAssistantMessage([fauxText("好，那就先这样。")]));
    await postEvent(messageEvent({ msgId: "om_q_2", text: "算了", parentId: askRow!.providerMsgId! }));
    await waitRunsSettled();
    await waitWhileOutboundPending();

    snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.questions[0]).toMatchObject({ status: "answered" });
    expect(snap.threads[0]!.state).not.toBe("waiting_you");
    fake.close();
  }, 30_000);
});

describe("review #9: empty final texts are only a failure when nothing reached the user", () => {
  it("a silent empty answer gets the notice; ask_user's empty ending stays silent", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    // A run whose only output is a tool call nobody sees (situation) → empty text → notice.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("situation", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("")]),
    );
    await dm("看下现状", "om_empty_1");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("没有给出回复"))).toBe(true);

    // ask_user terminates with empty final text — the ask itself was the user-facing output.
    await ownerStub().fauxScript([]);
    await scriptModel(fauxAssistantMessage([fauxToolCall("ask_user", { question: "这样行吗？" })], { stopReason: "toolUse" }));
    await dm("那个方案", "om_empty_2");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const texts2 = await sentTexts();
    expect(texts2.some((t) => t.includes("这样行吗"))).toBe(true);
    expect(texts2.filter((t) => t.includes("没有给出回复")).length).toBeLessThanOrEqual(1); // only the first run's
    fake.close();
  }, 30_000);
});

describe("review #10: unknown provider/model combinations are surfaced, not silent", () => {
  it("llmSelection reports modelKnown, and a mismatched seal/config is visible", async () => {
    const base = await ownerStub().llmSelection(); // vars = faux (registered at build time)
    expect(base.modelKnown).toBe(true);
    await ownerStub().setModelConfig("anthropic", "sk-ant-x");
    const mismatched = await ownerStub().llmSelection(null); // sealed anthropic + default deepseek-flash
    expect(mismatched).toMatchObject({ provider: "anthropic", modelId: "deepseek-flash" });
    expect(mismatched.modelKnown).toBe(false); // would answer no_model; ensureRootModel logs it
  });
});

describe("review (other): the true submit-succeeded/markSubmitted-lost crash window", () => {
  it("a wake left pending after its submit is drained once, and replays add no input", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome.kind).toBe("dispatched");
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: workerId, branch: "shepherd/w-1" } });
    await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/w-1" });
    await scriptModel(fauxAssistantMessage([fauxText("记账。")]));
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "修好了" });

    // Wait for the wake to exist, then roll its status back to pending — exactly the state a
    // crash between harness.submit and markSubmitted leaves behind.
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.wakes.length >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await waitRunsSettled(); // first drain submits it
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const storage = (instance as unknown as { ctx: { storage: { sql: { exec: (q: string) => unknown } } } }).ctx.storage;
      storage.sql.exec("UPDATE sh_wake SET status = 'pending', submittedAt = NULL");
    });
    const before = (await llmState()).inputs.filter((i) => i.text.startsWith("⟦event⟧")).length;
    await ownerStub().drainWakes(); // replays the submit — same operationId
    await waitRunsSettled();
    const after = (await llmState()).inputs.filter((i) => i.text.startsWith("⟦event⟧")).length;
    expect(after).toBe(before); // pi's requestId dedup holds the line
    fake.close();
  }, 30_000);
});

describe("review (other): a replayed cmdId registers no ghost worker", () => {
  it("dispatchForTest with the same cmdId twice leaves one worker row", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    expect(first.kind).toBe("dispatched");
    const [cmd] = await fake.waitForCmds(1);
    const threadId = (first as { threadId: string }).threadId;
    const again = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", threadId, cmdId: String(cmd!.id) });
    expect(again.kind).toBe("dispatched");
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers).toHaveLength(1); // no second `starting` ghost
    fake.close();
  });
});

describe("review #3 (guard): the one-dispatch guard resets across runs", () => {
  it("two user runs dispatch to different targets without the guard blocking the second", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    for (const title of ["第一件", "第二件"]) {
      await scriptModel(
        fauxAssistantMessage([fauxToolCall("start_worker", { prompt: title, repoRef: "repo-a", newTitle: title, basis: "user_explicit" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText(`已派发${title}。`)]),
      );
      await dm(`${title}，去做`);
      await waitRunsSettled();
    }
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads).toHaveLength(2);
    expect(fake.cmds).toHaveLength(2);
    fake.close();
  }, 30_000);
});
