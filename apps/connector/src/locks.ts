// One-file-one-process invariant, docs/design/connector-pi.md §4.3. pi has no session-file
// lock, so the connector guarantees: only one pi process per workerId at any moment, doubly
// enforced by ~/.sig/locks/<workerId>.lock (pid + start time) plus in-memory state.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface LockFileContent {
  workerId: string;
  pid: number;
  /** `ps -p <pid> -o lstart=` output when available; guards against pid reuse. */
  startTime?: string;
  createdAt: number;
}

export type AcquireResult = { ok: true; path: string } | { ok: false; error: "lock_held"; pid: number; path: string };

export function locksDir(stateDir: string): string {
  return join(stateDir, "locks");
}

export function lockPath(stateDir: string, workerId: string): string {
  return join(locksDir(stateDir), `${workerId}.lock`);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort process start time (macOS/Linux `ps`); null when unavailable. */
export function processStartTime(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readLock(path: string): LockFileContent | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LockFileContent;
    if (typeof parsed.pid !== "number" || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Takes the lock for `workerId`. If the process named by the lock file is still alive,
 * refuses with `lock_held`; if the process no longer exists (stale lock), removes it and
 * continues (§4.3).
 */
export function acquireLock(stateDir: string, workerId: string): AcquireResult {
  const dir = locksDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const path = lockPath(stateDir, workerId);

  const existing = readLock(path);
  if (existing) {
    // Alive = pid responds AND (when a start time was recorded) it is still the same process,
    // so a reused pid never reads as a held lock (§9.3 applies the same idea to orphans).
    if (lockIsHeld(existing)) return { ok: false, error: "lock_held", pid: existing.pid, path };
    // Stale: the process no longer exists (or the pid was reused by a different process).
    rmSync(path, { force: true });
  }

  const content: LockFileContent = {
    workerId,
    pid: process.pid,
    startTime: processStartTime(process.pid),
    createdAt: Date.now(),
  };
  const tmp = join(dir, `.${workerId}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(content) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return { ok: true, path };
}

/** Returns true when a live lock was actually released; false when none existed. */
export function releaseLock(stateDir: string, workerId: string): boolean {
  const path = lockPath(stateDir, workerId);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** Whether a live (non-stale) lock currently exists for the worker. */
export function isLockHeld(stateDir: string, workerId: string): boolean {
  const existing = readLock(lockPath(stateDir, workerId));
  if (!existing) return false;
  return pidAlive(existing.pid);
}

/** The same pid + start-time identity check acquireLock uses, over an arbitrary lock. */
function lockIsHeld(existing: LockFileContent): boolean {
  let alive = pidAlive(existing.pid);
  if (alive && existing.startTime !== undefined) {
    alive = processStartTime(existing.pid) === existing.startTime;
  }
  return alive;
}

/** Startup stale-lock sweep (connector-pi.md §9.1): after a crash every lock names a dead
 * connector process — remove those so reconciliation and resume can proceed. A lock naming
 * a LIVE process is left untouched: that is another connector, and lock_held is the correct
 * answer for it. Returns the workerIds whose stale locks were removed. */
export function removeStaleLocks(stateDir: string): string[] {
  const dir = locksDir(stateDir);
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const workerId = name.slice(0, -".lock".length);
    const lock = readLock(path);
    if (!lock || !lockIsHeld(lock)) {
      rmSync(path, { force: true });
      removed.push(lock?.workerId ?? workerId);
    }
  }
  return removed;
}

/** Test support: an in-process "crash" cannot kill the test runner, so the locks it wrote
 * still name a live pid. Rewrite them to name a dead process — exactly the state a real
 * connector crash leaves behind for removeStaleLocks to sweep. */
export function markLocksHeldByDeadProcess(stateDir: string): void {
  const dir = locksDir(stateDir);
  if (!existsSync(dir)) return;
  const probe = spawnSync("true");
  const deadPid = probe.pid ?? 999_999_999; // reaped before spawnSync returns
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".lock")) continue;
    const path = join(dir, name);
    const lock = readLock(path);
    if (!lock) continue;
    writeFileSync(path, JSON.stringify({ ...lock, pid: deadPid }) + "\n", { mode: 0o600 });
  }
}
