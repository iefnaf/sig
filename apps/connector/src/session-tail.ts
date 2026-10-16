// Session-tail inspection, docs/design/connector-pi.md §9.1 step 3. After a connector crash
// every worker that was in flight gets the tail of its session JSONL read: a complete
// wrap-up — the last entry is the assistant's FINAL message (stopReason "stop") and `report`
// was called inside the run window — is settled retroactively; anything else means the run
// was interrupted → `lost`; a session with no user message at all was interrupted during
// startup → `not_started` (there is no run to resume).
//
// Session file shape (pi research §"Sessions", session-manager.d.ts): the first line is a
// header, the rest are tree entries; `message` entries carry `message.role/content/stopReason`;
// assistant tool calls are content blocks of `{type: "toolCall", name, arguments}`.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ReportPayload } from "./agent.ts";
import { normalizeReport } from "./pi-adapter.ts";

export type SessionTail =
  | { kind: "settled"; report: ReportPayload }
  | { kind: "lost" }
  | { kind: "not_started" };

/** Enough tail to cover a wrap-up (prompt → tool calls → final message) without reading
 * whole sessions; the same order of magnitude as the stderr tail cap (§4.4). */
const DEFAULT_TAIL_BYTES = 256 * 1024;

/** Bookkeeping entries that may legitimately follow the assistant's final message. */
const IGNORABLE_TAIL_TYPES = new Set(["usage", "label", "session_info"]);

interface TailEntry {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: unknown;
  };
}

export function inspectSessionTail(
  sessionFile: string | null | undefined,
  opts: { tailBytes?: number } = {},
): SessionTail {
  if (!sessionFile) return { kind: "not_started" };
  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch {
    return { kind: "not_started" }; // no session file → no run ever started (or nothing to read)
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { kind: "not_started" };
    const length = Math.min(size, opts.tailBytes ?? DEFAULT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return adjudicateTail(parseTailEntries(buffer.toString("utf8"), size > length));
  } finally {
    closeSync(fd);
  }
}

function parseTailEntries(text: string, droppedLeadingLine: boolean): TailEntry[] {
  const lines = text.split("\n");
  if (droppedLeadingLine) lines.shift(); // a line straddling the read boundary
  if (lines[lines.length - 1] === "") lines.pop(); // well-formed trailing newline
  else lines.pop(); // a torn final write mid-crash: unparseable by definition, drop it
  const entries: TailEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TailEntry);
    } catch {
      // skip (a corrupted middle line must not fail the whole tail)
    }
  }
  return entries;
}

function adjudicateTail(entries: TailEntry[]): SessionTail {
  const meaningful = entries.filter((e) => e.type !== "session" && !IGNORABLE_TAIL_TYPES.has(e.type));
  if (meaningful.length === 0) return { kind: "not_started" };

  // The run window starts after the LAST user message (the delivered prompt, or a forced
  // continuation). No user message anywhere → the prompt never reached the session.
  let windowStart = -1;
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const entry = meaningful[i]!;
    if (entry.type === "message" && entry.message?.role === "user") {
      windowStart = i;
      break;
    }
  }
  if (windowStart === -1) return { kind: "not_started" };

  // Wrap-up: the last meaningful entry must be the assistant's final message.
  const last = meaningful[meaningful.length - 1]!;
  const lastMessage = last.type === "message" ? last.message : undefined;
  if (lastMessage?.role !== "assistant" || lastMessage.stopReason !== "stop") return { kind: "lost" };

  // `report` inside the window, LAST call wins (§5.2 item 3); a report from an earlier run
  // (before the last user message) does not count.
  const window = meaningful.slice(windowStart + 1);
  for (let i = window.length - 1; i >= 0; i--) {
    const message = window[i]!.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j] as { type?: string; name?: string; arguments?: unknown } | null;
      if (block?.type === "toolCall" && block.name === "report") {
        const report = normalizeReport(block.arguments);
        if (report) return { kind: "settled", report };
      }
    }
  }
  return { kind: "lost" };
}
