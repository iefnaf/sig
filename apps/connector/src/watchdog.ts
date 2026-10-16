// Stall watchdog (issue #13, ADR-0001 "stall detection"; spike-conclusions §2/§5): a worker
// that is silent on stdout for the threshold AND accumulating ~no CPU across its whole
// process tree over the sample window is wedged — quiet-but-hot is a build, not a stall, so
// CPU is the discriminator. The pi process itself waits idle while its tool children work, so
// the measurement covers pi + all descendants (pid+startTime identity, connector-pi.md §9.3),
// as a delta of cumulative CPU time between two samples — never a `%cpu` snapshot, whose
// semantics differ by platform (Linux reports a process-lifetime average). First strike gets
// one automatic respawn (same worktree, same session, continuation note); a second strike
// settles the run as error:stall. The host (WorkerManager) owns the lifecycle actions; this
// class owns only detection and strike counting.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { listDescendants, type ProcRef } from "./descendants.ts";

const exec = promisify(execFile);

/** One `ps -p <pid> -o time=` row parse; undefined when the value cannot be read. */
export function parseCpuTimeMs(text: string): number | undefined {
  // Formats seen in the wild: "[DD-]MM:SS.cc" (macOS, centiseconds), "[DD-]HH:MM:SS" and
  // "MM:SS" (procps, whole seconds). Any segment count 1–3 parses; anything else is
  // unreadable — and an unreadable sample is never evidence of a stall.
  const dayMatch = /^(\d+)-(.*)$/.exec(text.trim());
  const days = dayMatch ? Number(dayMatch[1]) : 0;
  const parts = (dayMatch ? dayMatch[2]! : text.trim()).split(":");
  if (parts.length < 1 || parts.length > 3) return undefined;
  let seconds = 0;
  for (const part of parts) {
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(part);
    if (!match) return undefined;
    seconds = seconds * 60 + Number(match[1]) + (match[2] ? Number(match[2]) / 10 ** match[2].length : 0);
  }
  return Math.round((days * 86_400 + seconds) * 1000);
}

/** Linux `/proc/<pid>/stat` cumulative CPU (utime+stime) in ms; undefined off /proc systems. */
export function parseProcStatCpuMs(text: string, clockTicksPerSecond = 100): number | undefined {
  // Fields after the comm field in parentheses (comm may contain spaces): state ppid pgrp
  // session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime ...
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return ((utime + stime) * 1000) / clockTicksPerSecond;
}

/** One member of the measured tree, identified by pid (+ start time when known). */
export interface TreeMember {
  pid: number;
  startTime?: string;
}

/** One cumulative-CPU snapshot of a process tree: the sum, plus the member identities. */
export interface TreeCpuSample {
  totalCpuMs: number;
  /** Sorted identity keys (`pid@startTime`); two samples only compare when these match. */
  members: string[];
}

/** Linux reads /proc (10 ms tick resolution); elsewhere one `ps` pass over the tree.
 *
 * Quantization caveat (PR #41 review, non-blocking): where `ps time=` is whole seconds
 * (procps; BSDs), a tree accruing under ~1 CPU-second across the ~2.6 s sample window can
 * floor to a zero delta and read "cold" → one false strike-1 respawn. Linux never takes
 * this path while /proc is readable (tick resolution), and macOS prints centiseconds, so
 * this bites only BSD-family platforms; the cost is bounded (one respawn) and the
 * member-churn and freshness guards still hold. */
async function cumulativeCpuMs(members: TreeMember[]): Promise<Map<number, number> | undefined> {
  const out = new Map<number, number>();
  let sawProc = false;
  for (const member of members) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${member.pid}/stat`, "utf8");
      sawProc = true;
    } catch {
      continue; // not a /proc system (or the pid vanished; the ps pass below decides)
    }
    const ms = parseProcStatCpuMs(stat);
    if (ms === undefined) return undefined;
    out.set(member.pid, ms);
  }
  if (sawProc) return out; // every member resolved through /proc (uniform resolution)
  // ps fallback: one pass for all pids (macOS gives centisecond `time`, procps seconds).
  if (members.length === 0) return out;
  try {
    const { stdout } = await exec("ps", ["-p", members.map((m) => m.pid).join(","), "-o", "pid=", "-o", "time="], { timeout: 2000 });
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const ms = parseCpuTimeMs(match[2]!);
      if (ms === undefined) return undefined;
      out.set(Number(match[1]), ms);
    }
    return out;
  } catch {
    return undefined;
  }
}

const memberKey = (member: TreeMember): string => `${member.pid}@${member.startTime ?? "?"}`;

/**
 * Cumulative CPU of `pid` plus all its descendants (connector-pi.md §9.3): the tree pi's tool
 * children actually work in. undefined when any member cannot be read — an unreadable sample
 * is never evidence of a stall.
 */
export async function sampleTreeCpu(pid: number): Promise<TreeCpuSample | undefined> {
  const descendants = await listDescendants(pid);
  const members: TreeMember[] = [{ pid }, ...descendants];
  const cpu = await cumulativeCpuMs(members);
  if (!cpu) return undefined;
  if (members.some((member) => !cpu.has(member.pid))) return undefined; // a member is gone/unreadable
  return { totalCpuMs: members.reduce((sum, m) => sum + (cpu.get(m.pid) ?? 0), 0), members: members.map(memberKey).sort() };
}

export interface StallWatchdogOptions {
  /** Silence (no stdout) after which CPU sampling starts; default 8 min (the spike's value). */
  stallMs?: number;
  /** Tree CPU accumulated over the sample window, as % of one core; default 5. */
  cpuPct?: number;
  /** Check cadence; default clamp(stallMs / 4, 5 s, 30 s). */
  tickMs?: number;
  /** Minimum gap between the two samples; default 2.5 s (tests shrink it). */
  cpuSampleGapMs?: number;
  /** Tree sampler seam (tests inject deterministic samples). */
  sampleTreeCpu?: (pid: number) => Promise<TreeCpuSample | undefined>;
  /** Detection errors land here and never crash the host (the daemon must survive its watchdog). */
  onError?: (err: unknown) => void;
  now?: () => number;
}

/** A live worker process the watchdog may examine, from the adapter's activity map. */
export interface WatchdogCandidate {
  workerId: string;
  pid: number;
  /** Time of the last stdout chunk (spawn time until the first output). */
  lastOutputAt: number;
}

export interface StallWatchdogHooks {
  /** Live worker processes to consider this tick; the host filters by lifecycle state. */
  candidates(): WatchdogCandidate[];
  /**
   * A confirmed stall. Strike 1: respawn in place (same worktree, continue note). Strike 2:
   * the respawned run stalled too — settle as error:stall.
   */
  onStrike(workerId: string, strike: 1 | 2, why: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StallWatchdog {
  private readonly stallMs: number;
  private readonly cpuPct: number;
  private readonly tickMs: number;
  private readonly cpuSampleGapMs: number;
  private readonly sample: (pid: number) => Promise<TreeCpuSample | undefined>;
  private readonly onErrorHook: ((err: unknown) => void) | undefined;
  private readonly now: () => number;
  private readonly hooks: StallWatchdogHooks;

  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Bumped by stop(): in-flight checks compare against it after every await and give up. */
  private generation = 0;
  /** Strikes this run, per worker; reset by forget() when the run ends. */
  private readonly strikes = new Map<string, number>();
  /**
   * Last time the tree said "hot" (or unreadable/churning) for a silent worker: a legitimate
   * long build must not be re-sampled on every tick, so a hot check pushes the next stall
   * consideration out by another full stallMs.
   */
  private readonly lastHotAt = new Map<string, number>();

  constructor(options: StallWatchdogOptions, hooks: StallWatchdogHooks) {
    this.stallMs = options.stallMs ?? 8 * 60_000;
    this.cpuPct = options.cpuPct ?? 5;
    this.tickMs = options.tickMs ?? Math.max(5_000, Math.min(30_000, Math.ceil(this.stallMs / 4)));
    this.cpuSampleGapMs = options.cpuSampleGapMs ?? 2_500;
    this.sample = options.sampleTreeCpu ?? sampleTreeCpu;
    this.onErrorHook = options.onError;
    this.now = options.now ?? Date.now;
    this.hooks = hooks;
  }

  /** Starts the periodic check; idempotent. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    // Never let a rejected tick escape: an unhandled rejection would take the whole daemon
    // down (Node's default), which is far worse than the stall it was reporting.
    this.timer = setInterval(() => void this.tick().catch((err) => this.report(err)), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.generation += 1; // in-flight checks abort at their next await
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The run ended (settled / lost / stopped): drop strike and hotness state. */
  forget(workerId: string): void {
    this.strikes.delete(workerId);
    this.lastHotAt.delete(workerId);
  }

  /**
   * One detection pass. Returns the strikes it confirmed. Safe to call directly (tests,
   * manual sweeps); the interval loop skips while a previous tick is still running — a
   * strike handler can respawn a process, which must not race a second tick. A failure on
   * one worker (sampler or strike handler) is reported and never ends the pass.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let confirmed = 0;
    try {
      for (const candidate of this.hooks.candidates()) {
        try {
          if (await this.check(candidate)) confirmed += 1;
        } catch (err) {
          this.report(err);
        }
      }
    } finally {
      this.ticking = false;
    }
    return confirmed;
  }

  private report(err: unknown): void {
    try {
      this.onErrorHook?.(err);
    } catch {
      // a broken error hook must not take the daemon down either
    }
  }

  /** How long a candidate has been silent: since its last stdout, or the last hot check. */
  private silentFor(candidate: WatchdogCandidate): number {
    return this.now() - Math.max(candidate.lastOutputAt, this.lastHotAt.get(candidate.workerId) ?? 0);
  }

  private async check(candidate: WatchdogCandidate): Promise<boolean> {
    const { workerId, pid } = candidate;
    const generation = this.generation;
    if (this.silentFor(candidate) <= this.stallMs) return false;
    const startedAt = this.now();
    // Two cumulative-CPU snapshots of the whole tree. Either sample unreadable, or the member
    // sets differing between them (a tool child spawned or exited — a busy build churning),
    // means the CPU picture is incomparable: push the window, never strike.
    const first = await this.sample(pid);
    if (generation !== this.generation) return false;
    if (first === undefined) {
      this.lastHotAt.set(workerId, this.now());
      return false;
    }
    await sleep(this.cpuSampleGapMs);
    if (generation !== this.generation) return false;
    const second = await this.sample(pid);
    if (generation !== this.generation) return false;
    if (second === undefined || first.members.join(",") !== second.members.join(",")) {
      this.lastHotAt.set(workerId, this.now());
      return false;
    }
    const elapsedMs = Math.max(1, this.now() - startedAt);
    const deltaMs = second.totalCpuMs - first.totalCpuMs;
    const utilization = (deltaMs / elapsedMs) * 100;
    if (utilization >= this.cpuPct) {
      this.lastHotAt.set(workerId, this.now());
      return false;
    }
    // Freshness: the worker may have spoken (or been replaced by another path) while the two
    // samples were taken. Re-read the candidate and abandon unless it is the same process
    // and still silent past the threshold.
    const fresh = this.hooks.candidates().find((c) => c.workerId === workerId);
    if (!fresh || fresh.pid !== pid || this.silentFor(fresh) <= this.stallMs) return false;
    const why =
      `no stdout for ${Math.round(this.silentFor(fresh) / 1000)}s ` +
      `with tree CPU +${Math.round(deltaMs)}ms over ${Math.round(elapsedMs)}ms (${utilization.toFixed(1)}%)`;
    const strike = Math.min(2, (this.strikes.get(workerId) ?? 0) + 1);
    await this.hooks.onStrike(workerId, strike === 1 ? 1 : 2, why);
    // Counted only once the host acted: a failed strike handler must not consume the strike
    // (it would turn the next strike into the terminal one without its respawn).
    this.strikes.set(workerId, strike);
    this.lastHotAt.delete(workerId);
    return true;
  }
}

/** The continuation note appended to the original prompt on a stall respawn (spike shape). */
export function stallContinueNote(why: string): string {
  return (
    `(System note: your previous run stalled — ${why} — and was restarted automatically. ` +
    "Check the current files and git status to confirm what is already done, then continue " +
    "the task from where it stopped. Do not redo completed work.)"
  );
}
