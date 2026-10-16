import { describe, expect, it } from "vitest";
import { generatePairingCode } from "../src/pairingCode.ts";

describe("generatePairingCode", () => {
  it("produces an 8-character Crockford base32 code", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  it("is not constant across calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});
