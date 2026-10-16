import { describe, expect, it } from "vitest";
import { CmdAckMessageSchema, CmdMessageSchema, CmdResultMessageSchema } from "../src/commands.ts";

describe("CmdMessageSchema", () => {
  it("accepts a well-formed cmd", () => {
    const cmd = { t: "cmd", id: "cmd_1", cseq: 1, kind: "start_worker", workerId: "w1", notAfter: 1791966296285, args: { prompt: "go" } };
    expect(CmdMessageSchema.safeParse(cmd).success).toBe(true);
  });

  it("accepts a null notAfter (no expiry)", () => {
    const cmd = { t: "cmd", id: "cmd_1", cseq: 1, kind: "interrupt", notAfter: null };
    expect(CmdMessageSchema.safeParse(cmd).success).toBe(true);
  });

  it("rejects the wrong message type", () => {
    expect(CmdMessageSchema.safeParse({ t: "nope", id: "cmd_1", cseq: 1, kind: "interrupt" }).success).toBe(false);
  });
});

describe("CmdAckMessageSchema", () => {
  it.each(["accepted", "duplicate", "rejected", "ambiguous"])("accepts status %s", (status) => {
    expect(CmdAckMessageSchema.safeParse({ t: "cmd_ack", re: "cmd_1", status }).success).toBe(true);
  });

  it("accepts duplicate with the original result attached", () => {
    const ack = { t: "cmd_ack", re: "cmd_1", status: "duplicate", result: { ok: true, data: { workerId: "w1" } } };
    expect(CmdAckMessageSchema.safeParse(ack).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(CmdAckMessageSchema.safeParse({ t: "cmd_ack", re: "cmd_1", status: "bogus" }).success).toBe(false);
  });
});

describe("CmdResultMessageSchema", () => {
  it("accepts an ok result", () => {
    expect(CmdResultMessageSchema.safeParse({ t: "cmd_result", re: "cmd_1", ok: true, data: { workerId: "w1" } }).success).toBe(true);
  });

  it("accepts a failed result with an error payload", () => {
    const msg = { t: "cmd_result", re: "cmd_1", ok: false, error: { code: "lock_held", message: "busy", retriable: false } };
    expect(CmdResultMessageSchema.safeParse(msg).success).toBe(true);
  });
});
