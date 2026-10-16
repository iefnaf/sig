// Deterministic machine choice and the dispatch service (issue #5 → #6): ADR-0001 decision 6
// as a pure function, and — through the DO — the service the steward's start_worker tool calls:
// thread create/attach, refusal texts, and the offline ask card. The M1 phrases are gone
// (natural language reaches the LLM); the two that remain (issue #22) and everything else
// deterministic stay tested deterministically.
import { beforeEach, describe, expect, it } from "vitest";
import { chooseMachine, parseOwnerCommand, type MachineCandidate } from "../src/dispatch.ts";
import {
  configureAndBind,
  mockReset,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

describe("parseOwnerCommand: the two deterministic chat commands (issue #22)", () => {
  it("parses the add-machine and web-link phrases", () => {
    expect(parseOwnerCommand("/加机器")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/添加机器 ")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/add-machine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/addmachine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerCommand("/网页")).toEqual({ kind: "web_link" });
    expect(parseOwnerCommand("/web ")).toEqual({ kind: "web_link" });
    expect(parseOwnerCommand("/login")).toEqual({ kind: "web_link" });
    // Trailing content means it is not the fixed phrase — it falls through to the LLM.
    expect(parseOwnerCommand("/加机器 现在")).toBeNull();
    expect(parseOwnerCommand("/网页 login.html")).toBeNull();
  });

  it("everything else is the steward LLM's, including the retired M1 phrases", () => {
    expect(parseOwnerCommand("帮我把登录 bug 修一下")).toBeNull();
    expect(parseOwnerCommand("/派发 repo-a 修复登录 bug")).toBeNull();
    expect(parseOwnerCommand("/状态")).toBeNull();
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

  it("the user-named machine wins over everything, online or not", () => {
    const choice = chooseMachine({
      candidates: [candidate("a"), candidate("b", { name: "mac-b", online: false })],
      machineHint: "mac-b",
      lastMachine: "a",
      continuation: true,
    });
    expect(choice).toEqual({ kind: "machine", deviceId: "b", queued: true });
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

  it("a continuation goes back to the Thread's last machine and queues while it is offline (bug 4)", () => {
    const choice = chooseMachine({
      candidates: [candidate("a"), candidate("b", { online: false })],
      machineHint: null,
      lastMachine: "b",
      continuation: true,
    });
    expect(choice).toEqual({ kind: "machine", deviceId: "b", queued: true });
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
    await mockReset();
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

  it("asks with buttons when the only machine with the repo is offline, creating the Thread", async () => {
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
    expect(snap.threads[0]!.workers).toHaveLength(0); // nothing dispatched: ask, don't decide
    expect(snap.threads[0]!.lastMachine).toBe(fake.deviceId);
    await waitWhileOutboundPending();
    const cards = (await ownerStub().outboundRows(10)).filter((r) => r.kind === "card" && r.status === "sent");
    expect(JSON.stringify(cards[0]?.payload)).toContain("排队等上线");
  });

  it("attaches to an existing thread and relays the previous branch as base", async () => {
    const fake = await pairFakeConnector("mac-studio", {
      run: { status: "done", summary: "第一段完成", branch: "shepherd/leg-1" },
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

    const second = await ownerStub().dispatchForTest({ prompt: "第二段任务", repoRef: "repo-a", threadId });
    expect(second).toMatchObject({ kind: "dispatched", created: false, threadId });
    const [, cmd2] = await fake.waitForCmds(2);
    expect((cmd2!.args as Record<string, unknown>).base).toBe("shepherd/leg-1"); // relay (spec §5.3)
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
