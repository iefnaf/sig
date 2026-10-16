// Descendant-process tracking, docs/design/connector-pi.md §9.3. While a pi process runs,
// the connector snapshots its descendants (pid + start time) every 5 seconds into LocalStore.
// Cleanup — triggered by pi exiting unexpectedly, connector startup, or a stop_process
// timeout — terminates each listed pid only if it is still alive AND the start time still
// matches, so a pid reused by an unrelated process is never killed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pidAlive, processStartTime } from "./locks.ts";

const exec = promisify(execFile);

/** A process as recorded in a snapshot: pid plus the start time that proves identity. */
export interface ProcRef {
  pid: number;
  startTime?: string;
}

/** One row of a `ps` listing (pid, parent, optional start time). */
export interface PsRow {
  pid: number;
  ppid: number;
  startTime?: string;
}

/** Parses `ps -axo pid=,ppid=,lstart=` output (lstart is a multi-word timestamp; without
 * lstart the start time is simply absent and matching degrades to pid aliveness). */
export function parsePsRows(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)(?:\s+(.*\S))?\s*$/.exec(trimmed);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      ...(match[3] ? { startTime: match[3] } : {}),
    });
  }
  return rows;
}

/** All descendants of `rootPid` (the root itself excluded), transitively, from one snapshot. */
export function collectDescendants(rootPid: number, rows: PsRow[]): ProcRef[] {
  const childrenOf = new Map<number, PsRow[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(row);
    childrenOf.set(row.ppid, list);
  }
  const out: ProcRef[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ pid: child.pid, ...(child.startTime ? { startTime: child.startTime } : {}) });
      queue.push(child.pid);
    }
  }
  return out;
}

/** One `ps` pass over the whole process table; [] when ps is unavailable. */
export async function listDescendants(rootPid: number): Promise<ProcRef[]> {
  let output: string;
  try {
    ({ stdout: output } = await exec("ps", ["-axo", "pid=,ppid=,lstart="], { timeout: 5000 }));
  } catch {
    try {
      ({ stdout: output } = await exec("ps", ["-axo", "pid=,ppid="], { timeout: 5000 }));
    } catch {
      return []; // degrade: no snapshot is better than a wrong cleanup
    }
  }
  return collectDescendants(rootPid, parsePsRows(output));
}

export interface KillDeps {
  alive?: (pid: number) => boolean;
  startTime?: (pid: number) => string | undefined;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Grace between SIGTERM and the SIGKILL escalation. */
  graceMs?: number;
}

/**
 * Terminates the snapshot's orphans: SIGTERM first, SIGKILL after the grace period for
 * survivors. A pid is touched only while it is alive and (when a start time was recorded)
 * still the same process — the §9.3 pid-reuse guard. Returns the refs that were signalled.
 */
export async function killOrphans(refs: ProcRef[], deps: KillDeps = {}): Promise<ProcRef[]> {
  const alive = deps.alive ?? pidAlive;
  const startTime = deps.startTime ?? processStartTime;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const stillOurs = (ref: ProcRef): boolean => {
    if (ref.pid <= 1 || ref.pid === process.pid) return false; // never signal init or ourselves
    if (!alive(ref.pid)) return false;
    if (ref.startTime !== undefined) return startTime(ref.pid) === ref.startTime;
    return true;
  };
  const targets = refs.filter(stillOurs);
  for (const target of targets) {
    try {
      kill(target.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (targets.length === 0) return [];
  await new Promise((resolve) => setTimeout(resolve, deps.graceMs ?? 500));
  for (const survivor of targets.filter((ref) => stillOurs(ref))) {
    try {
      kill(survivor.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return targets;
}
