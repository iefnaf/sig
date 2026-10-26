// The connector's half of the §6.6 history relay: on `history_req`, load one HistoryPage and
// drip it out as `history_chunk` messages — each ≤ 256 KiB, at most 2 unacked in flight, the
// browser's `history_ack`s (relayed by the DO) releasing the next chunk. Nothing here is
// persisted: the request never enters the command table, and an unanswered stream dies with
// its 60 s idle TTL. A failed load is answered with a plain `error{re}` so the browser's
// stream terminates with a reason instead of hanging.
import {
  HISTORY_CHUNK_MAX_BYTES,
  HISTORY_MAX_BYTES,
  HISTORY_RELAY_TTL_MS,
  HISTORY_WINDOW_SIZE,
  type HistoryChunkMessage,
  type HistoryPage,
} from "@alexlikevibe/protocol";

export interface HistoryStreamDeps {
  /** Wire out (the transport's current socket). Dropping frames (closed socket) is fine. */
  send: (message: HistoryChunkMessage | { t: "error"; re: string; code: string; message: string; retriable: boolean }) => void;
  /** Loads one page (WorkerManager.history: live get_entries or the session JSONL fallback). */
  load: (workerId: string, since: string | undefined, maxBytes: number, format?: "full") => Promise<HistoryPage>;
  now?: () => number;
  windowSize?: number;
  maxChunkBytes?: number;
  idleTtlMs?: number;
}

interface StreamState {
  workerId: string;
  chunks: HistoryChunkMessage[];
  /** Index of the next chunk to send. */
  next: number;
  /** Highest contiguously acked chunk index, -1 before the first ack. */
  acked: number;
  /** Millis of the last activity (request, chunk, ack); the TTL sweep drops past idleTtlMs. */
  lastActivityAt: number;
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export class HistoryStreams {
  readonly #deps: HistoryStreamDeps;
  readonly #streams = new Map<string, StreamState>();
  readonly #windowSize: number;
  readonly #maxChunkBytes: number;
  readonly #idleTtlMs: number;
  #sweepTimer: NodeJS.Timeout | undefined;

  constructor(deps: HistoryStreamDeps) {
    this.#deps = deps;
    this.#windowSize = deps.windowSize ?? HISTORY_WINDOW_SIZE;
    this.#maxChunkBytes = deps.maxChunkBytes ?? HISTORY_CHUNK_MAX_BYTES;
    this.#idleTtlMs = deps.idleTtlMs ?? HISTORY_RELAY_TTL_MS;
  }

  /** Handles one `history_req`; the page load runs detached, replies land when ready. */
  onRequest(request: { id: string; workerId: string; since?: string; maxBytes?: number; format?: "full" }): void {
    const reqId = request.id;
    const maxBytes = Math.min(request.maxBytes ?? HISTORY_MAX_BYTES, HISTORY_MAX_BYTES);
    const now = this.#now();
    this.#streams.set(reqId, { workerId: request.workerId, chunks: [], next: 0, acked: -1, lastActivityAt: now });
    this.#armSweep();
    // A summary read keeps its original three-argument call; only a full-session read names its format.
    const loading = request.format
      ? this.#deps.load(request.workerId, request.since, maxBytes, request.format)
      : this.#deps.load(request.workerId, request.since, maxBytes);
    loading
      .then((page) => this.#start(reqId, page))
      .catch((err: unknown) => {
        if (!this.#streams.has(reqId)) return; // already gone (swept / connection dropped)
        this.#drop(reqId);
        this.#deps.send({
          t: "error",
          re: reqId,
          code: (err as { code?: string }).code ?? "internal",
          message: err instanceof Error ? err.message : String(err),
          retriable: false,
        });
      });
  }

  /** A browser ack relayed by the DO: slide the window, release the next chunk. */
  onAck(reqId: string, n: number): void {
    const stream = this.#streams.get(reqId);
    if (!stream) return; // done chunk already released everything; late acks are harmless
    stream.lastActivityAt = this.#now();
    if (n === stream.acked + 1) stream.acked = n;
    this.#pump(stream);
    if (stream.next >= stream.chunks.length) this.#drop(reqId);
  }

  /** The socket died: nothing is re-sent over a new one (§6.6), so drop every stream. */
  reset(): void {
    this.#streams.clear();
    this.#disarmSweep();
  }

  /** Test/inspection support. */
  get size(): number {
    return this.#streams.size;
  }

  #start(reqId: string, page: HistoryPage): void {
    const stream = this.#streams.get(reqId);
    if (!stream) return;
    // chunkPage always returns at least the terminating chunk, even for an empty page.
    stream.chunks = chunkPage(reqId, page, this.#maxChunkBytes);
    stream.lastActivityAt = this.#now();
    this.#pump(stream);
    if (stream.next >= stream.chunks.length) this.#drop(reqId);
  }

  /** Sends every chunk the window allows: indexes next .. acked + windowSize. */
  #pump(stream: StreamState): void {
    while (stream.next < stream.chunks.length && stream.next <= stream.acked + this.#windowSize) {
      const chunk = stream.chunks[stream.next]!;
      stream.next += 1;
      stream.lastActivityAt = this.#now();
      this.#deps.send(chunk);
    }
  }

  #drop(reqId: string): void {
    this.#streams.delete(reqId);
    if (this.#streams.size === 0) this.#disarmSweep();
  }

  #armSweep(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.#sweep(), Math.max(250, Math.floor(this.#idleTtlMs / 2)));
    this.#sweepTimer.unref?.();
  }

  #disarmSweep(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  #sweep(): void {
    const cutoff = this.#now() - this.#idleTtlMs;
    for (const [reqId, stream] of this.#streams) {
      if (stream.lastActivityAt < cutoff) this.#drop(reqId);
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }
}

/** Splits a page into chunk messages, each ≤ maxChunkBytes on the wire; always at least one
 * (the terminator). A chunk's cursor is the last entry id inside it; the final chunk carries
 * the page's done semantics. */
export function chunkPage(reqId: string, page: HistoryPage, maxChunkBytes = HISTORY_CHUNK_MAX_BYTES): HistoryChunkMessage[] {
  const chunks: HistoryChunkMessage[] = [];
  let entries: HistoryPage["entries"] = [];
  const flush = () => {
    chunks.push({
      t: "history_chunk",
      re: reqId,
      n: chunks.length,
      entries,
      cursor: entries.length > 0 ? entries[entries.length - 1]!.nextCursor ?? entries[entries.length - 1]!.id : null,
      ...(page.format ? { format: page.format } : {}),
      done: false,
    });
    entries = [];
  };
  for (const entry of page.entries) {
    const size = byteLength({ t: "history_chunk", re: reqId, n: 0, entries: [...entries, entry], cursor: entry.nextCursor ?? entry.id, done: false, ...(page.format ? { format: page.format } : {}) });
    if (entries.length > 0 && size > maxChunkBytes) flush();
    entries.push(entry);
  }
  if (entries.length > 0) flush();
  if (chunks.length === 0) {
    // Nothing fit the budget at all: terminate rather than leaving the browser paging on a
    // null cursor forever (re-opening would produce the same empty result).
    chunks.push({ t: "history_chunk", re: reqId, n: 0, entries: [], cursor: page.cursor, done: true, ...(page.format ? { format: page.format } : {}) });
    return chunks;
  }
  // The final chunk always carries done=true — that is the stream terminator for the relay
  // row and the browser. `truncated` preserves the page's own budget verdict: true means the
  // page stopped at maxBytes and re-opening with since=cursor continues (or reports "nothing
  // more"); the browser must not guess this from byte counts (they differ between UTF-8
  // budgets and UTF-16 string lengths, so a character heuristic misreads CJK cuts).
  const last = chunks[chunks.length - 1]!;
  last.done = true;
  last.cursor = page.cursor;
  if (!page.done && page.cursor !== null) last.truncated = true;
  return chunks;
}
