import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";

function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

describe("POST /pair", () => {
  it("redeems a valid pairing code and returns deviceId, token, wsUrl", async () => {
    const { code } = await ownerStub().createPairing();
    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code, name: "mac-studio" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; token: string; wsUrl: string };
    expect(body.deviceId).toMatch(/^dev_/);
    expect(body.token).toMatch(/^st1\./);
    expect(body.wsUrl).toBe("wss://example.com/agents/steward/owner");
  });

  it("rejects an unknown code", async () => {
    const res = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code: "ZZZZZZZZ", name: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a reused code (single-use)", async () => {
    const { code } = await ownerStub().createPairing();
    const first = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code, name: "a" }),
    });
    expect(first.status).toBe(200);
    const second = await SELF.fetch("https://example.com/pair", {
      method: "POST",
      body: JSON.stringify({ code, name: "a" }),
    });
    expect(second.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const res = await SELF.fetch("https://example.com/pair", { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing required fields", async () => {
    const res = await SELF.fetch("https://example.com/pair", { method: "POST", body: JSON.stringify({ code: "ABCDEFGH" }) });
    expect(res.status).toBe(400);
  });
});
