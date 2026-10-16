// WorkerManager, docs/design/connector-pi.md §2/§4.4/§5/§6/§8/§9/§11: worker lifecycle,
// command handling with dedup, locks, worktrees, event normalization into persisted
// WorkerEvents (seq per worker, written to LocalStore BEFORE send), the merge of GitFacts
// into the `report` event, and the §9 failure/recovery slice — orphan cleanup from
// descendant snapshots (§9.3), startup reconciliation with the session-tail check (§9.1),
// and automatic resume with the fixed prompt, 30 s backoff, and the ≤2/hour budget (§9.2).
import type { AgentAdapter, ErrorClass, RawAdapterEvent, StartSpec, WorkerMode } from "./agent.ts";
import { classifyError } from "./adjudication.ts";
import { killOrphans, listDescendants, type ProcRef } from "./descendants.ts";
import { collectGitFacts } from "./git-facts.ts";
import { acquireLock, markLocksHeldByDeadProcess, releaseLock, removeStaleLocks } from "./locks.ts";
import { RESUME_PROMPT, PiAdapter } from "./pi-adapter.ts";
import { ProgressThrottle } from "./progress.ts";
import { inspectSessionTail, type SessionTail } from "./session-tail.ts";
import type { LocalStore, RegisteredRepo, WorkerRow } from "./store.ts";
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
  /** §8.2 serial mode: the write worker waits for the repo's current write worker instead of
   * starting now. The `started` event follows when the slot frees. */
  queued?: boolean;
}

/** Knobs and seams for the §9 recovery paths (tests shrink timers and inject process I/O). */
export interface RecoveryOptions {
  /** Descendant-snapshot cadence while workers run (§9.3; default 5 s). */
  snapshotIntervalMs?: number;
  /** Backoff before an automatic resume fires (§9.2; default 30 s). */
  autoResumeBackoffMs?: number;
  /** Automatic resumes allowed per worker per window (§9.2; default 2). */
  maxAutoResumesPerHour?: number;
  /** The rolling window the budget counts over (default 1 h). */
  resumeWindowMs?: number;
  /** Process-table seam (tests inject a deterministic ps). */
  listDescendants?: (pid: number) => Promise<ProcRef[]>;
  /** Kill seam (tests record signals instead of signalling real pids). */
  killOrphans?: (refs: ProcRef[]) => Promise<ProcRef[]>;
  /** Session-tail seam (tests script tails and crash-mid-reconciliation faults). */
  inspectTail?: (sessionFile: string | null | undefined) => SessionTail;
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
  recovery?: RecoveryOptions;
}

/** workerId must satisfy pi's --session-id restrictions (§4.2). */
const WORKER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/;

/** States a worker can be in right before a connector crash for the tail check (§9.1);
 * `lost` workers additionally get their pending resume re-scheduled at startup. */
const IN_FLIGHT_STATES = new Set(["starting", "running", "recovering"]);

/** §8.2 serial mode: states in which a write worker holds the repo's single write slot —
 * in-flight, awaiting an automatic resume (`lost`), or itself queued ahead of another. */
const SERIAL_SLOT_STATES = new Set(["starting", "running", "recovering", "lost", "queued"]);

/** §8.2/§13 (issue #16): settings that live in the connector's LocalStore and are set only
 * by the machine's owner via the CLI. A command carrying one is rejected outright — the
 * last line of defense against a compromised steward (connector-do-protocol §6.2). */
const LOCAL_ONLY_ARGS = ["approveProject", "approve", "workspace", "workspaceMode"];

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

  // --- §9 recovery state -------------------------------------------------------------------
  private readonly snapshotIntervalMs: number;
  private readonly autoResumeBackoffMs: number;
  private readonly maxAutoResumes: number;
  private readonly resumeWindowMs: number;
  private readonly listDescendantsFn: (pid: number) => Promise<ProcRef[]>;
  private readonly killOrphansFn: (refs: ProcRef[]) => Promise<ProcRef[]>;
  private readonly inspectTailFn: (sessionFile: string | null | undefined) => SessionTail;
  private snapshotTimer?: NodeJS.Timeout;
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  /** Repos with a queued-write launch in flight (guards pump re-entry). */
  private readonly pumpingRepos = new Set<string>();
  /** Set by simulateCrash: a crashed instance processes nothing further. */
  private crashed = false;

  constructor(options: WorkerManagerOptions) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    this.adapter = options.adapter ?? new PiAdapter({ stateDir: options.stateDir });
    this.worktrees = new WorktreeManager({ worktreesRoot: join(options.stateDir, "worktrees") });
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    const recovery = options.recovery ?? {};
    this.snapshotIntervalMs = recovery.snapshotIntervalMs ?? 5000;
    this.autoResumeBackoffMs = recovery.autoResumeBackoffMs ?? 30_000;
    this.maxAutoResumes = recovery.maxAutoResumesPerHour ?? 2;
    this.resumeWindowMs = recovery.resumeWindowMs ?? 3_600_000;
    this.listDescendantsFn = recovery.listDescendants ?? listDescendants;
    this.killOrphansFn = recovery.killOrphans ?? killOrphans;
    this.inspectTailFn = recovery.inspectTail ?? inspectSessionTail;
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
  async handleCommand(
    commandId: string,
    kind: string,
    args: Record<string, unknown>,
    envelopeWorkerId?: string,
  ): Promise<unknown> {
    switch (kind) {
      case "start_worker":
        rejectLocalOnlyArgs(args);
        return this.startWorker(commandId, parseStartWorkerArgs(args));
      case "stop_process": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        await this.stopProcess(workerId);
        return {};
      }
      case "resume": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        const reason = typeof args.reason === "string" && args.reason.length > 0 ? args.reason : "manual";
        const count = this.store.recordResume(workerId, this.resumeWindowMs);
        await this.resumeWorker(workerId, reason, count);
        return { resumed: true, count };
      }
      case "cleanup_worktree": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        return this.cleanupWorktree(workerId, args.force === true);
      }
      default:
        throw new CommandError("unsupported_command", `command kind '${kind}' is not implemented yet`);
    }
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

    // --- §8.2 serial mode: only one write worker at a time in the repo. A second write task
    // is queued (FIFO) and starts when the current one settles; the command result says so,
    // and the `started` event follows when the slot frees. Readonly tasks are never isolated
    // (§8.3) and never queue.
    if (args.mode === "write" && repo.workspace === "serial") {
      const holder = this.writeSlotHolder(args.repoId, args.workerId);
      if (holder) {
        this.store.upsertWorker({
          workerId: args.workerId,
          threadId: args.threadId,
          repoId: args.repoId,
          mode: "write",
          state: "queued",
          branch: null,
          worktree: null,
          base: args.base ?? null,
        });
        // The args persist so a connector restart re-arms the queue (the command result
        // with queued:true already went out; losing the start would strand the Thread).
        this.store.saveQueuedStart(args.workerId, commandId, args);
        await this.emitEvent(args.workerId, "queued", { behind: holder });
        return { queued: true, sessionId: "", cwd: repo.path };
      }
    }

    return this.launchWorker(commandId, args, repo);
  }

  /** Everything after validation: lock, workspace resolution (§8.2), the `starting` row,
   * adapter start, and the `started` event. Both the direct path and the serial pump land
   * here; launch failures surface as CommandError (the direct path forwards them to
   * cmd_result, the pump breaks the worker instead). */
  private async launchWorker(commandId: string, args: StartWorkerArgs, repo: RegisteredRepo): Promise<StartWorkerResult> {
    // --- One process per session (§4.3): lock file, `lock_held` when alive, stale removed.
    const lock = acquireLock(this.stateDir, args.workerId);
    if (!lock.ok) {
      throw new CommandError("lock_held", `worker ${args.workerId} is locked by pid ${lock.pid}`, true);
    }

    // --- §8.2 workspace resolution. Write + worktree/serial → a dedicated worktree; write +
    // main, and every readonly run (§8.3) → the repository's own checkout, no worktree.
    const useWorktree = args.mode === "write" && repo.workspace !== "main";
    let cwd = repo.path;
    let branch: string | undefined;
    let base: string | undefined;
    let worktree: string | undefined;
    if (useWorktree) {
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
    // `main` mode ignores `base`: the checkout is whatever the owner left it at — the
    // connector never checks branches out in the user's own working directory.

    this.store.upsertWorker({
      workerId: args.workerId,
      threadId: args.threadId,
      repoId: args.repoId,
      mode: args.mode,
      state: "starting",
      branch,
      worktree,
      base,
    });
    this.active.set(args.workerId, { repoId: args.repoId, worktree, branch, base });

    const spec: StartSpec = {
      workerId: args.workerId,
      threadId: args.threadId,
      cwd,
      mode: args.mode,
      prompt: args.prompt,
      commandId,
      // §13: approveProject comes from the repo's local config, never from the command.
      approveProject: repo.approved === true ? true : undefined,
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
        base,
      });
      this.startSnapshotLoop();
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

  /** stop_process (§6.1): reclaim the process, keep the session on disk. On a queued write
   * worker (§8.2) there is no process yet — the pending start is dropped instead, so the
   * queue does not launch a task the user tried to stop. */
  async stopProcess(workerId: string): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (worker?.state === "queued") {
      this.store.deleteQueuedStart(workerId);
      this.store.setWorkerState(workerId, "idle", "stopped_while_queued");
      await this.emitEvent(workerId, "settled", { outcome: "aborted" });
      return;
    }
    await this.adapter.stopProcess(workerId); // process_exit handler releases the lock
    // §9.3: a stop that had to escalate to SIGKILL may have orphaned tool children.
    await this.cleanupOrphans(workerId);
  }

  // --- Serial write queue (connector-pi.md §8.2) --------------------------------------------

  /** The write worker holding the repo's serial slot, if any (creation order; `lost` still
   * holds the slot while an automatic resume may bring it back). `exclude` keeps a worker
   * from blocking itself. */
  private writeSlotHolder(repoId: string, excludeWorkerId?: string): string | undefined {
    const holders = this.store
      .listWorkers()
      .filter(
        (w) =>
          w.repoId === repoId &&
          w.mode === "write" &&
          w.workerId !== excludeWorkerId &&
          SERIAL_SLOT_STATES.has(w.state),
      );
    // Name the live runner, not another queued worker, when one exists.
    return holders.find((w) => w.state !== "queued")?.workerId ?? holders[0]?.workerId;
  }

  /** Starts the next queued write worker of every repo whose slot freed up. Triggered by
   * settle/break transitions, reconciliation, and queue-loss cleanup — never by a timer. */
  private pumpQueuedWorkers(): void {
    if (this.crashed) return;
    const repos = new Set(
      this.store.listWorkers().filter((w) => w.state === "queued" && !this.pumpingRepos.has(w.repoId)).map((w) => w.repoId),
    );
    for (const repoId of repos) {
      this.pumpOnce(repoId);
    }
  }

  /** A repo's oldest queued write worker launches when no write worker is in flight. The
   * `pumpingRepos` guard makes re-entrant pumps (settle during a launch) a no-op. */
  private pumpOnce(repoId: string): void {
    if (this.crashed || this.pumpingRepos.has(repoId)) return;
    const workers = this.store.listWorkers().filter((w) => w.repoId === repoId);
    const inFlight = workers.some((w) => w.mode === "write" && IN_FLIGHT_STATES.has(w.state));
    const lost = workers.some((w) => w.mode === "write" && w.state === "lost"); // resume may still bring it back
    const next = workers.find((w) => w.state === "queued"); // creation order (FIFO)
    if (!next || inFlight || lost) return;
    const queued = this.store.getQueuedStart(next.workerId);
    if (!queued) {
      // The persisted start args vanished (e.g. a queue row from before this feature's
      // schema): break honestly instead of stranding the Thread at `queued` forever.
      void this.breakWorker(
        next.workerId,
        "unknown",
        "Queued start was lost in a connector restart; re-dispatch the task.",
        "queue_lost",
      );
      return;
    }
    this.pumpingRepos.add(repoId);
    void this.launchQueued(next, queued).finally(() => {
      this.pumpingRepos.delete(repoId);
      // The launch may itself unblock another queued worker (e.g. it broke immediately).
      this.pumpQueuedWorkers();
    });
  }

  private async launchQueued(worker: WorkerRow, queued: { commandId: string; args: unknown }): Promise<void> {
    if (this.crashed) return;
    this.store.deleteQueuedStart(worker.workerId);
    if (typeof queued.args !== "object" || queued.args === null) {
      await this.breakWorker(worker.workerId, "unknown", "Queued start args were unreadable; re-dispatch the task.", "queue_lost");
      return;
    }
    const args = parseStartWorkerArgs(queued.args as Record<string, unknown>);
    const repo = this.store.getRepo(worker.repoId);
    if (!repo) {
      await this.breakWorker(worker.workerId, "unknown", `repo '${worker.repoId}' is no longer registered`, "startup_failed");
      return;
    }
    try {
      // The command result already went out with queued:true; the `started` event (emitted
      // by launchWorker) is what tells the steward the run is now live.
      await this.launchWorker(queued.commandId, args, repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.breakWorker(worker.workerId, "unknown", `Queued start failed: ${message}`, "startup_failed");
    }
  }

  // --- cleanup_worktree (connector-pi.md §6.1/§8.2) -----------------------------------------

  /** Explicit-only worktree removal: refuses dirty or unpushed worktrees unless `force`, and
   * refuses outright while the worker may still use it (in flight, queued, or awaiting a
   * resume). Nothing in the connector ever deletes a worktree on its own (§8.2). */
  async cleanupWorktree(workerId: string, force: boolean): Promise<{ removed: string }> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    if (!worker.worktree) {
      throw new CommandError(
        "no_worktree",
        `worker ${workerId} ran without a worktree (readonly task or main-checkout repo)`,
      );
    }
    if (SERIAL_SLOT_STATES.has(worker.state)) {
      throw new CommandError(
        "worker_running",
        `worker ${workerId} is ${worker.state}; stop it and let it settle before cleaning up its worktree`,
      );
    }
    const repo = this.store.getRepo(worker.repoId);
    if (!repo) throw new CommandError("not_registered_repo", `repo '${worker.repoId}' is not registered on this machine`);
    try {
      await this.worktrees.cleanup(repo.path, worker.worktree, { force });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError("worktree_dirty", message);
    }
    this.store.clearWorkerWorktree(workerId);
    return { removed: worker.worktree };
  }

  // --- Startup reconciliation (connector-pi.md §9.1) ----------------------------------------

  /**
   * Runs once per boot BEFORE the first hello, so the workers snapshot the DO reconciles
   * against already reflects the crash: orphan cleanup from the persisted descendant
   * snapshots (§9.3), stale-lock sweep, then the session-tail check for every worker that
   * was in flight, then auto-resume scheduling (§9.2). Per-worker failures are contained —
   * a crash mid-reconciliation leaves the remaining workers reconciled and the next boot
   * retries the rest (§14 fault injection).
   */
  async reconcileStartup(): Promise<void> {
    for (const workerId of this.store.listOrphanSnapshots()) {
      await this.cleanupOrphans(workerId).catch(() => undefined);
    }
    removeStaleLocks(this.stateDir);
    for (const worker of this.store.listWorkers()) {
      if (this.crashed) return;
      if (worker.state === "lost") {
        // A resume was pending when the connector died (e.g. killed mid-reconciliation or
        // inside the backoff window): schedule again — the persisted budget bounds this.
        this.scheduleAutoResume(worker.workerId, "connector_restart");
        continue;
      }
      if (!IN_FLIGHT_STATES.has(worker.state)) continue;
      try {
        await this.reconcileWorkerTail(worker);
      } catch (err) {
        console.error(`[shepherd] session-tail reconciliation failed for ${worker.workerId}:`, err);
      }
    }
    // Queued write workers whose runner settled or broke over the restart can start now.
    this.pumpQueuedWorkers();
  }

  private async reconcileWorkerTail(worker: WorkerRow): Promise<void> {
    const tail = this.inspectTailFn(worker.sessionFile);
    if (tail.kind === "settled") {
      // The crash happened shortly before agent_settled: emit the wrap-up retroactively,
      // git facts merged exactly like the live path (§7.2: facts from git, not the model).
      const git =
        worker.worktree && worker.base
          ? await collectGitFacts(worker.worktree, worker.base).catch(() => undefined)
          : undefined;
      await this.emitEvent(worker.workerId, "report", { ...tail.report, ...(git ? { git } : {}) });
      await this.emitEvent(worker.workerId, "settled", { outcome: "reported" });
      this.store.setWorkerState(worker.workerId, "idle", "reported");
      this.pumpQueuedWorkers(); // §8.2: the serial slot freed
      return;
    }
    if (tail.kind === "not_started") {
      // The prompt never reached the session (crash during startup): there is no run to
      // resume — auto-resuming an empty session would only confuse the model. The command
      // itself is `ambiguous` (§6.3); surface the break and let the steward re-dispatch.
      await this.breakWorker(
        worker.workerId,
        "unknown",
        "Connector restarted during startup; the task never began. Re-dispatch it.",
        "startup_interrupted",
      );
      return;
    }
    this.store.setWorkerState(worker.workerId, "lost", "restart");
    await this.emitEvent(worker.workerId, "lost", { reason: "connector_restart" });
    this.scheduleAutoResume(worker.workerId, "connector_restart");
  }

  // --- Automatic resume (connector-pi.md §9.2) ----------------------------------------------

  /** Schedules one automatic resume after the backoff; the budget is enforced both here and
   * when the timer fires, so a worker that keeps dying cannot loop (≤2/hour, then broken). */
  private scheduleAutoResume(workerId: string, reason: string): void {
    if (this.crashed || this.resumeTimers.has(workerId)) return;
    if (this.store.countResumes(workerId, this.resumeWindowMs) >= this.maxAutoResumes) {
      void this.breakWorker(
        workerId,
        "unknown",
        `Automatic resume budget exhausted (${this.maxAutoResumes} per hour); the worker needs a human decision.`,
        "resumes_exhausted",
      );
      return;
    }
    const timer = setTimeout(() => {
      this.resumeTimers.delete(workerId);
      void this.autoResume(workerId, reason);
    }, this.autoResumeBackoffMs);
    timer.unref?.();
    this.resumeTimers.set(workerId, timer);
  }

  private async autoResume(workerId: string, reason: string): Promise<void> {
    if (this.crashed) return;
    const worker = this.store.getWorker(workerId);
    if (!worker) return;
    const resumable =
      worker.state === "lost" ||
      worker.state === "recovering" ||
      // A transient settle left an idle-HOT worker (§5.2: one automatic resume allowed).
      (worker.state === "idle" && worker.lastOutcome === "error");
    if (!resumable) return; // settled or resumed by other means in the meantime
    const count = this.store.recordResume(workerId, this.resumeWindowMs);
    if (count > this.maxAutoResumes) {
      await this.breakWorker(
        workerId,
        "unknown",
        `Automatic resume budget exhausted (${this.maxAutoResumes} per hour); the worker needs a human decision.`,
        "resumes_exhausted",
      );
      return;
    }
    this.store.setWorkerState(workerId, "recovering");
    try {
      await this.resumeWorker(workerId, reason, count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorClass: ErrorClass = classifyError(message) === "auth" ? "auth" : "unknown";
      await this.breakWorker(workerId, errorClass, `Automatic resume failed: ${message}`, "resume_failed");
    }
  }

  /**
   * Resumes a worker from its pi session (§9.2): with a live process the fixed prompt is
   * delivered over RPC; otherwise the process is relaunched with the same `--session-id` in
   * the worker's own cwd. Emits `resumed{reason, count}` on success.
   */
  private async resumeWorker(workerId: string, reason: string, count: number): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    if (worker.state === "queued") {
      // §8.2: a queued write worker has no session yet — there is nothing to resume. It
      // starts on its own when the repo's serial slot frees.
      throw new CommandError("not_started", `worker ${workerId} is queued behind another write task; it starts when that one settles`);
    }
    if (this.adapter.isRunning?.(workerId)) {
      await this.adapter.resume(workerId, reason);
      this.store.setWorkerState(workerId, "running");
      await this.emitEvent(workerId, "resumed", { reason, count });
      return;
    }
    const repo = this.store.getRepo(worker.repoId);
    const cwd = worker.worktree ?? repo?.path;
    if (!cwd) throw new CommandError("startup_failed", `no worktree or repo path to resume worker ${workerId} in`);
    const lock = acquireLock(this.stateDir, workerId);
    if (!lock.ok) throw new CommandError("lock_held", `worker ${workerId} is locked by pid ${lock.pid}`, true);
    const spec: StartSpec = {
      workerId,
      threadId: worker.threadId,
      cwd,
      mode: worker.mode === "readonly" ? "readonly" : "write",
      prompt: RESUME_PROMPT,
      commandId: `resume-${count}-${this.now()}`,
      // §13: the repo's local trust applies to resumes exactly like first starts.
      approveProject: repo?.approved === true ? true : undefined,
    };
    this.active.set(workerId, {
      repoId: worker.repoId,
      worktree: worker.worktree ?? undefined,
      branch: worker.branch ?? undefined,
      base: worker.base ?? undefined,
    });
    try {
      const handle = await this.adapter.start(spec);
      this.store.upsertWorker({
        workerId,
        threadId: worker.threadId,
        repoId: worker.repoId,
        mode: spec.mode,
        state: "running",
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile ?? null,
        branch: worker.branch,
        worktree: worker.worktree,
        base: worker.base,
      });
      this.startSnapshotLoop();
      await this.emitEvent(workerId, "resumed", { reason, count });
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      this.active.delete(workerId);
      throw err;
    }
  }

  /** Terminal `broken` (§5.1/§9.2): automatic recovery is over. The `settled` error event is
   * the signal the steward routes to the user (auth-class failures tell them to fix
   * credentials on the machine; everything else asks for a decision). */
  private async breakWorker(workerId: string, errorClass: ErrorClass, detail: string, lastOutcome: string): Promise<void> {
    this.store.setWorkerState(workerId, "broken", lastOutcome);
    await this.emitEvent(workerId, "settled", { outcome: "error", errorClass, lastText: detail });
    // §8.2: a broken write worker frees the repo's serial slot for the next queued one.
    this.pumpQueuedWorkers();
  }

  // --- Orphan cleanup (§9.3) ----------------------------------------------------------------

  /** Terminates the worker's snapshot orphans (alive + start-time match) and drops the
   * snapshot. Triggered by pi exiting unexpectedly, connector startup, and stop timeouts. */
  async cleanupOrphans(workerId: string): Promise<ProcRef[]> {
    const refs = this.store.getOrphanSnapshot(workerId);
    if (!refs || refs.length === 0) {
      this.store.deleteOrphanSnapshot(workerId);
      return [];
    }
    const killed = await this.killOrphansFn(refs);
    this.store.deleteOrphanSnapshot(workerId);
    return killed;
  }

  private startSnapshotLoop(): void {
    if (this.crashed || this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => void this.snapshotOnce(), this.snapshotIntervalMs);
    this.snapshotTimer.unref?.();
  }

  private stopSnapshotLoop(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
  }

  private async snapshotOnce(): Promise<void> {
    if (this.crashed) return;
    const pids = this.adapter.workerPids?.() ?? [];
    if (pids.length === 0) {
      this.stopSnapshotLoop();
      return;
    }
    for (const { workerId, pid } of pids) {
      try {
        this.store.setOrphanSnapshot(workerId, await this.listDescendantsFn(pid));
      } catch {
        // ps failed; the previous snapshot stays — better a stale list than none
      }
    }
  }

  // --- Shutdown ------------------------------------------------------------------------------

  /** Graceful shutdown: stop background loops. Worker processes are left to the OS — on
   * connector exit stdin closes and pi disposes of its tool tree itself (§9.1 measurement). */
  stop(): void {
    this.stopSnapshotLoop();
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
  }

  /** Test support: emulate a connector crash — every child is SIGKILLed with no graceful
   * stop, lock files and descendant snapshots stay on disk exactly as a real crash leaves
   * them (locks rewritten to name the now-dead holder), and this instance processes no
   * further events or timers. */
  simulateCrash(): void {
    this.crashed = true;
    this.stopSnapshotLoop();
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    this.adapter.simulateCrash?.();
    markLocksHeldByDeadProcess(this.stateDir);
  }

  // --- Adapter event → persisted WorkerEvent ----------------------------------------------

  private async onAdapterEvent(event: RawAdapterEvent): Promise<void> {
    if (this.crashed) return;
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
        if (event.outcome === "error" && event.errorClass === "auth") {
          // §9.2: auth never auto-resumes — the user must fix credentials on the machine, so
          // the connector is done with this worker; the settled event routes it to them.
          this.store.setWorkerState(event.workerId, "broken", "error:auth");
        } else {
          this.store.setWorkerState(event.workerId, "idle", event.outcome);
        }
        this.throttles.delete(event.workerId);
        if (event.outcome === "error" && event.errorClass === "transient") {
          // §5.2/§9.2: one automatic resume for transient-class errors (backoff + budget apply).
          this.scheduleAutoResume(event.workerId, "error:transient");
        } else {
          // §8.2: a settled write worker frees the repo's serial slot. (A transient error's
          // resume keeps the slot — the run is still in flight from the queue's viewpoint.)
          this.pumpQueuedWorkers();
        }
        return;
      }
      case "process_exit": {
        await this.emitEvent(event.workerId, "process_exit", { code: event.code, signal: event.signal });
        releaseLock(this.stateDir, event.workerId);
        this.throttles.delete(event.workerId);
        this.active.delete(event.workerId);
        const worker = this.store.getWorker(event.workerId);
        // An unexpected exit mid-run → lost (§9.1): sweep this worker's orphaned tool
        // children (§9.3), then try the automatic resume (§9.2).
        if (event.unexpected && worker && IN_FLIGHT_STATES.has(worker.state)) {
          await this.cleanupOrphans(event.workerId);
          this.store.setWorkerState(event.workerId, "lost", "crash");
          await this.emitEvent(event.workerId, "lost", {
            reason: "process_exit",
            code: event.code,
            signal: event.signal,
          });
          this.scheduleAutoResume(event.workerId, "process_exit");
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

function commandWorkerId(args: Record<string, unknown>, envelopeWorkerId: string | undefined, kind: string): string {
  const workerId = typeof args.workerId === "string" && args.workerId.length > 0 ? args.workerId : envelopeWorkerId;
  if (!workerId) throw new CommandError("bad_request", `${kind} requires a workerId`);
  return workerId;
}

/** §8.2/§13 (issue #16): local-only settings arriving inside a command are rejected before
 * anything runs — even a fully authenticated steward must not flip approveProject or the
 * workspace mode from afar; the owner sets them with `shepherd repo-config` on the machine. */
function rejectLocalOnlyArgs(args: Record<string, unknown>): void {
  for (const key of LOCAL_ONLY_ARGS) {
    if (key in args) {
      throw new CommandError(
        "local_only_setting",
        `'${key}' is a connector-local setting; set it on the machine with 'shepherd repo-config' (§13)`,
      );
    }
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
