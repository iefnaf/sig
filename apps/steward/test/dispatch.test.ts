// Fixed-phrase parsing and deterministic machine choice (issue #5): no LLM anywhere —
// the phrase grammar and the ADR-0001 decision-6 rule are pure functions under test.
import { describe, expect, it } from "vitest";
import { chooseMachine, parseOwnerText, type MachineCandidate } from "../src/dispatch.ts";

describe("parseOwnerText: the M1 fixed phrases", () => {
  it("parses /派发 with repo, optional @machine, and the prompt", () => {
    expect(parseOwnerText("/派发 repo-a 修复登录 bug")).toEqual({
      kind: "dispatch",
      repoRef: "repo-a",
      machineHint: null,
      prompt: "修复登录 bug",
    });
    expect(parseOwnerText("  /dispatch repo-a@mac-studio   修复登录 bug，顺便加测试  ")).toEqual({
      kind: "dispatch",
      repoRef: "repo-a",
      machineHint: "mac-studio",
      prompt: "修复登录 bug，顺便加测试",
    });
    expect(parseOwnerText("/run repo-a multiline prompts\nkeep their lines")).toMatchObject({
      kind: "dispatch",
      prompt: "multiline prompts\nkeep their lines",
    });
  });

  it("parses the status phrase", () => {
    expect(parseOwnerText("/状态")).toEqual({ kind: "status" });
    expect(parseOwnerText("/status ")).toEqual({ kind: "status" });
  });

  it("parses the add-machine and web-link phrases", () => {
    expect(parseOwnerText("/加机器")).toEqual({ kind: "add_machine" });
    expect(parseOwnerText("/添加机器 ")).toEqual({ kind: "add_machine" });
    expect(parseOwnerText("/add-machine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerText("/addmachine")).toEqual({ kind: "add_machine" });
    expect(parseOwnerText("/网页")).toEqual({ kind: "web_link" });
    expect(parseOwnerText("/web ")).toEqual({ kind: "web_link" });
    expect(parseOwnerText("/login")).toEqual({ kind: "web_link" });
    // Trailing content means it is not the fixed phrase — it falls through to dispatch/help.
    expect(parseOwnerText("/加机器 现在")).toBeNull();
    expect(parseOwnerText("/网页 login.html")).toBeNull();
  });

  it("rejects everything else: natural language waits for the M2 steward", () => {
    expect(parseOwnerText("帮我把登录 bug 修一下")).toBeNull();
    expect(parseOwnerText("/派发")).toBeNull(); // no repo, no prompt
    expect(parseOwnerText("/派发 repo-a")).toBeNull(); // no prompt
    expect(parseOwnerText("/派发 repo-a@ 修复")).toBeNull(); // empty machine qualifier
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
