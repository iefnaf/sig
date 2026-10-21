// Report merging and push policy (issue #11, spec §7.5–7.6, steward.md §6.4–6.5):
// - `urgency: push` goes out at once; anything tied to `waiting_you` is always push;
// - `quiet` notifications merge per channel over the 60 s window — several completions
//   become ONE short report that keeps each Thread's three parts;
// - viewing a Thread (web open, reply, button click) clears unread.
import { runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ShOutboundRow, Steward } from "../src/steward.ts";
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
  webLogin,
  type FakeConnector,
  type FakeWorkerRun,
} from "./helpers.ts";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

// Delivery passes serialize on a chain inside the DO; awaiting an explicit pass also waits
// out any void-fired one (the outbound-queue suite's settleDelivery trick).
async function settleDelivery(): Promise<void> {
  await ownerStub().deliverOutbound();
}

async function execSql(fn: (sql: Sql) => void): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    fn(sql);
  });
}

/** Time-travels the merge window: every still-queued quiet row becomes due NOW. */
async function forceQuietDue(): Promise<void> {
  const now = Date.now();
  await execSql((sql) => sql`UPDATE sh_outbound SET nextAttemptAt = 1 WHERE status = 'queued' AND urgency = 'quiet' AND nextAttemptAt > ${now}`);
}

/** Polls until `count` queued quiet rows exist (drainNotifications is void-chained). */
async function waitForQuietRows(count: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ownerStub().outboundRows(50);
    if (rows.filter((r) => r.urgency === "quiet" && r.status === "queued").length >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${rows.filter((r) => r.urgency === "quiet").length}/${count} quiet rows`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

import { mergeQuietOutbound, sectionFromPayload, type QuietSection } from "../src/report-template.ts";

type SentRow = { id: string; providerMsgId: string | null; kind: string; payload: string };

/** Groups ALL sent rows by providerMsgId (a merged quiet group shares one id across text and
 *  card members) and renders each group as ONE message — exactly GET /api/messages in
 *  production (ADR-0003). */
async function sentMessages(): Promise<Array<{ id: string; kind: "text" | "card"; body: string }>> {
  const rows = (await ownerStub().outboundRows(100)).filter((r) => r.status === "sent") as unknown as SentRow[];
  const groups = new Map<string, SentRow[]>();
  for (const row of rows) {
    const key = row.providerMsgId ?? row.id;
    const members = groups.get(key);
    if (members) members.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()].map(([id, members]) => {
    if (members.length === 1) return { id, kind: members[0]!.kind as "text" | "card", body: String(members[0]!.payload) };
    const sections = members
      .map((row) => sectionFromPayload(JSON.parse(row.payload) as { text?: string; card?: unknown; part?: QuietSection }))
      .filter((s): s is QuietSection => s !== null);
    // Mixed groups render as the merged report message (the old "card" shape); pure-text
    // groups merge into one text.
    const hasReport = sections.some((s) => s.kind === "report");
    return { id, kind: hasReport ? ("card" as const) : ("text" as const), body: JSON.stringify({ text: mergeQuietOutbound(sections).text }) };
  });
}

async function sentMessagesByKind(kind: "text" | "card"): Promise<Array<{ id: string; body: string }>> {
  return (await sentMessages()).filter((m) => m.kind === kind).map((m) => ({ id: m.id, body: m.body }));
}

async function sentCardBodies(): Promise<Array<{ body: string }>> {
  return (await sentMessagesByKind("card")).map((m) => ({ body: m.body }));
}

/** Sent messages of one kind, payload strings (ADR-0003: rows ARE the messages). */
async function sentPayloads(kind: "text" | "card"): Promise<string[]> {
  return (await sentMessagesByKind(kind)).map((m) => m.body);
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  // The production window: these tests are exactly about holding and merging.
  await ownerStub().setQuietMergeForTest(60_000);
});

describe("push vs quiet: what buzzes the phone (spec §7.6)", () => {
  it("push sends immediately; quiet holds for the merge window", async () => {
    const { id: push } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", text: "需要你拍板", urgency: "push" });
    await settleDelivery();
    expect((await ownerStub().outboundRow(push))?.status).toBe("sent");

    const { id: quiet } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", text: "记账完成", urgency: "quiet" });
    await settleDelivery();
    // Held: nothing on the wire, the row waits out its window. (mockCalls DRAINS the log,
    // so each read counts only what happened since the previous one.)
    expect((await ownerStub().outboundRow(quiet))?.status).toBe("queued");
    expect((await sentPayloads("text")).some((b) => b.includes("需要你拍板"))).toBe(true); // only the push landed

    // Once the window closes, the quiet row goes out on its own.
    await forceQuietDue();
    await settleDelivery();
    const row = await ownerStub().outboundRow(quiet);
    expect(row?.status).toBe("sent");
    expect(String(row?.payload)).toContain("记账完成");
  });

  it("anything tied to waiting_you is always push, whatever the model asked for", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const dispatched = await ownerStub().dispatchForTest({ prompt: "查构建", repoRef: "repo-a", newTitle: "查构建" });
    if (dispatched.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(dispatched)}`);
    const [cmd] = await fake.waitForCmds(1);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { sessionId: dispatched.workerId, branch: "sig/t-1" } });
    await fake.emit("started", dispatched.workerId, { sessionId: dispatched.workerId, branch: "sig/t-1" });
    // A blocked report opens a question; settled with nothing running, the Thread is
    // waiting_you — the exact state whose notifications must never sit in a merge window.
    await fake.emit("report", dispatched.workerId, { type: "report", status: "blocked", summary: "被挡住了", question: "用哪个分支？" });
    await fake.emit("settled", dispatched.workerId, { type: "settled", outcome: "reported" });
    let qid: string | undefined;
    let threadId: string | undefined;
    for (let i = 0; i < 200 && (qid === undefined || threadId === undefined); i++) {
      const thread = (await ownerStub().debugSnapshot()).threads[0];
      qid = thread?.questions[0]?.qid;
      threadId = thread?.threadId;
      if (qid === undefined || threadId === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (qid === undefined || threadId === undefined) throw new Error("blocked report never opened a question");
    // Settled with an open question and nothing running: the Thread is waiting_you — the
    // exact state whose notifications must never sit in a merge window.
    for (let i = 0; i < 200; i++) {
      if ((await ownerStub().debugSnapshot()).threads[0]?.state === "waiting_you") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await ownerStub().debugSnapshot()).threads[0]!.state).toBe("waiting_you");

    // The event run classifies the question with notify_user — NO urgency given (quiet by
    // default), but the question binding makes it push: it must reach the user at once.
    await scriptModel(
      fauxAssistantMessage(
        [fauxToolCall("notify_user", { conclusion: "分支问题需要你定", did: ["已核对分支清单"], questionId: qid, threadId })],
        { stopReason: "toolUse" },
      ),
    );
    await waitRunsSettled();
    // notify_user with a question binding closes the question (the notify reached the
    // user); the Thread settles back to idle — but the NOTIFICATION itself was push.

    // NO window forcing in this test (unlike waitWhileOutboundPending): a row that turns
    // "sent" on its own proves the notify went out immediately as push.
    const deadline = Date.now() + 5_000;
    let notify: ShOutboundRow | undefined;
    for (;;) {
      notify = (await ownerStub().outboundRows(30)).find(
        (r) => JSON.stringify(r.payload).includes("分支问题需要你定"),
      );
      if (notify?.status === "sent" || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(notify).toBeDefined();
    expect(notify!.status).toBe("sent");
    expect(notify!.urgency).toBe("push");
    fake.close();
  }, 30_000);
});

describe("quiet merging: one window, one message (steward.md §6.4)", () => {
  it("quiet arrivals inside one window merge into one send; a later arrival opens its own window", async () => {
    const loginSection = { kind: "report" as const, tone: "success" as const, conclusion: "登录修好", did: ["改了登录的两处"], threadTitle: "登录" };
    const refundSection = { kind: "report" as const, tone: "success" as const, conclusion: "退款修好", did: ["改了退款的两处"], threadTitle: "退款" };
    const { id: a } = await ownerStub().enqueueOutbound({ kind: "card", to: "ou_owner", urgency: "quiet", threadId: "t_a", card: { header: { title: { content: "登录修好" } } }, part: loginSection });
    const { id: b } = await ownerStub().enqueueOutbound({ kind: "card", to: "ou_owner", urgency: "quiet", threadId: "t_b", card: { header: { title: { content: "退款修好" } } }, part: refundSection });
    const { id: c } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "quiet", text: "两条记忆整理完毕" });

    await forceQuietDue();
    await settleDelivery();

    // ONE wire send for the whole window, carrying every section.
    const cards = await sentCardBodies();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body).toContain("登录修好");
    expect(cards[0]!.body).toContain("退款修好");
    expect(cards[0]!.body).toContain("两条记忆整理完毕");
    expect(cards[0]!.body).toContain("合并汇报：2 件事");

    // Every merged row is settled against the SAME provider message: one card, one quote
    // target, every bound Thread visible to the reply router.
    const rows = await ownerStub().outboundRows(30);
    const merged = rows.filter((r) => [a, b, c].includes(r.id));
    expect(merged).toHaveLength(3);
    expect(merged.every((r) => r.status === "sent")).toBe(true);
    expect(new Set(merged.map((r) => r.providerMsgId)).size).toBe(1);

    // A quiet row arriving AFTER the window sends on its own — never glued to a closed one.
    const { id: d } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "quiet", text: "稍后的记账" });
    await settleDelivery();
    expect((await ownerStub().outboundRow(d))?.status).toBe("queued");
    await forceQuietDue();
    await settleDelivery();
    const row = await ownerStub().outboundRow(d);
    expect(row?.status).toBe("sent");
    const texts = await sentPayloads("text");
    expect(texts.some((body) => body.includes("稍后的记账"))).toBe(true);
  });

  it("done reports across Threads merge into one card that keeps each Thread's three parts", async () => {
    // pushed: ordinary completions — an unpushed write completion would carry #21's consent
    // ask and push instead of merging (that behavior has its own suite in pr-consent.test.ts).
    const runA: FakeWorkerRun = {
      status: "done",
      summary: "登录 bug 修好，测试通过",
      changes: ["auth/session.ts 补上 token 刷新"],
      tests: { ran: true, passed: true },
      branch: "sig/login-1",
      pushed: true,
    };
    const runB: FakeWorkerRun = {
      status: "done",
      summary: "退款幂等补齐，回归通过",
      changes: ["payment/refund.ts 加幂等键"],
      tests: { ran: true, passed: true },
      branch: "sig/refund-1",
      next: "跑一遍全量回归",
      pushed: true,
    };
    const fake = await pairFakeConnector("mac-studio", { run: runA, autorun: true });
    await fake.connect();
    fake.queueRun(runB);
    const first = await ownerStub().dispatchForTest({ prompt: "修登录 bug", repoRef: "repo-a", newTitle: "修登录 bug" });
    if (first.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(first)}`);
    const second = await ownerStub().dispatchForTest({ prompt: "补退款幂等", repoRef: "repo-a", newTitle: "补退款幂等" });
    if (second.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(second)}`);

    // Both completions land close together — two quiet done-report rows in ONE window.
    await scriptModel(fauxAssistantMessage([fauxText("记账。")]));
    await waitForQuietRows(2);
    await forceQuietDue();
    await settleDelivery();
    await waitRunsSettled();

    const cards = await sentCardBodies();
    const merged = cards.find((body) => body.body.includes("合并汇报"));
    expect(merged).toBeDefined();
    // Each Thread keeps its three parts: conclusion, did, and (when present) needs-you.
    expect(merged!.body).toContain("登录 bug 修好，测试通过");
    expect(merged!.body).toContain("auth/session.ts 补上 token 刷新");
    expect(merged!.body).toContain("退款幂等补齐，回归通过");
    expect(merged!.body).toContain("payment/refund.ts 加幂等键");
    expect(merged!.body).toContain("建议下一步：跑一遍全量回归");
    expect(merged!.body).toContain("详情：https://example.com/link/"); // per-thread timeline links ride along

    // Exactly one merged card went out for the two reports.
    expect(cards.filter((c) => c.body.includes("合并汇报"))).toHaveLength(1);

    // Unread marks the news on BOTH threads; the rows share one providerMsgId.
    const snap = await ownerStub().debugSnapshot();
    const login = snap.threads.find((t) => t.title === "修登录 bug")!;
    const refund = snap.threads.find((t) => t.title === "补退款幂等")!;
    expect(login.unread).toBe(true);
    expect(refund.unread).toBe(true);
    const rows = await ownerStub().outboundRows(30);
    const mergedRows = rows.filter((r) => r.kind === "card" && r.urgency === "quiet" && r.status === "sent");
    expect(mergedRows).toHaveLength(2);
    expect(new Set(mergedRows.map((r) => r.providerMsgId)).size).toBe(1);
    fake.close();

    // Replying to the merged card: both Threads count as seen (§6.5), and the reply routes
    // to the CONVERSATION — with several matters on one card, only the steward can tell
    // which one "都推了吧" means.
    await scriptModel(fauxAssistantMessage([fauxText("好的。")]));
    await postEvent(messageEvent({ msgId: "om_merged_reply", text: "都推了吧", parentId: mergedRows[0]!.providerMsgId! }));
    await waitRunsSettled();
    const after = await ownerStub().debugSnapshot();
    expect(after.threads.find((t) => t.title === "修登录 bug")!.unread).toBe(false);
    expect(after.threads.find((t) => t.title === "补退款幂等")!.unread).toBe(false);
    const state = await llmState();
    const replyRun = state.runs.find((r) => r.operationId === "user:om_merged_reply");
    expect(replyRun?.routedThreadId).toBeNull();
    const requests = await modelRequests();
    const mergedNote = requests.find((r) => (r.userText ?? "").includes("都推了吧"));
    expect(mergedNote?.userText).toContain("合并汇报"); // the note explains the multi-thread card
  }, 30_000);
});

describe("viewing a Thread clears unread (steward.md §6.5)", () => {
  /** One idle thread with a forced-sent done card (quiet, window time-travelled). */
  async function threadWithUnreadCard(): Promise<{ fake: FakeConnector; threadId: string; cardMsgId: string }> {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "登录 bug 修好，测试通过", changes: ["auth/session.ts 补上 token 刷新"], pushed: true },
    });
    await fake.connect();
    const dispatched = await ownerStub().dispatchForTest({ prompt: "修登录 bug", repoRef: "repo-a", newTitle: "修登录 bug" });
    if (dispatched.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(dispatched)}`);
    await scriptModel(fauxAssistantMessage([fauxText("记账。")]));
    await waitForQuietRows(1);
    await forceQuietDue();
    await settleDelivery();
    await waitRunsSettled();
    const rows = await ownerStub().outboundRows(30);
    const card = rows.find((r) => r.kind === "card" && r.status === "sent" && r.providerMsgId);
    expect(card).toBeDefined();
    return { fake, threadId: dispatched.threadId, cardMsgId: card!.providerMsgId! };
  }

  it("opening the Thread in the workspace clears unread", async () => {
    const { fake, threadId } = await threadWithUnreadCard();
    expect((await ownerStub().debugSnapshot()).threads[0]!.unread).toBe(true);
    const cookie = await webLogin();
    // The deep link loads the workspace with the Thread selected; the page then tells the
    // server the owner is looking at it (the read endpoint) — loading alone is not reading.
    const page = await SELF.fetch(`https://example.com/app/threads/${threadId}`, { headers: { cookie } });
    expect(page.status).toBe(200);
    await expectUnread(threadId, true);
    const { csrf } = (await (await SELF.fetch("https://example.com/app/api/workspace", { headers: { cookie } })).json()) as { csrf: string };
    const read = await SELF.fetch(`https://example.com/app/api/threads/${threadId}/read`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: "{}",
    });
    expect(read.status).toBe(200);
    await expectUnread(threadId, false);
    fake.close();
  }, 30_000);

  it("replying to the Thread's report clears unread", async () => {
    const { fake, threadId, cardMsgId } = await threadWithUnreadCard();
    await scriptModel(fauxAssistantMessage([fauxText("知道了。")]));
    const res = await postEvent(messageEvent({ msgId: "om_read_reply", text: "知道了", parentId: cardMsgId }));
    expect(res.status).toBe(200);
    await waitRunsSettled();
    await expectUnread(threadId, false);
    fake.close();
  }, 30_000);

  it("a card button click clears unread (a click is both read and a reply)", async () => {
    const { fake, threadId } = await threadWithUnreadCard();
    // An ask_user card whose candidate button points at the Thread: the tap routes there
    // and counts as read (§6.5) — the click IS the reply. (The ask ends the turn, so the
    // script is the one tool-call step, exactly like llm-reply's ask tests.)
    await scriptModel(
      fauxAssistantMessage([
        fauxToolCall("ask_user", { question: "接着先做哪件？", candidates: [{ label: "继续修登录", threadId }] }),
      ], { stopReason: "toolUse" }),
    );
    await postEvent(messageEvent({ msgId: "om_ask_which", text: "下一步？" }));
    await waitRunsSettled();
    await waitWhileOutboundPending();
    await expectUnread(threadId, true);

    const rows = await ownerStub().outboundRows(30);
    const askCard = rows.find((r) => r.kind === "card" && r.status === "sent" && JSON.stringify(r.payload).includes("接着先做哪件"));
    expect(askCard).toBeDefined();
    const card = JSON.parse(askCard!.payload as string) as { card: { buttons?: Array<{ action?: string }> } };
    const action = (card.card.buttons ?? []).find((btn) => btn.action?.startsWith("ask:"))!.action!;

    await postEvent({ cardMsgId: askCard!.providerMsgId!, action });
    await waitRunsSettled();
    await expectUnread(threadId, false);
    fake.close();
  }, 30_000);
});

// ---- small local helpers -------------------------------------------------------------------------

async function expectUnread(threadId: string, unread: boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const thread = (await ownerStub().debugSnapshot()).threads.find((t) => t.threadId === threadId);
    if (thread?.unread === unread) return;
    if (Date.now() > deadline) throw new Error(`thread ${threadId} unread !== ${unread}: ${JSON.stringify(thread)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
