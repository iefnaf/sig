// Bounded, conservative session observations for crash recovery and pre-launch comparison
// (connector-pi.md §6.3/§10). Absence is evidence only when the entire relevant tail was read.
// COMMAND_ENTRY_TYPE must match ext/sig-pi.ts (the extension writes the marker; this
// reader looks for it — the string literal is duplicated because the extension file is
// shipped standalone into ~/.sig/ext and must not import connector sources).
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { redactText } from "./redact.ts";

export const COMMAND_ENTRY_TYPE = "sig.command";
const TAIL_BYTES = 256 * 1024;
type Entry = Record<string, unknown> & { id?: string; type: string };

export interface SessionObservation {
  entries: Entry[];
  lastEntryId: string | null;
  readable: boolean;
  complete: boolean;
  truncated: boolean;
}

export function observeSession(file: string | null | undefined, tailBytes = TAIL_BYTES): SessionObservation {
  const unavailable: SessionObservation = { entries: [], lastEntryId: null, readable: false, complete: false, truncated: false };
  if (!file) return unavailable;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const before = fstatSync(fd);
    if (!before.isFile()) return unavailable;
    const length = Math.min(before.size, tailBytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, before.size - length);
    const after = fstatSync(fd);
    const truncated = before.size > length;
    const text = buffer.subarray(0, read).toString("utf8");
    const lines = text.split("\n");
    if (truncated) lines.shift(); // may start inside a JSON record (or a UTF-8 character)
    let complete = read === length && before.size === after.size && before.mtimeMs === after.mtimeMs;
    if (lines.pop() !== "") complete = false; // torn final record, even if it looks parseable
    const entries: Entry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== "object" || typeof entry.type !== "string") {
          complete = false;
          continue;
        }
        if (entry.type === "session") continue;
        if (typeof entry.id !== "string") complete = false;
        entries.push(entry);
      } catch {
        complete = false;
      }
    }
    return { entries, lastEntryId: entries.at(-1)?.id ?? null, readable: true, complete, truncated };
  } catch {
    return unavailable;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type CommandDelivery = "delivered" | "not_delivered" | "ambiguous";
export function inspectCommandDelivery(
  file: string | null | undefined,
  commandId: string,
  afterEntryId?: string | null,
  tailBytes?: number,
): CommandDelivery {
  const tail = observeSession(file, tailBytes);
  // Markers are append-order evidence, including abandoned branches. Text equality is
  // never evidence: two commands may deliberately contain the exact same instruction.
  if (tail.entries.some((e) => e.type === "custom" && e.customType === COMMAND_ENTRY_TYPE &&
    (e.data as { commandId?: unknown } | null)?.commandId === commandId)) return "delivered";
  if (!tail.readable || !tail.complete) return "ambiguous";
  if (tail.truncated && !tail.entries.some((e) => e.id === afterEntryId)) return "ambiguous";
  return "not_delivered";
}

export interface ExternalActivity {
  entryCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  lastEntryId: string | null;
  partial: boolean;
  summary: string;
  changedFiles: string[];
}

export function externalActivity(tail: SessionObservation, lastKnownEntryId: string | null | undefined): ExternalActivity | null {
  if (!tail.readable || tail.lastEntryId === (lastKnownEntryId ?? null)) return null;
  const index = lastKnownEntryId ? tail.entries.findIndex((e) => e.id === lastKnownEntryId) : -1;
  const entries = tail.entries.slice(index + 1);
  const partial = !tail.complete || tail.truncated && index === -1 || !!lastKnownEntryId && index === -1;
  const users: string[] = [];
  const files = new Set<string>();
  for (const entry of entries) {
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "user") {
      const content = message.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ") : "";
      if (text) users.push(redactText(text.replace(/\s+/g, " ")).slice(0, 160));
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type !== "toolCall" || !["edit", "write"].includes(block.name)) continue;
        const path = block.arguments?.path ?? block.arguments?.file_path;
        if (typeof path === "string") files.add(redactText(path).slice(0, 160));
      }
    }
  }
  const changedFiles = [...files].slice(0, 20);
  const summary = [
    users.length ? `User messages: ${users.slice(-3).join("; ")}` : "Session entries changed.",
    changedFiles.length ? `Files touched by edit/write calls: ${changedFiles.join(", ")}` : "",
    partial ? "Only the available tail is summarized; earlier entries may be missing." : "",
  ].filter(Boolean).join(" ").slice(0, 1000);
  const timestamp = (entry: Entry | undefined): string | null => typeof entry?.timestamp === "string" ? entry.timestamp : null;
  return { entryCount: entries.length, firstTimestamp: timestamp(entries[0]), lastTimestamp: timestamp(entries.at(-1)),
    lastEntryId: tail.lastEntryId, partial, summary, changedFiles };
}
