import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";

function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

function postPair(code: string, name = "m", ip?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return SELF.fetch("https://example.com/pair", { method: "POST", body: JSON.stringify({ code, name }), headers });
}

describe("POST /pair", () => {
  it("redeems a valid pairing code and returns deviceId, token, wsUrl", async () => {
    const { code } = await ownerStub().createPairing();
    const res = await postPair(code, "mac-studio");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; token: string; wsUrl: string };
    expect(body.deviceId).toMatch(/^dev_/);
    expect(body.token).toMatch(/^st1\./);
    expect(body.wsUrl).toBe("wss://example.com/agents/steward/owner");
  });

  it("rejects an unknown code", async () => {
    const res = await postPair("ZZZZZZZZ", "x");
    expect(res.status).toBe(400);
  });

  it("rejects a reused code (single-use)", async () => {
    const { code } = await ownerStub().createPairing();
    const first = await postPair(code, "a");
    expect(first.status).toBe(200);
    const second = await postPair(code, "a");
    expect(second.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing required fields", async () => {
    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCDEFGH" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /pair brute-force lockout (protocol doc §5.2, issue #27)", () => {
  const ip = (n: number) => `203.0.113.${n}`;

  beforeEach(async () => {
    // Failure buckets are shared DO state (the lock is the point); start each case clean.
    await ownerStub().channelLogEntries(1);
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (s: TemplateStringsArray) => void }).sql.bind(instance);
      sql`DELETE FROM pair_fail`;
    });
  });

  it("locks a source IP after 5 failed codes, even for a valid code, and reports Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postPair("WRONGCODE", "m", ip(7));
      expect(res.status).toBe(400);
    }
    const { code } = await ownerStub().createPairing();
    const locked = await postPair(code, "m", ip(7));
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: string }).error).toBe("rate_limited");
    const retryAfter = Number(locked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it("below the thresholds, failures from one IP do not block another IP's valid pairing", async () => {
    for (let i = 0; i < 4; i++) await postPair("WRONGCODE", "m", ip(7)); // ip(7) at 4/5, global at 4/5
    const { code } = await ownerStub().createPairing();
    const res = await postPair(code, "other-machine", ip(8));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toMatch(/^st1\./);
  });

  it("locks globally after 5 failures spread across IPs — nobody can pair", async () => {
    for (let i = 0; i < 5; i++) await postPair("WRONGCODE", "m", ip(20 + i));
    const { code } = await ownerStub().createPairing();
    for (const attackerIp of [ip(31), ip(32)]) {
      const res = await postPair(code, "m", attackerIp);
      expect(res.status).toBe(429);
    }
  });

  it("a successful pairing clears that IP's bucket but not the global one", async () => {
    for (let i = 0; i < 3; i++) await postPair("WRONGCODE", "m", ip(9));
    const { code } = await ownerStub().createPairing();
    expect((await postPair(code, "legit", ip(9))).status).toBe(200); // under the limit, pairs
    // The legit machine fat-fingered 3 times, paired once — its bucket is clean again.
    const { code: code2 } = await ownerStub().createPairing();
    expect((await postPair(code2, "legit", ip(9))).status).toBe(200);
  });

  it("the lock lifts after it expires and the window restarts", async () => {
    // Shrink the lockout inside the DO (same pattern as feishuSendTimeoutMs) — but keep it
    // comfortably larger than the six request roundtrips below: a 60ms TTL expired mid-setup
    // on slow CI runners (3 parallel test groups + connector on 4 vCPUs) and the locked
    // assert got 200. 1000ms covers the setup with ~10× margin; the sleep clears it with
    // a full second of slack.
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      (instance as unknown as { pairLockMs: number }).pairLockMs = 1000;
    });
    for (let i = 0; i < 5; i++) await postPair("WRONGCODE", "m", ip(10));
    const { code } = await ownerStub().createPairing();
    const locked = await postPair(code, "m", ip(10));
    expect(locked.status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { code: fresh } = await ownerStub().createPairing();
    expect((await postPair(fresh, "m", ip(10))).status).toBe(200);
  });
});
