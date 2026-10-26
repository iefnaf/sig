// The connector's §6.6 half: `history_req` becomes a windowed `history_chunk` stream —
// ≤ 2 chunks in flight, browser acks (relayed by the DO) release the next, chunks stay under
// 256 KiB, failed loads answer `error{re}`, and an idle stream dies with the 60 s TTL.
import { HISTORY_MAX_BYTES, type HistoryEntry, type HistoryPage } from "@alexlikevibe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryStreams, chunkPage } from "../src/history-stream.ts";

interface Sent {
  chunk: { t: "history_chunk"; re: string; n: number; entries: HistoryEntry[]; cursor?: string | null; done: boolean };
  error: { t: "error"; re: string; code: string; message: string; retriable: boolean };
}

let sent: Sent["chunk"][];
let errors: Sent["error"][];
let streams: HistoryStreams;

beforeEach(() => {
  sent = [];
  errors = [];
});

afterEach(() => {
  streams?.reset();
});

function makeStreams(
  load: (workerId: string, since: string | undefined, maxBytes: number) => Promise<HistoryPage>,
  opts: { idleTtlMs?: number; windowSize?: number; maxChunkBytes?: number } = {},
): HistoryStreams {
  streams = new HistoryStreams({
    send: (message) => {
      if (message.t === "history_chunk") sent.push(message);
      else errors.push(message);
    },
    load,
    ...(opts.idleTtlMs ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.windowSize ? { windowSize: opts.windowSize } : {}),
    ...(opts.maxChunkBytes ? { maxChunkBytes: opts.maxChunkBytes } : {}),
  });
  return streams;
}

const page = (count: number, done = true): HistoryPage => ({
  entries: Array.from({ length: count }, (_, i) => ({ id: `e${i + 1}`, role: i % 2 === 0 ? "user" : "assistant", text: `entry ${i + 1}` })),
  cursor: count > 0 ? `e${count}` : null,
  done,
});

const flushed = async (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("HistoryStreams window control", () => {
  it("sends chunks 0 and 1 immediately, then one per ack (window 2)", async () => {
    const load = vi.fn().mockResolvedValue(page(6));
    // One entry per chunk: the 160-byte cap forces the six tiny entries into six chunks.
    const s = makeStreams(load, { maxChunkBytes: 160 });
    s.onRequest({ id: "req-1", workerId: "w1", maxBytes: HISTORY_MAX_BYTES });
    await flushed();
    expect(load).toHaveBeenCalledWith("w1", undefined, HISTORY_MAX_BYTES);
    expect(sent.map((c) => c.n)).toEqual([0, 1]); // window full: 2 unacked

    s.onAck("req-1", 0);
    expect(sent.map((c) => c.n)).toEqual([0, 1, 2]);
    s.onAck("req-1", 1);
    expect(sent.map((c) => c.n)).toEqual([0, 1, 2, 3]);
    s.onAck("req-1", 2);
    expect(sent.map((c) => c.n)).toEqual([0, 1, 2, 3, 4]);
    s.onAck("req-1", 3);
    expect(sent.map((c) => c.n)).toEqual([0, 1, 2, 3, 4, 5]); // final chunk released
    expect(sent[5]!.done).toBe(true);
    expect(sent[5]!.cursor).toBe("e6");
    // Everything sent → the stream is gone; late acks are ignored.
    expect(s.size).toBe(0);
    s.onAck("req-1", 4);
    expect(sent).toHaveLength(6);
  });

  it("keeps the window honest: an out-of-order or duplicate ack releases nothing", async () => {
    const s = makeStreams(vi.fn().mockResolvedValue(page(5)), { maxChunkBytes: 160 });
    s.onRequest({ id: "req-2", workerId: "w1" });
    await flushed();
    s.onAck("req-2", 1); // skipped 0
    expect(sent.map((c) => c.n)).toEqual([0, 1]);
    s.onAck("req-2", 1); // duplicate
    expect(sent.map((c) => c.n)).toEqual([0, 1]);
    s.onAck("req-2", 0); // now contiguous
    expect(sent.map((c) => c.n)).toEqual([0, 1, 2]);
  });

  it("answers a failed load with error{re} and drops the stream", async () => {
    const s = makeStreams(vi.fn().mockRejectedValue(Object.assign(new Error("no session file"), { code: "no_history" })));
    s.onRequest({ id: "req-3", workerId: "w-missing", since: "e9", maxBytes: 1024 });
    await flushed();
    expect(sent).toEqual([]);
    expect(errors).toEqual([{ t: "error", re: "req-3", code: "no_history", message: "no session file", retriable: false }]);
    expect(s.size).toBe(0);
  });

  it("forwards since and clamps maxBytes at the protocol ceiling", async () => {
    const load = vi.fn().mockResolvedValue(page(0));
    const s = makeStreams(load);
    s.onRequest({ id: "req-4", workerId: "w1", since: "e3", maxBytes: 999_999_999 });
    await flushed();
    expect(load).toHaveBeenCalledWith("w1", "e3", HISTORY_MAX_BYTES);
    // Empty page: a single terminating chunk, done, no cursor.
    expect(sent).toEqual([{ t: "history_chunk", re: "req-4", n: 0, entries: [], cursor: null, done: true }]);
  });

  it("drops every stream when the socket dies (reset: nothing is re-sent)", async () => {
    const s = makeStreams(vi.fn().mockResolvedValue(page(5)), { maxChunkBytes: 160 });
    s.onRequest({ id: "req-5", workerId: "w1" });
    await flushed();
    expect(s.size).toBe(1);
    s.reset();
    expect(s.size).toBe(0);
    s.onAck("req-5", 0);
    expect(sent.map((c) => c.n)).toEqual([0, 1]);
  });

  it("sweeps streams idle past the TTL", async () => {
    const s = makeStreams(vi.fn().mockResolvedValue(page(5)), { idleTtlMs: 60, maxChunkBytes: 160 });
    s.onRequest({ id: "req-6", workerId: "w1" });
    await flushed();
    expect(s.size).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(s.size).toBe(0);
    // After the sweep the acks land on a gone stream: nothing sent, nothing thrown.
    s.onAck("req-6", 0);
    expect(sent.map((c) => c.n)).toEqual([0, 1]);
  });
});

describe("chunkPage", () => {
  it("splits entries into chunks under the byte cap, terminating with done=true and the page cursor", () => {
    const big: HistoryPage = {
      entries: Array.from({ length: 40 }, (_, i) => ({ id: `e${i + 1}`, role: "assistant" as const, text: "x".repeat(2000) })),
      cursor: "e40",
      done: false,
    };
    const chunks = chunkPage("req-c", big, 8 * 1024);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(8 * 1024);
    }
    expect(chunks.map((c) => c.n)).toEqual(chunks.map((_, i) => i));
    // Every non-final chunk is open; the final one terminates and carries the resume cursor
    // plus the budget verdict (truncated) — the browser never guesses it from byte counts.
    for (const chunk of chunks.slice(0, -1)) expect(chunk.done).toBe(false);
    const last = chunks[chunks.length - 1]!;
    expect(last.done).toBe(true);
    expect(last.cursor).toBe("e40");
    expect(last.truncated).toBe(true);
    // No entry lost or duplicated across the split.
    const ids = chunks.flatMap((c) => c.entries.map((e) => e.id));
    expect(ids).toEqual(big.entries.map((e) => e.id));
  });

  it("a complete page terminates without the truncated flag", () => {
    const chunks = chunkPage("req-1", { entries: [{ id: "e1", role: "user", text: "hi" }], cursor: "e1", done: true });
    expect(chunks).toEqual([
      { t: "history_chunk", re: "req-1", n: 0, entries: [{ id: "e1", role: "user", text: "hi" }], cursor: "e1", done: true },
    ]);
  });

  it("an empty budget-cut page (nothing fit) terminates without a continue cursor", () => {
    const chunks = chunkPage("req-0", { entries: [], cursor: null, done: false });
    expect(chunks).toEqual([{ t: "history_chunk", re: "req-0", n: 0, entries: [], cursor: null, done: true }]);
  });
});
