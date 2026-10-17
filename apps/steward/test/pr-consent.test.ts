// The PR consent gate (issue #21, spike-conclusions §2, connector-pi.md §7.3 rule 4):
// a done report on a write task with unpushed commits carries [同意]/[先不要]; approving
// sends the `pr_worker` command (push + gh pr create on the machine) and the PR URL lands
// back in the chat asynchronously; declining records the decision and does nothing else;
// failures (no gh / auth / push rejected) come back as a three-part failure card and the
// gate re-arms so the same button retries. Everything runs the production path — real
// webhook clicks, real reducer, real outbox — with the model scripted through faux.
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ShOutboundRow } from "../src/steward.ts";
import {
  configureAndBind,
  mockReset,
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
  await mockReset();
  await configureAndBind("ou_owner");
});

type SentCard = { id: string; payload: string; threadId: string | null; providerMsgId: string | null };

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(80);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

async function sentCards(): Promise<SentCard[]> {
  const rows = (await ownerStub().outboundRows(80)) as unknown as ShOutboundRow[];
  return rows.filter((r) => r.kind === "card" && r.status === "sent") as unknown as SentCard[];
}

function cardActionEvent(cardMsgId: string, action: string, eventId = `evt_card_${crypto.randomUUID().slice(0, 8)}`) {
  return {
    schema: "2.0",
    header: {
      event_id: eventId,
      event_type: "card.action.trigger",
      create_time: String(Date.now()),
      token: "verify-token",
      app_id: "cli_test_app",
    },
    event: {
      operator: { open_id: "ou_owner" },
      action: { value: { action } },
      context: { open_message_id: cardMsgId },
    },
  };
}

/** Every button of the card (consent buttons carry pr_ actions; 查看详情/打开 PR are URL buttons). */
function buttonsOf(card: SentCard): Array<{ label?: string; action?: string; url?: string }> {
  const parsed = JSON.parse(card.payload as string) as { card?: { elements?: Array<{ actions?: Array<Record<string, unknown>> }> } };
  return (parsed.card?.elements ?? []).flatMap((e) => e.actions ?? []).map((btn) => ({
    label: (btn.text as { content?: string } | undefined)?.content,
    action: (btn.value as { action?: string } | undefined)?.action,
    url: typeof btn.url === "string" ? btn.url : undefined,
  }));
}

/** Only the consent gate's [同意]/[先不要] — the details link is a URL button, not an action. */
function consentButtonsOf(card: SentCard) {
  return buttonsOf(card).filter((b) => b.action?.startsWith("pr_"));
}

/** Polls a sync-or-async getter until pred holds (events reduce asynchronously). */
async function waitFor<T>(get: () => T | Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached (${what}): ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface DoneRun {
  fake: FakeConnector;
  workerId: string;
  threadId: string;
  card: SentCard;
}

/** Dispatches a worker by hand, plays a done report with unpushed commits, waits for the
 *  deterministic done card (with its bookkeeping wake settled), and returns everything. */
async function doneReport(overrides: { git?: Record<string, unknown> } = {}): Promise<DoneRun> {
  const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
  await fake.connect();
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug", basis: "user_explicit" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("已派发。")]),
  );
  await postEvent({ schema: "2.0", header: { event_id: `evt_dm_${crypto.randomUUID().slice(0, 8)}`, event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "verify-token", app_id: "cli_test_app" }, event: { sender: { sender_id: { open_id: "ou_owner" } }, message: { message_id: `om_${crypto.randomUUID().slice(0, 8)}`, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "帮我把 repo-a 里那个登录 bug 修了" }) } } });
  const [startCmd] = await fake.waitForCmds(1);
  const workerId = String((startCmd!.args as Record<string, unknown>).workerId);
  const threadId = String((startCmd!.args as Record<string, unknown>).threadId);
  await waitRunsSettled();
  await waitWhileOutboundPending();

  fake.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
  fake.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, branch: "shepherd/login-1" } });
  await fake.emit("started", workerId, { sessionId: workerId, branch: "shepherd/login-1" });
  await fake.emit("report", workerId, {
    type: "report",
    status: "done",
    summary: "登录 bug 修好，测试通过",
    changes: ["auth/session.ts 补上过期刷新"],
    tests: { ran: true, passed: true },
    git: { branch: "shepherd/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 1, insertions: 5, deletions: 1, pushed: false, ...overrides.git },
  });
  await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
  // The done-bookkeeping wake (§5.3): script it so the run settles quietly.
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("update_thread", { threadId, summary: "登录 bug 已修复" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("记账完成。")]),
  );
  await waitRunsSettled();
  await waitWhileOutboundPending();
  const card = await waitFor(
    () => sentCards(),
    (cards) => cards.some((c) => JSON.stringify(c.payload).includes("登录 bug 修好")),
    "done card sent",
  ).then((cards) => cards.find((c) => JSON.stringify(c.payload).includes("登录 bug 修好"))!);
  return { fake, workerId, threadId, card };
}

describe("done cards carry the consent buttons (AC1)", () => {
  it("a write task with unpushed commits gets [同意]/[先不要]; the ask names branch and commits", async () => {
    const { card } = await doneReport();
    const buttons = consentButtonsOf(card);
    expect(buttons).toEqual([
      { label: "同意", action: "pr_approve", url: undefined },
      { label: "先不要", action: "pr_decline", url: undefined },
    ]);
    expect(card.payload).toContain("shepherd/login-1");
    expect(card.payload).toContain("还没推送");
  });

  it("no buttons once the branch is already pushed", async () => {
    const { card } = await doneReport({ git: { pushed: true } });
    expect(consentButtonsOf(card)).toEqual([]);
  });

  it("no buttons for a report with no commits ahead (dirty-only is not PR material)", async () => {
    const { card } = await doneReport({ git: { ahead: 0, dirty: 3 } });
    expect(consentButtonsOf(card)).toEqual([]);
  });
});

describe("[同意] → pr_worker → PR URL back in the chat (AC2)", () => {
  it("the click sends the command to the worker's machine and replies; pr_created pushes the URL card", async () => {
    const { fake, workerId, threadId, card } = await doneReport();
    const before = fake.cmds.length;
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve"));

    const prCmd = (await waitFor(
      () => fake.cmds.find((c) => c.kind === "pr_worker"),
      (c) => c !== undefined,
      "pr_worker command sent",
    ))!;
    expect(prCmd).toMatchObject({ workerId, notAfter: null });
    expect((prCmd.args as Record<string, unknown>).title).toBe("登录 bug 修好，测试通过");
    expect(String((prCmd.args as Record<string, unknown>).body)).toContain("auth/session.ts");
    expect(String(prCmd.id)).toMatch(/^pr:/);

    // Exactly one command went out, and the reply tells the user an answer is coming.
    expect(fake.cmds.length - before).toBe(1);
    await waitWhileOutboundPending();
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("正在推送") && t.includes("shepherd/login-1"))).toBe(true);

    // The consent row records the decision.
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.prConsent.some((c) => c.workerId === workerId && c.decision === "approved"),
      "consent recorded",
    );
    expect(snap.prConsent.find((c) => c.workerId === workerId)!.cmdId).toBe(prCmd.id);

    // The connector answers asynchronously: the URL lands as a deterministic card.
    fake.send({ t: "cmd_ack", re: prCmd.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: prCmd.id, ok: true, data: { url: "https://github.com/example/repo-a/pull/7" } });
    await fake.emit("pr_created", workerId, {
      type: "pr_created",
      cmdId: prCmd.id,
      url: "https://github.com/example/repo-a/pull/7",
      branch: "shepherd/login-1",
    });
    await waitWhileOutboundPending();
    const prCard = await waitFor(
      () => sentCards(),
      (cards) => cards.some((c) => JSON.stringify(c.payload).includes("pull/7")),
      "pr_created card sent",
    ).then((cards) => cards.find((c) => JSON.stringify(c.payload).includes("pull/7"))!);
    expect(prCard.threadId).toBe(threadId);
    const buttons = buttonsOf(prCard);
    expect(buttons).toContainEqual({ label: "打开 PR", action: undefined, url: "https://github.com/example/repo-a/pull/7" });
    expect(JSON.stringify(prCard.payload)).toContain("PR 已创建");

    // The URL is on the consent row, so a repeated click answers honestly (no second PR).
    const settled = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.prConsent.some((c) => c.workerId === workerId && c.url === "https://github.com/example/repo-a/pull/7"),
      "url recorded on consent row",
    );
    expect(settled.prConsent.find((c) => c.workerId === workerId)!.failure).toBeNull();
  });

  it("a second click while in flight answers honestly and sends nothing new", async () => {
    const { fake, card } = await doneReport();
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve"));
    await waitFor(() => fake.cmds, (c) => c.some((x) => x.kind === "pr_worker"), "first pr_worker");
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve", "evt_card_second"));
    await waitWhileOutboundPending();
    expect(fake.cmds.filter((c) => c.kind === "pr_worker")).toHaveLength(1);
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("正在推送并创建 PR，稍等结果"))).toBe(true);
  });

  it("a click on a card whose report is gone (stale outbound id) is told so, nothing runs", async () => {
    const { fake } = await doneReport();
    await postEvent(cardActionEvent("om_unknown_card", "pr_approve"));
    await waitWhileOutboundPending();
    expect(fake.cmds.filter((c) => c.kind === "pr_worker")).toHaveLength(0);
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("已经失效"))).toBe(true);
  });
});

describe("[先不要] records the decision and does nothing else (AC3)", () => {
  it("no command is sent; the decision is on the consent row and the timeline", async () => {
    const { fake, workerId, threadId, card } = await doneReport();
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_decline"));
    await waitWhileOutboundPending();
    expect(fake.cmds.filter((c) => c.kind === "pr_worker")).toHaveLength(0);
    const texts = await sentTexts();
    expect(texts.some((t) => t.includes("先不推送"))).toBe(true);
    const snap = await ownerStub().debugSnapshot();
    const consent = snap.prConsent.find((c) => c.workerId === workerId);
    expect(consent).toMatchObject({ decision: "declined", url: null, failure: null, cmdId: null });
    expect(snap.threads.find((t) => t.threadId === threadId)!.timeline.some((e) => e.text.includes("先不推送/创建 PR"))).toBe(true);
  });
});

describe("failures come back as a three-part failure report (AC4)", () => {
  it.each([
    ["gh_missing", "the GitHub CLI (`gh`) is not installed on this machine", "没有安装 GitHub CLI"],
    ["auth", "gh is not authenticated", "gh auth login"],
    ["push", "! [remote rejected] shepherd/login-1 (pre-receive hook declined)", "推送分支被拒绝"],
  ])("%s → red failure card whose needs-you names the fix and the retry", async (stage, message, needle) => {
    const { fake, workerId, threadId, card } = await doneReport();
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve"));
    const prCmd = (await waitFor(
      () => fake.cmds.some((x) => x.kind === "pr_worker"),
      (v) => v,
      "pr_worker sent",
    ))
      ? fake.cmds.find((x) => x.kind === "pr_worker")!
      : undefined!;
    // The connector's failure shape: the event first, then the failed command result.
    await fake.emit("pr_failed", workerId, { type: "pr_failed", cmdId: prCmd.id, stage, message });
    fake.send({ t: "cmd_ack", re: prCmd.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: prCmd.id, ok: false, error: { code: stage, message } });

    const failCard = await waitFor(
      () => sentCards(),
      (cards) => cards.some((c) => JSON.stringify(c.payload).includes("推送 / 创建 PR 失败")),
      "failure card sent",
    ).then((cards) => cards.find((c) => JSON.stringify(c.payload).includes("推送 / 创建 PR 失败"))!);
    const payload = JSON.stringify(failCard.payload);
    expect(payload).toContain("red"); // three-part failure tone
    expect(payload).toContain(needle);
    expect(payload).toContain("再点一次「同意」"); // the retry contract
    expect(failCard.threadId).toBe(threadId);

    // Exactly ONE failure card although both the event and the failed cmd_result reported.
    await waitWhileOutboundPending();
    const failureCards = (await sentCards()).filter((c) => JSON.stringify(c.payload).includes("推送 / 创建 PR 失败"));
    expect(failureCards).toHaveLength(1);

    // The gate re-arms: the consent row carries the failure, and a new [同意] retries with a
    // fresh command id.
    const snap = await waitFor(
      () => ownerStub().debugSnapshot(),
      (s) => s.prConsent.some((c) => c.workerId === workerId && c.failure !== null),
      "failure recorded",
    );
    expect(snap.prConsent.find((c) => c.workerId === workerId)!.failure).toContain(message.slice(0, 20));

    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve", "evt_card_retry"));
    const retry = await waitFor(
      () => fake.cmds.filter((c) => c.kind === "pr_worker").length,
      (n) => n >= 2,
      "retry command sent",
    ).then(() => fake.cmds.filter((c) => c.kind === "pr_worker"));
    expect(retry[1]!.id).not.toBe(prCmd.id);
    expect(String(retry[1]!.id)).toMatch(/:2$/);
  });

  it("a pr_worker the connector rejects at the door (no event) still reaches the owner", async () => {
    const { fake, card } = await doneReport();
    await postEvent(cardActionEvent(card.providerMsgId!, "pr_approve"));
    const prCmd = (await waitFor(
      () => fake.cmds.some((x) => x.kind === "pr_worker"),
      (v) => v,
      "pr_worker sent",
    ))
      ? fake.cmds.find((x) => x.kind === "pr_worker")!
      : undefined!;
    fake.send({ t: "cmd_ack", re: prCmd.id, status: "rejected", code: "no_worktree" });
    await waitWhileOutboundPending();
    const failureCards = await waitFor(
      () => sentCards(),
      (cards) => cards.some((c) => JSON.stringify(c.payload).includes("推送 / 创建 PR 失败")),
      "failure card sent",
    );
    expect(failureCards.length).toBeGreaterThan(0);
    void fake;
  });
});

describe("the notify row id is the callback's routing key (§3.1, issue #21)", () => {
  it("the done card's outbound id is notify:report:<workerId>:<seq>", async () => {
    const { workerId, card } = await doneReport();
    expect(card.id).toMatch(new RegExp(`^notify:report:${workerId}:\\d+$`));
  });
});
