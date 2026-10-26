// PiAdapter: the first AgentAdapter implementation, docs/design/connector-pi.md §3–§7.
// Normalizes pi's raw event stream into coarse-grained adapter events and runs outcome
// adjudication on `agent_settled` (§5.2). Git facts are NOT collected here — the
// WorkerManager merges those after adjudication so they come from git, not the model.
import type {
  AgentAdapter,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  RawAdapterEvent,
  ReportPayload,
  SessionUsage,
  StartSpec,
  WorkerHandle,
} from "./agent.ts";
import { AdapterError, PartialInterruptError } from "./agent.ts";
import { adjudicate, type RunWindow } from "./adjudication.ts";
import { normalizeSessionEntries } from "./session-history.ts";
import { observeSession } from "./session-observation.ts";
import { installAssets, type InstalledAssets } from "./install.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PiProcess } from "./pi-process.ts";
import type { HistoryPage } from "@alexlikevibe/protocol";

/** Must match COMMAND_NAME in ./ext/sig-pi.ts (locked together by a test). */
const SIG_COMMAND = "sig";

export interface PiAdapterOptions {
  stateDir: string;
  /** argv prefix for the pi binary; default ["pi"]. Tests point this at fake-pi. */
  command?: string[];
  /** get_state must succeed within this window after spawn (§4.4: 5 seconds). */
  getStateTimeoutMs?: number;
  /** Extra env passed to the child (tests). The connector's own credentials never ride along. */
  env?: Record<string, string | undefined>;
  /** Where per-worker stderr tails are kept (§12); default <stateDir>/logs. Pass null to disable. */
  workerLogsDir?: string | null;
}

/** Env for the agent child (§4.2: "inherit the user's environment; the connector's own
 * credentials are not passed through", issue #27). The connector's state lives under
 * SIG_* variables (the home setting locates the device-token store), so the whole
 * namespace is stripped; the device token itself never was an env var. */
export function childEnv(
  source: Record<string, string | undefined> = process.env,
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("SIG_")) continue;
    env[key] = value;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

const PI_CAPABILITIES: AgentCapabilities = {
  steer: true,
  followUp: true,
  interrupt: true,
  resume: true,
  history: true,
  images: true,
  structuredReport: true,
  readonly: true,
};

/** The fixed resume prompt, connector-pi.md §9.2. */
export const RESUME_PROMPT =
  "Your previous process was interrupted (machine or process restart). First check the current " +
  "files and git status, confirm what is already done, then continue the task. Interrupted tool " +
  "calls may have been only partially executed.";

interface WorkerRuntime {
  workerId: string;
  process: PiProcess;
  cwd: string;
  /** Set when the connector itself is stopping the process; makes exits "expected". */
  stopping: boolean;
  turn: number;
  window: RunWindow & { open: boolean };
  /**
   * Events are buffered from spawn until start() resolves: a fast agent can begin streaming
   * (agent_start …) before the caller has emitted its `started` event, which must come first
   * on the wire (§11.1). The flush rides a macrotask, so the caller's `await` continuation —
   * which emits `started` — deterministically runs first.
   */
  buffered: RawAdapterEvent[] | null;
}

export class PiAdapter implements AgentAdapter {
  readonly kind = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;

  private readonly options: PiAdapterOptions;
  private readonly workerLogsDir: string | null;
  private readonly runtimes = new Map<string, WorkerRuntime>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  private assets?: InstalledAssets;

  constructor(options: PiAdapterOptions) {
    this.options = options;
    this.workerLogsDir = options.workerLogsDir === null ? null : (options.workerLogsDir ?? join(options.stateDir, "logs"));
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

  /** Builds the startup command line (§4.2). */
  buildArgs(spec: StartSpec, assets: InstalledAssets): string[] {
    const args = [
      "--mode",
      "rpc",
      "--session-id",
      spec.workerId,
      "--extension",
      assets.extensionPath,
      "--append-system-prompt",
      assets.promptPath,
      // §13: --no-approve unless the repo is locally approved (approveProject is a
      // connector-local per-repo setting, never taken from a command).
      spec.approveProject === true ? "--approve" : "--no-approve",
    ];
    if (spec.mode === "readonly") args.push("--tools", "read,grep,find,ls,report");
    if (spec.model) args.push("--model", spec.model);
    return args;
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    // In-memory half of the one-file-one-process invariant (§4.3); the lock file is the
    // WorkerManager's half.
    if (this.runtimes.has(spec.workerId)) {
      throw new AdapterError("lock_held", `a pi process for ${spec.workerId} is already running`);
    }
    this.assets = this.assets ?? installAssets(this.options.stateDir);
    if (this.workerLogsDir) mkdirSync(this.workerLogsDir, { recursive: true });

    let runtime!: WorkerRuntime;
    const proc = new PiProcess({
      command: this.options.command ?? ["pi"],
      args: this.buildArgs(spec, this.assets),
      cwd: spec.cwd,
      env: childEnv(process.env, this.options.env),
      stderrFile: this.workerLogsDir ? join(this.workerLogsDir, `pi-${spec.workerId}.log`) : undefined,
      onEvent: (record) => this.onPiEvent(runtime, record),
      onExit: (info) => this.onPiExit(runtime, info),
    });
    runtime = {
      workerId: spec.workerId,
      process: proc,
      cwd: spec.cwd,
      stopping: false,
      turn: 0,
      window: { open: false, aborted: false },
      buffered: [],
    };
    this.runtimes.set(spec.workerId, runtime);
    proc.spawn();

    try {
      // §4.4 step 4: get_state must succeed within the timeout and sessionId must match.
      const timeout = this.options.getStateTimeoutMs ?? 5000;
      const state = await proc.rpc({ type: "get_state" }, timeout);
      if (state.sessionId !== spec.workerId) {
        throw new AdapterError(
          "startup_failed",
          `sessionId mismatch: expected ${spec.workerId}, got ${String(state.sessionId)}`,
        );
      }
      const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : null;
      // §6.3/§10: the session file and its current tail are on record BEFORE the prompt is
      // sent, so a crash anywhere past this point leaves decidable evidence (the marker
      // entry for this command, and the external-activity baseline it is diffed against).
      // Fires even with no session file: the write-ahead must precede the prompt regardless.
      const observation = sessionFile ? observeSession(sessionFile) : null;
      try {
        spec.onSession?.(sessionFile, observation?.lastEntryId ?? null);
      } catch {
        // observation bookkeeping must never fail a launch
      }
      const handle: WorkerHandle = {
        workerId: spec.workerId,
        sessionId: String(state.sessionId),
        sessionFile: sessionFile ?? undefined,
        cwd: spec.cwd,
      };

      // §4.4 step 5: send the prompt, wrapped for the extension's commandId marker
      // (ADR-0001). The `/sig` extension command consumes it, so the response's
      // disposition must be "handled".
      const message = wrapPrompt(spec.commandId, spec.prompt);
      const response = await proc.rpc(
        { type: "prompt", message, images: spec.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) },
        timeout,
      );
      const disposition = String(response.disposition ?? "");
      if (disposition !== "handled") {
        throw new AdapterError(
          "startup_failed",
          `sig extension did not consume the prompt (disposition: ${disposition || "missing"}); ` +
            `is ~/.sig/ext loadable?`,
        );
      }
      this.pendingResumeSpecs.set(spec.workerId, spec);
      setImmediate(() => this.flushBuffered(runtime));
      return handle;
    } catch (err) {
      // Startup failed → broken (§5.1); clean up the process and rethrow.
      runtime.buffered = null; // nothing started, so nothing to replay
      this.runtimes.delete(spec.workerId);
      runtime.stopping = true;
      await proc.close().catch(() => proc.kill());
      if (err instanceof AdapterError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AdapterError("startup_failed", `pi startup failed: ${reason}`);
    }
  }

  async send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }> {
    const runtime = this.require(id);
    const images = input.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (how === "prompt") {
      // A prompt-path send goes through the same `/sig` wrapper as the initial prompt,
      // so the commandId marker lands in the session (ADR-0001: ambiguous-command detection).
      const message = input.commandId ? wrapPrompt(input.commandId, input.text) : input.text;
      await runtime.process.rpc({ type: "prompt", message, images });
      return {};
    }
    // §6.3: a queued steer/follow_up cannot carry the `/sig` wrapper (pi forbids
    // extension commands there), so the commandId travels as an input preamble. pi's input
    // handler runs before queueing: it strips the preamble and appends the custom entry, so
    // the marker is on disk from the moment pi ACCEPTS the message into its queue.
    const type = how === "steer" ? "steer" : "follow_up";
    const message = input.commandId ? markerPreamble(input.commandId, input.text) : input.text;
    await runtime.process.rpc({ type, message, images });
    // §6.2: steer takes effect after the current tool batch finishes.
    return { effect: how === "steer" ? "after_current_tools" : undefined };
  }

  /** §6.2: `clear_queue` first — the returned texts ride the `queue_returned` event so the
   *  steward can decide whether to resend — then `abort`. If `abort` fails after
   *  `clear_queue` already emptied pi's queue, the retrieved texts ride a
   *  PartialInterruptError so the manager can still surface them (R2-3: pi has no copy). */
  async interrupt(id: string): Promise<InterruptResult> {
    const runtime = this.require(id);
    const queue = (await runtime.process.rpc({ type: "clear_queue" })) as {
      steering?: unknown;
      followUp?: unknown;
    };
    const returned = [...queueTexts(queue.steering), ...queueTexts(queue.followUp)];
    try {
      await runtime.process.rpc({ type: "abort" });
    } catch (err) {
      throw new PartialInterruptError(returned, err instanceof Error ? err : new Error(String(err)));
    }
    return { returned };
  }

  async resume(id: string, reason: string, options: { commandId?: string } = {}): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (runtime && !runtime.process.hasExited) {
      // §6.3: the resume prompt on a live process carries the marker like any other prompt,
      // so a crash mid-`sending` is decidable from the session tail.
      const commandId = options.commandId ?? `resume-${Date.now()}`;
      await runtime.process.rpc({ type: "prompt", message: wrapPrompt(commandId, `${RESUME_PROMPT}\n\nReason: ${reason}`) });
      return;
    }
    // Relaunch with the same session id and send the fixed resume prompt (§9.2).
    const existing = this.pendingResumeSpecs.get(id);
    if (!existing) throw new AdapterError("not_found", `no known spec to resume worker ${id}`);
    await this.start({ ...existing, prompt: RESUME_PROMPT, commandId: options.commandId ?? `resume-${Date.now()}` });
  }

  /** Remembered so `resume` can relaunch a dead worker (§9.2). */
  private readonly pendingResumeSpecs = new Map<string, StartSpec>();

  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    await runtime.process.close();
  }

  isRunning(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited;
  }

  isStreaming(id: string): boolean {
    const runtime = this.runtimes.get(id);
    return !!runtime && !runtime.process.hasExited && runtime.window.open;
  }

  /** Live worker pids for the descendant-snapshot loop (connector-pi.md §9.3). */
  workerPids(): Array<{ workerId: string; pid: number }> {
    const out: Array<{ workerId: string; pid: number }> = [];
    for (const [workerId, runtime] of this.runtimes) {
      const pid = runtime.process.pid;
      if (!runtime.process.hasExited && pid !== undefined) out.push({ workerId, pid });
    }
    return out;
  }

  /** §11.4 live path: `get_entries{since}` is pi's only incremental read (research §3). */
  async history(id: string, since: string | undefined, maxBytes: number): Promise<HistoryPage> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.process.hasExited) {
      throw new AdapterError("not_running", `no live pi process for worker ${id}`);
    }
    const response = await runtime.process.rpc(
      { type: "get_entries", ...(since ? { since } : {}) },
      10_000,
    );
    const entries = Array.isArray(response.entries) ? (response.entries as Record<string, unknown>[]) : [];
    // `since` filtering already happened inside pi; the normalizer only budgets the bytes.
    return normalizeSessionEntries(entries, { maxBytes });
  }

  /** Live processes with their last stdout time — the stall watchdog's inputs (issue #13). */
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

  /** Test support: emulate a connector crash — every child is SIGKILLed with no graceful
   * stop, lock files are left on disk exactly as a real crash leaves them, and exit events
   * are marked "expected" so a still-listening manager takes no recovery action. */
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
      throw new AdapterError("not_running", `no live pi process for worker ${id}`);
    }
    return runtime;
  }

  // --- Event normalization (§11.1 sources) ------------------------------------------------

  private onPiEvent(runtime: WorkerRuntime, record: Record<string, unknown>): void {
    switch (record.type) {
      case "agent_start": {
        // Run window = from the FIRST agent_start after a command is accepted to the next
        // agent_settled (§5.2); retries re-entering agent_start stay inside the window.
        if (!runtime.window.open) {
          runtime.window = { open: true, aborted: false };
        }
        return;
      }
      case "turn_start": {
        runtime.turn += 1;
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "thinking",
          turn: runtime.turn,
        });
        return;
      }
      case "tool_execution_start": {
        const tool = String(record.toolName ?? "unknown");
        if (tool === "report") {
          const report = normalizeReport(record.args);
          if (report) runtime.window.report = report;
        }
        this.emit({
          type: "progress",
          workerId: runtime.workerId,
          phase: "tool",
          tool,
          target: extractTarget(record.args),
          turn: runtime.turn,
        });
        return;
      }
      case "message_end": {
        const message = record.message as Record<string, unknown> | undefined;
        if (message?.role === "assistant") {
          runtime.window.lastAssistant = {
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
            errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
            text: extractText(message.content),
          };
        }
        return;
      }
      case "auto_retry_end": {
        runtime.window.lastRetry = {
          success: record.success === true,
          finalError: typeof record.finalError === "string" ? record.finalError : undefined,
        };
        return;
      }
      case "agent_settled": {
        if (!runtime.window.open) return;
        runtime.window.aborted = record.aborted === true;
        void this.settle(runtime);
        return;
      }
      default:
        return;
    }
  }

  private async settle(runtime: WorkerRuntime): Promise<void> {
    const facts = runtime.window;
    const adjudicated = adjudicate(facts);
    runtime.window = { open: false, aborted: false };
    runtime.turn = 0;

    // usage from get_session_stats at settlement (§11.2).
    let usage: SessionUsage | undefined;
    if (!runtime.process.hasExited) {
      usage = (await runtime.process.rpc({ type: "get_session_stats" }, 2000).catch(() => undefined)) as SessionUsage | undefined;
    }

    this.emit({
      type: "settled",
      workerId: runtime.workerId,
      outcome: adjudicated.outcome,
      errorClass: adjudicated.errorClass,
      lastText: adjudicated.lastText?.slice(0, 4000),
      report: adjudicated.report,
      usage,
    });
  }

  private onPiExit(runtime: WorkerRuntime, info: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.runtimes.get(runtime.workerId) === runtime) this.runtimes.delete(runtime.workerId);
    this.emit({
      type: "process_exit",
      workerId: runtime.workerId,
      code: info.code,
      signal: info.signal,
      // An exit while still buffering (start() has not resolved) is reported through
      // start()'s own rejection — an `unexpected` process_exit here would race the
      // startup-failure handling in the WorkerManager.
      unexpected: !runtime.stopping && runtime.buffered === null,
    });
  }
}

/** `/sig <commandId>\n<text>` — the extension unwraps it and writes the marker (ADR-0001). */
export function wrapPrompt(commandId: string, text: string): string {
  return `/${SIG_COMMAND} ${commandId}\n${text}`;
}

/** The §6.3 marker for deliveries pi will not accept extension commands on (steer/
 *  follow_up): a one-line preamble that is part of the message itself, so pi persists it
 *  together with the user message exactly when the message is delivered. */
export function markerPreamble(commandId: string, text: string): string {
  return `[sig:command ${commandId}]\n${text}`;
}

/** Validates and normalizes `report` tool args into the §7.2 payload; null when invalid. */
export function normalizeReport(args: unknown): ReportPayload | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = args as Record<string, unknown>;
  const status = raw.status;
  if (status !== "done" && status !== "blocked" && status !== "needs_decision") return null;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const stringList = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
  const payload: ReportPayload = { status, summary };
  const changes = stringList(raw.changes);
  if (changes) payload.changes = changes;
  const decisions = stringList(raw.decisions);
  if (decisions) payload.decisions = decisions;
  const leftovers = stringList(raw.leftovers);
  if (leftovers) payload.leftovers = leftovers;
  if (typeof raw.question === "string") payload.question = raw.question;
  if (typeof raw.next === "string") payload.next = raw.next;
  if (typeof raw.answer === "string") payload.answer = raw.answer;
  if (typeof raw.tests === "object" && raw.tests !== null) {
    const tests = raw.tests as Record<string, unknown>;
    payload.tests = {
      ran: tests.ran === true,
      passed: typeof tests.passed === "boolean" ? tests.passed : undefined,
      note: typeof tests.note === "string" ? tests.note : undefined,
    };
  }
  return payload;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("");
}

export { extractText as extractAssistantText };

/** `clear_queue` hands back the queued messages (real pi queues plain strings); tolerate
 *  message-shaped items too so a future pi change cannot silently drop texts. */
function queueTexts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) =>
      typeof item === "string" ? item : extractText((item as { content?: unknown } | null)?.content),
    )
    .filter((text) => text.length > 0);
}

/** First 80 chars of a path or command — never file contents or command output (§11.2). */
export function extractTarget(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const raw = args as Record<string, unknown>;
  for (const key of ["file_path", "path", "filename", "command", "pattern", "query", "url"]) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 80);
  }
  return undefined;
}
