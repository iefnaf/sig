import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore, WritePolicyError } from "../src/store.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sig-connector-test-"));
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

// Issue #88: Git is a detected capability, not a registration requirement — a repo's write
// policy (isolation/concurrency) now derives from its capability, not a flat "workspace" enum.
describe("LocalStore repos and write policy (issue #88)", () => {
  it("a git-capability repo defaults to worktree/parallel", () => {
    const store = new LocalStore(dbPath);
    store.addRepo({ repoId: "/repo-a", name: "repo-a", path: "/repo-a", capability: { kind: "git", gitRoot: "/repo-a", defaultBranch: "main", remote: null } });
    expect(store.getRepo("/repo-a")).toMatchObject({
      capability: { kind: "git", gitRoot: "/repo-a", defaultBranch: "main", remote: null },
      writePolicy: { isolation: "worktree", concurrency: "parallel" },
    });
    store.close();
  });

  it("a plain-capability repo defaults to in-place/serial", () => {
    const store = new LocalStore(dbPath);
    store.addRepo({ repoId: "/plain-a", name: "plain-a", path: "/plain-a", capability: { kind: "plain" } });
    expect(store.getRepo("/plain-a")).toMatchObject({
      capability: { kind: "plain" },
      writePolicy: { isolation: "in-place", concurrency: "serial" },
    });
    store.close();
  });

  it("setWritePolicy rejects worktree isolation on a plain repo", () => {
    const store = new LocalStore(dbPath);
    store.addRepo({ repoId: "/plain-a", name: "plain-a", path: "/plain-a", capability: { kind: "plain" } });
    expect(() => store.setWritePolicy("/plain-a", { isolation: "worktree" })).toThrow(WritePolicyError);
    // The rejected call must not have partially applied — concurrency stays at its default.
    expect(store.getRepo("/plain-a")).toMatchObject({ writePolicy: { isolation: "in-place", concurrency: "serial" } });
    store.close();
  });

  it("setWritePolicy and setApproved round-trip without clobbering each other's fields", () => {
    const store = new LocalStore(dbPath);
    store.addRepo({ repoId: "/repo-a", name: "repo-a", path: "/repo-a", capability: { kind: "git", gitRoot: "/repo-a", defaultBranch: "main", remote: null } });
    expect(store.setWritePolicy("/repo-a", { concurrency: "serial" })).toBe(true);
    expect(store.getRepo("/repo-a")).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "serial" }, approved: false });
    expect(store.setApproved("/repo-a", true)).toBe(true);
    // Approving must not have reset the isolation/concurrency set just before it.
    expect(store.getRepo("/repo-a")).toMatchObject({ writePolicy: { isolation: "worktree", concurrency: "serial" }, approved: true });
    expect(store.setWritePolicy("/repo-a", { isolation: "in-place" })).toBe(true);
    // And flipping isolation must not have reset approval.
    expect(store.getRepo("/repo-a")).toMatchObject({ writePolicy: { isolation: "in-place", concurrency: "serial" }, approved: true });
    expect(store.setWritePolicy("/no/such/repo", { concurrency: "parallel" })).toBe(false);
    expect(store.setApproved("/no/such/repo", true)).toBe(false);
    store.close();
  });

  it("re-registering a repo via addRepo keeps its existing write policy and approval", () => {
    const store = new LocalStore(dbPath);
    store.addRepo({ repoId: "/repo-a", name: "repo-a", path: "/repo-a", capability: { kind: "git", gitRoot: "/repo-a", defaultBranch: "main", remote: null } });
    store.setWritePolicy("/repo-a", { isolation: "in-place", concurrency: "serial" });
    store.setApproved("/repo-a", true);
    // Re-registration (e.g. the connector re-announcing the same repo on reconnect) must only
    // refresh identity/capability fields, never the repo's local settings.
    store.addRepo({ repoId: "/repo-a", name: "repo-a-renamed", path: "/repo-a", capability: { kind: "git", gitRoot: "/repo-a", defaultBranch: "develop", remote: "git@example.com:a.git" } });
    expect(store.getRepo("/repo-a")).toMatchObject({
      name: "repo-a-renamed",
      capability: { kind: "git", defaultBranch: "develop", remote: "git@example.com:a.git" },
      writePolicy: { isolation: "in-place", concurrency: "serial" },
      approved: true,
    });
    store.close();
  });
});
