import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, isLockHeld, lockPath, releaseLock } from "../src/locks.ts";
import { tmpDir } from "./helpers.ts";

let dir: string;

beforeEach(() => {
  dir = tmpDir("sig-locks-test");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

async function deadPid(): Promise<number> {
  const child = spawn("true");
  const pid = child.pid!;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

describe("worker locks (connector-pi.md §4.3)", () => {
  it("acquires, reports held while the owner is alive, and releases", () => {
    const acquired = acquireLock(dir, "w_alive");
    expect(acquired.ok).toBe(true);
    expect(isLockHeld(dir, "w_alive")).toBe(true);

    // The same live process (the test runner) holds the lock → lock_held with the pid.
    const second = acquireLock(dir, "w_alive");
    expect(second).toMatchObject({ ok: false, error: "lock_held", pid: process.pid });

    expect(releaseLock(dir, "w_alive")).toBe(true);
    expect(isLockHeld(dir, "w_alive")).toBe(false);
    expect(existsSync(lockPath(dir, "w_alive"))).toBe(false);
  });

  it("removes stale locks whose process no longer exists", async () => {
    const pid = await deadPid();
    mkdirSync(`${dir}/locks`, { recursive: true });
    writeFileSync(lockPath(dir, "w_stale"), JSON.stringify({ workerId: "w_stale", pid, createdAt: Date.now() }));

    expect(isLockHeld(dir, "w_stale")).toBe(false);
    const acquired = acquireLock(dir, "w_stale");
    expect(acquired.ok).toBe(true);
    // The stale lock was replaced by ours.
    const stored = JSON.parse(readFileSync(lockPath(dir, "w_stale"), "utf8"));
    expect(stored.pid).toBe(process.pid);
  });

  it("treats a corrupted lock file as stale", () => {
    mkdirSync(`${dir}/locks`, { recursive: true });
    writeFileSync(lockPath(dir, "w_broken"), "{not json");
    const acquired = acquireLock(dir, "w_broken");
    expect(acquired.ok).toBe(true);
  });

  it("releasing a nonexistent lock is a no-op", () => {
    expect(releaseLock(dir, "w_never")).toBe(false);
  });
});
