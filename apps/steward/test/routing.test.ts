// Routing (issue #7, steward.md §3): find_threads' explicit short-circuit and candidate
// assembly, the beforeTool confidence gate, ask_user's candidate card and the click that
// routes back as user_reply_to, the idle-attach reminder, and settle-time dispatch
// verification. The model is the scripted faux provider; every other hop is the production
// path (webhook → run → tools → dispatcher → outbound queue → card callback).
import { beforeEach, describe, expect, it } from "vitest";
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

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 8)}`, parentId?: string): Promise<Response> {
  return postEvent(messageEvent({ msgId, text, parentId }));
}

/** A card-action event on one of our sent cards (the webhook shape the adapter parses). */
function cardActionEvent(cardMsgId: string, action: string) {
  return { cardMsgId, action };
}

async function connectedMachine(name = "mac-studio"): Promise<FakeConnector> {
  const fake = await pairFakeConnector(name, { run: null, autorun: false });
  await fake.connect();
  return fake;
}

/** Dispatches one thread (deterministic path), settles it, leaves it idle+read. */
async function oneIdleThread(title: string): Promise<{ fake: FakeConnector; threadId: string }> {
  const fake = await connectedMachine();
  const outcome = await ownerStub().dispatchForTest({ prompt: title, repoRef: "repo-a", newTitle: title });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(outcome)}`);
  const threadId = outcome.threadId;
  const workerId = outcome.workerId;
  const [cmd] = await fake.waitForCmds(1);
  fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
  // A realistic leg: started (the session exists on the connector) → report → settled.
  // Without the started event the worker has no sessionId and a follow-up correctly
  // opens a NEW session instead of resuming (issue #8 / PR #54 review finding 1).
  await fake.emit("started", workerId, { sessionId: workerId, branch: `sig/${title}-1` });
  await fake.emit("report", workerId, { type: "report", status: "done", summary: `${title}完成` });
  await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
  await waitRunsSettled();
  // The done card is quiet now (issue #11) — settle the queue so tests can quote it.
  await waitWhileOutboundPending();
  return { fake, threadId };
}

/** The last tool result the model saw for a tool name, across requests. */
async function sawToolResult(needle: string): Promise<string | null> {
  const requests = await modelRequests();
  for (const request of [...requests].reverse()) {
    if (request.lastToolResult.includes(needle)) return request.lastToolResult;
  }
  return null;
}

describe("find_threads (steward.md §3.2, issue #7)", () => {
  it("a quote-routed run short-circuits to the explicit thread — no candidate guessing", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    // A report card exists for this thread; the user quote-replies it and the model looks
    // for candidates — signal 1 must answer "explicit, this thread".
    const card = (await ownerStub().outboundRows(20)).find((r) => r.kind === "card" && r.status === "sent" && r.threadId === threadId);
    expect(card?.providerMsgId).toBeTruthy();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "那个再改改" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("知道了。")]),
    );
    await dm("那个再改改", `om_qr_${crypto.randomUUID().slice(0, 6)}`, card!.providerMsgId!);
    await waitRunsSettled();
    const result = await sawToolResult("explicit");
    expect(result).toContain(threadId);
    fake.close();
  }, 30_000);

  it("keyword recall finds an idle thread by title and by summary via the FTS index", async () => {
    const { fake } = await oneIdleThread("登录页样式调整");
    // The brief now carries the registered repos (issue #7): the model must see a repoRef
    // for dispatches instead of asking the user which repo.
    const requests0 = await modelRequests();
    const seeded = requests0.find((r) => r.brief?.includes("仓库："));
    expect(seeded?.brief).toContain("repo-a");
    await scriptModel(
      // By title-ish keywords (no explicit routing attached to the run).
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "把登录页的间距再调大一点" })], { stopReason: "toolUse" }),
      // By a word that only exists in the worker's report summary ("完成" is too generic —
      // use the thread title fragment plus 样式, which the summary carries too).
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "样式的事怎么样" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("看过了。")]),
    );
    await dm("查一下");
    await waitRunsSettled();
    const requests = await modelRequests();
    const results = requests.map((r) => r.lastToolResult).filter((r) => r.includes("candidates"));
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const result of results) {
      expect(result).toContain("登录页样式调整");
    }
    fake.close();
  }, 30_000);

  it("an explicit title mention short-circuits without any LLM recall", async () => {
    const { fake } = await oneIdleThread("定时清理临时文件");
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "把「定时清理临时文件」的保留期改成 7 天" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("找到了。")]),
    );
    await dm("找一下");
    await waitRunsSettled();
    const result = await sawToolResult("explicit");
    expect(result).toContain("定时清理临时文件");
    expect(result).toContain("点名了它的标题");
    fake.close();
  }, 30_000);
});

describe("the routing confidence gate (steward.md §3.3 / §7.2, issue #7)", () => {
  it("a non-explicit attach without routing is blocked; with high confidence it dispatches", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    await scriptModel(
      // First attempt: attach with no routing — blocked by the policy hook.
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再跑一次测试", repoRef: "repo-a", threadId, basis: "user_explicit" })], { stopReason: "toolUse" }),
      // Second attempt: same target, now with high confidence — goes through.
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再跑一次测试", repoRef: "repo-a", threadId, basis: "user_explicit", routing: { confidence: "high", reason: "话语点名登录页报错" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂到登录页报错那件事上。")]),
    );
    await dm("登录页报错那个再跑一次测试");
    const [cmd] = await fake.waitForCmds(1); // exactly one dispatch despite two tool calls
    expect(cmd!.kind).toBe("start_worker");
    await waitRunsSettled();
    expect(await sawToolResult("必须给出 routing")).not.toBeNull();
    // The gate's rejection is visible to the model as the tool result of the blocked call.
    const requests = await modelRequests();
    expect(requests.some((r) => r.lastToolResult.includes("confidence"))).toBe(true);
    fake.close();
  }, 30_000);

  it("medium confidence never dispatches — the hook demands ask_user instead", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "改改", repoRef: "repo-a", threadId, basis: "user_explicit", routing: { confidence: "medium", reason: "可能是它" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好吧，我问问。")]),
    );
    await dm("登录那个再改改");
    await waitRunsSettled();
    expect(await sawToolResult("不允许非 high")).not.toBeNull();
    // Nothing new was dispatched (the one cmd in flight is the seeding dispatch).
    expect(fake.cmds.filter((c) => String((c.args as Record<string, unknown>).prompt).includes("改改"))).toHaveLength(0);
    fake.close();
  }, 30_000);

  it("a quote-routed attach is explicit — no routing demanded (signal 1 skips the gate)", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    const card = (await ownerStub().outboundRows(20)).find((r) => r.kind === "card" && r.status === "sent" && r.threadId === threadId);
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再补几个单测", repoRef: "repo-a", threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已续派。")]),
    );
    await dm("再补几个单测", `om_ex_${crypto.randomUUID().slice(0, 6)}`, card!.providerMsgId!);
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    await waitRunsSettled();
    fake.close();
  }, 30_000);

  // Review #48 finding 1: the prompt promises that find_threads' confidence=explicit answer
  // attaches without routing — the gate must honor that for signal 2 (a plain DM naming the
  // title; routedThreadId is null here). Zero coverage before this.
  it("a find_threads explicit hit (signal 2) attaches without routing — plain DM naming the title", async () => {
    const { fake, threadId } = await oneIdleThread("定时清理临时文件");
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "把「定时清理临时文件」的保留期改成 7 天" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "保留期改成 7 天", repoRef: "repo-a", threadId, basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂到定时清理那件事上。")]),
    );
    await dm("把『定时清理临时文件』的保留期改成 7 天");
    const cmds = await fake.waitForCmds(2); // 1 = the seeding dispatch, 2 = the attach
    // Same machine + agent → the attach resumes the idle session (issue #8): the deliverable
    // is a send into that worker. The gate under test never fired.
    expect(cmds[1]!.kind).toBe("send");
    expect(String((cmds[1]!.args as Record<string, unknown>).text)).toContain("保留期改成 7 天");
    await waitRunsSettled();
    expect(await sawToolResult("已续派")).not.toBeNull();
    expect(await sawToolResult("必须给出 routing")).toBeNull(); // the gate never fired
    fake.close();
  }, 30_000);

  it("an explicit hit for another thread does not exempt an attach elsewhere", async () => {
    const { fake } = await oneIdleThread("定时清理临时文件");
    const other = await ownerStub().dispatchForTest({ prompt: "登录页样式", repoRef: "repo-a", newTitle: "登录页样式调整" });
    if (other.kind !== "dispatched") throw new Error("seeding failed");
    await waitRunsSettled();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("find_threads", { query: "把「定时清理临时文件」的保留期改成 7 天" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "改样式", repoRef: "repo-a", threadId: other.threadId, basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("问用户吧。")]),
    );
    await dm("改改");
    await waitRunsSettled();
    // The memo names t_cron; attaching the OTHER thread without routing must still be gated.
    expect(await sawToolResult("必须给出 routing")).not.toBeNull();
    fake.close();
  }, 30_000);
});

describe("ask_user candidate buttons and click routing (steward.md §3.3/§9.1, issue #7)", () => {
  it("a routing ask sends ≤3 candidate buttons + 新开一件事; the click routes back as user_reply_to and attaches without further confidence", async () => {
    const fake = await connectedMachine();
    const a = await ownerStub().dispatchForTest({ prompt: "修复登录页报错", repoRef: "repo-a", newTitle: "修复登录页报错" });
    const b = await ownerStub().dispatchForTest({ prompt: "登录页样式调整", repoRef: "repo-a", newTitle: "登录页样式调整" });
    if (a.kind !== "dispatched" || b.kind !== "dispatched") throw new Error("seeding failed");
    await waitRunsSettled();

    // The model cannot decide between the two login threads → ask with candidates.
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("ask_user", {
          question: "「登录那个」指哪件事？",
          candidates: [
            { threadId: a.threadId, label: "登录页报错" },
            { threadId: b.threadId, label: "登录页样式" },
          ],
        }),
      ], { stopReason: "toolUse" }),
    );
    await dm("登录那个再改改");
    await waitRunsSettled();
    await waitWhileOutboundPending();

    // The card: two candidate buttons + 新开一件事, each carrying only ask:<qid>:<idx>.
    const askCards = (await ownerStub().outboundRows(30)).filter(
      (r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).includes("指哪件事"),
    );
    expect(askCards).toHaveLength(1);
    const card = JSON.parse(askCards[0]!.payload as string) as { card?: { buttons?: Array<{ label?: string; action?: string }> } };
    const buttons = card.card?.buttons ?? [];
    expect(buttons.map((btn) => btn.label)).toEqual(["登录页报错", "登录页样式", "新开一件事"]);
    const pickFirst = buttons[0]!.action!;
    expect(pickFirst.startsWith("ask:")).toBe(true);
    const qid = pickFirst.split(":")[1]!;
    const question = (await ownerStub().debugSnapshot()).questions.find((q) => q.qid === qid);
    expect(question).toMatchObject({ status: "open" });

    // The user clicks the first candidate. The question closes, the click becomes a routed
    // user run, and the model's continuation dispatch attaches as EXPLICIT (no routing).
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再改改登录报错", repoRef: "repo-a", threadId: a.threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂到登录页报错那件事上。")]),
    );
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, pickFirst));
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    expect(String((cmd!.args as Record<string, unknown>).threadId)).toBe(a.threadId);
    await waitRunsSettled();

    const snap = await ownerStub().debugSnapshot();
    expect(snap.questions.find((q) => q.qid === qid)?.status).toBe("answered");
    const runs = (await llmState()).runs;
    const clickRun = runs.find((r) => r.operationId.startsWith("user:act:"));
    expect(clickRun?.routedThreadId).toBe(a.threadId);
    fake.close();
  }, 30_000);

  it("the 新开一件事 click submits an unrouted user run", async () => {
    await connectedMachine();
    await ownerStub().dispatchForTest({ prompt: "修复登录页报错", repoRef: "repo-a", newTitle: "修复登录页报错" });
    await waitRunsSettled();
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("ask_user", { question: "指哪件事？", candidates: [{ threadId: "t_missing", label: "x" }] }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好的，新开：把登录日志加上。")]),
    );
    await dm("登录那个再改改");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const askCards = (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).includes("指哪件事"));
    expect(askCards).toHaveLength(1);
    const card = JSON.parse(askCards[0]!.payload as string) as { card?: { buttons?: Array<{ action?: string }> } };
    const newButton = (card.card?.buttons ?? []).find((btn) => btn.action?.startsWith("asknew:"));
    expect(newButton).toBeTruthy();

    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, newButton!.action!));
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    const clickRun = runs.find((r) => r.operationId.startsWith("user:act:"));
    expect(clickRun).toMatchObject({ kind: "user", routedThreadId: null, status: "settled" });
    const inputs = (await llmState()).inputs;
    expect(inputs.some((i) => i.text.includes("新开一件事"))).toBe(true);
  }, 30_000);

  // Review #48 finding 4: an option click on a thread-scoped question is the answer to that
  // Thread's question — the run must route there (as a quote-reply to the same card already
  // does), or the follow-up attach hits the confidence gate for no reason.
  it("an option click on a thread-scoped ask routes the answer run to that thread — attach needs no routing", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "用哪个方案修？", options: ["方案A", "方案B"], threadId })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "按方案A修", repoRef: "repo-a", threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已按方案A续派。")]),
    );
    await dm("修吧");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const askCards = (await ownerStub().outboundRows(30)).filter(
      (r) => r.kind === "card" && r.status === "sent" && r.threadId === threadId && JSON.stringify(r.payload).includes("用哪个方案修"),
    );
    expect(askCards).toHaveLength(1);
    const card = JSON.parse(askCards[0]!.payload as string) as { card?: { buttons?: Array<{ action?: string }> } };
    const first = (card.card?.buttons ?? [])[0]!.action!;
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, first));
    const cmds = await fake.waitForCmds(2); // 1 = seeding, 2 = the click run's attach
    expect(cmds[1]!.kind).toBe("send"); // same-machine attach resumes (issue #8)
    expect(String((cmds[1]!.args as Record<string, unknown>).text)).toContain("按方案A修");
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    const clickRun = runs.find((r) => r.operationId.startsWith("user:act:"));
    expect(clickRun?.routedThreadId).toBe(threadId);
    fake.close();
  }, 30_000);

  it("a duplicate click on an answered question is a polite no-op, not a second run", async () => {
    await connectedMachine();
    await ownerStub().dispatchForTest({ prompt: "修复登录页报错", repoRef: "repo-a", newTitle: "修复登录页报错" });
    await waitRunsSettled();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "用哪个方案？", options: ["A", "B"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好。")]),
    );
    await dm("怎么办");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const askCards = (await ownerStub().outboundRows(30)).filter((r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).includes("用哪个方案"));
    const card = JSON.parse(askCards[0]!.payload as string) as { card?: { buttons?: Array<{ action?: string }> } };
    const first = (card.card?.buttons ?? [])[0]!.action!;
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, first));
    await waitRunsSettled();
    const runsAfterFirst = (await llmState()).runs.length;
    // Feishu would not redeliver the same eventId (sh_inbound dedup) — but a second, fresh
    // event clicking the same button of the now-answered question must also not start a run.
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, first));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitWhileOutboundPending();
    expect((await llmState()).runs.length).toBe(runsAfterFirst);
    const texts = (await ownerStub().outboundRows(30))
      .filter((r) => r.kind === "text" && r.status === "sent")
      .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
    expect(texts.some((t) => t.includes("已经回答过"))).toBe(true);
  }, 30_000);
});

describe("idle-attach is stated in the reply (steward.md §3.3, spec §5.2)", () => {
  it("attaching to a thread idle for days appends the reminder to the tool result", async () => {
    const fake = await connectedMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "老任务", repoRef: "repo-a", newTitle: "老任务" });
    if (outcome.kind !== "dispatched") throw new Error("dispatch failed");
    const workerId = outcome.workerId;
    fake.send({ t: "cmd_ack", re: (await fake.waitForCmds(1))[0]!.id, status: "accepted" });
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "完成" });
    await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
    await waitRunsSettled();
    // Age the thread far past the 3-day band (lastActivityAt is reducer-owned; the test
    // reaches in the same way resetLedgerState does).
    await ownerStub().ageThreadForTest(outcome.threadId, 10);
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "接着做第二段", repoRef: "repo-a", threadId: outcome.threadId, basis: "user_explicit", routing: { confidence: "high", reason: "用户点名接续" } })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已挂到之前那个「老任务」上。")]),
    );
    await dm("老任务接着做");
    await fake.waitForCmds(2);
    await waitRunsSettled();
    expect(await sawToolResult("已沉寂")).not.toBeNull();
    fake.close();
  }, 30_000);
});

describe("settle-time dispatch verification (spike-conclusions §2, issue #7)", () => {
  it("a reply claiming 已派发 with no dispatch queues the corrective ⟦verify⟧ run", async () => {
    await connectedMachine();
    await scriptModel(
      fauxAssistantMessage([fauxText("好的，已派发给 mac-studio，完成后我会汇报。")]),
      fauxAssistantMessage([fauxText("（更正：刚才没真派。）")]), // the verify run's own reply
    );
    await dm("帮我修个东西");
    await waitRunsSettled();
    await waitWhileOutboundPending();

    const runs = (await llmState()).runs;
    const original = runs.find((r) => r.kind === "user");
    expect(original?.resultText).toContain("已派发");
    const verify = runs.find((r) => r.kind === "verify");
    expect(verify).toMatchObject({ operationId: `verify:${original!.operationId}`, replyTo: original!.replyTo, status: "settled" });
    const inputs = (await llmState()).inputs;
    expect(inputs.some((i) => i.text.startsWith("⟦verify⟧") && i.text.includes("没有发生任何 start_worker"))).toBe(true);
  }, 30_000);

  it("a corrective dispatch inside the verify run is authorized by the original message", async () => {
    const fake = await connectedMachine();
    // Step 1 is the flawed reply; steps 2–3 are the verify run actually dispatching — no
    // provenanceRef is demanded (kind=verify is user-authorized via replyTo).
    await scriptModel(
      fauxAssistantMessage([fauxText("已派发给 mac-studio，完成后我会汇报。")]),
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("这次真的派出去了。")]),
    );
    await dm("帮我修个东西", "om_v2_msg");
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    const verify = runs.find((r) => r.kind === "verify");
    expect(verify?.status).toBe("settled");
    expect(verify?.dispatchCount).toBe(1); // the corrective dispatch was attributed here
    fake.close();
  }, 30_000);

  // Review #48 finding 2: a quote-routed run that lies about dispatching gets a verify run;
  // its corrective attach to the same thread must not hit the confidence gate — the verify
  // run inherits routedThreadId from the run it corrects. Only the newTitle path was covered
  // before.
  it("a quote-routed claim's verify run inherits routedThreadId — the corrective attach skips the gate", async () => {
    const { fake, threadId } = await oneIdleThread("修复登录页报错");
    const card = (await ownerStub().outboundRows(20)).find((r) => r.kind === "card" && r.status === "sent" && r.threadId === threadId);
    await scriptModel(
      // The flawed quote-routed reply: claims a dispatch that never happened.
      fauxAssistantMessage([fauxText("已派发给 mac-studio，完成后我会汇报。")]),
      // The verify run's corrective attach — NO routing argument.
      fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "再补几个单测", repoRef: "repo-a", threadId, basis: "user_reply_to" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("这次真的派出去了。")]),
    );
    await dm("再补几个单测", `om_vr_${crypto.randomUUID().slice(0, 6)}`, card!.providerMsgId!);
    const cmds = await fake.waitForCmds(2); // 1 = seeding, 2 = the corrective dispatch
    expect(cmds[1]!.kind).toBe("send"); // same-machine attach resumes (issue #8)
    expect(String((cmds[1]!.args as Record<string, unknown>).text)).toContain("再补几个单测");
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    const verify = runs.find((r) => r.kind === "verify");
    expect(verify?.routedThreadId).toBe(threadId);
    expect(verify?.dispatchCount).toBe(1);
    expect(await sawToolResult("必须给出 routing")).toBeNull();
    fake.close();
  }, 30_000);

  it("a reply with no dispatch claim settles quietly — no verify run", async () => {
    await connectedMachine();
    await scriptModel(fauxAssistantMessage([fauxText("我记下了，还没派。")]));
    await dm("帮我记个事");
    await waitRunsSettled();
    const runs = (await llmState()).runs;
    expect(runs.filter((r) => r.kind === "verify")).toHaveLength(0);
  }, 30_000);
});

describe("content markers never leak into steward inputs (wake-text.ts invariant, review #48 finding 5)", () => {
  it("a claimed dispatch containing ⟦…⟧ is marker-escaped inside the ⟦verify⟧ input", async () => {
    await connectedMachine();
    await scriptModel(
      // The claim text is model output and may itself contain markers — quoting it into the
      // verify wake unescaped would smuggle a fake system wake into that run's input.
      fauxAssistantMessage([fauxText("已派发；顺带一提 ⟦event⟧ 不是我说的话。")]),
      fauxAssistantMessage([fauxText("（更正：刚才没真派。）")]),
    );
    await dm("帮我修个东西");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const inputs = (await llmState()).inputs;
    const verifyInput = inputs.find((i) => i.text.startsWith("⟦verify⟧"));
    expect(verifyInput).toBeTruthy();
    expect(verifyInput!.text).toContain("〔event〕"); // escaped — never the real marker
    expect(verifyInput!.text).not.toContain("⟦event⟧");
  }, 30_000);

  it("ask-card click notes escape the question and the chosen label", async () => {
    await connectedMachine();
    await ownerStub().dispatchForTest({ prompt: "修复登录页报错", repoRef: "repo-a", newTitle: "修复登录页报错" });
    await waitRunsSettled();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "要执行⟦verify⟧吗？", options: ["执行", "先不"] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好的。")]),
    );
    await dm("怎么办");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    const askCards = (await ownerStub().outboundRows(30)).filter(
      (r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).includes("要执行"),
    );
    expect(askCards).toHaveLength(1);
    const card = JSON.parse(askCards[0]!.payload as string) as { card?: { buttons?: Array<{ action?: string }> } };
    const first = (card.card?.buttons ?? [])[0]!.action!;
    await postEvent(cardActionEvent(askCards[0]!.providerMsgId!, first));
    await waitRunsSettled();
    // The click's input: the note embeds the (escaped) question text, so find it by content.
    const inputs = (await llmState()).inputs;
    const clickInput = inputs.find((i) => i.text.includes("用户在提问卡片「要执行〔verify〕吗？」上选择了"));
    expect(clickInput).toBeTruthy();
    expect(clickInput!.text).toContain("〔verify〕"); // the question's markers were escaped
    expect(clickInput!.text).not.toContain("⟦verify⟧");
  }, 30_000);
});
