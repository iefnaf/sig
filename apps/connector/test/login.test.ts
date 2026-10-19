// loginLink (ADR-0004): a paired machine asks its steward for a one-time browser link.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginLink } from "../src/login.ts";
import { LocalStore } from "../src/store.ts";

let dir: string;
let store: LocalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-login-test-"));
  store = new LocalStore(join(dir, "connector.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("loginLink", () => {
  it("posts with the device credential and returns the url", async () => {
    store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_1", token: "st1.tok" });
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.authorization ?? null });
      return Response.json({ url: "https://example.com/link/wl1.x" });
    }) as typeof fetch;
    expect(await loginLink(store, fetchImpl)).toBe("https://example.com/link/wl1.x");
    expect(seen).toEqual([{ url: "https://example.com/login", auth: "Bearer st1.tok" }]);
  });

  it("returns null when not paired, and throws on a refused credential", async () => {
    expect(await loginLink(store, (async () => new Response("{}")) as typeof fetch)).toBeNull();
    store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_1", token: "st1.tok" });
    await expect(loginLink(store, (async () => new Response("{}", { status: 401 })) as typeof fetch)).rejects.toThrow(/401/);
  });
});
