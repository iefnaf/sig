// The session viewer's pure half (ui/session-model.js): reassembling a recorded entry from its
// fragments, reading pi's and Claude Code's records into display blocks without losing any, and
// telling the agent's current branch from the ones it left behind. No DOM here — session.js draws
// what this describes, and is checked as shipped in ui-modules.test.ts.
import { describe, expect, it } from "vitest";
import { branchOf, callSummary, clip, createAssembler, describeRecord, imageSrc, inputRows, placeOf, pretty } from "../ui/session-model.js";

const fragments = (id: string, text: string, size: number) => {
  const out: Array<{ id: string; fragment: { data: string; offset: number; total: number } }> = [];
  for (let offset = 0; offset < text.length; offset += size) out.push({ id, fragment: { data: text.slice(offset, offset + size), offset, total: text.length } });
  return out;
};

describe("reassembling a recorded entry", () => {
  it("joins fragments, across as many pages as it took, into the record that was written", () => {
    const record = { id: "a1", text: "日本語 🙂 ".repeat(50) };
    const assembler = createAssembler();
    const pieces = fragments("L0", JSON.stringify(record), 37);
    const results = pieces.map((piece) => assembler.push(piece));
    expect(results.slice(0, -1).every((result) => "pending" in result)).toBe(true);
    expect(assembler.partial).toBe(false);
    expect(results[results.length - 1]).toEqual({ record });
  });

  it("holds a half-received entry while the next page is fetched", () => {
    const assembler = createAssembler();
    const [first, second] = fragments("L0", '{"a":1}', 4);
    expect(assembler.push(first!)).toEqual({ pending: true });
    expect(assembler.partial).toBe(true);
    expect(assembler.push(second!)).toEqual({ record: { a: 1 } });
  });

  it("refuses a stream that skips, repeats, overruns or is not fragments at all", () => {
    const [first, second, third] = fragments("L0", '{"abcdef":1}', 4);
    const skipped = createAssembler();
    skipped.push(first!);
    expect(skipped.push(third!)).toEqual({ error: "gap" });
    expect(skipped.partial).toBe(false);
    const repeated = createAssembler();
    repeated.push(first!);
    repeated.push(second!);
    expect(repeated.push(second!)).toEqual({ error: "gap" });
    const mixed = createAssembler();
    mixed.push(first!);
    expect(mixed.push({ ...second!, id: "L99" })).toEqual({ error: "gap" });
    const overrun = createAssembler();
    expect(overrun.push({ id: "L0", fragment: { data: '{"a":1}extra', offset: 0, total: 7 } })).toEqual({ error: "overflow" });
    const nonsense = createAssembler();
    for (const entry of [{}, { id: "L0" }, { id: "L0", fragment: { data: 5, offset: 0, total: 1 } }, { id: "L0", fragment: { data: "x", offset: 0.5, total: 1 } }, null, undefined]) {
      expect(nonsense.push(entry as never), JSON.stringify(entry)).toEqual({ error: "malformed" });
    }
  });

  it("reports an entry that is not JSON as unreadable, and carries on with the next", () => {
    const assembler = createAssembler();
    expect(assembler.push({ id: "L0", fragment: { data: "this is not json", offset: 0, total: 16 } })).toEqual({ error: "parse" });
    expect(assembler.push({ id: "L20", fragment: { data: '{"ok":true}', offset: 0, total: 11 } })).toEqual({ record: { ok: true } });
  });

  it("starts over when an entry restarts, and can be reset", () => {
    const assembler = createAssembler();
    const [first] = fragments("L0", '{"a":1}', 4);
    assembler.push(first!);
    expect(assembler.push({ id: "L9", fragment: { data: '{"b":2}', offset: 0, total: 7 } })).toEqual({ record: { b: 2 } });
    assembler.push(first!);
    assembler.reset();
    expect(assembler.partial).toBe(false);
  });
});

describe("reading pi's records", () => {
  const message = (role: string, rest: Record<string, unknown>, id = "m1", parentId: string | null = null) => ({ type: "message", id, parentId, timestamp: "2026-10-18T10:00:00.000Z", message: { role, ...rest } });

  it("reads user and assistant messages, thinking, and tool calls with their whole arguments", () => {
    const user = describeRecord(message("user", { content: "fix the login bug" }));
    expect(user).toMatchObject({ id: "m1", parentId: null, agent: "pi", sidechain: false, at: Date.parse("2026-10-18T10:00:00.000Z") });
    expect(user.blocks).toEqual([{ t: "text", role: "user", text: "fix the login bug" }]);

    const assistant = describeRecord(message("assistant", {
      model: "claude-sonnet-4-5",
      content: [
        { type: "thinking", thinking: "look at the session code first" },
        { type: "text", text: "On it." },
        { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "line 1\nline 2" } },
      ],
    }, "m2", "m1"));
    expect(assistant).toMatchObject({ id: "m2", parentId: "m1", model: "claude-sonnet-4-5" });
    expect(assistant.blocks).toEqual([
      { t: "thinking", text: "look at the session code first", redacted: false },
      { t: "text", role: "assistant", text: "On it." },
      { t: "tool_call", callId: "c1", name: "write", input: { path: "a.ts", content: "line 1\nline 2" } },
    ]);
  });

  it("reads tool results, with images and errors, and bash executions", () => {
    const result = describeRecord(message("toolResult", { toolCallId: "c1", toolName: "read", isError: true, content: [{ type: "text", text: "no such file" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }, "m3", "m2"));
    expect(result.blocks).toEqual([{ t: "tool_result", callId: "c1", name: "read", text: "no such file", images: [{ mime: "image/png", data: "AAAA" }], error: true }]);
    const bash = describeRecord(message("bashExecution", { command: "ls", output: "a\nb", exitCode: 0, cancelled: false, truncated: true }));
    expect(bash.blocks).toEqual([{ t: "bash", command: "ls", output: "a\nb", exitCode: 0, cancelled: false, truncated: true }]);
  });

  it("shows an error the model hit, and a system prompt change by what it changed", () => {
    const failed = describeRecord(message("assistant", { content: [], stopReason: "error", errorMessage: "rate limited" }));
    expect(failed.blocks).toEqual([{ t: "meta", kind: "error", title: "error", detail: "rate limited" }]);
    const system = describeRecord(message("system", { content: "", sections: { preamble: "You are…", cwd: "/work" }, toolsAdded: [{ name: "read" }, { name: "edit" }], toolsRemoved: [{ name: "write" }] }));
    expect(system.blocks[0]).toMatchObject({ t: "meta", kind: "system", title: "preamble, cwd · +2 tools · −1 tools" });
    expect((system.blocks[0] as { detail: string }).detail).toContain("## cwd\n/work");
  });

  it("reads the bookkeeping entries: header, model, compaction, branch summary, extensions", () => {
    expect(describeRecord({ type: "session", version: 3, id: "session-uuid", cwd: "/work" })).toMatchObject({ id: null, blocks: [{ t: "meta", kind: "session", title: "/work" }] }); // the header is not a tree node
    expect(describeRecord({ type: "model_change", id: "x", parentId: "m1", provider: "openai", modelId: "gpt-4o" }).blocks).toEqual([{ t: "meta", kind: "model", title: "openai/gpt-4o", detail: "" }]);
    expect(describeRecord({ type: "compaction", id: "x", parentId: "m1", summary: "earlier work", tokensBefore: 50000 }).blocks).toEqual([{ t: "meta", kind: "compaction", title: "50000", detail: "earlier work" }]);
    expect(describeRecord({ type: "branch_summary", id: "x", parentId: "m1", fromId: "m9", summary: "tried A" }).blocks).toEqual([{ t: "meta", kind: "branch_summary", title: "m9", detail: "tried A" }]);
    expect(describeRecord({ type: "custom", id: "x", parentId: "m1", customType: "sig", data: { commandId: "c1" } }).blocks).toEqual([{ t: "meta", kind: "custom", title: "sig", detail: pretty({ commandId: "c1" }) }]);
  });

  it("keeps anything it does not know as a raw block instead of dropping it", () => {
    const strange = describeRecord({ type: "hologram", id: "z", parentId: null, payload: [1, 2] });
    expect(strange.blocks).toEqual([{ t: "raw", title: "hologram", json: pretty({ type: "hologram", id: "z", parentId: null, payload: [1, 2] }) }]);
    expect(describeRecord(message("telepathy", { content: "x" })).blocks[0]).toMatchObject({ t: "raw", title: "message · telepathy" });
    expect(describeRecord(message("assistant", { content: [{ type: "hologram", x: 1 }] })).blocks[0]).toMatchObject({ t: "raw", title: "hologram" });
    expect(describeRecord("a string").blocks[0]).toMatchObject({ t: "raw", json: "a string" });
    expect(describeRecord(null).blocks[0]).toMatchObject({ t: "raw" });
    expect(describeRecord([1, 2]).blocks[0]).toMatchObject({ t: "raw" });
  });
});

describe("reading Claude Code's records", () => {
  it("reads messages, tool use, and the tool results that come back as user records", () => {
    const user = describeRecord({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-18T10:00:00.000Z", message: { role: "user", content: "fix it" } });
    expect(user).toMatchObject({ id: "u1", parentId: null, agent: "claude" });
    expect(user.blocks).toEqual([{ t: "text", role: "user", text: "fix it" }]);

    const assistant = describeRecord({ type: "assistant", uuid: "u2", parentUuid: "u1", message: { role: "assistant", model: "claude-sonnet-4-5", content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
    ] } });
    expect(assistant).toMatchObject({ id: "u2", parentId: "u1", model: "claude-sonnet-4-5" });
    expect(assistant.blocks.map((block) => block.t)).toEqual(["thinking", "text", "tool_call"]);

    const result = describeRecord({ type: "user", uuid: "u3", parentUuid: "u2", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "total 0" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }], is_error: false },
    ] } });
    expect(result.blocks).toEqual([{ t: "tool_result", callId: "t1", name: "", text: "total 0", images: [{ mime: "image/png", data: "QUJD" }], error: false }]);
    expect(describeRecord({ type: "user", uuid: "u4", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "plain", is_error: true }] } }).blocks[0]).toMatchObject({ text: "plain", error: true });
  });

  it("reads system notes and summaries, flags sub-agent work, and keeps the rest raw", () => {
    expect(describeRecord({ type: "system", uuid: "s1", subtype: "compact_boundary", level: "info", content: "Conversation compacted" }).blocks).toEqual([{ t: "meta", kind: "info", title: "compact_boundary · info", detail: "Conversation compacted" }]);
    expect(describeRecord({ type: "summary", summary: "Fixing login", leafUuid: "u9" }).blocks).toEqual([{ t: "meta", kind: "summary", title: "", detail: "Fixing login" }]);
    expect(describeRecord({ type: "assistant", uuid: "x", isSidechain: true, message: { role: "assistant", content: "sub" } }).sidechain).toBe(true);
    expect(describeRecord({ type: "file-history-snapshot", messageId: "m", snapshot: {} }).blocks[0]).toMatchObject({ t: "raw", title: "file-history-snapshot" });
    expect(describeRecord({ type: "user", uuid: "e", message: { role: "user", content: [] } }).blocks[0]).toMatchObject({ t: "raw", title: "user" }); // never an empty entry
  });
});

describe("the conversation tree", () => {
  const n = (id: string | null, parentId: string | null = null, sidechain = false, agent = "pi") => ({ id, parentId, sidechain, agent });

  it("puts a straight conversation entirely on the branch, and says nothing about branches", () => {
    const nodes = [n(null), n("a"), n("b", "a"), n("c", "b")];
    const branch = branchOf(nodes);
    expect(branch.forked).toBe(false);
    expect(nodes.map((node) => placeOf(node, branch))).toEqual(["main", "main", "main", "main"]);
  });

  it("marks what the agent left behind once it really forked: the leaf is the last entry, the branch its ancestry", () => {
    // a ─ b ─ c            (abandoned)
    //      └─ d ─ e        (current)
    const nodes = [n("a"), n("b", "a"), n("c", "b"), n("d", "b"), n("e", "d")];
    const branch = branchOf(nodes);
    expect(branch.forked).toBe(true);
    expect([...branch.onBranch].sort()).toEqual(["a", "b", "d", "e"]);
    expect(nodes.map((node) => placeOf(node, branch))).toEqual(["main", "main", "other", "main", "main"]);
  });

  it("does not mistake a stray root for a fork", () => {
    const nodes = [n("a"), n("b", "a"), n("loose"), n("c", "b")];
    expect(nodes.map((node) => placeOf(node, branchOf(nodes)))).toEqual(["main", "main", "main", "main"]);
  });

  it("leaves Claude Code alone: parallel tool results hang off sibling entries and are not a fork", () => {
    // assistant A2 and A3 call tools in parallel; each result's parent is the entry that made the call.
    const nodes = [n("A1", null, false, "claude"), n("A2", "A1", false, "claude"), n("A3", "A2", false, "claude"), n("U1", "A2", false, "claude"), n("U2", "A3", false, "claude"), n("A4", "U2", false, "claude")];
    const branch = branchOf(nodes);
    expect(branch.forked).toBe(false);
    expect(nodes.map((node) => placeOf(node, branch))).toEqual(["main", "main", "main", "main", "main", "main"]);
  });

  it("treats sub-agent chains as their own thing, never as an abandoned branch or as the leaf", () => {
    const nodes = [n("a"), n("b", "a"), n("s1", "b", true), n("s2", "s1", true), n("c", "b")];
    const branch = branchOf(nodes);
    expect(branch.forked).toBe(false);
    expect(nodes.map((node) => placeOf(node, branch))).toEqual(["main", "main", "sidechain", "sidechain", "main"]);
  });

  it("survives a missing parent, a cycle and an empty file", () => {
    expect(branchOf([n("b", "gone"), n("c", "b"), n("d", "b")]).forked).toBe(true);
    expect([...branchOf([n("b", "gone"), n("c", "b"), n("d", "b")]).onBranch].sort()).toEqual(["b", "d"]);
    const cycle = [n("a", "b"), n("b", "a"), n("c", "a")];
    expect(() => branchOf(cycle)).not.toThrow();
    expect(branchOf([]).forked).toBe(false);
  });
});

describe("showing values", () => {
  it("summarizes a tool call by the argument that says what it is about", () => {
    expect(callSummary({ command: "ls -la\necho hi" })).toBe("ls -la");
    expect(callSummary({ file_path: "src/a.ts", content: "x" })).toBe("src/a.ts");
    expect(callSummary({ pattern: "TODO" })).toBe("TODO");
    expect(callSummary({ command: "x".repeat(300) })).toHaveLength(141);
    expect(callSummary({ unrelated: 1 })).toBe("");
    expect(callSummary("just a string")).toBe("just a string");
    expect(callSummary(undefined)).toBe("");
  });

  it("lays arguments out as rows, strings as written", () => {
    expect(inputRows({ path: "a.ts", content: "line 1\nline 2", options: { force: true } })).toEqual([
      ["path", "a.ts"], ["content", "line 1\nline 2"], ["options", pretty({ force: true })],
    ]);
    expect(inputRows("plain")).toEqual([["", "plain"]]);
    expect(inputRows(undefined)).toEqual([]);
    expect(inputRows(null)).toEqual([]);
  });

  it("clips long text without cutting a character in two", () => {
    expect(clip("short", 10)).toEqual({ shown: "short", hidden: 0 });
    expect(clip("abcdefghij", 4)).toEqual({ shown: "abcd", hidden: 6 });
    const emoji = "ab🙂cd"; // the emoji is two UTF-16 units at index 2–3
    expect(clip(emoji, 3)).toEqual({ shown: "ab", hidden: 4 });
    expect(clip(emoji, 4)).toEqual({ shown: "ab🙂", hidden: 2 });
  });

  it("makes a picture from base64 only for common raster types", () => {
    expect(imageSrc({ mime: "image/png", data: "QUJD" })).toBe("data:image/png;base64,QUJD");
    expect(imageSrc({ mime: "image/jpeg", data: "QUJDRA==" })).toBe("data:image/jpeg;base64,QUJDRA==");
    for (const bad of [
      { mime: "image/svg+xml", data: "QUJD" },
      { mime: "text/html", data: "QUJD" },
      { mime: "image/png", data: 'QUJD" onerror="x' },
      { mime: "image/png", data: "" },
      { mime: "image/png", data: "QUJD\n" },
      { mime: "", data: "QUJD" },
      null,
    ]) expect(imageSrc(bad as never), JSON.stringify(bad)).toBeNull();
  });
});
