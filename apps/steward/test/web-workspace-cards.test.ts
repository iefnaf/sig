// Every kind of decision Pip can hand the owner, pressed from the workspace instead of Feishu
// (ADR-0004): PR consent, an offline machine, a routine suggestion, a memory suggestion, and a
// question a worker asked. The tap goes through the same handlers as a Feishu callback, the
// acknowledgement comes back on the web, and Feishu hears nothing about it.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Ledger } from "../src/ledger.ts";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  llmState,
  messageEvent,
  ownerStub,
  pairFakeConnector,
  postEvent,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
} from "./helpers.ts";
import type { FakeConnector } from "./helpers.ts";

const BASE = "https://example.com";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

interface Item {
  id: string;
  kind: string;
  threadId: string | null;
  buttons: Array<{ label: string; action?: string }>;
}

async function browser() {
  const cookie = await webLogin();
  const get = async () => (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json() as Promise<{ csrf: string; attention: Item[]; messages: Array<{ id: string; open?: boolean }> }>;
  const { csrf } = await get();
  const post = (path: string, body: unknown) =>
    SELF.fetch(`${BASE}/app/api/${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
  return { get, post };
}

async function webTexts(): Promise<string[]> {
  return (await ownerStub().outboundRows(100))
    .filter((row) => row.channel === "local" && row.kind === "text")
    .map((row) => (JSON.parse(row.payload as string) as { text?: string }).text ?? "");
}

async function waitFor<T>(get: () => T | Promise<T>, pred: (value: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached (${what}): ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A write task that finished with unpushed commits: its done card carries the PR consent buttons. */
async function doneReport(): Promise<{ fake: FakeConnector; workerId: string; threadId: string; cardId: string }> {
  const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
  await fake.connect();
  await scriptModel(
    fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "fix the login bug", repoRef: "repo-a", newTitle: "Fix the login bug", basis: "user_explicit" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Started.")]),
  );
  await postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text: "please fix the login bug in repo-a" }));
  const [startCmd] = await fake.waitForCmds(1);
  const workerId = String((startCmd!.args as Record<string, unknown>).workerId);
  const threadId = String((startCmd!.args as Record<string, unknown>).threadId);
  await waitRunsSettled();
  await waitWhileOutboundPending();
  fake.send({ t: "cmd_ack", re: startCmd!.id, status: "accepted" });
  fake.send({ t: "cmd_result", re: startCmd!.id, ok: true, data: { sessionId: workerId, branch: "sig/login-1" } });
  await fake.emit("started", workerId, { sessionId: workerId, branch: "sig/login-1" });
  await fake.emit("report", workerId, {
    type: "report", status: "done", summary: "Login bug fixed, tests pass", changes: ["auth/session.ts waits for recovery"], tests: { ran: true, passed: true },
    git: { branch: "sig/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 1, insertions: 5, deletions: 1, pushed: false },
  });
  await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
  await scriptModel(fauxAssistantMessage([fauxToolCall("update_thread", { threadId, summary: "Fixed." })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("Recorded.")]));
  await waitRunsSettled();
  await waitWhileOutboundPending();
  const card = (await ownerStub().outboundRows(100)).find((row) => row.kind === "card" && row.id.startsWith(`notify:report:${workerId}:`));
  if (!card) throw new Error("the done card was never sent");
  return { fake, workerId, threadId, cardId: card.id };
}

describe("pull request consent", () => {
  it("approving on the web sends the PR command, answers on the web, and settles the card", async () => {
    const { fake, workerId, cardId } = await doneReport();
    const { get, post } = await browser();
    const item = (await get()).attention.find((entry) => entry.id === cardId);
    expect(item).toMatchObject({ kind: "consent" });
    expect(item!.buttons.map((button) => button.action)).toEqual(["pr_approve", "pr_decline"]);

    const before = fake.cmds.length;
    expect((await post("actions", { id: "approve-001", cardId, action: "pr_approve" })).status).toBe(202);
    const command = (await waitFor(() => fake.cmds.find((cmd) => cmd.kind === "pr_worker"), (cmd) => cmd !== undefined, "pr_worker command"))!;
    expect(command).toMatchObject({ workerId });
    expect(fake.cmds.length - before).toBe(1);
    expect((await webTexts()).some((text) => text.includes("正在推送") && text.includes("sig/login-1"))).toBe(true);

    const after = await get();
    expect(after.attention.find((entry) => entry.id === cardId)).toBeUndefined();
    expect(after.messages.find((message) => message.id === cardId)).toMatchObject({ open: false });
    expect((await post("actions", { id: "approve-002", cardId, action: "pr_approve" })).status).toBe(409);
    expect(fake.cmds.filter((cmd) => cmd.kind === "pr_worker")).toHaveLength(1);
    fake.close();
  }, 45_000);

  it("declining records the decision and sends nothing to the machine", async () => {
    const { fake, cardId } = await doneReport();
    const { get, post } = await browser();
    expect((await post("actions", { id: "decline-001", cardId, action: "pr_decline" })).status).toBe(202);
    await waitFor(() => webTexts(), (texts) => texts.some((text) => text.includes("先不推送")), "decline acknowledged on the web");
    expect(fake.cmds.filter((cmd) => cmd.kind === "pr_worker")).toHaveLength(0);
    expect((await ownerStub().debugSnapshot()).prConsent).toEqual([expect.objectContaining({ decision: "declined" })]);
    expect((await get()).attention.find((entry) => entry.id === cardId)).toBeUndefined();
    fake.close();
  }, 45_000);
});

describe("an offline machine", () => {
  it("cancelling on the web withdraws the held dispatch and says so on the web", async () => {
    const studio = await pairFakeConnector("studio-device", { run: null, machineName: "mac-studio", repos: [{ repoId: "/srv/repo-a", name: "repo-a" }] });
    await studio.connect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    studio.close();
    await waitFor(() => ownerStub().debugSnapshot(), (snap) => snap.machines.some((m) => m.name === "mac-studio" && !m.online), "mac-studio offline");
    const outcome = await ownerStub().dispatchForTest({ prompt: "fix it", repoRef: "repo-a", newTitle: "Fix it", machineHint: "mac-studio" });
    expect(outcome).toMatchObject({ kind: "asked_offline" });
    await waitWhileOutboundPending();

    const { get, post } = await browser();
    const item = (await get()).attention.find((entry) => entry.kind === "offline");
    expect(item).toBeDefined();
    expect(item!.buttons.map((button) => button.action)).toEqual(["wait_online", "cancel"]);

    expect((await post("actions", { id: "cancel-0001", cardId: item!.id, action: "cancel" })).status).toBe(202);
    await waitFor(() => webTexts(), (texts) => texts.some((text) => text.includes("已取消")), "cancel acknowledged on the web");
    expect((await get()).attention.find((entry) => entry.id === item!.id)).toBeUndefined();
    expect((await post("actions", { id: "cancel-0002", cardId: item!.id, action: "cancel" })).status).toBe(409);
  }, 45_000);
});

describe("a routine suggestion", () => {
  it("made during a web conversation appears on the web, and accepting it creates the routine", async () => {
    const { get, post } = await browser();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("suggest_routine", { instruction: "Check dependencies every Friday", kind: "instruction", cron: "0 17 * * 5" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Suggested a routine.")]),
    );
    expect((await post("messages", { id: "suggest-001", text: "I keep forgetting to check dependencies" })).status).toBe(202);
    await waitRunsSettled();
    const offer = (await get()).attention.find((entry) => entry.kind === "offer");
    expect(offer).toBeDefined();
    expect((await ownerStub().outboundRows(100)).find((row) => row.id === offer!.id)).toMatchObject({ channel: "local" });

    expect((await post("actions", { id: "accept-0001", cardId: offer!.id, action: "routine_accept" })).status).toBe(202);
    expect((await ownerStub().debugSnapshot()).routines).toEqual([expect.objectContaining({ instruction: "Check dependencies every Friday", status: "active" })]);
    expect((await webTexts()).some((text) => text.includes("已创建例行任务"))).toBe(true);
    expect((await get()).attention).toEqual([]);
  }, 45_000);
});

describe("a memory suggestion", () => {
  it("is archived from the web, and the note really moves out of the resident layer", async () => {
    const noteId = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      const done = ledger.notes.commit({ text: "Keep reports short", kind: "preference", source: "user_said", layer: "resident" });
      if (!done.ok) throw new Error(done.message);
      ledger.notes.drainPendingForReply();
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE sh_note SET lastUsedAt = ${Date.now() - 95 * 86_400_000} WHERE noteId = ${done.note.noteId}`;
      return done.note.noteId;
    });
    await ownerStub().notesMaintenance();
    await waitFor(async () => { await waitWhileOutboundPending(); return ownerStub().outboundRows(60); }, (rows) => rows.some((row) => row.id.startsWith(`noteask:${noteId}:`) && row.status === "sent"), "the suggestion card");

    const { get, post } = await browser();
    const item = (await get()).attention.find((entry) => entry.kind === "memory");
    expect(item).toBeDefined();
    expect(item!.buttons.map((button) => button.action)).toEqual(["note_archive", "note_keep"]);
    expect((await post("actions", { id: "archive-001", cardId: item!.id, action: "note_archive" })).status).toBe(202);
    expect((await ownerStub().debugSnapshot()).notes.find((note) => note.noteId === noteId)?.layer).toBe("archive");
    expect((await webTexts()).some((text) => text.includes("已归档"))).toBe(true);
    expect((await get()).attention.find((entry) => entry.kind === "memory")).toBeUndefined();
  }, 45_000);
});

describe("a question a worker asked", () => {
  it("is answered from the composer: the answer goes to the worker, not to the model", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const dispatched = await ownerStub().dispatchForTest({ prompt: "migrate the schema", repoRef: "repo-a", newTitle: "Migrate the schema" });
    if (dispatched.kind !== "dispatched") throw new Error(JSON.stringify(dispatched));
    fake.send({ t: "cmd_ack", re: (await fake.waitForCmds(1))[0]!.id, status: "accepted" });
    await fake.emit("started", dispatched.workerId, { sessionId: dispatched.workerId, branch: "sig/x-1" });
    await fake.emit("report", dispatched.workerId, { type: "report", status: "needs_decision", summary: "An old index exists", question: "Drop the old search_index too?" });
    const question = (await waitFor(() => ownerStub().debugSnapshot(), (snap) => snap.questions.some((q) => q.workerId === dispatched.workerId && q.status === "open"), "question opened")).questions.find((q) => q.workerId === dispatched.workerId)!;
    // The steward is down, so the deterministic fallback forwards the worker's own words.
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();

    const { get, post } = await browser();
    const item = (await get()).attention.find((entry) => entry.threadId === dispatched.threadId);
    expect(item).toMatchObject({ kind: "question" });
    expect(item!.buttons).toEqual([]); // a free-text question: answered by replying

    const runsBefore = (await llmState()).runs.length;
    expect((await post("messages", { id: "answer-0001", text: "Yes, drop it and rebuild", replyTo: item!.id })).status).toBe(202);
    const send = (await waitFor(() => fake.cmds.find((cmd) => cmd.kind === "send"), (cmd) => cmd !== undefined, "answer relayed"))!;
    expect(String((send.args as Record<string, unknown>).text)).toContain("Yes, drop it and rebuild");
    expect((await ownerStub().debugSnapshot()).questions.find((q) => q.qid === question.qid)).toMatchObject({ status: "answered" });
    expect((await webTexts()).some((text) => text.includes("已把你的回答转给"))).toBe(true);
    expect((await llmState()).runs.length).toBe(runsBefore); // no model run for the relay
    expect((await get()).attention).toEqual([]);
    fake.close();
  }, 45_000);
});
