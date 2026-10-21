// ClaudeAdapter: the second AgentAdapter implementation (issue #17, ADR-0001 decision 3;
// connector-pi.md §15 item 8; spike-conclusions §2 "Claude Code headless"). Claude Code
// becomes a worker the steward can dispatch to: headless `claude -p` with stream-json
// output, a Sig MCP `report` tool, and the SAME outcome-adjudication path as pi.
//
// Where the agents differ, the capabilities say so honestly (§3) and the WorkerManager
// degrades: headless print mode has no control channel after stdin hits EOF, so there is no
// mid-run steer and no queued follow-up — a send that lands mid-run is deferred to run end
// and delivered as the next prompt. The process model also differs from pi: one `claude -p`
// per run, the process exits when the run ends (there is no idle-hot window), and the next
// prompt relaunches with `--resume <session uuid>`.
import type {
  AgentAdapter,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  RawAdapterEvent,
  SessionUsage,
  StartSpec,
  WorkerHandle,
} from "./agent.ts";
import { AdapterError } from "./agent.ts";
import { adjudicate, type RunWindow } from "./adjudication.ts";
import { childEnv, extractTarget, normalizeReport, RESUME_PROMPT } from "./pi-adapter.ts";
import { installClaudeAssets, WORKER_SYSTEM_PROMPT } from "./install.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { appendCapped } from "./logger.ts";
import { redactText } from "./redact.ts";

/** Claude Code requires a UUID session id (§4.2's workerId shape does not qualify). */
const SIG_NAMESPACE = "e5f0a7c1-3b9d-4e8a-9f2b-6c4d1a7e8b3f";

/** Deterministic UUID (RFC 4122 shape, v5-style construction) for a workerId: the session id
 *  is a pure function of the worker, so relaunches — in this process or after a connector
 *  restart — always land on the same Claude Code session without extra state. */
export function claudeSessionId(workerId: string): string {
  const namespace = SIG_NAMESPACE.replace(/-/g, "");
  const hash = createHash("sha1");
  for (let i = 0; i < 16; i += 1) {
    hash.update(Buffer.from([Number.parseInt(namespace.slice(i * 2, i * 2 + 2), 16)]));
  }
  hash.update(workerId, "utf8");
  const bytes = hash.digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** stop_reason mapping (spike-conclusions §2): end_turn→stop, tool_use→tool_use,
 *  max_tokens→length — pi's vocabulary, so §5.2 adjudication reads both agents alike. */
export function mapStopReason(stopReason: unknown): string | undefined {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case null:
    case undefined:
      return undefined;
    default:
      return typeof stopReason === "string" ? stopReason : undefined;
  }
}

/** MCP tool calls arrive namespaced (`mcp__sig__report`): never match the bare name
 *  `report` — suffix-match instead (spike-conclusions §2). */
export function isReportTool(name: string): boolean {
  return name.endsWith("__report");
}

/** Honest capability set (connector-pi.md §3): what headless Claude Code can and cannot do. */
const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // No control channel after stdin EOF: a mid-run steer or queued follow-up is impossible.
  steer: false,
  followUp: false,
  // SIGKILL + a synthetic settled{aborted}; the session file is append-only, so --resume
  // still works and the fixed resume prompt covers half-finished tool calls (§9.2).
  interrupt: true,
  resume: true,
  // Claude Code keeps transcripts under ~/.claude; no raw-history read is exposed (MVP).
  history: false,
  // -p reads the prompt from stdin as text; there is no image channel.
  images: false,
  structuredReport: true,
  // The MVP permission bypass (--dangerously-skip-permissions) cannot truly restrict the
  // run to read-only; readonly tasks must not be dispatched to this agent.
  readonly: false,
};

export interface ClaudeAdapterOptions {
  stateDir: string;
  /** argv prefix for the claude binary; default ["claude"]. Tests point this at fake-claude. */
  command?: string[];
  /** Extra env for the child (tests). SIG_* is always stripped (issue #27). */
  env?: Record<string, string | undefined>;
  /** Per-worker stderr tails (§12); default <stateDir>/logs. Pass null to disable. */
  workerLogsDir?: string | null;
  /** hello.agents version string (the detected `claude --version` output). */
  version?: string;
  /** system/init must arrive within this window after spawn (default 30 s — the CLI cold
   *  start is slower than pi's ~350 ms). */
  initTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL on stop (default 3 s, §4.4). */
  stopGraceMs?: number;
}

interface WorkerRuntime {
  workerId: string;
  process: ClaudeProcess;
  cwd: string;
  sessionId: string;
  /** Set when the connector itself ends this process; makes exits "expected". */
  stopping: boolean;
  /** An interrupt killed this run before its `result`; the exit settles it as aborted. */
  interrupting: boolean;
  /** The `result` event arrived: the run settled, the exit that follows is expected. */
  resultSeen: boolean;
  turn: number;
  window: RunWindow & { open: boolean };
  /** Assistant text accumulated for the message currently being streamed. */
  pendingText: string;
  /** Buffer from spawn until start() resolves — `started` must precede streamed events (§11.1). */
  buffered: RawAdapterEvent[] | null;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly options: ClaudeAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  /** The last StartSpec per worker: a prompt-path send relaunches from it with --resume. */
  private readonly lastSpecs = new Map<string, StartSpec>();

  constructor(options: ClaudeAdapterOptions) {
    this.options = options;
    this.workerLogsDir = options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
  }

  get version(): string | undefined {
    return this.options.version;
  }

  on(event: "worker-event", fn: (e: RawAdapterEvent) => void): void {
    if (event !== "worker-event") throw new Error(`unknown event: ${event}`);
    this.listeners.push(fn);
  }

  private emit(e: RawAdapterEvent): void {
    const runtime = this.runtimes.get(e.workerId);
    if (runtime?.buffered) {
      runtime.buffered.push(e);
      return;
    }
    for (const fn of this.listeners) fn(e);
  }

  private flushBuffered(runtime: WorkerRuntime): void {
    const buffered = runtime.buffered;
    runtime.buffered = null;
    if (!buffered) return;
    for (const event of buffered) {
      for (const fn of this.listeners) fn(event);
    }
  }

  /** Builds the headless invocation (spike-conclusions §2): permission bypass is the MVP
   *  yolo product decision; `--session-id` on a first run, `--resume` on a continuation. */
  buildArgs(spec: StartSpec, mcpConfigPath: string): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfigPath,
      "--append-system-prompt",
      WORKER_SYSTEM_PROMPT,
      "--dangerously-skip-permissions",
    ];
    const sessionId = spec.resumeSessionId ?? claudeSessionId(spec.workerId);
    args.push(spec.resumeSessionId ? "--resume" : "--session-id", sessionId);
    if (spec.model) args.push("--model", spec.model);
    return args;
  }

  /** The per-worker mcp-config: Claude Code spawns our report server as an MCP child. */
  private writeMcpConfig(workerId: string, serverPath: string): string {
    const mcpDir = join(this.options.stateDir, "mcp");
    const configPath = join(mcpDir, `config-${workerId}.json`);
    const reportFile = join(mcpDir, "reports", `${workerId}.json`);
    // The path rides the config's argv — visible to the model in yolo mode, but it is a
    // scratch channel, not a secret (§7.2: model-reported content is semantics, not fact).
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          sig: { type: "stdio", command: process.execPath, args: [serverPath, reportFile], env: {} },
        },
      }),
    );
    return configPath;
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a claude process for ${spec.workerId} is already running`);
    }
    const assets = installClaudeAssets(this.options.stateDir);
    const serverPath = assets.serverPath;
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });
    const sessionId = spec.resumeSessionId ?? claudeSessionId(spec.workerId);
    const configPath = this.writeMcpConfig(spec.workerId, serverPath);

    let runtime!: WorkerRuntime;
    const proc = new ClaudeProcess({
      command: this.options.command ?? ["claude"],
      args: this.buildArgs(spec, configPath),
      cwd: spec.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `claude-${spec.workerId}.log`) : undefined,
      onEvent: (record) => this.onStreamEvent(runtime, record),
      onExit: (info) => this.onExit(runtime, info),
    });
    runtime = {
      workerId: spec.workerId,
      process: proc,
      cwd: spec.cwd,
      sessionId,
      stopping: false,
      interrupting: false,
      resultSeen: false,
      turn: 0,
      window: { open: false, aborted: false },
      pendingText: "",
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    this.lastSpecs.set(spec.workerId, spec);
    proc.spawn();
    // The stdin prompt is only processed on EOF (spike): write it, then END stdin.
    proc.writePrompt(spec.prompt);

    try {
      // §4.4 step 4 analog: system/init must arrive within the window, echo our session id,
      // and show the sig MCP server connected (§15 item 1's startup self-check).
      const init = await proc.waitForInit(this.options.initTimeoutMs ?? 30_000);
      const seen = typeof init.session_id === "string" ? init.session_id : "";
      if (!UUID_RE.test(sessionId) || (seen !== "" && seen !== sessionId)) {
        throw new AdapterError(
          "startup_failed",
          `session id mismatch: expected ${sessionId}, got ${seen || "(none)"} — is this Claude Code?`,
        );
      }
      const mcp = Array.isArray(init.mcp_servers)
        ? (init.mcp_servers as Array<Record<string, unknown>>).find((s) => s.name === "sig")
        : undefined;
      if (mcp && typeof mcp.status === "string" && mcp.status !== "connected") {
        throw new AdapterError(
          "startup_failed",
          `sig MCP server status '${mcp.status}': the report tool is not available; refusing to run unreported`,
        );
      }
      const handle: WorkerHandle = { workerId: spec.workerId, sessionId, cwd: spec.cwd };
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      runtime.buffered = null; // nothing started, so nothing to replay
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      proc.kill();
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AdapterError("startup_failed", `claude startup failed: ${reason}`);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    if (how !== "prompt") {
      // steer/follow_up are impossible after stdin EOF; the manager defers instead of calling.
      throw new AdapterError("unsupported", `claude-code cannot ${how} mid-run (no control channel after stdin EOF)`);
    }
    const previous = this.runtimes.get(id);
    if (previous && !previous.process.hasExited) {
      // The post-result exit window: the run settled, the process is on its way out —
      // reclaim it before the relaunch (one live process per worker, §4.3).
      previous.stopping = true;
      this.runtimes.delete(id);
      await previous.process.close(2000);
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to continue worker ${id}`);
    await this.start({
      ...spec,
      prompt: input.text,
      commandId: input.commandId ?? spec.commandId,
      resumeSessionId: claudeSessionId(id),
      images: input.images,
    });
    return {};
  }

  /** No graceful abort exists in headless mode: SIGKILL the process, then synthesize the
   *  `settled{aborted}` the interrupt flow waits for. The session survives (append-only
   *  transcript), so `--resume` + the fixed prompt recovers, exactly like a crash. */
  async interrupt(id: string): Promise<InterruptResult> {
    const runtime = this.require(id);
    if (runtime.resultSeen) {
      // PR #59 review finding 4: the run already settled and reported — nothing to abort.
      // Reclaim the lingering (exiting) process so the interrupt still does something, and
      // say so: aborted:false, or the steward tells the user "停了" next to a report card.
      runtime.stopping = true;
      this.runtimes.delete(id);
      await runtime.process.close(2000);
      return { returned: [], alreadySettled: true };
    }
    runtime.interrupting = true;
    runtime.process.kill();
    await runtime.process.waitExit();
    return { returned: [] };
  }

  async resume(id: string, reason: string, _options: { commandId?: string } = {}): Promise<void> {
    // (_options carries the pi commandId marker; claude has no session-file marker to write.)
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      throw new AdapterError(
        "not_idle",
        "claude-code cannot resume while a run is in flight; interrupt it or wait for the run to end",
      );
    }
    const spec = this.lastSpecs.get(id);
    if (!spec) throw new AdapterError("not_found", `no known spec to resume worker ${id}`);
    await this.start({ ...spec, prompt: `${RESUME_PROMPT}\n\nReason: ${reason}`, resumeSessionId: claudeSessionId(id) });
  }

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    await runtime.process.close(this.options.stopGraceMs);
  }

  isRunning(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited;
  }

  isStreaming(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited && runtime.window.open;
  }

  workerPids(): Array<{ workerId: string; pid: number }> {
    const out: Array<{ workerId: string; pid: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) out.push({ workerId, pid });
    }
    return out;
  }

  workerActivity(): Array<{ workerId: string; pid: number; lastOutputAt: number }> {
    const out: Array<{ workerId: string; pid: number; lastOutputAt: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) {
        out.push({ workerId, pid, lastOutputAt: runtime.process.lastOutputAt });
      }
    }
    return out;
  }

  /** Test support: emulate a hard connector crash — children SIGKILLed, no cleanup. */
  simulateCrash(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.stopping = true;
      try {
        runtime.process.kill();
      } catch {
        // already gone
      }
    }
    this.runtimes.clear();
  }

  stderrTail(id: string): string {
    return this.runtimes.get(id)?.process.getStderrTail() ?? "";
  }

  private require(id: string): WorkerRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live claude process for worker ${id}`);
    }
    return runtime;
  }

  // --- stream-json → RawAdapterEvent (spike-conclusions §2) ---------------------------------

  private onStreamEvent(runtime: WorkerRuntime, record: Record<string, unknown>): void {
    switch (record.type) {
      case "system": {
        if (record.subtype === "init") runtime.window = { open: true, aborted: false };
        return;
      }
      case "assistant": {
        const message = record.message as Record<string, unknown> | undefined;
        if (!message) return;
        runtime.turn += 1;
        runtime.pendingText = "";
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            runtime.pendingText += block.text;
            continue;
          }
          if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            const input = block.input;
            if (isReportTool(name)) {
              // Suffix match only: the namespace prefix is not ours to predict.
              const report = normalizeReport(input);
              if (report) runtime.window.report = report;
            }
            this.emit({
              type: "progress",
              workerId: runtime.workerId,
              phase: "tool",
              tool: isReportTool(name) ? "report" : name,
              target: extractTarget(input),
              turn: runtime.turn,
            });
          }
        }
        this.emit({ type: "progress", workerId: runtime.workerId, phase: "thinking", turn: runtime.turn });
        runtime.window.lastAssistant = {
          stopReason: mapStopReason(message.stop_reason),
          text: runtime.pendingText,
        };
        return;
      }
      case "user":
        // Tool results — no WorkerEvent of their own (§11.1 compression).
        return;
      case "result": {
        if (!runtime.window.open) return;
        const errored =
          record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error"));
        if (errored) {
          const detail =
            typeof record.result === "string" && record.result.length > 0
              ? record.result
              : String(record.subtype ?? "error during execution");
          runtime.window.lastAssistant = {
            stopReason: "error",
            errorMessage: detail,
            text: runtime.window.lastAssistant?.text ?? "",
          };
        }
        runtime.resultSeen = true;
        void this.settle(runtime, record);
        return;
      }
      default:
        return;
    }
  }

  private async settle(runtime: WorkerRuntime, result: Record<string, unknown>): Promise<void> {
    const facts = runtime.window;
    const adjudicated = adjudicate(facts);
    runtime.window = { open: false, aborted: false };
    runtime.turn = 0;

    // usage from the result envelope (the analog of pi's get_session_stats at settlement).
    const usage: SessionUsage = {};
    const rawUsage = result.usage as Record<string, unknown> | undefined;
    if (rawUsage && typeof rawUsage.input_tokens === "number") {
      const input = rawUsage.input_tokens;
      const output = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
      usage.tokens = { input, output, totalTokens: input + output };
    }
    if (typeof result.total_cost_usd === "number") usage.cost = result.total_cost_usd;

    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      ...(usage.tokens || usage.cost !== undefined ? { usage } : {}),
    });
  }

  private onExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    // An interrupt kill before `result`: settle the run as aborted — the interrupt flow
    // waits for exactly this. (A post-result exit needs no second settle.)
    if (runtime.interrupting && !runtime.resultSeen && runtime.window.open) {
      runtime.window.aborted = true;
      runtime.window = { open: false, aborted: false };
      this.emit({ type: "settled", workerId: runtime.workerId, outcome: "aborted" });
    }
    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code: info.code,
      signal: info.signal,
      // Expected when we stopped/interrupted it or the run's `result` already settled it;
      // anything else is a crash → the manager's lost/auto-resume path (§9.1/§9.2).
      unexpected: !runtime.stopping && !runtime.interrupting && !runtime.resultSeen,
    });
  }
}

/**
 * ClaudeProcess: spawn + strict LF framing over `claude -p` stdout, stderr tail, exit
 * detection. No RPC — headless Claude Code speaks one way (events out) with the prompt
 * going in over stdin, closed with end() to trigger processing (spike-conclusions §2).
 */
export class ClaudeProcess {
  private readonly options: ClaudeProcessOptions;
  private child?: ChildProcess;
  private stdoutBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private stderrTail = "";
  private readonly stderrLimit = 64 * 1024;
  private exited = false;
  private exitWaiters: (() => void)[] = [];
  private lastOutputAtMs = 0;
  private initWaiter:
    | { resolve: (init: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
    | null = null;

  constructor(options: ClaudeProcessOptions) {
    this.options = options;
  }

  spawn(): void {
    if (this.child) throw new Error("ClaudeProcess already spawned");
    const child = spawn(this.options.command[0]!, [...this.options.command.slice(1), ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error("claude process is not piped");
    }
    this.child = child;
    this.lastOutputAtMs = Date.now();
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    child.on("error", (err) => this.handleExit(null, null, err));
    child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  /** The prompt goes to stdin and stdin is ENDED: the spike hit a permanent hang without it. */
  writePrompt(prompt: string): void {
    const stdin = this.child?.stdin;
    if (!this.child || this.exited || !stdin) throw new Error("claude process is not running");
    stdin.write(prompt, () => {
      // stdin may already be destroyed (a fast crash); the exit event still arrives.
    });
    stdin.end();
  }

  /** Resolves on the `system/init` event; rejects on exit or timeout (the message carries
   *  the stderr tail, §9.4's startup-failure reporting). */
  waitForInit(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) {
        reject(new Error(`claude process exited before init; stderr tail:\n${this.stderrTail.slice(-2000)}`));
        return;
      }
      const timer = setTimeout(() => {
        this.initWaiter = null;
        reject(new Error(`no system/init within ${timeoutMs}ms; stderr tail:\n${this.stderrTail.slice(-2000)}`));
      }, timeoutMs);
      timer.unref?.();
      this.initWaiter = { resolve, reject, timer };
    });
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get lastOutputAt(): number {
    return this.lastOutputAtMs;
  }

  getStderrTail(): string {
    return this.stderrTail;
  }

  kill(): void {
    if (this.exited || !this.child) return;
    this.child.kill("SIGKILL");
  }

  /** Stop sequence: stdin is already EOF'd in print mode, so wait the grace period and
   *  SIGKILL. Resolves on exit. */
  async close(graceMs = 3000): Promise<void> {
    if (this.exited || !this.child) return;
    const exited = this.waitExit();
    try {
      this.child.stdin?.end();
    } catch {
      // already destroyed
    }
    const killer = setTimeout(() => this.kill(), graceMs);
    killer.unref?.();
    await exited;
    clearTimeout(killer);
  }

  waitExit(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.lastOutputAtMs = Date.now();
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
      if (record.type === "system" && record.subtype === "init" && this.initWaiter) {
        const waiter = this.initWaiter;
        this.initWaiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
      this.options.onEvent(record);
    }
  }

  private appendStderr(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    this.stderrTail = (this.stderrTail + text).slice(-this.stderrLimit);
    if (this.options.stderrFile) {
      appendCapped(this.options.stderrFile, redactText(text), this.stderrLimit);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    if (error) this.appendStderr(Buffer.from(`\n[sig] spawn error: ${error.message}\n`));
    if (this.initWaiter) {
      const waiter = this.initWaiter;
      this.initWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`claude process exited (code=${code} signal=${signal}); stderr tail:\n${this.stderrTail.slice(-2000)}`));
    }
    this.options.onExit({ code, signal });
    for (const waiter of this.exitWaiters) waiter();
    this.exitWaiters = [];
  }
}

export interface ClaudeProcessOptions {
  /** argv prefix for the claude binary, e.g. ["claude"] or [process.execPath, fakeClaudePath]. */
  command: string[];
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  onEvent: (event: Record<string, unknown>) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  stderrFile?: string;
}

/** Whether a `claude` binary is on the machine (hello.agents advertises it only when it
 *  is, issue #17 AC): `claude --version` must exit 0. Sync on purpose — a boot-time check. */
export function detectClaude(command: string[] = ["claude"], timeoutMs = 5000): { installed: boolean; version?: string } {
  try {
    const result = spawnSync(command[0]!, [...command.slice(1), "--version"], { timeout: timeoutMs, encoding: "utf8" });
    if (result.status !== 0 || result.error) return { installed: false };
    const version = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
    return { installed: true, version: version.length > 0 ? version : undefined };
  } catch {
    return { installed: false };
  }
}
