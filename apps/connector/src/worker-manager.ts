// WorkerManager, docs/design/connector-pi.md §2/§4.4/§5/§6/§8/§11: worker lifecycle,
// command handling with dedup, locks, worktrees, event normalization into persisted
// WorkerEvents (seq per worker, written to LocalStore BEFORE send), and the merge of
// GitFacts into the `report` event.
import type { AgentAdapter, RawAdapterEvent, StartSpec, WorkerMode } from "./agent.ts";
import { collectGitFacts } from "./git-facts.ts";
import { acquireLock, releaseLock } from "./locks.ts";
import { PiAdapter } from "./pi-adapter.ts";
import { ProgressThrottle } from "./progress.ts";
import type { LocalStore } from "./store.ts";
import { WorktreeManager } from "./worktree.ts";
import { join } from "node:path";

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** `start_worker` args (connector-pi.md §6.1 / protocol §6.2). */
export interface StartWorkerArgs {
  workerId: string;
  threadId: string;
  repoId: string;
  mode: WorkerMode;
  base?: string;
  prompt: string;
  images?: { data: string; mimeType: string }[];
  model?: string;
}

export interface StartWorkerResult {
  sessionId: string;
  branch?: string;
  cwd: string;
  worktree?: string;
}

export interface WorkerManagerOptions {
  store: LocalStore;
  stateDir: string;
  adapter?: AgentAdapter;
  /**
   * Persist-and-send for worker events (§11.3): the transport supplies this (ConnectorClient
   * writes the event to the durable EventLog — per-worker seq — before batching it out).
   * Tests inject a collector or a real EventLog.
   */
  emit?: (workerId: string, fields: Record<string, unknown>) => void;
  now?: () => number;
}

/** workerId must satisfy pi's --session-id restrictions (§4.2). */
const WORKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/;

export class WorkerManager {
  private readonly store: LocalStore;
  private readonly stateDir: string;
  private readonly adapter: AgentAdapter;
  private readonly worktrees: WorktreeManager;
  private readonly emit?: (workerId: string, fields: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly throttles = new Map<string, ProgressThrottle>();
  /** workerId → run context needed when adapter events arrive. */
  private readonly active = new Map<string, { repoId: string; worktree?: string; branch?: string; base?: string }>();

  constructor(options: WorkerManagerOptions) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    this.adapter = options.adapter ?? new PiAdapter({ stateDir: options.stateDir });
    this.worktrees = new WorktreeManager({ worktreesRoot: join(options.stateDir, "worktrees") });
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.adapter.on("worker-event", (event) => {
      void this.onAdapterEvent(event).catch((err) => {
        // Event handling must never take the connector down (e.g. store closed at shutdown).
        console.error(`[shepherd] worker-event handling failed for ${event.workerId}:`, err);
      });
    });
  }

  get agents() {
    return [{ kind: this.adapter.kind, capabilities: this.adapter.capabilities }];
  }

  /** Handles a steward command envelope; returns data for cmd_result or throws CommandError. */
  async handleCommand(commandId: string, kind: string, args: Record<string, unknown>): Promise<unknown> {
    if (kind !== "start_worker") {
      throw new CommandError("unsupported_command", `command kind '${kind}' is not implemented yet`);
    }
    return this.startWorker(commandId, parseStartWorkerArgs(args));
  }

  async startWorker(commandId: string, args: StartWorkerArgs): Promise<StartWorkerResult> {
    // Command dedup (§6.3) is the transport's job: ConnectorClient's CommandLog answers
    // redeliveries with `duplicate` and calls this handler only for unseen commandIds.
    if (!WORKER_ID_RE.test(args.workerId)) {
      throw new CommandError("bad_worker_id", `workerId '${args.workerId}' is not a valid pi session id (§4.2)`);
    }
    if (typeof args.prompt !== "string" || args.prompt.length === 0) {
      throw new CommandError("bad_request", "prompt is required");
    }
    // §6.2: images are checked at the entrance (4 MB base64 per image) and rejected rather
    // than being passed through for pi to choke on.
    for (const image of args.images ?? []) {
      if (!image.data || image.data.length > 4 * 1024 * 1024) {
        throw new CommandError("too_large", "image exceeds the 4 MB base64 limit");
      }
    }

    // --- Repository whitelist (§8.1): a start_worker for an unregistered repo is rejected.
    const repo = this.store.getRepo(args.repoId);
    if (!repo) {
      throw new CommandError("not_registered_repo", `repo '${args.repoId}' is not registered on this machine`);
    }

    // --- One process per session (§4.3): lock file, `lock_held` when alive, stale removed.
    const lock = acquireLock(this.stateDir, args.workerId);
    if (!lock.ok) {
      throw new CommandError("lock_held", `worker ${args.workerId} is locked by pid ${lock.pid}`, true);
    }

    // --- Write tasks get a dedicated worktree (§8.2).
    let cwd = repo.path;
    let branch: string | undefined;
    let base: string | undefined;
    let worktree: string | undefined;
    if (args.mode === "write") {
      try {
        const created = await this.worktrees.create({ repoPath: repo.path, threadId: args.threadId, base: args.base });
        cwd = created.path;
        branch = created.branch;
        base = created.base;
        worktree = created.path;
      } catch (err) {
        releaseLock(this.stateDir, args.workerId);
        const message = err instanceof Error ? err.message : String(err);
        throw new CommandError("worktree_failed", `could not create worktree: ${message}`);
      }
    }

    this.store.upsertWorker({
      workerId: args.workerId,
      threadId: args.threadId,
      repoId: args.repoId,
      mode: args.mode,
      state: "starting",
      branch,
      worktree,
    });
    this.active.set(args.workerId, { repoId: args.repoId, worktree, branch, base });

    const spec: StartSpec = {
      workerId: args.workerId,
      threadId: args.threadId,
      cwd,
      mode: args.mode,
      prompt: args.prompt,
      commandId,
      images: args.images,
      model: args.model,
    };

    try {
      const handle = await this.adapter.start(spec);
      const result: StartWorkerResult = {
        sessionId: handle.sessionId,
        branch,
        cwd,
        worktree,
      };
      this.store.upsertWorker({
        workerId: args.workerId,
        threadId: args.threadId,
        repoId: args.repoId,
        mode: args.mode,
        state: "running",
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile ?? null,
        branch,
        worktree,
      });
      // `started` (§11.1): successful start — the run is live, progress follows.
      await this.emitEvent(args.workerId, "started", {
        sessionId: handle.sessionId,
        cwd,
        branch,
      });
      return result;
    } catch (err) {
      releaseLock(this.stateDir, args.workerId);
      this.active.delete(args.workerId);
      this.store.setWorkerState(args.workerId, "broken");
      const code = (err as { code?: string }).code ?? "startup_failed";
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError(code, message);
    }
  }

  /** stop_process (§6.1): reclaim the process, keep the session on disk. */
  async stopProcess(workerId: string): Promise<void> {
    await this.adapter.stopProcess(workerId); // process_exit handler releases the lock
  }

  // --- Adapter event → persisted WorkerEvent ----------------------------------------------

  private async onAdapterEvent(event: RawAdapterEvent): Promise<void> {
    switch (event.type) {
      case "progress": {
        const throttle = this.throttles.get(event.workerId) ?? new ProgressThrottle();
        this.throttles.set(event.workerId, throttle);
        if (!throttle.decide(this.now(), event.phase, event.tool)) return;
        await this.emitEvent(event.workerId, "progress", {
          phase: event.phase,
          tool: event.tool,
          target: event.target,
          turn: event.turn,
        });
        return;
      }
      case "settled": {
        const context = this.active.get(event.workerId);
        // `report` merged with GitFacts (§7.2): facts come from git, not the model.
        if (event.outcome === "reported" && event.report) {
          const git =
            context?.worktree && context.base
              ? await collectGitFacts(context.worktree, context.base).catch(() => undefined)
              : undefined;
          await this.emitEvent(event.workerId, "report", { ...event.report, ...(git ? { git } : {}) });
        }
        await this.emitEvent(event.workerId, "settled", {
          outcome: event.outcome,
          errorClass: event.errorClass,
          lastText: event.lastText,
          usage: event.usage,
        });
        this.store.setWorkerState(event.workerId, "idle", event.outcome);
        this.throttles.delete(event.workerId);
        return;
      }
      case "process_exit": {
        await this.emitEvent(event.workerId, "process_exit", { code: event.code, signal: event.signal });
        releaseLock(this.stateDir, event.workerId);
        this.throttles.delete(event.workerId);
        this.active.delete(event.workerId);
        const worker = this.store.getWorker(event.workerId);
        // An unexpected exit while running → lost (reconciliation/resume is §9, a later slice).
        if (event.unexpected && worker && (worker.state === "running" || worker.state === "starting")) {
          this.store.setWorkerState(event.workerId, "lost", "crash");
          await this.emitEvent(event.workerId, "lost", {
            reason: "process_exit",
            code: event.code,
            signal: event.signal,
          });
        }
        return;
      }
    }
  }

  /** Hands the event to the transport's persist-and-send (§11.3: EventLog seq first, then wire). */
  private async emitEvent(workerId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    this.emit?.(workerId, { type, ...clean });
  }
}

function parseStartWorkerArgs(args: Record<string, unknown>): StartWorkerArgs {
  const mode = args.mode === "readonly" ? "readonly" : "write";
  const images = Array.isArray(args.images)
    ? (args.images as { data: string; mimeType: string }[]).map((img) => ({ data: String(img.data), mimeType: String(img.mimeType) }))
    : undefined;
  const parsed: StartWorkerArgs = {
    workerId: String(args.workerId ?? ""),
    threadId: String(args.threadId ?? ""),
    repoId: String(args.repoId ?? ""),
    mode,
    prompt: String(args.prompt ?? ""),
    images,
  };
  if (typeof args.base === "string" && args.base.length > 0) parsed.base = args.base;
  if (typeof args.model === "string" && args.model.length > 0) parsed.model = args.model;
  return parsed;
}
