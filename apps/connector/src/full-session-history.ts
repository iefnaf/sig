// Full-fidelity session reads (ADR-0003): the recorded session file as the agent wrote it, one
// JSONL record per entry, handed to the browser in bounded fragments. Nothing is summarized or
// cut here — a record larger than a page simply spans several pages — and nothing is parsed:
// the browser reassembles and interprets the record, so a damaged line costs one entry in the
// viewer, not the whole read. Only the worker's own session file is ever opened.
import { createReadStream, existsSync, readdirSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, HistoryPage } from "@alexlikevibe/protocol";

/** Characters of one record per wire entry; keeps an entry far below the 256 KiB chunk cap. */
const FRAGMENT_CHARS = 24 * 1024;
/** One record larger than this is refused rather than buffered (a runaway tool result). */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;
/** Per-page allowance for the chunk envelope around the entries. */
const PAGE_OVERHEAD = 1024;
const ENTRY_OVERHEAD = 512;

/** Where the next read starts: a byte offset, plus how far into that record the reader got. */
interface Cursor {
  byte: number;
  offset: number;
  /** Hash of the record being resumed mid-way, so a rewritten line is noticed instead of spliced. */
  hash?: string;
  /** The file the cursor was issued for; a different file is a different session. */
  ino?: number;
}

const encode = (cursor: Cursor): string => `full.${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function decode(value: string | undefined): Cursor {
  if (!value) return { byte: 0, offset: 0 };
  try {
    if (!value.startsWith("full.") || value.length > 1024) throw new Error("shape");
    const cursor = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")) as Cursor;
    const whole = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!whole(cursor.byte) || !whole(cursor.offset) || (cursor.ino !== undefined && !whole(cursor.ino))) throw new Error("fields");
    if (cursor.offset > 0 && typeof cursor.hash !== "string") throw new Error("hash");
    return cursor;
  } catch {
    throw failure("cursor_invalid", "That position in the session is not valid. Reload its history.");
  }
}

interface Line {
  text: string;
  /** Byte offset of the first character of the line. */
  byte: number;
  /** Byte offset after the line and its newline. */
  next: number;
  /** False for a trailing line with no newline yet: its writer may still be appending. */
  terminated: boolean;
}

/** Lines from `start`, each held whole (one record) but never the file. Linear in the line's length. */
async function* lines(path: string, start: number): AsyncGenerator<Line> {
  const stream = createReadStream(path, { start });
  const parts: Buffer[] = [];
  let length = 0;
  let byte = start;
  const take = (): string => {
    const text = Buffer.concat(parts, length).toString("utf8");
    parts.length = 0;
    length = 0;
    return text;
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0;
      for (let end = chunk.indexOf(10, from); end >= 0; end = chunk.indexOf(10, from)) {
        parts.push(chunk.subarray(from, end));
        length += end - from;
        const next = byte + length + 1;
        yield { text: take(), byte, next, terminated: true };
        byte = next;
        from = end + 1;
      }
      if (from < chunk.length) {
        parts.push(chunk.subarray(from));
        length += chunk.length - from;
        if (length > MAX_RECORD_BYTES) throw failure("history_too_large", "A recorded entry is too large to show.");
      }
    }
    if (length > 0) yield { text: take(), byte, next: byte + length, terminated: false };
  } finally {
    stream.destroy();
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/**
 * One page of the session file starting at `since` (a cursor from a previous page, or none for
 * the beginning). Reading stops when the page budget is spent, the end of the file is reached,
 * or the last line is still being written; `done` says which of the first two it was.
 */
export async function readFullSessionHistory(path: string, since: string | undefined, maxBytes: number): Promise<HistoryPage> {
  const start = decode(since);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw failure("no_history", since ? "The local session file is gone." : "The local session file does not exist (yet).");
    }
    throw failure("no_history", "The local session file cannot be read.");
  }
  if (!info.isFile()) throw failure("no_history", "The local session record is not a file.");
  if ((start.ino !== undefined && start.ino !== info.ino) || start.byte > info.size) {
    throw failure("cursor_invalid", "The local session was replaced. Reload its history.");
  }
  if (maxBytes < 4096) throw failure("history_budget", "The history byte budget is too small.");
  const ino = info.ino;
  const entries: HistoryEntry[] = [];
  let cursor = since ?? encode({ byte: 0, offset: 0, ino });
  let budget = maxBytes - PAGE_OVERHEAD;

  for await (const line of lines(path, start.byte)) {
    if (!line.terminated) break; // a writer is mid-append; the next read picks it up whole
    if (line.text.trim() === "") {
      cursor = encode({ byte: line.next, offset: 0, ino });
      continue;
    }
    const data = line.text;
    const id = `L${line.byte}`;
    let offset = line.byte === start.byte ? start.offset : 0;
    let hash: string | undefined;
    if (offset > 0) {
      hash = sha256(data);
      if (offset >= data.length || hash !== start.hash) throw failure("cursor_invalid", "A session entry changed while it was being read.");
    }
    while (offset < data.length) {
      let length = Math.min(FRAGMENT_CHARS, data.length - offset);
      let entry: HistoryEntry;
      let bytes: number;
      for (;;) {
        let end = offset + length;
        // Never cut a character in two: an emoji is one pair of UTF-16 units.
        if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end = end - 1 > offset ? end - 1 : end + 1;
        length = end - offset;
        if (end < data.length) hash ??= sha256(data);
        const next: Cursor = end === data.length ? { byte: line.next, offset: 0, ino } : { byte: line.byte, offset: end, hash, ino };
        entry = { id, role: "record", text: "", fragment: { data: data.slice(offset, end), offset, total: data.length }, nextCursor: encode(next) };
        bytes = Buffer.byteLength(JSON.stringify(entry)) + ENTRY_OVERHEAD;
        if (bytes <= budget || length <= 2) break;
        length = Math.floor(length / 2);
      }
      if (bytes > budget) return { format: "full", entries, cursor, done: false };
      entries.push(entry);
      cursor = entry.nextCursor!;
      budget -= bytes;
      offset += length;
      if (budget < 2 * ENTRY_OVERHEAD) return { format: "full", entries, cursor, done: false };
    }
  }
  return { format: "full", entries, cursor, done: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code keeps a session's transcript at `<config>/projects/<cwd, non-alphanumerics as "-">/<uuid>.jsonl`.
 * The folder name is its convention, not ours, so when the computed place is empty the session id
 * (a UUID, unique to the worker) finds the file anywhere under `projects`.
 */
export function claudeSessionPath(cwd: string, sessionId: string, configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string | null {
  if (!UUID.test(sessionId)) throw failure("no_history", "That is not a Claude Code session id.");
  const projects = join(configDir, "projects");
  const folders = new Set([cwd]);
  try {
    folders.add(realpathSync(cwd)); // Claude Code names the folder after the physical working directory
  } catch {
    // The directory is gone (a cleaned-up worktree); the session id search below still works.
  }
  for (const folder of folders) {
    const candidate = join(projects, folder.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No projects folder: Claude Code has not written anything on this machine.
  }
  return null;
}
