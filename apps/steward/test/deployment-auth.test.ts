// Password screening is deliberately tested without the network: the range response shape is
// the security boundary, and a malformed or unavailable service must keep password setup closed.
import { describe, expect, it, vi } from "vitest";
import { passwordDigest, screenPassword } from "../src/deployment-auth.ts";

async function sha1(password: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

describe("deployment password screening", () => {
  it("rejects short and common passwords before making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await screenPassword("too short", fetchImpl)).toBe(false);
    expect(await screenPassword("password!!!!!!!!!", fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a compromised password and accepts an absent range suffix", async () => {
    const compromised = "a long but publicly compromised passphrase";
    const hash = await sha1(compromised);
    const compromisedFetch = vi.fn<typeof fetch>(async () =>
      new Response(`${hash.slice(5)}:7\r\n${"0".repeat(35)}:0\r\n`));
    expect(await screenPassword(compromised, compromisedFetch)).toBe(false);

    const cleanFetch = vi.fn<typeof fetch>(async () => new Response(`${"0".repeat(35)}:0\r\n`));
    expect(await screenPassword("a unique local deployment password 91!", cleanFetch)).toBe(true);
  });

  it("fails closed when the range response is malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("not a padded hash range"));
    await expect(screenPassword("a unique local deployment password 92!", fetchImpl)).rejects.toThrow("invalid password screening response");
  });

  it("stores an algorithm-tagged verifier rather than the password", async () => {
    const digest = await passwordDigest("a unique local deployment password 93!", "00112233445566778899aabbccddeeff");
    expect(digest).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{64}$/);
    expect(digest).not.toContain("unique local");
  });
});
