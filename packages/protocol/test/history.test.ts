// History relay message schemas, docs/design/connector-do-protocol.md §6.6.
import { describe, expect, it } from "vitest";
import {
  HistoryAckMessageSchema,
  HistoryChunkMessageSchema,
  HistoryEntrySchema,
  HistoryOpenMessageSchema,
  HistoryReqMessageSchema,
  MachineOfflineMessageSchema,
} from "../src/history.ts";

describe("history relay messages", () => {
  it("accepts the §6.6 shapes", () => {
    expect(
      HistoryOpenMessageSchema.safeParse({ t: "history_open", id: "o1", workerId: "w1" }).success,
    ).toBe(true);
    expect(
      HistoryOpenMessageSchema.safeParse({
        t: "history_open",
        id: "o1",
        workerId: "w1",
        since: "e91",
        maxBytes: 65536,
      }).success,
    ).toBe(true);
    expect(
      HistoryReqMessageSchema.safeParse({
        t: "history_req",
        id: "req1",
        workerId: "w1",
        maxBytes: 65536,
      }).success,
    ).toBe(true);
    expect(
      HistoryChunkMessageSchema.safeParse({
        t: "history_chunk",
        re: "req1",
        n: 0,
        entries: [{ id: "e1", role: "assistant", text: "…", tools: [] }],
        cursor: "e91",
        done: false,
        truncated: true,
      }).success,
    ).toBe(true);
    expect(
      HistoryAckMessageSchema.safeParse({ t: "history_ack", re: "req1", n: 0 }).success,
    ).toBe(true);
    expect(
      MachineOfflineMessageSchema.safeParse({ t: "machine_offline", re: "o1" }).success,
    ).toBe(true);
  });

  it("rejects the role drift and non-positive budgets", () => {
    expect(
      HistoryEntrySchema.safeParse({ id: "e1", role: "toolResult", text: "" }).success,
    ).toBe(false);
    expect(
      HistoryEntrySchema.safeParse({ id: "", role: "user", text: "" }).success,
    ).toBe(false);
    expect(
      HistoryOpenMessageSchema.safeParse({ t: "history_open", id: "o1", workerId: "w1", maxBytes: 0 }).success,
    ).toBe(false);
    expect(
      HistoryChunkMessageSchema.safeParse({ t: "history_chunk", re: "req1", n: -1, entries: [], done: true }).success,
    ).toBe(false);
    expect(
      HistoryReqMessageSchema.safeParse({ t: "history_req", id: "req1", workerId: "w1" }).success,
    ).toBe(false);
  });
});

describe("full-session reads (ADR-0003)", () => {
  const fragmentEntry = { id: "L0", role: "record", text: "", fragment: { data: '{"a":', offset: 0, total: 7 }, nextCursor: "full.abc" };

  it("carry the format through open, request and chunk, and keep fragments and cursors intact", () => {
    const open = HistoryOpenMessageSchema.parse({ t: "history_open", id: "o1", workerId: "w1", format: "full", since: "full.abc" });
    expect(open.format).toBe("full");
    const req = HistoryReqMessageSchema.parse({ t: "history_req", id: "r1", workerId: "w1", maxBytes: 65536, format: "full" });
    expect(req.format).toBe("full");
    const chunk = HistoryChunkMessageSchema.parse({ t: "history_chunk", format: "full", re: "r1", n: 0, entries: [fragmentEntry], cursor: "full.abc", done: false });
    expect(chunk.format).toBe("full");
    expect(chunk.entries[0]).toEqual(fragmentEntry);
  });

  it("leave summary reads as they were: no format, no fragments", () => {
    const open = HistoryOpenMessageSchema.parse({ t: "history_open", id: "o1", workerId: "w1" });
    expect(open).not.toHaveProperty("format");
    expect(HistoryEntrySchema.parse({ id: "e1", role: "user", text: "hi" })).toEqual({ id: "e1", role: "user", text: "hi" });
  });

  it("refuses formats it does not know and fragments that cannot be real", () => {
    expect(HistoryOpenMessageSchema.safeParse({ t: "history_open", id: "o1", workerId: "w1", format: "everything" }).success).toBe(false);
    for (const bad of [
      { ...fragmentEntry, fragment: { data: "x", offset: -1, total: 7 } },
      { ...fragmentEntry, fragment: { data: "x", offset: 0, total: 0 } },
      { ...fragmentEntry, fragment: { data: 5, offset: 0, total: 7 } },
      { ...fragmentEntry, fragment: { data: "x", offset: 0.5, total: 7 } },
      { ...fragmentEntry, role: "tool" },
    ]) {
      expect(HistoryEntrySchema.safeParse(bad).success).toBe(false);
    }
  });
});
