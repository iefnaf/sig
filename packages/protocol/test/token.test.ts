import { describe, expect, it } from "vitest";
import { deriveKeyId, mintToken, parseToken, serverKey } from "../src/token.ts";

const SECRET = "test-server-key";
const NEW_SECRET = "test-server-key-2";

describe("device token", () => {
  it("round-trips deviceId and epoch, carrying the minting key's id", async () => {
    const key = await serverKey(SECRET);
    const token = await mintToken(key, "dev_abc123", 1);
    expect(token).toMatch(/^st1\.[0-9a-f]{8}\.dev_abc123\.1\.\d+\.[0-9a-f]{64}$/);
    const parsed = await parseToken(key, token);
    expect(parsed).toEqual({ deviceId: "dev_abc123", epoch: 1, keyId: key.id });
  });

  it("derives stable, distinct key ids per secret", async () => {
    expect(await deriveKeyId(SECRET)).toBe(await deriveKeyId(SECRET));
    expect(await deriveKeyId(SECRET)).not.toBe(await deriveKeyId(NEW_SECRET));
  });

  it("rejects a tampered mac", async () => {
    const key = await serverKey(SECRET);
    const token = await mintToken(key, "dev_abc123", 1);
    const tampered = token.slice(0, -4) + (token.endsWith("0000") ? "1111" : "0000");
    expect(await parseToken(key, tampered)).toBeNull();
  });

  it("rejects a token signed with a key outside the configured set", async () => {
    const token = await mintToken(await serverKey(SECRET), "dev_abc123", 1);
    expect(await parseToken(await serverKey("wrong-secret"), token)).toBeNull();
    expect(await parseToken([], token)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const key = await serverKey(SECRET);
    expect(await parseToken(key, "garbage")).toBeNull();
    expect(await parseToken(key, "st2.dev_abc123.1.123.abcd")).toBeNull();
    expect(await parseToken(key, "st1.dev_abc123.1.123.not-hex")).toBeNull();
    expect(await parseToken(key, "st1.12345678.dev_abc123.1.123." + "0".repeat(64))).toBeNull(); // unknown keyId
    expect(await parseToken(key, null)).toBeNull();
  });
});

describe("device token: SERVER_KEY rotation window (issue #27)", () => {
  it("verifies a previous-key token while the old key stays in the set, and names the key", async () => {
    const previous = await serverKey(SECRET);
    const current = await serverKey(NEW_SECRET);
    const token = await mintToken(previous, "dev_abc123", 1);
    const parsed = await parseToken([current, previous], token);
    expect(parsed).toEqual({ deviceId: "dev_abc123", epoch: 1, keyId: previous.id });
  });

  it("stops verifying once the previous key is dropped from the set", async () => {
    const previous = await serverKey(SECRET);
    const current = await serverKey(NEW_SECRET);
    const token = await mintToken(previous, "dev_abc123", 1);
    expect(await parseToken([current], token)).toBeNull();
  });

  it("accepts legacy pre-keyId tokens against any configured key", async () => {
    const key = await serverKey(SECRET);
    // st1.<deviceId>.<epoch>.<issuedAt>.<mac> — the format minted before keyIds existed.
    const base = `st1.dev_abc123.1.12345`;
    const enc = new TextEncoder();
    const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(base)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const legacy = `${base}.${mac}`;
    const other = await serverKey(NEW_SECRET);
    expect(await parseToken([other, key], legacy)).toEqual({ deviceId: "dev_abc123", epoch: 1, keyId: key.id });
    expect(await parseToken([await serverKey("unrelated")], legacy)).toBeNull();
  });
});
