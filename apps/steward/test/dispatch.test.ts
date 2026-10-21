// Deterministic machine choice and the dispatch service (issue #5 → #6): ADR-0001 decision 6
// as a pure function, and — through the DO — the service the steward's start_worker tool calls:
// thread create/attach, refusal texts, and the offline ask card. The M1 phrases are gone
// (natural language reaches the LLM); the two that remain (issue #22) and everything else
// deterministic stay tested deterministically.
import { beforeEach, describe, expect, it } from "vitest";
import { isSpendQuery } from "../src/budget.ts";
import { chooseMachine, parseOwnerCommand, type MachineCandidate } from "../src/dispatch.ts";
import {
  configureAndBind,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

describe("parseOwnerCommand: the deterministic chat commands (issue #22 + #28's spend query)", () => {
  it("parses the add-machine, web-link, and spend phrases", () => {
    expect(parseOwnerCommand("/加机器")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/添加机器 ")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/add-machine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/addmachine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/网页")).toEqual({ kind: "web_link" });
    expect(parseOwnerCommand("/web ")).toEqual({ kind: "web_link" });
    expect(parseOwnerCommand("/login")).toEqual({ kind: "web_link" });
    expect(parseOwnerCommand("/花费")).toEqual({ kind: "spend" });
    expect(parseOwnerCommand("/usage")).toEqual({ kind: "spend" });
    expect(parseOwnerCommand("今天花了多少钱？")).toEqual({ kind: "spend" });
    expect(parseOwnerCommand("How much have you spent today?")).toEqual({ kind: "spend" });
    // Trailing content means it is not the fixed phrase — it falls through to the LLM.
    expect(parseOwnerCommand("/加机器 现在")).toBeNull();
    expect(parseOwnerCommand("/网页 login.html")).toBeNull();
    expect(parseOwnerCommand("/花费 和 /预算 都看看")).toBeNull();
  });

  it("everything else is the steward LLM's, including the retired M1 phrases", () => {
    expect(parseOwnerCommand("帮我把登录 bug 修一下")).toBeNull();
    expect(parseOwnerCommand("/派发 repo-a 修复登录 bug")).toBeNull();
    expect(parseOwnerCommand("/状态")).toBeNull();
    // #28: a spend *question* matches whole-message only — compound tasks fall through.
    expect(parseOwnerCommand("今天把这个登录 bug 修一下，花多少钱都行")).toBeNull();
    expect(parseOwnerCommand("查一下今天花了多少时间修那个 bug")).toBeNull();
    expect(parseOwnerCommand("how much did the refactor cost today?")).toBeNull();
  });

  it("isSpendQuery: the natural forms it answers, and the ones it must not touch", () => {
    for (const yes of [
      "/花费", "/用量", "/预算", "/spend", "/usage", "/budget",
      "今天花了多少钱？", "你今天花了多少钱", "总管今日一共用了多少", "今天用了多少 token",
      "今天的费用是多少", "今日预算还剩多少", "how much have you spent today",
      "How much did you spend so far today?", "what's today's spend", "today's usage",
    ]) {
      expect(isSpendQuery(yes), yes).toBe(true);
    }
    for (const no of [
      "", "在吗", "顺便问下今天花了多少钱之外再修个 bug",
      "帮我记下今天花了多少顿饭钱", "今天花了多少时间修 bug",
      "how much is the login bug refactor", "今天把登录 bug 修一下",
    ]) {
      expect(isSpendQuery(no), JSON.stringify(no)).toBe(false);
    }
  });
});

function candidate(deviceId: string, overrides: Partial<MachineCandidate> = {}): MachineCandidate {
  return { deviceId, name: deviceId, online: true, freeSlots: 2, ...overrides };
}

describe("chooseMachine: ADR-0001 decision 6, deterministic", () => {
  it("dispatches to the unique online machine that has the repo", () => {
    const choice = chooseMachine({
      candidates: [candidate("a", { online: false }), candidate("b")],
      machineHint: null,
      lastMachine: null,
      continuation: false,
    });
    expect(choice).toEqual({ kind: "machine", deviceId: "b", queued: false });
  });

  it("the user-named machine wins over everything — and offline means the wait/switch ask (protocol §7.3)", () => {
    const choice = chooseMachine({
      candidates: [candidate("a"), candidate("b", { name: "mac-b", online: false })],
      machineHint: "mac-b",
      lastMachine: "a",
      continuation: true,
    });
    expect(choice).toEqual({ kind: "ask_offline", deviceId: "b" });
  });

  it("an unmatched @machine is reported, never guessed around", () => {
    const choice = chooseMachine({
      candidates: [candidate("a")],
      machineHint: "elsewhere",
      lastMachine: null,
      continuation: false,
    });
    expect(choice).toEqual({ kind: "no_match" });
  });

  it("a continuation goes back to the Thread's last machine; offline it asks instead of silently queueing (bug 4 → §7.3)", () => {
    const choice = chooseMachine({
      candidates: [candidate("a"), candidate("b", { online: false })],
      machineHint: null,
      lastMachine: "b",
      continuation: true,
    });
    expect(choice).toEqual({ kind: "ask_offline", deviceId: "b" });
  });

  it("among several online machines the most free slots wins; a tie asks", () => {
    expect(
      chooseMachine({
        candidates: [candidate("a", { freeSlots: 1 }), candidate("b", { freeSlots: 3 }), candidate("c", { freeSlots: 2 })],
        machineHint: null,
        lastMachine: null,
        continuation: false,
      }),
    ).toEqual({ kind: "machine", deviceId: "b", queued: false });

    const tie = chooseMachine({
      candidates: [candidate("a", { freeSlots: 2 }), candidate("b", { freeSlots: 2 })],
      machineHint: null,
      lastMachine: null,
      continuation: false,
    });
    expect(tie).toMatchObject({ kind: "ask_which" });
  });

  it("no machine online: a single offline candidate becomes the offline ask, several become a choice", () => {
    expect(
      chooseMachine({
        candidates: [candidate("a", { online: false })],
        machineHint: null,
        lastMachine: null,
        continuation: false,
      }),
    ).toEqual({ kind: "ask_offline", deviceId: "a" });

    expect(
      chooseMachine({
        candidates: [candidate("a", { online: false }), candidate("b", { online: false })],
        machineHint: null,
        lastMachine: null,
        continuation: false,
      }),
    ).toMatchObject({ kind: "ask_which" });
  });

  it("no candidates at all is no_match", () => {
    expect(chooseMachine({ candidates: [], machineHint: null, lastMachine: null, continuation: false })).toEqual({ kind: "no_match" });
  });
});

// The dispatch service behind the start_worker tool, exercised through the DO with a paired
// machine — the same code path the steward LLM's tool calls take (issue #6).
describe("the dispatch service (Dispatcher.startWorker)", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("refuses an unknown repo with actionable guidance and dispatches nothing", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "no-such-repo", newTitle: "修东西" });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect((outcome as { reason: string }).reason).toContain("没有机器登记过仓库");
    expect(fake.cmds).toHaveLength(0);
    fake.close();
  });

  it("asks with buttons when the only machine with the repo is offline, holding the command (protocol §7.3)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.close(); // hello registered the repo; the socket dying takes the machine offline
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.machines.every((m) => !m.online)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修个东西" });
    expect(outcome).toMatchObject({ kind: "asked_offline", machineName: "mac-studio" });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads).toHaveLength(1); // the ask created the Thread and set affinity
    // The command is parked: registered + enqueued but HELD until the owner answers.
    expect(snap.threads[0]!.workers).toHaveLength(1);
    expect(snap.threads[0]!.workers[0]!.state).toBe("starting");
    expect(snap.threads[0]!.lastMachine).toBe(fake.deviceId);
    // The command is written (protocol §7.3) but held — never delivered without an answer.
    const worker = snap.threads[0]!.workers[0]!;
    const cmdRow = await ownerStub().outboxRow(worker.cmdId!);
    expect(cmdRow?.state).toBe("queued");
    expect(cmdRow?.notAfter).not.toBeNull();
    await waitWhileOutboundPending();
    const cards = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards[0]?.payload)).toContain("等它上线");
    fake.close();
  });

  it("attaches to an existing thread on the same machine and resumes the previous session (issue #8)", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "第一段完成", branch: "sig/leg-1" },
    });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "第一段任务", repoRef: "repo-a", newTitle: "第一段任务" });
    expect(first).toMatchObject({ kind: "dispatched", created: true });
    await fake.waitForCmds(1);
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.threads[0]!.workers[0]?.state === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const threadId = (await ownerStub().debugSnapshot()).threads[0]!.threadId;
    const leg1 = (await ownerStub().debugSnapshot()).threads[0]!.workers[0]!;

    // Same agent + same machine + healthy session → the task goes INTO the old session
    // (spec §5.3 case 1): a `send`, no new worker row, no base, no brief.
    const second = await ownerStub().dispatchForTest({ prompt: "第二段任务", repoRef: "repo-a", threadId });
    expect(second).toMatchObject({
      kind: "dispatched",
      created: false,
      threadId,
      continuation: { action: "resume", brief: false },
    });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.kind).toBe("send"); // resume mechanism = the connector's §6.2 idle relaunch
    expect(cmd2!.args).toMatchObject({ workerId: leg1.workerId, text: "第二段任务", intent: "auto" });
    expect(cmd2!.args).not.toHaveProperty("base");
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers).toHaveLength(1); // the same session, no second row
    expect(snap.threads[0]!.workers[0]!.state).toBe("starting"); // resume-pending until `started`
    // cmdId = tool:<taskId> is asserted in llm-reply.test.ts, where the real tool runs
    fake.close();
  });

  it("dispatch carries the steward's mode choice; the default is write (spec §11)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();

    // Readonly: research/Q&A/review — runs in the repo's own checkout, no relay base.
    const ro = await ownerStub().dispatchForTest({ prompt: "梳理一下认证流程", repoRef: "repo-a", newTitle: "梳理认证", mode: "readonly" });
    expect(ro).toMatchObject({ kind: "dispatched" });
    // Write (default when the model omits mode or is unsure): a worktree task.
    const wr = await ownerStub().dispatchForTest({ prompt: "修个 bug", repoRef: "repo-a", newTitle: "修 bug" });
    expect(wr).toMatchObject({ kind: "dispatched" });

    const [roCmd, wrCmd] = await fake.waitForCmds(2);
    expect(roCmd!.args).toMatchObject({ mode: "readonly" });
    expect(roCmd!.args).not.toHaveProperty("base"); // readonly never relays a branch
    expect(wrCmd!.args).toMatchObject({ mode: "write" });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads.map((t) => t.workers[0]!.mode)).toEqual(["readonly", "write"]);
    fake.close();
  });

  it("a duplicate cmdId converges on the same command row (replay idempotency)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    expect(first).toMatchObject({ kind: "dispatched" });
    const [cmd] = await fake.waitForCmds(1);
    const threadId = (first as { threadId: string }).threadId;
    // Same cmdId again (what a replayed tool call would produce): one command, ever.
    const outcome = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", threadId, cmdId: String(cmd!.id) });
    expect(outcome).toMatchObject({ kind: "dispatched" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.cmds).toHaveLength(1);
    fake.close();
  });
});

// PR #45 review #6: interventions on a broken worker are refused before the enqueue — the
// connector rejects them anyway (broken_worker), and refusing here keeps the tool reply from
// claiming a delivery (「已发送」/「会尽快停下」) that can never happen.
describe("the dispatch service: interventions on a broken worker are refused up front (PR #45 review #6)", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("send_to_worker refuses instead of promising a prompt delivery", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    expect(first).toMatchObject({ kind: "dispatched" });
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    // The connector failed the start: the worker lands broken (markStartFailed).
    fake.send({ t: "cmd_result", re: cmd!.id, ok: false, error: { code: "startup_failed" } });
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.threads[0]?.workers[0]?.state === "broken") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const send = await ownerStub().sendForTest({ workerId, text: "追加指令", intent: "auto" });
    expect(send).toMatchObject({ kind: "refused" });
    expect((send as { reason: string }).reason).toContain("已损坏");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.cmds).toHaveLength(1); // nothing was enqueued
    fake.close();
  });

  it("interrupt_worker refuses instead of promising a stop", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "任务", repoRef: "repo-a", newTitle: "任务" });
    expect(first).toMatchObject({ kind: "dispatched" });
    const [cmd] = await fake.waitForCmds(1);
    const workerId = String((cmd!.args as Record<string, unknown>).workerId);
    fake.send({ t: "cmd_result", re: cmd!.id, ok: false, error: { code: "startup_failed" } });
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.threads[0]?.workers[0]?.state === "broken") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const interrupt = await ownerStub().interruptForTest({ workerId });
    expect(interrupt).toMatchObject({ kind: "refused" });
    expect((interrupt as { reason: string }).reason).toContain("已损坏");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.cmds).toHaveLength(1); // nothing was enqueued
    fake.close();
  });
});

// Issue #17: the steward can TARGET an agent (hello.agents is the menu) — the command
// carries it, the worker row records it, and machines without it are refused honestly
// instead of receiving a start_worker the connector would bounce (unknown_agent).
describe("the dispatch service: agent targeting (issue #17)", () => {
  beforeEach(async () => {
    await resetLedgerState();
    await configureAndBind("ou_owner");
  });

  it("dispatches to claude-code when the machine advertises it; the command and worker row say so", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false, agents: ["pi", "claude-code"] });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({
      prompt: "用另一套思路修个东西",
      repoRef: "repo-a",
      newTitle: "修东西",
      agent: "claude-code",
    });
    expect(outcome).toMatchObject({ kind: "dispatched" });
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.kind).toBe("start_worker");
    expect(cmd!.args).toMatchObject({ agent: "claude-code" });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers[0]!.agent).toBe("claude-code");
    fake.close();
  });

  it("defaults to pi and omits the agent field (legacy connectors never see it)", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false });
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({ prompt: "修个东西", repoRef: "repo-a", newTitle: "修东西" });
    expect(outcome).toMatchObject({ kind: "dispatched" });
    const [cmd] = await fake.waitForCmds(1);
    expect(cmd!.args).not.toHaveProperty("agent");
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers[0]!.agent).toBe("pi");
    fake.close();
  });

  it("refuses honestly when no machine with the repo has the agent installed", async () => {
    const fake = await pairFakeConnector("mac-studio", { run: null, autorun: false }); // pi only
    await fake.connect();
    const outcome = await ownerStub().dispatchForTest({
      prompt: "用 Claude Code 修个东西",
      repoRef: "repo-a",
      newTitle: "修东西",
      agent: "claude-code",
    });
    expect(outcome).toMatchObject({ kind: "refused" });
    expect((outcome as { reason: string }).reason).toContain("claude-code");
    expect((outcome as { reason: string }).reason).toContain("pi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.cmds).toHaveLength(0); // never sent — the connector would bounce it
    fake.close();
  });

  it("an agent switch on a Thread is a new session from the previous leg's branch (spec §5.3)", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "pi leg done", branch: "sig/leg-1" },
      autorun: false,
      agents: ["pi", "claude-code"],
    });
    await fake.connect();
    const first = await ownerStub().dispatchForTest({ prompt: "第一段：pi 先跑", repoRef: "repo-a", newTitle: "接力" });
    expect(first).toMatchObject({ kind: "dispatched" });
    const leg1Id = (first as { workerId: string }).workerId;
    const [cmd1] = await fake.waitForCmds(1);
    fake.send({ t: "cmd_ack", re: cmd1!.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: cmd1!.id, ok: true, data: { sessionId: leg1Id, branch: "sig/leg-1" } });
    await fake.emit("started", leg1Id, { sessionId: leg1Id, branch: "sig/leg-1" });
    await fake.emit("report", leg1Id, {
      type: "report",
      status: "done",
      summary: "pi leg done",
      git: {
        branch: "sig/leg-1",
        base: "b464a0f8c355115c1212b0f019b4a65d2bb44e3",
        ahead: 1,
        dirty: 0,
        filesChanged: 1,
        insertions: 10,
        deletions: 0,
        pushed: false,
        head: "3e56dab13073fd2a79e042e36414851b2fba95f",
        commits: ["3e56dab13073fd2a79e042e36414851b2fba95f"],
        changedFiles: ["PLAN.md"],
        pointersTruncated: false,
      },
    });
    await fake.emit("settled", leg1Id, { type: "settled", outcome: "reported", usage: { contextUsage: { percent: 2 } } });
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      if (snap.threads[0]!.workers[0]?.state === "idle") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const threadId = (await ownerStub().debugSnapshot()).threads[0]!.threadId;

    // Same thread, DIFFERENT agent: never a resume — a new session on the pi leg's branch.
    const second = await ownerStub().dispatchForTest({
      prompt: "第二段：claude 接力",
      repoRef: "repo-a",
      threadId,
      agent: "claude-code",
    });
    expect(second).toMatchObject({
      kind: "dispatched",
      continuation: { action: "new_session", reason: "agent_switch", base: "sig/leg-1" },
    });
    const [, cmd2] = await fake.waitForCmds(2);
    expect(cmd2!.args).toMatchObject({ agent: "claude-code", base: "sig/leg-1" });
    const snap = await ownerStub().debugSnapshot();
    expect(snap.threads[0]!.workers).toHaveLength(2);
    expect(snap.threads[0]!.workers[1]!.agent).toBe("claude-code");
    fake.close();
  });
});
