import { describe, expect, it } from "vitest";
import { CloseCode, reconnectOn } from "../src/closeCodes.ts";

describe("closeCodes", () => {
  it("exposes the §3.5 table as named constants", () => {
    expect(CloseCode.NORMAL).toBe(1000);
    expect(CloseCode.SERVICE_RESTART).toBe(1001);
    expect(CloseCode.UNAUTHORIZED).toBe(4401);
    expect(CloseCode.REVOKED).toBe(4403);
    expect(CloseCode.SUPERSEDED).toBe(4409);
    expect(CloseCode.VERSION_MISMATCH).toBe(4426);
    expect(CloseCode.RATE_LIMITED).toBe(4429);
    expect(CloseCode.INTERNAL_ERROR).toBe(4500);
  });

  it("reconnects on normal close, restart, rate-limit, and internal error", () => {
    expect(reconnectOn(CloseCode.NORMAL)).toBe(true);
    expect(reconnectOn(CloseCode.SERVICE_RESTART)).toBe(true);
    expect(reconnectOn(CloseCode.RATE_LIMITED)).toBe(true);
    expect(reconnectOn(CloseCode.INTERNAL_ERROR)).toBe(true);
  });

  it("does not reconnect on auth, revocation, supersede, or version mismatch", () => {
    expect(reconnectOn(CloseCode.UNAUTHORIZED)).toBe(false);
    expect(reconnectOn(CloseCode.REVOKED)).toBe(false);
    expect(reconnectOn(CloseCode.SUPERSEDED)).toBe(false);
    expect(reconnectOn(CloseCode.VERSION_MISMATCH)).toBe(false);
  });

  it("defaults unknown codes to reconnect (fail open, matching §3.5's 4500/other-server-error spirit)", () => {
    expect(reconnectOn(9999)).toBe(true);
  });
});
