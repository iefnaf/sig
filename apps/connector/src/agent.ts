// AgentAdapter contract, docs/design/connector-pi.md §3. Only the "must" members form the
// minimal set every agent implements; the rest is expressed through capability declarations
// and the WorkerManager degrades (and tells the steward) when a capability is missing.

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
  images?: { data: string; mimeType: string }[];
  model?: string;
}

export interface WorkerHandle {
  workerId: string;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
}

export type Delivery = "prompt" | "steer" | "follow_up";

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

export type ErrorClass = "auth" | "transient" | "context" | "unknown";

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

  start(spec: StartSpec): Promise<WorkerHandle>; // must
  send(
    id: string,
    input: { text: string; images?: { data: string; mimeType: string }[] },
    how: Delivery,
  ): Promise<{ effect?: string }>; // must
  interrupt(id: string): Promise<void>; // must
  resume(id: string, reason: string): Promise<void>; // must
  stopProcess(id: string): Promise<void>; // must; frees memory, the session stays on disk
  on(event: "worker-event", fn: (e: RawAdapterEvent) => void): void;
  /** Whether the worker's process is alive (idle-hot counts). Used to pick the resume path (§9.2). */
  isRunning?(id: string): boolean;
  /** Live worker pids for the descendant-snapshot loop (connector-pi.md §9.3). */
  workerPids?(): Array<{ workerId: string; pid: number }>;
  /** Test support: emulate a hard crash of the connector (children SIGKILLed, no cleanup). */
  simulateCrash?(): void;
}
