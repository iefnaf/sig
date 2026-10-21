// PiProcess: a thin `pi --mode rpc` client, docs/design/connector-pi.md §2 and §4.
// Responsibilities only: spawn the child, strict LF framing, request/response correlation,
// event dispatch, exit detection. ~a couple hundred lines, no dependency on pi's RpcClient
// (research §4 constraint 1: it can't launch an installed `pi` binary and mishandles stderr).
//
// Spike conclusions §2: responses use `success`, not `ok` — check `success === false || error`.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { appendCapped } from "./logger.ts";
import { redactText } from "./redact.ts";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface PiProcessOptions {
  /** argv prefix for the agent binary, e.g. ["pi"] or [process.execPath, fakePiPath]. */
  command: string[];
  /** Arguments after the prefix (e.g. ["--mode", "rpc", ...]). */
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  /** Keep only the last N bytes of stderr (connector-pi.md §4.4). */
  stderrTailBytes?: number;
  /** When set, stderr is also appended (redacted, capped) to this file — the per-worker
   * tail the design keeps under ~/.sig/logs/ (§12). */
  stderrFile?: string;
  /** Cap for the stderr file; defaults to the same 64 KiB as the in-memory tail. */
  stderrFileMaxBytes?: number;
  /** Grace period between closing stdin and SIGKILL on stop (§4.4: 3s measured). */
  stopGraceMs?: number;
  /** Fallback rpc budget when a call passes none (PR #45 review #8): control RPCs —
   *  steer/follow_up/clear_queue/abort and prompt deliveries — are acceptance round-trips
   *  pi answers in milliseconds (research #3 measured abort at ~3 ms), so a response that
   *  never comes means a wedged process; failing the command beats parking it (and the
   *  steward's outbox row) forever. Defaults to 15 s. */
  defaultRpcTimeoutMs?: number;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiProcess {
  private readonly options: PiProcessOptions;
  private readonly pending = new Map<string, Pending>();
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private stderrTail = "";
  private readonly stderrLimit: number;
  private readonly defaultRpcTimeoutMs: number;
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitWaiters: (() => void)[] = [];
  /** Last stdout activity (spawn time until the first chunk) — the watchdog's silence clock. */
  private lastOutputAtMs = 0;

  constructor(options: PiProcessOptions) {
    this.options = options;
    this.stderrLimit = options.stderrTailBytes ?? 64 * 1024;
    this.defaultRpcTimeoutMs = options.defaultRpcTimeoutMs ?? 15_000;
  }

  spawn(): void {
    if (this.child) throw new Error("PiProcess already spawned");
    const child = spawn(this.options.command[0]!, [...this.options.command.slice(1), ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // pi's bash tool starts detached children; keep pi in our process group regardless.
      detached: false,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    // Silence counts from spawn: a process that never says anything is silent from birth.
    this.lastOutputAtMs = Date.now();

    // Keep draining stdout unconditionally: pi honors backpressure, so a client that stops
    // reading stalls the process (rpc.md "Framing"). The data handler is attached at spawn
    // and never removed.
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    // A stdin write after the child died emits EPIPE on the stream; without a listener
    // that is an uncaught exception (it took down CI and would take down the daemon).
    // Lifecycle is owned by the exit/error handlers below — a failed write past death is
    // expected: fire-and-forget sends no-op, and pending calls reject via their timeout.
    child.stdin.on("error", () => {});
    child.on("error", (err) => this.handleExit(null, null, err));
    child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Last stdout activity, ms epoch (see spawn). */
  get lastOutputAt(): number {
    return this.lastOutputAtMs;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  /** Sends one command and resolves with the response `data`. Rejects on `success === false`,
   * an `error` field, timeout (explicit, or the default budget when none is passed), or
   * process exit (spike-conclusions §2: `success`, not `ok`). */
  rpc(command: Record<string, unknown>, timeoutMs: number = this.defaultRpcTimeoutMs): Promise<Record<string, unknown>> {
    const id = typeof command.id === "string" ? command.id : randomUUID();
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) {
        reject(new RpcError("pi process is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`rpc timed out after ${timeoutMs}ms`, String(command.type ?? "")));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      this.writeLine({ ...command, id });
    });
  }

  /** Sends a command without waiting for its response (fire-and-forget). */
  send(command: Record<string, unknown>): void {
    this.writeLine(command);
  }

  private writeLine(record: Record<string, unknown>): void {
    if (!this.child || this.exited) throw new RpcError("pi process is not running");
    // One complete JSON object per record terminated by LF. Node's stdin stream buffers
    // internally under backpressure; commands are small so this never grows unboundedly.
    this.child.stdin.write(JSON.stringify(record) + "\n");
  }

  /** Stop sequence (§4.4): close stdin → wait the grace period → SIGKILL. Resolves on exit. */
  async close(graceMs = this.options.stopGraceMs ?? 3000): Promise<void> {
    if (this.exited || !this.child) return;
    const exited = this.waitExit();
    try {
      this.child.stdin.end();
    } catch {
      // stdin may already be destroyed; the exit event still arrives.
    }
    const killer = setTimeout(() => this.kill(), graceMs);
    killer.unref?.();
    await exited;
    clearTimeout(killer);
  }

  kill(): void {
    if (this.exited || !this.child) return;
    this.child.kill("SIGKILL");
  }

  waitExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.lastOutputAtMs = Date.now();
    // Strict LF framing: split records only on LF (strip one optional trailing CR). Never use
    // readline — it also splits on U+2028/U+2029, which are valid inside JSON strings.
    this.stdoutBuffer += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
      let line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // §9.4: an unparseable line is logged and dropped; do not terminate.
        this.stderrTail += `\n[sig] unparseable stdout line: ${line.slice(0, 200)}\n`;
        continue;
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: Record<string, unknown>): void {
    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : null;
      if (id && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        if (record.success === false || record.error !== undefined) {
          pending.reject(
            new RpcError(String(record.error ?? "rpc failed"), typeof record.command === "string" ? record.command : undefined),
          );
        } else {
          pending.resolve((record.data as Record<string, unknown>) ?? {});
        }
      }
      // Responses without a known id (e.g. late timeouts, parse errors) are dropped.
      return;
    }
    this.options.onEvent(record);
  }

  private appendStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.stderrTail = (this.stderrTail + text).slice(-this.stderrLimit);
    if (this.options.stderrFile) {
      // Diagnostics only, never session content (that flows over stdout); still redacted.
      // Best-effort by contract: a late chunk after the log dir vanished (tests tearing
      // down, disk removed) must never take the connector down with it.
      try {
        appendCapped(this.options.stderrFile, redactText(text), this.options.stderrFileMaxBytes ?? this.stderrLimit);
      } catch {
        // the in-memory tail above still carries it
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    if (error) this.appendStderr(Buffer.from(`\n[sig] spawn error: ${error.message}\n`));
    const failure = new RpcError(
      `pi process exited (code=${code} signal=${signal})${this.stderrTail ? `; stderr tail:\n${this.stderrTail.slice(-2000)}` : ""}`,
    );
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    this.options.onExit(this.exitInfo);
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}
