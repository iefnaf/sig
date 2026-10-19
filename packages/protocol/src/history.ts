// History (L3 raw transcript) relay messages, docs/design/connector-do-protocol.md §6.6 and
// connector-pi.md §11.4. The DO is a pure relay: the browser asks, the connector answers in
// chunks, and the content passes through DO memory without ever being written to its storage.
import { z } from "zod";

/** Cumulative cap for one stream, 2 MB (protocol §6.6; also the default when unset). */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** Each chunk message is capped at 256 KiB (protocol §3.6 / §6.6). */
export const HISTORY_CHUNK_MAX_BYTES = 256 * 1024;
/** Simple window control between connector and browser: 2 chunks in flight (protocol §6.6). */
export const HISTORY_WINDOW_SIZE = 2;
/** A relay row that has not finished within 60 s is dropped (protocol §6.6). */
export const HISTORY_RELAY_TTL_MS = 60_000;
/** Per-entry text truncation (connector-pi.md §11.4 "truncated when overly long"). */
export const HISTORY_ENTRY_TEXT_MAX_CHARS = 4000;
/** Tool-argument summaries carry a path/command only, first 80 chars (connector-pi.md §11.2). */
export const HISTORY_TOOL_ARGS_MAX_CHARS = 80;
/** Tool-call summaries per entry: bounds a single normalized entry far below the chunk cap
 * even for a message with thousands of tool calls. */
export const HISTORY_TOOLS_MAX = 50;

/** One normalized transcript entry: role, text, tool-call summaries (connector-pi.md §11.4). */
export const HistoryEntrySchema = z.object({
  /** The session entry id — doubles as the pagination cursor. */
  id: z.string().min(1),
  /** `record` is a raw recorded entry of a full-session read (`fragment` carries its text). */
  role: z.enum(["user", "assistant", "record"]),
  /** Full-session reads: one piece of the entry's JSON text — `data` is characters
   * `offset`…`offset + data.length` of `total`; the browser joins the pieces and parses. */
  fragment: z.object({ data: z.string(), offset: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
  /** Full-session reads: where to resume after this entry (an opaque cursor). */
  nextCursor: z.string().optional(),
  text: z.string(),
  tools: z.array(z.object({ name: z.string(), args: z.string().optional() })).optional(),
});

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** A page of normalized history: `cursor` is the last entry included; `done` marks the end. */
export interface HistoryPage {
  format?: "full";
  entries: HistoryEntry[];
  /** Last entry id delivered, or null when nothing fit / nothing exists. */
  cursor: string | null;
  /** True when the whole transcript (after `since`) fit within maxBytes. */
  done: boolean;
}

/** browser → DO: open a stream for one worker's raw transcript. */
export const HistoryOpenMessageSchema = z.object({
  t: z.literal("history_open"),
  format: z.literal("full").optional(),
  id: z.string().min(1),
  workerId: z.string().min(1),
  since: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
});

export type HistoryOpenMessage = z.infer<typeof HistoryOpenMessageSchema>;

/** DO → connector: pull one page. Not a `cmd` — never queued, persisted, or re-sent (§6.6). */
export const HistoryReqMessageSchema = z.object({
  t: z.literal("history_req"),
  format: z.literal("full").optional(),
  id: z.string().min(1),
  workerId: z.string().min(1),
  since: z.string().min(1).optional(),
  maxBytes: z.number().int().positive(),
});

export type HistoryReqMessage = z.infer<typeof HistoryReqMessageSchema>;

/** connector → DO → browser: one chunk of normalized entries. */
export const HistoryChunkMessageSchema = z.object({
  t: z.literal("history_chunk"),
  format: z.literal("full").optional(),
  re: z.string().min(1),
  n: z.number().int().nonnegative(),
  entries: z.array(HistoryEntrySchema),
  cursor: z.string().nullable().optional(),
  done: z.boolean(),
  /** The page this chunk ends was cut by the maxBytes budget: re-opening with
   * `since=cursor` continues (or reports "nothing more"). Absent on complete pages. */
  truncated: z.boolean().optional(),
});

export type HistoryChunkMessage = z.infer<typeof HistoryChunkMessageSchema>;

/** browser → DO → connector: chunk `n` of request `re` reached the browser (§6.6 window). */
export const HistoryAckMessageSchema = z.object({
  t: z.literal("history_ack"),
  re: z.string().min(1),
  n: z.number().int().nonnegative(),
});

export type HistoryAckMessage = z.infer<typeof HistoryAckMessageSchema>;

/** DO → browser: the machine holding this worker is not connected (§6.6). */
export const MachineOfflineMessageSchema = z.object({
  t: z.literal("machine_offline"),
  re: z.string().min(1),
});

export type MachineOfflineMessage = z.infer<typeof MachineOfflineMessageSchema>;
