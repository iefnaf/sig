import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/pairing.ts";
import { LocalStore } from "../src/store.ts";

let dir: string;
let store: LocalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sig-connector-pairing-test-"));
  store = new LocalStore(join(dir, "connector.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://example.com/pair");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({ code: expect.any(String), name: expect.any(String) });
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
}

describe("connect", () => {
  it("redeems the pairing code and saves credentials locally", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { deviceId: "dev_abc", token: "st1.dev_abc.1.100.deadbeef", wsUrl: "wss://example.com/agents/steward/owner" },
    });

    const result = await connect("https://example.com", "ABCDEFGH", "mac-studio", { store, fetchImpl });

    expect(result.deviceId).toBe("dev_abc");
    expect(store.getCredentials()).toEqual({
      serverUrl: "https://example.com",
      deviceId: "dev_abc",
      token: "st1.dev_abc.1.100.deadbeef",
      connEpoch: 0,
    });
  });

  it("throws and does not save credentials when the server rejects the code", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { error: "invalid code" } });

    await expect(connect("https://example.com", "ZZZZZZZZ", "mac-studio", { store, fetchImpl })).rejects.toThrow();
    expect(store.getCredentials()).toBeNull();
  });
});
