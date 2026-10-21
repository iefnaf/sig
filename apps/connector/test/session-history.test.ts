// Session-history reads (connector-pi.md §11.4): the JSONL fallback parses the session file
// along the CURRENT branch (walking back from the leaf via parentId — forks leave off-branch
// entries in the file), normalizes to roles/text/tool summaries, truncates, and caps at
// maxBytes with a pagination cursor.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeSessionEntries, readSessionHistory } from "../src/session-history.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sig-session-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function entry(id: string, parentId: string | null, body: Record<string, unknown>): Record<string, unknown> {
  return { id, parentId, timestamp: Date.now(), ...body };
}

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", message: { role: "user", content: text } };
}

function assistantMessage(content: unknown, stopReason = "stop"): Record<string, unknown> {
  return { type: "message", message: { role: "assistant", content, stopReason } };
}

/** A session whose live branch is e1 → e2 → e3(toolResult) → e7, with e6 forked off e1. */
function branchFixture(): Array<Record<string, unknown>> {
  return [
    entry("e1", null, userMessage("/sig cmd-1\nFix the login bug")),
    entry("e2", "e1", assistantMessage([{ type: "text", text: "Working on it" }, { type: "toolCall", id: "c1", name: "edit", arguments: { file_path: "src/auth/session.ts" } }])),
    entry("e3", "e2", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [] } }),
    entry("e4", "e2", { type: "usage", tokens: { input: 10 } }),
    entry("e5", "e2", { type: "custom", commandId: "cmd-1" }),
    entry("e6", "e1", assistantMessage("abandoned fork")),
    entry("e7", "e3", assistantMessage([{ type: "text", text: "Done" }])),
  ];
}

function writeFixture(name: string, entries: Array<Record<string, unknown>>): string {
  const path = join(dir, `${name}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: dir }),
    ...entries.map((e) => JSON.stringify(e)),
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("readSessionHistory (JSONL along the current branch)", () => {
  it("reads only the current branch, normalized: roles, text, tool summaries; bookkeeping skipped", () => {
    const file = writeFixture("w-branch", branchFixture());
    const page = readSessionHistory(file);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e7");
    expect(page.entries).toEqual([
      { id: "e1", role: "user", text: "/sig cmd-1\nFix the login bug" },
      {
        id: "e2",
        role: "assistant",
        text: "Working on it",
        tools: [{ name: "edit", args: "src/auth/session.ts" }],
      },
      { id: "e7", role: "assistant", text: "Done" },
    ]);
  });

  it("caps tool-call summaries at 50 with a count marker (one entry can never outgrow a chunk)", () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `echo ${i}` } }));
    const file = writeFixture("w-tools", [
      entry("e1", null, userMessage("go")),
      entry("e2", "e1", assistantMessage([{ type: "text", text: "working" }, ...blocks])),
    ]);
    const page = readSessionHistory(file);
    const tools = page.entries[1]!.tools!;
    expect(tools).toHaveLength(51); // 50 summaries + the count marker
    expect(tools[49]).toEqual({ name: "bash", args: "echo 49" });
    expect(tools[50]).toEqual({ name: "+4950 more tool calls" });
    // The normalized entry stays far below the 256 KiB chunk cap.
    expect(Buffer.byteLength(JSON.stringify(page.entries[1]))).toBeLessThan(16 * 1024);
  });

  it("truncates overly long text to 4000 chars and tool args to 80", () => {
    const long = "x".repeat(10_000);
    const deepPath = `${"d/".repeat(60)}file.ts`;
    const file = writeFixture("w-trunc", [
      entry("e1", null, userMessage(long)),
      entry("e2", "e1", assistantMessage([{ type: "text", text: long }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: deepPath } }])),
    ]);
    const page = readSessionHistory(file);
    expect(page.entries[0]!.text).toHaveLength(4000);
    expect(page.entries[1]!.text).toHaveLength(4000);
    expect(page.entries[1]!.tools).toEqual([{ name: "bash", args: deepPath.slice(0, 80) }]);
  });

  it("resumes after the since cursor along the branch", () => {
    const file = writeFixture("w-since", branchFixture());
    const page = readSessionHistory(file, { since: "e2" });
    expect(page.entries.map((e) => e.id)).toEqual(["e7"]);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e7");
  });

  it("stops at maxBytes with done=false and a resumable cursor", () => {
    const file = writeFixture("w-budget", branchFixture());
    const whole = readSessionHistory(file);
    const sizeOfFirst = JSON.stringify(whole.entries[0]).length;
    const page = readSessionHistory(file, { maxBytes: sizeOfFirst + 10 });
    expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(page.done).toBe(false);
    expect(page.cursor).toBe("e1");
    // Continuing from the cursor delivers the rest of the branch.
    const rest = readSessionHistory(file, { since: page.cursor! });
    expect(rest.entries.map((e) => e.id)).toEqual(["e2", "e7"]);
  });

  it("returns an empty done page for a missing file, an empty file, or content-free entries", () => {
    expect(readSessionHistory(join(dir, "never-written.jsonl"))).toEqual({ entries: [], cursor: null, done: true });
    const onlyBookkeeping = writeFixture("w-quiet", [entry("e1", null, { type: "usage" })]);
    expect(readSessionHistory(onlyBookkeeping)).toEqual({ entries: [], cursor: null, done: true });
  });

  it("skips a torn final line (a crash mid-write) instead of failing", () => {
    const path = join(dir, "w-torn.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "w-torn" }),
      JSON.stringify(entry("e1", null, userMessage("hello"))),
      JSON.stringify(entry("e2", "e1", assistantMessage([{ type: "text", text: "half-writ" }]))).slice(0, 40), // torn
    ];
    writeFileSync(path, lines.join("\n") + "\n");
    const page = readSessionHistory(path);
    expect(page.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(page.done).toBe(true);
  });
});

describe("normalizeSessionEntries (the live get_entries path's shared normalizer)", () => {
  it("normalizes pi's get_entries payload shape (header included, string content)", () => {
    const page = normalizeSessionEntries([
      { type: "session", id: "s1" },
      entry("e1", null, userMessage("do it")),
      entry("e2", "e1", assistantMessage("did it")),
    ]);
    expect(page.entries).toEqual([
      { id: "e1", role: "user", text: "do it" },
      { id: "e2", role: "assistant", text: "did it" },
    ]);
    expect(page.done).toBe(true);
    expect(page.cursor).toBe("e2");
  });

  it("system-prompt-shaped messages are not transcript", () => {
    const page = normalizeSessionEntries([entry("e0", null, { type: "message", message: { role: "system", content: "You are…" } })]);
    expect(page.entries).toEqual([]);
    expect(page.done).toBe(true);
  });
});
