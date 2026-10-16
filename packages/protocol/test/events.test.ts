import { describe, expect, it } from "vitest";
import { EventsAckMessageSchema, EventsGapMessageSchema, EventsMessageSchema, ResyncMessageSchema, WorkerEventSchema } from "../src/events.ts";

describe("WorkerEventSchema", () => {
  it("accepts a progress event with extra fields", () => {
    const e = { workerId: "w1", seq: 1, ts: 1, type: "progress", phase: "tool", tool: "edit", target: "a.ts", turn: 1 };
    expect(WorkerEventSchema.safeParse(e).success).toBe(true);
  });

  it("rejects a missing seq", () => {
    expect(WorkerEventSchema.safeParse({ workerId: "w1", ts: 1, type: "progress" }).success).toBe(false);
  });
});

describe("EventsMessageSchema", () => {
  it("accepts a batch of one or more events", () => {
    const msg = { t: "events", id: "e1", batch: [{ workerId: "w1", seq: 1, ts: 1, type: "progress" }] };
    expect(EventsMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(EventsMessageSchema.safeParse({ t: "events", id: "e1", batch: [] }).success).toBe(false);
  });
});

describe("EventsAckMessageSchema", () => {
  it("accepts a cumulative ack", () => {
    expect(EventsAckMessageSchema.safeParse({ t: "events_ack", workerId: "w1", upTo: 130 }).success).toBe(true);
  });
});

describe("ResyncMessageSchema", () => {
  it("accepts a replay request", () => {
    expect(ResyncMessageSchema.safeParse({ t: "resync", workerId: "w1", from: 131 }).success).toBe(true);
  });
});

describe("EventsGapMessageSchema", () => {
  it("accepts a gap report", () => {
    expect(EventsGapMessageSchema.safeParse({ t: "events_gap", workerId: "w1", from: 131, to: 150 }).success).toBe(true);
  });
});
