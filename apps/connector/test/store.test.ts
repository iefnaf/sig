import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "../src/store.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-connector-test-"));
  dbPath = join(dir, "connector.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("LocalStore", () => {
  it("creates the database file with 0600 permissions", () => {
    const store = new LocalStore(dbPath);
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
    store.close();
  });

  it("returns null credentials before anything is saved", () => {
    const store = new LocalStore(dbPath);
    expect(store.getCredentials()).toBeNull();
    store.close();
  });

  it("round-trips saved credentials", () => {
    const store = new LocalStore(dbPath);
    store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_abc", token: "st1.dev_abc.1.100.deadbeef" });
    expect(store.getCredentials()).toEqual({
      serverUrl: "https://example.com",
      deviceId: "dev_abc",
      token: "st1.dev_abc.1.100.deadbeef",
      connEpoch: 0,
    });
    store.close();
  });

  it("increments and persists connEpoch across reopen (simulating a connector restart)", () => {
    const store = new LocalStore(dbPath);
    store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_abc", token: "tok" });
    expect(store.nextConnEpoch()).toBe(1);
    expect(store.nextConnEpoch()).toBe(2);
    store.close();

    const reopened = new LocalStore(dbPath);
    expect(reopened.getCredentials()?.connEpoch).toBe(2);
    expect(reopened.nextConnEpoch()).toBe(3);
    reopened.close();
  });

  it("clears credentials", () => {
    const store = new LocalStore(dbPath);
    store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_abc", token: "tok" });
    store.clearCredentials();
    expect(store.getCredentials()).toBeNull();
    store.close();
  });

  it("round-trips, clears, and re-reads the proxy config across a reopen (issue #68)", () => {
    const store = new LocalStore(dbPath);
    expect(store.getProxyConfig()).toBeNull();
    store.setProxyConfig({ url: "http://127.0.0.1:7890/", noProxy: ".corp.example" });
    expect(store.getProxyConfig()).toEqual({ url: "http://127.0.0.1:7890/", noProxy: ".corp.example" });
    store.clearProxyConfig();
    expect(store.getProxyConfig()).toBeNull();
    // Re-set, close, reopen: the daemon reads it at every boot.
    store.setProxyConfig({ url: "http://127.0.0.1:7890/" });
    store.close();
    const reopened = new LocalStore(dbPath);
    expect(reopened.getProxyConfig()).toEqual({ url: "http://127.0.0.1:7890/" });
    reopened.close();
  });

  it("treats a proxy row that no longer parses as absent instead of failing boot", () => {
    const store = new LocalStore(dbPath);
    store.setProxyConfig({ url: "http://127.0.0.1:7890/" });
    // Corrupt the row the way a hand-edit or future format would.
    store.database.prepare("UPDATE config SET value = ? WHERE key = 'proxy'").run("{not json");
    expect(store.getProxyConfig()).toBeNull();
    store.close();
  });
});
