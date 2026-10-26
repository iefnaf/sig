// AgentAdapter contract, docs/design/connector-pi.md §3. Only the "must" members form the
// minimal set every agent implements; the rest is expressed through capability declarations
// and the WorkerManager degrades (and tells the steward) when a capability is missing.

import type { HistoryPage } from "@alexlikevibe/protocol";

export type AgentKind = "pi" | "claude-code" | "codex";

export interface AgentCapabilities {
  /** Change direction immediately while running (takes effect after the current tool finishes). */
  steer: boolean;
  /** Handled after the current run ends. */
  followUp: boolean;
  /** Abort the current run. */
  interrupt: boolean;
  /** Resume from the session after the process disappears. */
  resume: boolean;
  /** Read the raw history. */
  history: boolean;
  images: boolean;
  /** Can produce a structured closing report. */
  structuredReport: boolean;
  /** Can truly be restricted to read-only. */
  readonly: boolean;
}

export type WorkerMode = "write" | "readonly";

/** A `start_worker` command after repository/lock/worktree resolution (connector-pi.md §6.1). */
export interface StartSpec {
  workerId: string;
  threadId: string;
  /** Working directory: the worktree (write) or the repository itself (readonly). */
  cwd: string;
  mode: WorkerMode;
  prompt: string;
  /** Correlates the run window with the steward command (ADR-0001 marker). */
  commandId: string;
  /** §6.3/§10 recovery evidence: fires exactly once after get_state answers and BEFORE the
   *  prompt is sent — with the session file and its current tail entry id (null file when
   *  the agent reports none), so a crash anywhere past this point stays decidable. */
  onSession?: (sessionFile: string | null, lastKnownEntryId: string | null) => void;
  /** approveProject (§13): the repo's local trust flag — pi runs with --approve. Never
   * taken from the command; set by the WorkerManager from the LocalStore's repo row. */
  approveProject?: boolean;
  images?: { data: string; mimeType: string }[];
  model?: string;
  /** Continuation launches (send-relaunch, resume, stall respawn) set this when the worker
   *  already has a session: agents whose session id is not the workerId (Claude Code's UUID)
   *  resume with it instead of deriving a fresh one. Pi ignores it — its session id IS the
   *  workerId, so first start and resume share one flag. */
  resumeSessionId?: string;
}

export interface WorkerHandle {
  workerId: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

export type Delivery = "prompt" | "steer" | "follow_up";

/** `interrupt` (connector-pi.md §6.2): the texts pi's `clear_queue` handed back — the
 *  undelivered steer/follow_up messages, surfaced to the steward as `queue_returned`. */
export interface InterruptResult {
  returned: string[];
  /** PR #59 review finding 4: the run had ALREADY settled when the interrupt landed (the
   *  agent's post-result window). The manager reports aborted:false — "aborted" must never
   *  sit next to a completed run's report card. Absent = something was in flight. */
  alreadySettled?: boolean;
}

/** Thrown by an adapter whose `clear_queue` succeeded but the subsequent `abort` failed
 *  (PR #45 review round 2, R2-3): the agent already handed its queued texts back and
 *  emptied its queue, so the texts ride the error — the manager surfaces them as
 *  `queue_returned` before failing the command, or they are lost (the agent has no copy). */
export class PartialInterruptError extends Error {
  constructor(
    readonly returned: string[],
    readonly causeErr: Error,
  ) {
    super(`interrupt failed after clear_queue: ${causeErr.message}`);
    this.name = "PartialInterruptError";
  }
}

/** Thrown by adapters for structured failures (code surfaces in cmd_result). The
 *  AgentAdapter contract's shared error type — pi and Claude Code both use it. */
export class AdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

/** Report tool payload, connector-pi.md §7.2 (v1 fields). */
export interface ReportPayload {
  status: "done" | "blocked" | "needs_decision";
  summary: string;
  changes?: string[];
  decisions?: string[];
  leftovers?: string[];
  tests?: { ran: boolean; passed?: boolean; note?: string };
  question?: string;
  next?: string;
  /** The full answer/finding when this task was informational (no code change) rather than a change. */
  answer?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface SessionUsage {
  tokens?: TokenUsage;
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

export type ErrorClass = "auth" | "transient" | "context" | "stall" | "unknown";

export type SettledOutcome = "reported" | "aborted" | "error" | "unreported";

/** Normalized adapter events. Coarse-grained; no code content (connector-pi.md §1 goal 2). */
export type RawAdapterEvent =
  | {
      type: "progress";
      workerId: string;
      phase: "thinking" | "tool";
      tool?: string;
      /** First 80 chars of a path or command — never file contents or command output. */
      target?: string;
      turn: number;
    }
  | {
      type: "settled";
      workerId: string;
      outcome: SettledOutcome;
      errorClass?: ErrorClass;
      /** Only set for `unreported`: fallback classification input for the steward. */
      lastText?: string;
      report?: ReportPayload;
      usage?: SessionUsage;
    }
  | {
      type: "process_exit";
      workerId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
      /** True when the process died while the worker was neither settling nor stopped. */
      unexpected: boolean;
    };

export interface AgentAdapter {
  readonly kind: AgentKind;
  readonly capabilities: AgentCapabilities;
  /** Reported in hello.agents (protocol §6.1); defaults to the connector's own version. */
  readonly version?: string;

  start(spec: StartSpec): Promise<WorkerHandle>; // must
  send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string },
    how: Delivery,
  ): Promise<{ effect?: string }>; // must
  interrupt(id: string): Promise<InterruptResult>; // must
  resume(id: string, reason: string, options?: { commandId?: string }): Promise<void>; // must
  stopProcess(id: string): Promise<void>; // must; frees memory, the session stays on disk
  on(event: "worker-event", fn: (e: RawAdapterEvent) => void): void;
  /** Whether the worker's process is alive (idle-hot counts). Used to pick the resume path (§9.2). */
  isRunning?(id: string): boolean;
  /** Whether a run window is open (between agent_start and agent_settled) — i.e. there is
   *  something for `interrupt` to abort, and a settle event must follow the abort. */
  isStreaming?(id: string): boolean;
  /** Live worker pids for the descendant-snapshot loop (connector-pi.md §9.3). */
  workerPids?(): Array<{ workerId: string; pid: number }>;
  /**
   * On-demand raw-history read (connector-pi.md §11.4) while the process is running: the
   * adapter fetches increments over RPC and normalizes them. The not-running fallback —
   * parsing the session JSONL — lives with the WorkerManager, which owns the session file path.
   */
  history?(id: string, since: string | undefined, maxBytes: number): Promise<HistoryPage>;
  /** Live processes with their last stdout time — the stall watchdog's inputs (issue #13). */
  workerActivity?(): Array<{ workerId: string; pid: number; lastOutputAt: number }>;
  /** Test support: emulate a hard crash of the connector (children SIGKILLed, no cleanup). */
  simulateCrash?(): void;
}
