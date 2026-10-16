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
