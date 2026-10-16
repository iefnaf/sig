// WorkerManager, docs/design/connector-pi.md §2/§4.4/§5/§6/§8/§9/§11: worker lifecycle,
// command handling with dedup, locks, worktrees, event normalization into persisted
// WorkerEvents (seq per worker, written to LocalStore BEFORE send), the merge of GitFacts
// into the `report` event, and the §9 failure/recovery slice — orphan cleanup from
// descendant snapshots (§9.3), startup reconciliation with the session-tail check (§9.1),
// and automatic resume with the fixed prompt, 30 s backoff, and the ≤2/hour budget (§9.2).
import type { AgentAdapter, Delivery, ErrorClass, RawAdapterEvent, StartSpec, WorkerMode } from "./agent.ts";
import { classifyError } from "./adjudication.ts";
import { killOrphans, listDescendants, type ProcRef } from "./descendants.ts";
import { collectGitFacts } from "./git-facts.ts";
import { acquireLock, markLocksHeldByDeadProcess, releaseLock, removeStaleLocks } from "./locks.ts";
import { RESUME_PROMPT, PiAdapter } from "./pi-adapter.ts";
import { ProgressThrottle } from "./progress.ts";
import { inspectSessionTail, type SessionTail } from "./session-tail.ts";
import type { LocalStore, WorkerRow } from "./store.ts";
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

/** `send` args (connector-pi.md §6.1/§6.2): intent picks the delivery per the state table. */
export interface SendArgs {
  workerId: string;
  text: string;
  intent: "now" | "after" | "auto";
  images?: { data: string; mimeType: string }[];
}

export interface SendResult {
  delivery: "prompt" | "steer" | "follow_up" | "queued";
  /** §6.2: steer waits for the current tool batch — the steward relays this to the user. */
  effect?: "after_current_tools";
  /** True when an idle-cold send relaunched the process with `--session-id` (§6.2). */
  relaunched?: boolean;
}

/** `interrupt` args (§6.1): abort, optionally followed by one new instruction. */
export interface InterruptArgs {
  workerId: string;
  then?: string;
}

export interface InterruptOutcome {
  aborted: boolean;
  /** How many undelivered texts came back via `clear_queue` (also in `queue_returned`). */
  queueReturned: number;
  /** Delivery report for the `then` instruction, when one was given. */
  then?: SendResult;
}

/** A `send` held while the worker is starting/recovering/lost (§6.2 queue rows). */
interface PendingSend {
  commandId: string;
  text: string;
  intent: SendArgs["intent"];
  images?: { data: string; mimeType: string }[];
  resolve: (result: SendResult) => void;
  reject: (err: CommandError) => void;
}

const DEFAULT_IDLE_RECLAIM_MS = 10 * 60_000;
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 5_000;

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
  /** Idle window before the process is reclaimed (§4.1; default 10 min). The session stays. */
  idleReclaimMs?: number;
  /** How long `interrupt` waits for the aborted run's `agent_settled` (default 5 s). */
  abortSettleTimeoutMs?: number;
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
  /** Set by simulateCrash: a crashed instance processes nothing further. */
  private crashed = false;

  // --- §6.1/§6.2 intervention state -----------------------------------------------------------
  /** Sends held while the worker is starting/recovering/lost (§6.2 queue rows); drained
   *  when the transition completes, superseded by an interrupt (protocol §7.4). */
  private readonly pendingSends = new Map<string, PendingSend[]>();
  /** The in-flight start/resume transition per worker: what `interrupt` waits out and what
   *  drains the send queue when it settles. */
  private readonly transitions = new Map<string, Promise<unknown>>();
  /** §4.1 idle reclamation: per-worker timer from the last settle to stopProcess. */
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleReclaimMs: number;
  /** Waiter sets resolved by the next `settled` adapter event (the interrupt flow's
   *  wait-for-agent_settled{aborted:true} step). */
  private readonly abortWaiters = new Map<string, Set<() => void>>();
  private readonly abortSettleTimeoutMs: number;

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
    this.idleReclaimMs = recovery.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS;
    this.abortSettleTimeoutMs = recovery.abortSettleTimeoutMs ?? DEFAULT_ABORT_SETTLE_TIMEOUT_MS;
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
        // Tracked as a transition: an interrupt arriving mid-start waits it out, and queued
        // sends (§6.2) drain when startup completes.
        return this.withTransition(
          commandWorkerId(args, envelopeWorkerId, kind),
          () => this.startWorker(commandId, parseStartWorkerArgs(args)),
        );
      case "send":
        return this.sendToWorker(commandId, parseSendArgs(args, envelopeWorkerId));
      case "interrupt":
        return this.interruptWorker(commandId, parseInterruptArgs(args, envelopeWorkerId));
      case "stop_process": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        await this.stopProcess(workerId);
        return {};
      }
      case "resume": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        const reason = typeof args.reason === "string" && args.reason.length > 0 ? args.reason : "manual";
        return this.withTransition(workerId, async () => {
          const count = this.store.recordResume(workerId, this.resumeWindowMs);
          await this.resumeWorker(workerId, reason, count);
          return { resumed: true, count };
        });
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

  /** stop_process (§6.1): reclaim the process, keep the session on disk. */
  async stopProcess(workerId: string): Promise<void> {
    this.cancelIdleReclaim(workerId);
    await this.adapter.stopProcess(workerId); // process_exit handler releases the lock
    // §9.3: a stop that had to escalate to SIGKILL may have orphaned tool children.
    await this.cleanupOrphans(workerId);
  }

  // --- §6.1/§6.2: send and interrupt -----------------------------------------------------------

  /** Tracks an in-flight start/resume so an interrupt can wait it out and the send queue
   *  drains exactly once when the transition settles (success or failure). */
  private async withTransition<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    const transition = (async () => {
      try {
        return await fn();
      } finally {
        this.transitions.delete(workerId);
      }
    })();
    this.transitions.set(workerId, transition);
    try {
      return await transition;
    } finally {
      await this.drainPendingSends(workerId);
    }
  }

  /**
   * `send` (§6.2): delivery per the state table — running steers (or follow_up for
   * `after`), idle-hot prompts, idle-cold relaunches the process with `--session-id`, and
   * starting/lost/recovering queue until the transition completes. §6.3 image cap applies.
   */
  private async sendToWorker(commandId: string, args: SendArgs): Promise<SendResult> {
    const worker = this.requireWorker(args.workerId);
    if (args.text.length === 0) throw new CommandError("bad_request", "text is required");
    for (const image of args.images ?? []) {
      if (!image.data || image.data.length > 4 * 1024 * 1024) {
        throw new CommandError("too_large", "image exceeds the 4 MB base64 limit");
      }
    }
    if (worker.state === "broken") {
      throw new CommandError("broken_worker", `worker ${args.workerId} is broken and needs a human decision`);
    }
    this.cancelIdleReclaim(args.workerId); // the send revives the worker
    if (worker.state === "starting" || worker.state === "recovering" || worker.state === "lost") {
      // §6.2 queue rows: hold until startup/resume completes (or an interrupt supersedes).
      return new Promise<SendResult>((resolve, reject) => {
        const queue = this.pendingSends.get(args.workerId) ?? [];
        this.pendingSends.set(args.workerId, queue);
        queue.push({
          commandId,
          text: args.text,
          intent: args.intent,
          images: args.images,
          resolve,
          reject,
        });
      });
    }
    return this.deliverSend(worker, commandId, args);
  }

  /** The state table's delivery cells for idle/running workers (§6.2). */
  private async deliverSend(
    worker: WorkerRow,
    commandId: string,
    input: { text: string; intent: SendArgs["intent"]; images?: SendArgs["images"] },
  ): Promise<SendResult> {
    const { workerId } = worker;
    const hot = this.adapter.isRunning?.(workerId) ?? false;
    if (worker.state === "running" || worker.state === "recovering") {
      if (!hot) {
        throw new CommandError(
          "not_running",
          `worker ${workerId} is ${worker.state} but has no live process; wait for reconciliation`,
          true,
        );
      }
      // Steer/follow_up are the only safe deliveries mid-run: pi rejects a bare prompt into a
      // streaming agent, and the store's `running` can lag the real settle (the settled
      // handler first collects git facts) — a steer that lands after the run ended simply
      // waits in pi's queue for the next one. Never lost, never racing.
      const how: Delivery = input.intent === "after" ? "follow_up" : "steer";
      await this.adapter.send(workerId, { text: input.text, images: input.images }, how);
      return how === "steer" ? { delivery: "steer", effect: "after_current_tools" } : { delivery: "follow_up" };
    }
    // idle: prompt starts the next run in the same session. State flips first so a
    // concurrent send cannot double-prompt; on failure it rolls back to idle.
    if (hot) return this.deliverHotPrompt(worker, commandId, input);
    // idle-cold relaunch is a tracked transition exactly like a resume: a send racing the
    // cold-start window queues on the `starting` row and drains when the relaunch settles
    // — success *or* failure — instead of hanging until some later interrupt supersedes it
    // (PR #45 review #1); an interrupt arriving mid-relaunch waits it out (§6.2 "stop right
    // after dispatch").
    return this.withTransition(workerId, () => this.relaunchForSend(worker, commandId, input));
  }

  /** The idle-hot prompt cell: the state flips to `running` before the RPC so a concurrent
   *  send cannot double-prompt. A failed RPC rolls back to idle and re-arms §4.1 idle
   *  reclamation — the timer was cancelled when the send was accepted, and without the
   *  re-arm a failed prompt would strand the process hot forever (PR #45 review #3). */
  private async deliverHotPrompt(
    worker: WorkerRow,
    commandId: string,
    input: { text: string; images?: SendArgs["images"] },
  ): Promise<SendResult> {
    const { workerId } = worker;
    this.store.setWorkerState(workerId, "running");
    try {
      await this.adapter.send(workerId, { text: input.text, images: input.images, commandId }, "prompt");
    } catch (err) {
      this.store.setWorkerState(workerId, "idle");
      this.armIdleReclaim(workerId);
      throw err;
    }
    await this.emitEvent(workerId, "started", { sessionId: worker.sessionId ?? workerId, cwd: worker.worktree ?? undefined });
    return { delivery: "prompt" };
  }

  /** §6.2 idle-cold row: relaunch the process with the same `--session-id` and deliver the
   *  text as its prompt — same lock discipline as a resume (§4.3/§9.2), session untouched. */
  private async relaunchForSend(
    worker: WorkerRow,
    commandId: string,
    input: { text: string; images?: SendArgs["images"] },
  ): Promise<SendResult> {
    const { workerId } = worker;
    const repo = this.store.getRepo(worker.repoId);
    const cwd = worker.worktree ?? repo?.path;
    if (!cwd) throw new CommandError("startup_failed", `no worktree or repo path to reach worker ${workerId} in`);
    const lock = acquireLock(this.stateDir, workerId);
    if (!lock.ok) throw new CommandError("lock_held", `worker ${workerId} is locked by pid ${lock.pid}`, true);
    this.store.setWorkerState(workerId, "starting");
    this.active.set(workerId, {
      repoId: worker.repoId,
      worktree: worker.worktree ?? undefined,
      branch: worker.branch ?? undefined,
      base: worker.base ?? undefined,
    });
    const spec: StartSpec = {
      workerId,
      threadId: worker.threadId,
      cwd,
      mode: worker.mode === "readonly" ? "readonly" : "write",
      prompt: input.text,
      commandId,
      images: input.images,
    };
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
      await this.emitEvent(workerId, "started", {
        sessionId: handle.sessionId,
        cwd,
        branch: worker.branch ?? undefined,
      });
      return { delivery: "prompt", relaunched: true };
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      this.active.delete(workerId);
      this.store.setWorkerState(workerId, "idle");
      this.armIdleReclaim(workerId); // no live process → the reclaim no-ops; keeps the idle paths symmetric
      const code = (err as { code?: string }).code ?? "startup_failed";
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError(code, `cold-start send failed: ${message}`);
    }
  }

  /**
   * `interrupt` (§6.2): connector-queued sends ahead of it are superseded (protocol §7.4);
   * then `clear_queue` (texts → `queue_returned`), `abort`, wait for `agent_settled{aborted:
   * true}`, and — when `then` is present — deliver it as the next prompt.
   */
  private async interruptWorker(commandId: string, args: InterruptArgs): Promise<InterruptOutcome> {
    this.requireWorker(args.workerId);
    this.cancelIdleReclaim(args.workerId);
    this.supersedePendingSends(args.workerId);
    // A start/resume still in flight owns the process; let it land (bounded by its own
    // timeouts) so the abort hits a known state — "stop that one" right after dispatch.
    const transition = this.transitions.get(args.workerId);
    if (transition) await transition.catch(() => undefined);
    let returned: string[] = [];
    let aborted = false;
    let then: SendResult | undefined;
    try {
      if (this.adapter.isRunning?.(args.workerId)) {
        const result = await this.adapter.interrupt(args.workerId);
        returned = result.returned;
        if (returned.length > 0) {
          await this.emitEvent(args.workerId, "queue_returned", { texts: returned });
        }
        aborted = true;
        // Wait out the abort only when a run window is open — an interrupt on an idle-hot
        // worker has nothing settling, and the wait must not stall the command (§6.2).
        if (this.adapter.isStreaming?.(args.workerId)) await this.waitForAbortSettle(args.workerId);
      }
      if (args.then !== undefined) {
        const worker = await this.awaitSettleBeforeThen(args.workerId);
        if (worker.state === "broken") {
          throw new CommandError("broken_worker", `worker ${args.workerId} is broken and needs a human decision`);
        }
        const runWindowOpen = this.adapter.isStreaming?.(args.workerId) ?? false;
        const storeSettled = worker.state !== "running" && worker.state !== "recovering";
        if (!runWindowOpen && !storeSettled) {
          // PR #45 review #2: the settle pipeline stalled past the bound while pi's run window
          // is observably closed. §6.2 says then = prompt — force the idle-hot prompt cell (a
          // prompt into an idle process is safe); a steer would park the then-text in pi's
          // queue with no run left to apply it.
          then = await this.deliverHotPrompt(worker, commandId, { text: args.then });
        } else {
          then = await this.deliverSend(worker, commandId, { text: args.then, intent: "auto" });
        }
      }
    } finally {
      // §4.1 (PR #45 review #3): paths that leave the worker idle without a settle of their
      // own (an interrupt on an idle-hot worker has nothing aborting; a failed then-prompt
      // rolls back) must re-arm the idle window — the timer was cancelled on entry and
      // nothing else would bring it back.
      this.rearmIdleReclaimIfIdle(args.workerId);
    }
    return { aborted, queueReturned: returned.length, ...(then !== undefined ? { then } : {}) };
  }

  /**
   * A fresh worker row for the `then` delivery, after waiting out the settle lag: pi's run
   * window closes the moment `agent_settled` arrives, but the store's `running` lags that by
   * the settle pipeline (`get_session_stats` RPC + report/git facts). §6.2 says then =
   * prompt, so when no run window is open while the store still says running we wait
   * (bounded by abortSettleTimeoutMs) for the settle to land before applying the state
   * table — otherwise the then-text would be steered into a run that already ended (PR #45
   * review #2). With a run window still open (an abort that outlived its settle timeout),
   * the state table applies as-is: a steer pi queues and never loses.
   */
  private async awaitSettleBeforeThen(workerId: string): Promise<WorkerRow> {
    const worker = this.requireWorker(workerId);
    if (this.adapter.isStreaming?.(workerId)) return worker; // a run window is open: §6.2's table applies
    if (worker.state !== "running" && worker.state !== "recovering") return worker; // store already caught up
    await this.waitForAbortSettle(workerId); // the settle is in flight; bounded by abortSettleTimeoutMs
    return this.requireWorker(workerId);
  }

  /** Resolved by the worker's next `settled` adapter event, or the timeout — whichever first. */
  private waitForAbortSettle(workerId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const waiters = this.abortWaiters.get(workerId) ?? new Set<() => void>();
      this.abortWaiters.set(workerId, waiters);
      const waiter = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(false);
      }, this.abortSettleTimeoutMs);
      timer.unref?.();
      waiters.add(waiter);
    });
  }

  /** Delivers everything queued for the worker (§6.2); every entry settles its command. */
  private async drainPendingSends(workerId: string): Promise<void> {
    const queue = this.pendingSends.get(workerId);
    if (!queue || queue.length === 0) return;
    const sends = [...queue];
    queue.length = 0;
    for (const send of sends) {
      if (this.crashed) {
        send.reject(new CommandError("connector_down", "connector is shutting down", true));
        continue;
      }
      try {
        const worker = this.requireWorker(workerId);
        if (worker.state === "broken") throw new CommandError("broken_worker", `worker ${workerId} is broken`);
        // The state table applies at delivery time: after startup/resume the worker is
        // running, so the queued message steers (or follows up) rather than prompting into
        // a busy agent — pi rejects a bare prompt mid-run ("Agent is already processing").
        send.resolve(await this.deliverSend(worker, send.commandId, send));
      } catch (err) {
        send.reject(err instanceof CommandError ? err : new CommandError("internal", String(err)));
      }
    }
  }

  /** Protocol §7.4: sends queued ahead of an interrupt whose delivery never started answer
   *  `result{ok:false, code:"superseded"}` — their instruction is the user's to re-issue. */
  private supersedePendingSends(workerId: string): void {
    const queue = this.pendingSends.get(workerId);
    if (!queue) return;
    this.pendingSends.delete(workerId);
    for (const send of queue) {
      send.reject(new CommandError("superseded", "superseded by an interrupt on the same worker"));
    }
  }

  // --- §4.1 idle reclamation -------------------------------------------------------------------

  private armIdleReclaim(workerId: string): void {
    this.cancelIdleReclaim(workerId);
    if (this.crashed) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(workerId);
      void this.reclaimIdleProcess(workerId);
    }, this.idleReclaimMs);
    timer.unref?.();
    this.idleTimers.set(workerId, timer);
  }

  private cancelIdleReclaim(workerId: string): void {
    const timer = this.idleTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(workerId);
    }
  }

  /** Re-arm the idle window when an intervention ends with the worker idle: no-op unless
   *  the store actually says idle (a live run's settle arms its own timer, §4.1). */
  private rearmIdleReclaimIfIdle(workerId: string): void {
    if (this.store.getWorker(workerId)?.state === "idle") this.armIdleReclaim(workerId);
  }

  /** §4.1: past the idle window the process is closed and the session stays on disk. The
   *  next `send` relaunches with `--session-id` (cold start ≈ 350 ms, measured). */
  private async reclaimIdleProcess(workerId: string): Promise<void> {
    if (this.crashed) return;
    const worker = this.store.getWorker(workerId);
    if (!worker || worker.state !== "idle") return;
    if (!(this.adapter.isRunning?.(workerId) ?? false)) return;
    await this.stopProcess(workerId).catch((err) => {
      console.error(`[shepherd] idle reclaim failed for ${workerId}:`, err);
    });
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
      // Tracked as a transition: queued sends (§6.2) drain when the resume completes, and an
      // interrupt waits it out instead of racing the relaunch.
      await this.withTransition(workerId, () => this.resumeWorker(workerId, reason, count));
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
    // A broken worker can never deliver what is still queued on it (§6.2): settle those
    // commands now instead of leaving them pending until a restart marks them ambiguous.
    const queue = this.pendingSends.get(workerId);
    if (queue) {
      this.pendingSends.delete(workerId);
      for (const send of queue) {
        send.reject(new CommandError("broken_worker", `worker ${workerId} is broken: ${detail}`));
      }
    }
    await this.emitEvent(workerId, "settled", { outcome: "error", errorClass, lastText: detail });
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
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
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
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
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
          // §4.1: the process stays for the idle window (hot idle), then is reclaimed.
          this.armIdleReclaim(event.workerId);
        }
        // An interrupt waiting for agent_settled{aborted:true} (§6.2) is released by any
        // settle — the run is over either way.
        for (const waiter of this.abortWaiters.get(event.workerId) ?? []) waiter();
        this.abortWaiters.delete(event.workerId);
        this.throttles.delete(event.workerId);
        if (event.outcome === "error" && event.errorClass === "transient") {
          // §5.2/§9.2: one automatic resume for transient-class errors (backoff + budget apply).
          this.scheduleAutoResume(event.workerId, "error:transient");
        }
        return;
      }
      case "process_exit": {
        await this.emitEvent(event.workerId, "process_exit", { code: event.code, signal: event.signal });
        releaseLock(this.stateDir, event.workerId);
        this.throttles.delete(event.workerId);
        this.active.delete(event.workerId);
        this.cancelIdleReclaim(event.workerId); // the process is gone; nothing to reclaim
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

  private requireWorker(workerId: string): WorkerRow {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    return worker;
  }
}

function commandWorkerId(args: Record<string, unknown>, envelopeWorkerId: string | undefined, kind: string): string {
  const workerId = typeof args.workerId === "string" && args.workerId.length > 0 ? args.workerId : envelopeWorkerId;
  if (!workerId) throw new CommandError("bad_request", `${kind} requires a workerId`);
  return workerId;
}

function parseImages(args: Record<string, unknown>): { data: string; mimeType: string }[] | undefined {
  if (!Array.isArray(args.images)) return undefined;
  return (args.images as { data: string; mimeType: string }[]).map((img) => ({
    data: String(img.data),
    mimeType: String(img.mimeType),
  }));
}

/** `send` (§6.1): `text, images?, intent` — intent defaults to `auto`. */
function parseSendArgs(args: Record<string, unknown>, envelopeWorkerId: string | undefined): SendArgs {
  const intent = args.intent === "now" || args.intent === "after" ? args.intent : "auto";
  return {
    workerId: commandWorkerId(args, envelopeWorkerId, "send"),
    text: typeof args.text === "string" ? args.text : "",
    intent,
    images: parseImages(args),
  };
}

/** `interrupt` (§6.1): `then?: { text }`. */
function parseInterruptArgs(args: Record<string, unknown>, envelopeWorkerId: string | undefined): InterruptArgs {
  const then =
    typeof (args.then as { text?: unknown } | undefined)?.text === "string" &&
    String((args.then as { text: unknown }).text).length > 0
      ? String((args.then as { text: unknown }).text)
      : undefined;
  return { workerId: commandWorkerId(args, envelopeWorkerId, "interrupt"), ...(then !== undefined ? { then } : {}) };
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
