import { describe, expect, it } from "vitest";
import { PingMessageSchema, PongMessageSchema } from "../src/heartbeat.ts";

describe("PingMessageSchema", () => {
  it("accepts a well-formed ping", () => {
    expect(PingMessageSchema.safeParse({ t: "ping", id: "p1" }).success).toBe(true);
  });
});

describe("PongMessageSchema", () => {
  it("accepts a well-formed pong replying to a ping", () => {
    expect(PongMessageSchema.safeParse({ t: "pong", re: "p1" }).success).toBe(true);
  });
});
