import { describe, expect, it } from "vitest";
import { ErrorMessageSchema, HelloMessageSchema, PROTOCOL_VERSION, WelcomeMessageSchema } from "../src/messages.ts";

const validHello = {
  t: "hello",
  id: "01J0000000000000000000000",
  protocol: { min: 1, max: 1 },
  deviceId: "dev_abc123",
  bootId: "boot_1",
  connEpoch: 1,
  connector: { version: "0.1.0", os: "darwin", arch: "arm64", node: "22.13.0" },
  machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
  agents: [],
  repos: [],
  limits: { maxWorkers: 4, running: 0 },
  workers: [],
  pendingAcks: [],
};

describe("PROTOCOL_VERSION", () => {
  it("is {min: 1, max: 1} for the MVP", () => {
    expect(PROTOCOL_VERSION).toEqual({ min: 1, max: 1 });
  });
});

describe("HelloMessageSchema", () => {
  it("accepts a well-formed hello", () => {
    expect(HelloMessageSchema.safeParse(validHello).success).toBe(true);
  });

  it("rejects a hello missing required fields", () => {
    const { deviceId, ...withoutDeviceId } = validHello;
    expect(HelloMessageSchema.safeParse(withoutDeviceId).success).toBe(false);
  });

  it("rejects the wrong message type", () => {
    expect(HelloMessageSchema.safeParse({ ...validHello, t: "welcome" }).success).toBe(false);
  });

  it("accepts a recovered failure's error code on a pendingAck (issue #15)", () => {
    const parsed = HelloMessageSchema.safeParse({
      ...validHello,
      pendingAcks: [{ cmdId: "cmd_1", state: "failed", code: "not_delivered" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("WelcomeMessageSchema", () => {
  const validWelcome = {
    t: "welcome",
    re: "01J0000000000000000000000",
    protocol: 1,
    serverTime: 1791965696285,
    sessionId: "sess_1",
    acks: {},
    limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
  };

  it("accepts a well-formed welcome", () => {
    expect(WelcomeMessageSchema.safeParse(validWelcome).success).toBe(true);
  });

  it("accepts a non-empty acks map", () => {
    expect(WelcomeMessageSchema.safeParse({ ...validWelcome, acks: { w1: 126 } }).success).toBe(true);
  });

  it("rejects a missing re", () => {
    const { re, ...withoutRe } = validWelcome;
    expect(WelcomeMessageSchema.safeParse(withoutRe).success).toBe(false);
  });
});

describe("ErrorMessageSchema", () => {
  it("accepts a known error code", () => {
    expect(
      ErrorMessageSchema.safeParse({ t: "error", re: "01J0000000000000000000000", code: "forbidden", message: "nope", retriable: false })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown error code", () => {
    expect(
      ErrorMessageSchema.safeParse({ t: "error", re: "01J0000000000000000000000", code: "made_up", message: "nope", retriable: false })
        .success,
    ).toBe(false);
  });
});
