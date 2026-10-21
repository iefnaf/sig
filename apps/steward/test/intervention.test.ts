// In-chat intervention, steward half (issue #9, steward.md §4.3/§7.2, connector-pi.md §6):
// the send_to_worker / interrupt_worker tools drive the deterministic dispatcher, the reply
// tells the model the delivery (after_current_tools for a running worker), the policy hook
// gates interrupts on the user's own hand, queue_returned events wake the steward about
// undelivered texts, and the live-equivalent loop — an interrupt flipping the Thread to
// idle — runs the whole path in seconds. The model is the scripted faux provider; the
// connector is the protocol-level FakeConnector.
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  FakeConnector,
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

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

async function dm(text: string, msgId = `om_${crypto.randomUUID().slice(0, 8)}`): Promise<Response> {
  return postEvent(messageEvent({ msgId, text }));
}

async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(30);
  return rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => (JSON.parse(r.payload as string) as { text?: string }).text ?? "");
}

/** The tool results the model saw (per faux request; the last one is the latest step's). */
async function toolResults(): Promise<string[]> {
  return (await modelRequests()).map((r) => r.lastToolResult);
}

async function connectedMachine(name = "mac-studio"): Promise<FakeConnector> {
  const fake = await pairFakeConnector(name, { run: null, autorun: false });
  await fake.connect();
  return fake;
}

interface RunningWorker {
  fake: FakeConnector;
  workerId: string;
  threadId: string;
}

/** Dispatches one worker through the LLM tool path and walks it to `running`. */
async function dispatchRunning(prompt = "修复登录 bug"): Promise<RunningWorker> {
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

describe("send_to_worker (steward.md §4.3, connector-pi.md §6.2)", () => {
  it("enqueues the send command with the intent; the tool reply says after_current_tools for a running worker", async () => {
    const { fake, workerId, threadId } = await dispatchRunning();

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("send_to_worker", { workerId, text: "改用 pnpm，不要 npm", intent: "now", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已让它改用 pnpm；不打断手头的工具，当前批次结束后转向。")]),
    );
    await dm("改用 pnpm 吧");
    const [, cmd] = await fake.waitForCmds(2);
    expect(cmd).toMatchObject({
      kind: "send",
      workerId,
      args: { workerId, text: "改用 pnpm，不要 npm", intent: "now" },
    });
    expect(cmd!.id).toMatch(/^tool:/); // cmdId = tool:<taskId> (§7.1)

    await waitRunsSettled();
    await waitWhileOutboundPending();
    // §6.2: the tool result carries the steer effect so the model can tell the user when the
    // redirect lands — this is what the connector's {effect:"after_current_tools"} mirrors.
    expect((await toolResults()).some((r) => r.includes("after_current_tools"))).toBe(true);
    expect((await sentTexts()).some((t) => t.includes("改用 pnpm"))).toBe(true);
    // Deterministic bookkeeping: the intervention is on the Thread timeline.
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.timeline.some((e) => e.kind === "intervention" && e.text.includes("改用 pnpm"))).toBe(true);
    expect(snap.threads[0]!.threadId).toBe(threadId);
    fake.close();
  }, 30_000);

  it("intent=after maps to follow_up in the reply; idle workers get an immediate prompt", async () => {
    const { fake, workerId } = await dispatchRunning();
    // The run settles: the worker is idle — an `after` still queues behind nothing.
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "第一段完成" });
    await fake.emit("settled", workerId, { type: "settled", outcome: "reported" });
    await waitRunsSettled();

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("send_to_worker", { workerId, text: "跑完后补几个测试", intent: "after", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已附言：跑完后补测试。")]),
    );
    await dm("跑完之后顺便补几个测试");
    await fake.waitForCmds(2);
    await waitRunsSettled();
    const results = await toolResults();
    // The tool answered for the idle state — delivered as a prompt, no steer effect promised.
    expect(results.some((r) => r.includes("空闲") && r.includes("立即"))).toBe(true);
    expect(results.some((r) => r.includes("after_current_tools"))).toBe(false);
    fake.close();
  }, 30_000);

  it("an event-triggered run cannot send without a verifiable provenanceRef (§7.2)", async () => {
    const { fake, workerId } = await dispatchRunning();
    // A report wakes the steward; the scripted model overreaches: send without provenanceRef.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("send_to_worker", { workerId, text: "再跑一遍", intent: "now", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("记账完成。")]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "完成" });
    await waitRunsSettled();
    const results = await toolResults();
    expect(results.some((r) => r.includes("refused") && r.includes("provenanceRef"))).toBe(true);
    expect(fake.cmds).toHaveLength(1); // nothing was sent to the connector
    fake.close();
  }, 30_000);
});

describe("interrupt_worker (steward.md §7.2: basis ∈ {user_explicit, user_reply_to})", () => {
  it("an event-triggered run cannot interrupt without a verifiable provenanceRef (§7.2, PR #45 review #4)", async () => {
    const { fake, workerId } = await dispatchRunning();
    // A report wakes the steward; the scripted model claims the user's hand without a
    // verifiable reference — the basis label alone is model-claimed and must not carry an abort.
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, basis: "user_explicit", provenanceRef: "user:om_nonexistent" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("好，先不动它。")]),
    );
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "完成" });
    await waitRunsSettled();
    const results = await toolResults();
    expect(results.some((r) => r.includes("refused") && r.includes("provenanceRef"))).toBe(true); // no ref
    expect(results.some((r) => r.includes("refused") && r.includes("om_nonexistent"))).toBe(true); // bogus ref
    expect(fake.cmds).toHaveLength(1); // only the original start_worker — no interrupt left the DO
    fake.close();
  }, 30_000);

  it("an event-triggered interrupt with a real user message id passes the gate", async () => {
    const { fake, workerId } = await dispatchRunning();
    // A standing user instruction the ref can point at (§7.2: verified against sh_inbound).
    await scriptModel(
      fauxAssistantMessage([fauxText("好，记住了：回头说停就停干净。")]), // replies to the DM below
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, basis: "user_reply_to", provenanceRef: "user:om_stopauth1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已停下。")]),
    );
    await dm("记住：回头我说停，就把它停干净", "om_stopauth1");
    await fake.emit("report", workerId, { type: "report", status: "done", summary: "完成" });
    const [, cmd] = await fake.waitForCmds(2);
    expect(cmd).toMatchObject({ kind: "interrupt", workerId });
    await waitRunsSettled();
    expect((await toolResults()).some((r) => r.includes("已发出中断"))).toBe(true);
    fake.close();
  }, 30_000);

  it("blocks inferred/other bases at the hook; a user-explicit basis enqueues the interrupt", async () => {
    const { fake, workerId } = await dispatchRunning();

    await scriptModel(
      // First attempt: the model leans on a preference (schema-valid basis, but not the
      // user's hand) — the §7.2 hook blocks it and the model sees why.
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, basis: "memory" })], { stopReason: "toolUse" }),
      // Second attempt: the user really did say stop.
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, then: "停下后改用 pnpm install 重来", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已停下它，并让它在停后改用 pnpm install。")]),
    );
    await dm("停下那个，停了以后改用 pnpm install 重来");
    const [, cmd] = await fake.waitForCmds(2);
    expect(cmd).toMatchObject({
      kind: "interrupt",
      workerId,
      args: { workerId, then: { text: "停下后改用 pnpm install 重来" } },
    });

    await waitRunsSettled();
    await waitWhileOutboundPending();
    const results = await toolResults();
    expect(results.some((r) => r.includes("Autonomy rule") && r.includes("user_explicit"))).toBe(true);
    expect(results.some((r) => r.includes("已发出中断"))).toBe(true);
    expect((await sentTexts()).some((t) => t.includes("已停下"))).toBe(true);
    fake.close();
  }, 30_000);

  it("refuses an unknown worker instead of enqueueing garbage", async () => {
    const { fake } = await dispatchRunning();
    await scriptModel(
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId: "w_nope", basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("没找到这个 worker。")]),
    );
    await dm("把 w_nope 停了");
    await waitRunsSettled();
    expect(fake.cmds).toHaveLength(1); // only the original start_worker
    expect((await toolResults()).some((r) => r.includes("refused"))).toBe(true);
    fake.close();
  }, 30_000);
});

describe("queue_returned events (connector-pi.md §6.2/§11.1)", () => {
  it("records the texts on the timeline and wakes the steward about them", async () => {
    const { fake, workerId, threadId } = await dispatchRunning();
    await scriptModel(
      fauxAssistantMessage([fauxText("取回的消息我记下了，等用户指示。")]), // the wake's answer (text discarded, §6.2)
    );
    await fake.emit("queue_returned", workerId, { type: "queue_returned", texts: ["改用 pnpm，不要 npm"] });
    await waitRunsSettled();

    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.timeline.some((e) => e.text.includes("改用 pnpm，不要 npm"))).toBe(true);
    const wakeRun = (await llmState()).runs.find((r) => r.kind === "event");
    expect(wakeRun).toBeDefined();
    expect(wakeRun!.text).toContain("改用 pnpm，不要 npm");
    expect(wakeRun!.text).toContain(threadId);
    expect(wakeRun!.text).toContain("未送达");
    fake.close();
  }, 30_000);
});

describe("the live-equivalent loop: an interrupt flips the Thread to idle within seconds", () => {
  it("owner says stop → interrupt cmd → aborted settle → Thread idle, all inside a seconds budget", async () => {
    const { fake, workerId, threadId } = await dispatchRunning();
    expect((await ownerStub().debugSnapshot()).threads[0]!.state).toBe("running");

    await scriptModel(
      fauxAssistantMessage([fauxToolCall("interrupt_worker", { workerId, basis: "user_explicit" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("已发出停止，它马上停下。")]),
    );
    const startedAt = Date.now();
    await dm("停下那个");

    // The connector's role: run the interrupt and report what pi did (§6.2's flow).
    const [, cmd] = await fake.waitForCmds(2);
    expect(cmd).toMatchObject({ kind: "interrupt", workerId });
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { aborted: true, queueReturned: 1 } });
    await fake.emit("queue_returned", workerId, { type: "queue_returned", texts: ["改用 pnpm"] });
    await fake.emit("settled", workerId, { type: "settled", outcome: "aborted" });

    // The reducer is synchronous with the event batch: idle should land immediately, and the
    // whole loop (message → model → cmd → abort → events) must stay inside a seconds budget.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      const thread = snap.threads.find((t) => t.threadId === threadId);
      if (thread?.state === "idle") break;
      if (Date.now() > deadline) {
        throw new Error(`thread never went idle: ${JSON.stringify(snap.threads, null, 2)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const worker = (await ownerStub().debugSnapshot()).threads[0]!.workers.find((w) => w.workerId === workerId);
    expect(worker?.state).toBe("idle");
    expect(worker?.lastOutcome).toBe("settled:aborted");
    await waitRunsSettled();
    await waitWhileOutboundPending();
    expect((await sentTexts()).some((t) => t.includes("已发出停止"))).toBe(true);
    fake.close();
  }, 30_000);
});
