// On-demand history reads (connector-pi.md §11.4): a normalized transcript of one worker's
// session — roles, text (truncated), tool-call summaries — with a maxBytes cap and a
// pagination cursor. Two sources feed the same normalizer: the live process
// (`get_entries{since}`) and the session JSONL parsed directly along the current branch
// (walking back from the leaf via parentId), used when no process is running.
//
// Session file shape (pi research §"Sessions"): first line is a `{type:"session"}` header,
// the rest are tree entries `{id, parentId, type, ...}`; `message` entries carry
// `message.role/content/stopReason`; assistant tool calls are content blocks
// `{type:"toolCall", name, arguments}`; tool results come back as `message` entries with
// role "toolResult".
import { readFileSync } from "node:fs";
import {
  HISTORY_ENTRY_TEXT_MAX_CHARS,
  HISTORY_MAX_BYTES,
  HISTORY_TOOL_ARGS_MAX_CHARS,
  HISTORY_TOOLS_MAX,
  type HistoryEntry,
  type HistoryPage,
} from "@alexlikevibe/protocol";

/** Bookkeeping entries that are not conversation content. */
const SKIPPED_ENTRY_TYPES = new Set(["usage", "label", "session_info", "compaction", "model_change", "custom"]);

interface SessionEntry {
  id?: unknown;
  parentId?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  } | null;
}

export interface NormalizeOptions {
  /** Only entries after this entry id (already applied by `get_entries{since}` on the live path). */
  since?: string;
  /** Cumulative JSON-byte budget for the normalized entries (default 2 MB). */
  maxBytes?: number;
}

/**
 * Normalizes already-ordered session entries (branch order, oldest first) into a HistoryPage.
 * Shared by the live `get_entries` path and the JSONL branch walk. Pure: no I/O.
 */
export function normalizeSessionEntries(entries: SessionEntry[], opts: NormalizeOptions = {}): HistoryPage {
  const maxBytes = opts.maxBytes ?? HISTORY_MAX_BYTES;
  const since = opts.since;
  const out: HistoryEntry[] = [];
  let bytes = 0;
  let cursor: string | null = null;
  let skippedSince = !since; // without `since` everything counts as "after"

  for (const entry of entries) {
    if (entry.type === "session") continue;
    if (since && entry.id === since) {
      skippedSince = true;
      continue;
    }
    const normalized = normalizeEntry(entry);
    if (!normalized) continue; // bookkeeping / toolResult / system messages: not transcript
    if (!skippedSince) continue;
    const size = jsonBytes(normalized);
    if (bytes + size > maxBytes) {
      return { entries: out, cursor, done: false };
    }
    out.push(normalized);
    cursor = normalized.id;
    bytes += size;
  }
  return { entries: out, cursor, done: true };
}

/**
 * Parses a session JSONL directly and reads along the current branch: the chain from the
 * file's last tree entry back to the root (forks/steer restarts leave off-branch entries in
 * the file; only the live branch is the conversation pi would continue).
 */
export function readSessionHistory(sessionFile: string, opts: NormalizeOptions = {}): HistoryPage {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch {
    return { entries: [], cursor: null, done: true }; // no file → nothing ever happened
  }
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // a torn mid-crash write; skip it like the §9.1 tail reader does
    }
  }
  return normalizeSessionEntries(currentBranch(entries), opts);
}

/** The branch ending at the file's last tree entry, oldest-first. */
function currentBranch(entries: SessionEntry[]): SessionEntry[] {
  const tree = entries.filter((e) => e.type !== "session" && typeof e.id === "string");
  if (tree.length === 0) return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of tree) byId.set(entry.id as string, entry);
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = tree[tree.length - 1];
  // Cycle-proof by construction: a chain longer than the tree must contain a cycle; stop.
  while (current && chain.length < tree.length) {
    chain.push(current);
    const parent = current.parentId;
    current = typeof parent === "string" && parent !== current.id ? byId.get(parent) : undefined;
  }
  return chain.reverse();
}

function normalizeEntry(entry: SessionEntry): HistoryEntry | null {
  if (entry.type !== "message" || !entry.message) return null;
  const role = entry.message.role;
  if (role !== "user" && role !== "assistant") return null; // toolResult/system: not shown
  const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
  if (!id) return null; // no id → cannot be cursor-addressed
  const { text, tools } = normalizeContent(entry.message.content);
  const normalized: HistoryEntry = { id, role, text: text.slice(0, HISTORY_ENTRY_TEXT_MAX_CHARS) };
  if (tools.length > 0) normalized.tools = tools;
  return normalized;
}

function normalizeContent(content: unknown): { text: string; tools: NonNullable<HistoryEntry["tools"]> } {
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };
  let text = "";
  const tools: NonNullable<HistoryEntry["tools"]> = [];
  let toolCalls = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      text += b.text;
    } else if (b.type === "toolCall" && typeof b.name === "string") {
      toolCalls += 1;
      if (tools.length < HISTORY_TOOLS_MAX) {
        const args = summarizeArgs(b.arguments);
        tools.push(args === undefined ? { name: b.name } : { name: b.name, args });
      }
    }
    // toolResult/image blocks: shown through the assistant's tool-call summary, not verbatim.
    // toolCalls past HISTORY_TOOLS_MAX are summarized below — the point of the cap is that
    // one entry can never outgrow the 256 KiB chunk limit (protocol §3.6).
  }
  if (toolCalls > HISTORY_TOOLS_MAX) {
    tools.push({ name: `+${toolCalls - HISTORY_TOOLS_MAX} more tool calls` });
  }
  return { text, tools };
}

/** First 80 chars of the target-ish argument — a path or command, never file contents (§11.2). */
function summarizeArgs(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const raw = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "filename", "command", "pattern", "query", "url"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, HISTORY_TOOL_ARGS_MAX_CHARS);
  }
  return undefined;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
