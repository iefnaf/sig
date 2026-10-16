import { describe, expect, it } from "vitest";
import { mintToken, parseToken } from "../src/token.ts";

const SECRET = "test-server-key";

describe("device token", () => {
  it("round-trips deviceId and epoch", async () => {
    const token = await mintToken(SECRET, "dev_abc123", 1);
    expect(token).toMatch(/^st1\.dev_abc123\.1\.\d+\.[0-9a-f]{64}$/);
    const parsed = await parseToken(SECRET, token);
    expect(parsed).toEqual({ deviceId: "dev_abc123", epoch: 1 });
  });

  it("rejects a tampered mac", async () => {
    const token = await mintToken(SECRET, "dev_abc123", 1);
    const tampered = token.slice(0, -4) + (token.endsWith("0000") ? "1111" : "0000");
    expect(await parseToken(SECRET, tampered)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintToken(SECRET, "dev_abc123", 1);
    expect(await parseToken("wrong-secret", token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await parseToken(SECRET, "garbage")).toBeNull();
    expect(await parseToken(SECRET, "st2.dev_abc123.1.123.abcd")).toBeNull();
    expect(await parseToken(SECRET, "st1.dev_abc123.1.123.not-hex")).toBeNull();
    expect(await parseToken(SECRET, null)).toBeNull();
  });
});
