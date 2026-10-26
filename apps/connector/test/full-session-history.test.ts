// ADR-0003: the full recorded session, read straight from the agent's own file in bounded,
// resumable fragments. What matters: every byte of every record can be recovered (long entries
// span pages, characters are never cut in two), a position that no longer fits the file is
// refused rather than spliced, and a file that is missing is said to be missing.
import { appendFileSync, mkdirSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryPage } from "@alexlikevibe/protocol";
import { claudeSessionPath, readFullSessionHistory } from "../src/full-session-history.ts";
import { tmpDir } from "./helpers.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = tmpDir("sig-full-history");
  file = join(dir, "session.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** What the browser does: join each entry's fragments back into the record's JSON text. */
function reassemble(pages: HistoryPage[]): string[] {
  const records: string[] = [];
  let open: { id: string; total: number; parts: string[]; length: number } | null = null;
  for (const entry of pages.flatMap((page) => page.entries)) {
    const fragment = entry.fragment!;
    if (fragment.offset === 0) open = { id: entry.id, total: fragment.total, parts: [], length: 0 };
    expect(open, `fragment of ${entry.id} at ${fragment.offset} has a start`).not.toBeNull();
    expect(open!.id).toBe(entry.id);
    expect(open!.length).toBe(fragment.offset);
    open!.parts.push(fragment.data);
    open!.length += fragment.data.length;
    if (open!.length === open!.total) {
      records.push(open!.parts.join(""));
      open = null;
    }
  }
  expect(open, "no record left half-received").toBeNull();
  return records;
}

/** Reads the whole file page by page, the way the viewer does. */
async function readAll(maxBytes: number): Promise<HistoryPage[]> {
  const pages: HistoryPage[] = [];
  let since: string | undefined;
  for (let guard = 0; guard < 500; guard++) {
    const page = await readFullSessionHistory(file, since, maxBytes);
    pages.push(page);
    since = page.cursor ?? undefined;
    if (page.done) return pages;
  }
  throw new Error("the read never finished");
}

describe("readFullSessionHistory", () => {
  it("returns every record whole and in order, as raw entries, and says it reached the end", async () => {
    const records = [
      { type: "session", version: 3, id: "s-1", cwd: "/work" },
      { type: "message", id: "a1", parentId: null, message: { role: "user", content: "fix the login bug" } },
      { type: "message", id: "a2", parentId: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
      { type: "message", id: "a3", parentId: "a2", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a\nb" }], isError: false } },
    ];
    writeFileSync(file, records.map(line).join(""));
    const page = await readFullSessionHistory(file, undefined, 1024 * 1024);
    expect(page.format).toBe("full");
    expect(page.done).toBe(true);
    expect(page.entries.every((entry) => entry.role === "record" && entry.text === "")).toBe(true);
    expect(reassemble([page]).map((text) => JSON.parse(text))).toEqual(records);
    // The text is the line as written, not a re-serialization of a parsed copy.
    expect(reassemble([page])).toEqual(records.map((record) => JSON.stringify(record)));
  });

  it("continues from the cursor: only what was appended since", async () => {
    writeFileSync(file, line({ id: "a1" }) + line({ id: "a2" }));
    const first = await readFullSessionHistory(file, undefined, 1024 * 1024);
    expect(first.entries).toHaveLength(2);
    expect((await readFullSessionHistory(file, first.cursor!, 1024 * 1024)).entries).toEqual([]); // nothing new yet
    appendFileSync(file, line({ id: "a3" }));
    const next = await readFullSessionHistory(file, first.cursor!, 1024 * 1024);
    expect(reassemble([next]).map((text) => JSON.parse(text))).toEqual([{ id: "a3" }]);
    expect(next.done).toBe(true);
  });

  it("splits a long record into fragments across pages and recovers it exactly, characters included", async () => {
    // 150 000 characters of mixed text: multi-byte, emoji (surrogate pairs), quotes, newlines.
    const unit = "日本語のテスト 🙂 \"quoted\" \\ back\nslash ✓ ";
    const huge = unit.repeat(Math.ceil(150_000 / unit.length)).slice(0, 150_000);
    const records = [{ id: "a1", text: "short" }, { id: "a2", output: huge }, { id: "a3", text: "after" }];
    writeFileSync(file, records.map(line).join(""));
    for (const maxBytes of [4096, 20_000, 1024 * 1024]) {
      const pages = await readAll(maxBytes);
      const lines = reassemble(pages);
      expect(lines.map((text) => JSON.parse(text)), `maxBytes ${maxBytes}`).toEqual(records);
      for (const entry of pages.flatMap((page) => page.entries)) {
        const data = entry.fragment!.data;
        expect(data.length).toBeLessThanOrEqual(24 * 1024);
        const last = data.charCodeAt(data.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff, "a fragment must not end between the halves of a character").toBe(false);
        expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(256 * 1024);
      }
      if (maxBytes < 100_000) expect(pages.length).toBeGreaterThan(1);
    }
  });

  it("never returns a page larger than its byte budget", async () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, text: "z".repeat(3000) }));
    writeFileSync(file, records.map(line).join(""));
    const pages = await readAll(16_000);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      const size = Buffer.byteLength(JSON.stringify(page.entries));
      expect(size).toBeLessThanOrEqual(16_000);
    }
    expect(reassemble(pages).map((text) => JSON.parse(text))).toEqual(records);
  });

  it("leaves a half-written last line for the next read, then returns it whole", async () => {
    writeFileSync(file, line({ id: "a1" }) + '{"id":"a2","text":"still being wri');
    const first = await readFullSessionHistory(file, undefined, 1024 * 1024);
    expect(reassemble([first]).map((text) => JSON.parse(text))).toEqual([{ id: "a1" }]);
    expect(first.done).toBe(true);
    appendFileSync(file, 'tten"}\n');
    const next = await readFullSessionHistory(file, first.cursor!, 1024 * 1024);
    expect(reassemble([next]).map((text) => JSON.parse(text))).toEqual([{ id: "a2", text: "still being written" }]);
  });

  it("skips blank lines and still moves the cursor past them", async () => {
    writeFileSync(file, `\n${line({ id: "a1" })}\n\n`);
    const page = await readFullSessionHistory(file, undefined, 1024 * 1024);
    expect(reassemble([page])).toEqual(['{"id":"a1"}']);
    appendFileSync(file, line({ id: "a2" }));
    expect(reassemble([await readFullSessionHistory(file, page.cursor!, 1024 * 1024)])).toEqual(['{"id":"a2"}']);
  });

  it("passes a damaged line through as it is: the viewer decides what it is worth", async () => {
    writeFileSync(file, line({ id: "a1" }) + "this is not json\n" + line({ id: "a3" }));
    const lines = reassemble([await readFullSessionHistory(file, undefined, 1024 * 1024)]);
    expect(lines).toEqual(['{"id":"a1"}', "this is not json", '{"id":"a3"}']);
  });

  it("refuses a position the file no longer matches instead of splicing", async () => {
    const records = [{ id: "a1", text: "x".repeat(60_000) }, { id: "a2" }];
    writeFileSync(file, records.map(line).join(""));
    const cut = await readFullSessionHistory(file, undefined, 8_000); // stops inside a1
    expect(cut.done).toBe(false);
    expect(cut.entries.length).toBeGreaterThan(0);

    // The same size, different content mid-record: the record changed under the reader.
    const original = records.map(line).join("");
    writeFileSync(file, original.replace(/x/g, "y"));
    await expect(readFullSessionHistory(file, cut.cursor!, 8_000)).rejects.toMatchObject({ code: "cursor_invalid" });

    // A shorter file than the cursor says: truncated and rewritten.
    writeFileSync(file, original);
    const later = await readFullSessionHistory(file, undefined, 1024 * 1024);
    truncateSync(file, 10);
    await expect(readFullSessionHistory(file, later.cursor!, 1024 * 1024)).rejects.toMatchObject({ code: "cursor_invalid" });

    // A different file in its place (a new inode), even a longer one.
    writeFileSync(file, original);
    const mid = await readFullSessionHistory(file, undefined, 1024 * 1024);
    renameSync(file, join(dir, "old.jsonl"));
    writeFileSync(file, original + line({ id: "a3" }));
    await expect(readFullSessionHistory(file, mid.cursor!, 1024 * 1024)).rejects.toMatchObject({ code: "cursor_invalid" });
  });

  it("refuses cursors it did not issue, and budgets too small to carry anything", async () => {
    writeFileSync(file, line({ id: "a1" }));
    for (const bad of ["garbage", "full.", "full.!!!", `full.${Buffer.from("[]").toString("base64url")}`, `full.${Buffer.from(JSON.stringify({ byte: -1, offset: 0 })).toString("base64url")}`, `full.${Buffer.from(JSON.stringify({ byte: 0, offset: 5 })).toString("base64url")}`, `full.${"A".repeat(2000)}`]) {
      await expect(readFullSessionHistory(file, bad, 1024 * 1024), bad.slice(0, 20)).rejects.toMatchObject({ code: "cursor_invalid" });
    }
    await expect(readFullSessionHistory(file, undefined, 100)).rejects.toMatchObject({ code: "history_budget" });
  });

  it("says when the file is missing — never an empty success", async () => {
    await expect(readFullSessionHistory(join(dir, "nope.jsonl"), undefined, 1024 * 1024)).rejects.toMatchObject({ code: "no_history", message: expect.stringMatching(/does not exist/) });
    writeFileSync(file, line({ id: "a1" }));
    const page = await readFullSessionHistory(file, undefined, 1024 * 1024);
    rmSync(file);
    await expect(readFullSessionHistory(file, page.cursor!, 1024 * 1024)).rejects.toMatchObject({ code: "no_history", message: expect.stringMatching(/gone/) });
    mkdirSync(join(dir, "folder.jsonl"));
    await expect(readFullSessionHistory(join(dir, "folder.jsonl"), undefined, 1024 * 1024)).rejects.toMatchObject({ code: "no_history" });
  });

  it("reads an empty file as an empty, finished session", async () => {
    writeFileSync(file, "");
    expect(await readFullSessionHistory(file, undefined, 1024 * 1024)).toMatchObject({ format: "full", entries: [], done: true });
  });
});

describe("claudeSessionPath", () => {
  const ID = "0b7a5d5e-6f1b-5c0e-9a53-8a5b1d3c2e10";
  let config: string;

  beforeEach(() => {
    config = join(dir, "claude-config");
  });

  it("finds the transcript where Claude Code keeps it for the working directory", () => {
    const folder = join(config, "projects", "-srv-repo-a-worktrees-w1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${ID}.jsonl`), "");
    expect(claudeSessionPath("/srv/repo-a/worktrees/w1", ID, config)).toBe(join(folder, `${ID}.jsonl`));
  });

  it("falls back to the session id when the folder name is not the one it computed", () => {
    const folder = join(config, "projects", "some-other-spelling-of-the-path");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${ID}.jsonl`), "");
    expect(claudeSessionPath("/srv/repo-a", ID, config)).toBe(join(folder, `${ID}.jsonl`));
  });

  it("says there is none when Claude Code wrote nothing here, and refuses anything that is not a session id", () => {
    expect(claudeSessionPath("/srv/repo-a", ID, config)).toBeNull();
    mkdirSync(join(config, "projects", "-srv-repo-a"), { recursive: true });
    expect(claudeSessionPath("/srv/repo-a", ID, config)).toBeNull();
    for (const bad of ["../../etc/passwd", "w-123", "", `${ID}/../x`]) expect(() => claudeSessionPath("/srv/repo-a", bad, config), bad).toThrow();
  });
});
