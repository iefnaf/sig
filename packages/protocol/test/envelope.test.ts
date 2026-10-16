import { describe, expect, it } from "vitest";
import { ulid } from "../src/envelope.ts";

describe("ulid", () => {
  it("produces a 26-character Crockford base32 id", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => ulid()));
    expect(ids.size).toBe(50);
  });

  it("sorts lexicographically with increasing timestamps", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_001);
    expect(earlier.slice(0, 10) <= later.slice(0, 10)).toBe(true);
  });
});
