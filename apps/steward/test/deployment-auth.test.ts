// Password screening is deliberately tested without the network: the range response shape is
// the security boundary, and a malformed or unavailable service must keep password setup closed.
import { describe, expect, it, vi } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { MIGRATIONS, runMigrations } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";
import { DeploymentAuth, passwordDigest, screenPassword } from "../src/deployment-auth.ts";

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

describe("deployment password availability", () => {
  it("returns actionable missing configuration without opening a session", async () => {
    const response = await SELF.fetch("https://example.com/auth/password", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json", "CF-Connecting-IP": "203.0.113.51" },
      body: JSON.stringify({ password: "12345" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "password_not_configured" });
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("rejects a short configured password without storing a verifier", async () => {
    await withAuthStorage(async (input) => {
      const auth = new DeploymentAuth({ ...input, env: { LOGIN_PASSWORD: "12345" } });
      expect(await auth.verifyPassword("12345", "weak")).toBe("password_rejected");
      expect(input.sql`SELECT id FROM sh_auth_password`).toEqual([]);
    });
  });

  it("identifies a missing deployment password", async () => {
    await withAuthStorage(async (input) => {
      const auth = new DeploymentAuth({ ...input, env: {} });
      expect(await auth.verifyPassword("12345", "missing")).toBe("password_not_configured");
    });
  });

  it("retries a temporary screening outage without requiring a new password", async () => {
    await withAuthStorage(async (input) => {
      const screen = vi.fn<(password: string) => Promise<boolean>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(true);
      const auth = new DeploymentAuth({ ...input, env: { LOGIN_PASSWORD: "a unique deployment password 94!" }, screenPassword: screen });
      expect(await auth.verifyPassword("a unique deployment password 94!", "outage")).toBe("password_screening_unavailable");
      expect(await auth.verifyPassword("a unique deployment password 94!", "outage")).toBe("password_screening_unavailable");
      expect(screen).toHaveBeenCalledTimes(1);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
      try {
        expect(await auth.verifyPassword("a unique deployment password 94!", "outage")).toBe("valid");
        expect(await auth.verifyPassword("wrong password", "outage")).toBe("invalid");
        expect(screen).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("revokes the previous browser authority when a replacement is rejected", async () => {
    await withAuthStorage(async (input) => {
      const original = new DeploymentAuth({ ...input, env: { LOGIN_PASSWORD: "a unique deployment password 95!" }, screenPassword: async () => true });
      expect(await original.verifyPassword("a unique deployment password 95!", "original")).toBe("valid");
      const revoked = vi.fn();
      const replacement = new DeploymentAuth({ ...input, env: { LOGIN_PASSWORD: "12345" }, sessionsRevoked: revoked });
      expect(await replacement.verifyPassword("12345", "replacement")).toBe("password_rejected");
      expect(input.sql`SELECT id FROM sh_auth_password`).toEqual([]);
      expect(revoked).toHaveBeenCalledOnce();
    });
  });
});

async function withAuthStorage(run: (input: Pick<ConstructorParameters<typeof DeploymentAuth>[0], "sql" | "transaction" | "sessionsRevoked">) => Promise<void>): Promise<void> {
  const stub = env.Steward.get(env.Steward.idFromName(`password-availability-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (instance: Steward, state: DurableObjectState) => {
    const sql = instance.sql.bind(instance);
    runMigrations(sql, MIGRATIONS, (operation) => state.storage.transactionSync(operation));
    await run({ sql, transaction: (operation) => state.storage.transactionSync(operation), sessionsRevoked: () => {} });
  });
}
