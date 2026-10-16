// Stall watchdog (issue #13, ADR-0001 "stall detection"; spike-conclusions §2/§5): a worker
// that is silent on stdout for the threshold AND sitting at ~0 CPU on two samples is wedged
// — quiet-but-hot is a build, not a stall, so CPU is the discriminator. First strike gets one
// automatic respawn (same worktree, same session, continuation note); a second strike settles
// the run as error:stall. The host (WorkerManager) owns the lifecycle actions; this class
// owns only detection and strike counting.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** One `ps -p <pid> -o %cpu=` sample; undefined when the value cannot be read. */
export async function sampleCpuPercent(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "%cpu="], { timeout: 2000 });
    const value = Number.parseFloat(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface StallWatchdogOptions {
  /** Silence (no stdout) after which CPU sampling starts; default 8 min (the spike's value). */
  stallMs?: number;
  /** Both CPU samples must sit below this to declare a stall; default 5 (%). */
  cpuPct?: number;
  /** Check cadence; default clamp(stallMs / 4, 5 s, 30 s). */
  tickMs?: number;
  /** Gap between the two CPU samples; default 2.5 s (tests shrink it). */
  cpuSampleGapMs?: number;
  /** CPU sampler seam (tests inject deterministic values). */
  sampleCpu?: (pid: number) => Promise<number | undefined>;
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
  private readonly sampleCpu: (pid: number) => Promise<number | undefined>;
  private readonly now: () => number;
  private readonly hooks: StallWatchdogHooks;

  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** Strikes this run, per worker; reset by forget() when the run ends. */
  private readonly strikes = new Map<string, number>();
  /**
   * Last time CPU said "hot" for a silent worker: a legitimate long build must not be
   * re-sampled on every tick, so a hot check pushes the next stall consideration out by
   * another full stallMs.
   */
  private readonly lastHotAt = new Map<string, number>();

  constructor(options: StallWatchdogOptions, hooks: StallWatchdogHooks) {
    this.stallMs = options.stallMs ?? 8 * 60_000;
    this.cpuPct = options.cpuPct ?? 5;
    this.tickMs = options.tickMs ?? Math.max(5_000, Math.min(30_000, Math.ceil(this.stallMs / 4)));
    this.cpuSampleGapMs = options.cpuSampleGapMs ?? 2_500;
    this.sampleCpu = options.sampleCpu ?? sampleCpuPercent;
    this.now = options.now ?? Date.now;
    this.hooks = hooks;
  }

  /** Starts the periodic check; idempotent. The timer never keeps the process alive. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
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
   * strike handler can respawn a process, which must not race a second tick.
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let confirmed = 0;
    try {
      for (const candidate of this.hooks.candidates()) {
        const strike = await this.check(candidate);
        if (strike) confirmed += 1;
      }
    } finally {
      this.ticking = false;
    }
    return confirmed;
  }

  private async check(candidate: WatchdogCandidate): Promise<boolean> {
    const { workerId, pid } = candidate;
    const since = Math.max(candidate.lastOutputAt, this.lastHotAt.get(workerId) ?? 0);
    const silentMs = this.now() - since;
    if (silentMs <= this.stallMs) return false;
    // Two samples, both cold. Either one hot (or unreadable) means a quiet-but-busy
    // process — a build, not a stall: push the next consideration out by a full window.
    const first = await this.sampleCpu(pid);
    if (first === undefined || first >= this.cpuPct) {
      this.lastHotAt.set(workerId, this.now());
      return false;
    }
    await sleep(this.cpuSampleGapMs);
    const second = await this.sampleCpu(pid);
    if (second === undefined || second >= this.cpuPct) {
      this.lastHotAt.set(workerId, this.now());
      return false;
    }
    const why = `no stdout for ${Math.round(silentMs / 1000)}s with CPU ${first.toFixed(1)}%/${second.toFixed(1)}%`;
    const strike = Math.min(2, (this.strikes.get(workerId) ?? 0) + 1);
    this.strikes.set(workerId, strike);
    this.lastHotAt.delete(workerId);
    await this.hooks.onStrike(workerId, strike === 1 ? 1 : 2, why);
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
