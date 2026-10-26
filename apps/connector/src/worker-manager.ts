// WorkerManager, docs/design/connector-pi.md §2/§4.4/§5/§6/§8/§9/§11: worker lifecycle,
// command handling with dedup, locks, worktrees, event normalization into persisted
// WorkerEvents (seq per worker, written to LocalStore BEFORE send), the merge of GitFacts
// into the `report` event, the §9 failure/recovery slice — orphan cleanup from descendant
// snapshots (§9.3), startup reconciliation with the session-tail check (§9.1), and automatic
// resume with the fixed prompt, 30 s backoff, and the ≤2/hour budget (§9.2) — and the stall
// watchdog (issue #13, ADR-0001): silent + cold-CPU workers get one in-place respawn, then
// settle as error:stall.
import type { AgentAdapter, Delivery, ErrorClass, RawAdapterEvent, StartSpec, WorkerHandle, WorkerMode } from "./agent.ts";
import { PartialInterruptError } from "./agent.ts";
import { classifyError } from "./adjudication.ts";
import { killOrphans, listDescendants, type ProcRef } from "./descendants.ts";
import { collectGitFacts } from "./git-facts.ts";
import { openPr, PrError, type PrExec } from "./pr.ts";
import { acquireLock, markLocksHeldByDeadProcess, releaseLock, removeStaleLocks } from "./locks.ts";
import { RESUME_PROMPT, PiAdapter } from "./pi-adapter.ts";
import { externalActivity, observeSession } from "./session-observation.ts";
import { findSessionHolders } from "./session-holders.ts";
import { ProgressThrottle } from "./progress.ts";
import { inspectSessionTail, type SessionTail } from "./session-tail.ts";
import { readSessionHistory } from "./session-history.ts";
import { readFullSessionHistory, claudeSessionPath } from "./full-session-history.ts";
import type { HistoryPage } from "@alexlikevibe/protocol";
import type { LocalStore, RegisteredRepo, WorkerRow } from "./store.ts";
import { StallWatchdog, stallContinueNote, type StallWatchdogOptions, type WatchdogCandidate } from "./watchdog.ts";
import { WorktreeManager, createReadonlyWorktree } from "./worktree.ts";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execGit = promisify(execFile);

/** Resolves a commit-ish (e.g. the previous relay leg's branch) to a full commit sha.
 *  Throws when the ref does not exist locally — a cross-machine relay without a fetched
 *  branch must fail loudly, not silently start from the default branch. */
async function resolveCommitish(cwd: string, commitish: string): Promise<string> {
  const { stdout } = await execGit("git", ["rev-parse", "--verify", `${commitish}^{commit}`], { cwd, timeout: 30_000 });
  const sha = stdout.trim();
  if (!sha) throw new Error(`cannot resolve '${commitish}'`);
  return sha;
}

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
  /** §6.2: steer waits for the current tool batch — the steward relays this to the user.
   *  `after_run_end`: the §3 degradation for agents that cannot steer at all (issue #17) —
   *  the text is delivered as the next prompt once the current run settles. */
  effect?: "after_current_tools" | "after_run_end";
  /** True when an idle-cold send relaunched the process with `--session-id` (§6.2). */
  relaunched?: boolean;
  /** §3 degradation (issue #17): why the delivery differs from the §6.2 state table — the
   *  steward relays this so nobody waits for a steer that will never come. */
  degraded?: string;
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

/** A mid-run send parked on a no-steer agent until its run settles (§3, issue #17). */
interface DeferredSend {
  commandId: string;
  text: string;
  images?: { data: string; mimeType: string }[];
}

const DEFAULT_IDLE_RECLAIM_MS = 10 * 60_000;
const DEFAULT_ABORT_SETTLE_TIMEOUT_MS = 5_000;

/** `start_worker` args (connector-pi.md §6.1 / protocol §6.2). */
export interface StartWorkerArgs {
  workerId: string;
  threadId: string;
  repoId: string;
  mode: WorkerMode;
  prompt: string;
  /** Which agent runs the task (issue #17); default 'pi'. Must be one of hello.agents. */
  agent?: string;
  base?: string;
  images?: { data: string; mimeType: string }[];
  model?: string;
}

export interface StartWorkerResult {
  sessionId: string;
  branch?: string;
  cwd: string;
  worktree?: string;
  /** Readonly relay legs (issue #8): the commit the detached-HEAD worktree sits on. */
  base?: string;
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
  /** Session-holder seam (tests inject a deterministic `ps`). */
  findSessionHolders?: (workerId: string, sessionFile: string | null | undefined, excludePids: number[]) => Promise<Array<{ pid: number; args: string }>>;
  /** ms within which a session-entry change counts as "someone is using it right now". */
  sessionInUseWindowMs?: number;
}

export interface WorkerManagerOptions {
  store: LocalStore;
  stateDir: string;
  /** Every agent this connector drives (issue #17: pi + Claude Code). The first entry is
   *  the default for start_worker commands that carry no `agent`. */
  adapters?: AgentAdapter[];
  /** Single-adapter shorthand (tests); ignored when `adapters` is given. Defaults to PiAdapter. */
  adapter?: AgentAdapter;
  /** Knobs for the pr_worker command (issue #21): the exec seam lets tests script gh/git
   *  without a network or a GitHub account. */
  pr?: { exec?: PrExec; timeoutMs?: number };
  /**
   * Persist-and-send for worker events (§11.3): the transport supplies this (ConnectorClient
   * writes the event to the durable EventLog — per-worker seq — before batching it out).
   * Tests inject a collector or a real EventLog.
   */
  emit?: (workerId: string, fields: Record<string, unknown>) => void;
  now?: () => number;
  recovery?: RecoveryOptions;
  /** §6.3: persist a command's write-ahead marker expectation. The app wires this to the
   *  CommandLog; tests observe it. */
  onExpectMarker?: (cmdId: string, meta: { sessionFile: string | null; afterEntryId: string | null }) => void;
  /** Stall-watchdog knobs (tests shrink timers and inject CPU samples). */
  watchdog?: StallWatchdogOptions;
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
  /** Every agent behind the contract (issue #17), keyed by kind; the default handles
   *  commands that name no agent (legacy rows included — their worker.agent is 'pi'). */
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly defaultAdapter: AgentAdapter;
  private readonly worktrees: WorktreeManager;
  private readonly prOptions: { exec?: PrExec; timeoutMs?: number } | undefined;
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
  private readonly findSessionHoldersFn: (workerId: string, sessionFile: string | null | undefined, excludePids: number[]) => Promise<Array<{ pid: number; args: string }>>;
  private readonly sessionInUseWindowMs: number;
  private readonly onExpectMarker?: (cmdId: string, meta: { sessionFile: string | null; afterEntryId: string | null }) => void;
  private snapshotTimer?: NodeJS.Timeout;
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();
  /** Repos with a queued-write launch in flight (guards pump re-entry). */
  private readonly pumpingRepos = new Set<string>();
  /** Workers with a launch between its synchronous `starting` claim and `running` — the
   * window in which a stop cannot reach the process through the adapter yet. */
  private readonly launching = new Set<string>();
  /** Workers stopped while `launching`: the launch checks this after every await and bails
   * without touching the stop's bookkeeping (review finding 3). */
  private readonly stopRequested = new Set<string>();
  /** Set by simulateCrash: a crashed instance processes nothing further. */
  private crashed = false;

  // --- §6.1/§6.2 intervention state -----------------------------------------------------------
  /** Sends held while the worker is starting/recovering/lost (§6.2 queue rows); drained
   *  when the transition completes, superseded by an interrupt (protocol §7.4). */
  private readonly pendingSends = new Map<string, PendingSend[]>();
  /** §3 degradation (issue #17): sends that landed mid-run on an agent that cannot steer
   *  (Claude Code headless). Delivered as the next prompt when the run settles; flushed
   *  back as `queue_returned` when the run ends any other way — never dropped. In memory
   *  on purpose: a connector crash loses them exactly like it loses a steer pi already
   *  queued (the command result went out in both cases), and the steward's re-ask path —
   *  not silent replay — is the recovery for both. */
  private readonly deferredSends = new Map<string, DeferredSend[]>();
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

  // --- stall watchdog (issue #13) -----------------------------------------------------------
  private readonly watchdog: StallWatchdog;
  /**
   * The original task prompt per worker, so a stall respawn can resend it with the
   * continuation note. Survives process_exit (the process dies before the respawn); a new
   * start_worker for the same id overwrites it.
   */
  private readonly runPrompts = new Map<string, string>();

  constructor(options: WorkerManagerOptions) {
    this.store = options.store;
    this.stateDir = options.stateDir;
    const list = options.adapters ?? (options.adapter ? [options.adapter] : [new PiAdapter({ stateDir: options.stateDir })]);
    if (list.length === 0) throw new Error("WorkerManager needs at least one AgentAdapter");
    this.adapters = new Map(list.map((adapter) => [adapter.kind, adapter]));
    this.defaultAdapter = this.adapters.get("pi") ?? list[0]!;
    this.worktrees = new WorktreeManager({ worktreesRoot: join(options.stateDir, "worktrees") });
    this.prOptions = options.pr;
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
    this.findSessionHoldersFn = recovery.findSessionHolders ?? findSessionHolders;
    this.sessionInUseWindowMs = recovery.sessionInUseWindowMs ?? 30_000;
    this.onExpectMarker = options.onExpectMarker;
    this.watchdog = new StallWatchdog(options.watchdog ?? {}, {
      candidates: () => this.watchdogCandidates(),
      onStrike: (workerId, strike, why) => this.handleStallStrike(workerId, strike, why),
    });
    for (const adapter of this.adapters.values()) {
      adapter.on("worker-event", (event) => {
        void this.onAdapterEvent(event).catch((err) => {
          // Event handling must never take the connector down (e.g. store closed at shutdown).
          console.error(`[sig] worker-event handling failed for ${event.workerId}:`, err);
        });
      });
    }
  }

  get agents() {
    return [...this.adapters.values()].map((a) => ({ kind: a.kind, version: a.version, capabilities: a.capabilities }));
  }

  /** The adapter for an agent kind; unknown kinds fail loudly (never silently fall back —
   *  the steward's hello.agents list is the contract). */
  private adapterFor(kind: string | null | undefined): AgentAdapter {
    if (!kind) return this.defaultAdapter;
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new CommandError("unknown_agent", `agent '${kind}' is not available on this machine`, false);
    }
    return adapter;
  }

  /** The adapter owning a worker row (legacy rows predate the agent column → pi). */
  private adapterOfWorker(worker: WorkerRow): AgentAdapter {
    return this.adapterFor(worker.agent ?? "pi");
  }

  /** PR #59 review finding 6: a worker whose agent is no longer wired (claude uninstalled
   *  between boots) must still be stoppable and cleanable — those paths degrade to "no live
   *  process" / fan-out instead of throwing unknown_agent at the operator. */
  private adapterOfWorkerOrNull(worker: WorkerRow): AgentAdapter | null {
    return this.adapters.get(worker.agent ?? "pi") ?? null;
  }

  /** stopProcess/interrupt can arrive for a worker the store no longer knows: fan the
   *  no-op-tolerant calls out to every adapter so whichever owns it is covered. */
  private stopProcessEverywhere(workerId: string): Promise<void> {
    return Promise.all([...this.adapters.values()].map((a) => a.stopProcess(workerId))).then(() => undefined);
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
          await this.resumeWorker(workerId, reason, count, { commandId });
          return { resumed: true, count };
        });
      }
      case "cleanup_worktree": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        return this.cleanupWorktree(workerId, args.force === true);
      }
      case "pr_worker": {
        const workerId = commandWorkerId(args, envelopeWorkerId, kind);
        return this.prWorker(
          commandId,
          workerId,
          typeof args.title === "string" ? args.title : "",
          typeof args.body === "string" ? args.body : "",
        );
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
    // A fresh task: any leftover strike/prompt state from a previous run of this id is void.
    this.watchdog.forget(args.workerId);
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

    // --- §3 capability gate (issue #17): the command's agent must exist here, and its
    // honest declarations are enforced — never quietly run a task the agent cannot honor.
    const agentKind = args.agent ?? "pi";
    const adapter = this.adapterFor(agentKind);
    if (args.images && args.images.length > 0 && !adapter.capabilities.images) {
      throw new CommandError(
        "unsupported_capability",
        `agent '${agentKind}' cannot take images (capability images=false); dispatch without them or to another agent`,
      );
    }
    if (args.mode === "readonly" && !adapter.capabilities.readonly) {
      throw new CommandError(
        "unsupported_capability",
        `agent '${agentKind}' cannot truly be restricted to read-only (capability readonly=false); dispatch it write tasks only`,
      );
    }
    // PR #59 review finding 3: a workerId is pinned to its agent for life (the row's agent
    // column is write-once). A start under a different agent would launch under the new
    // adapter while every later command still routes to the old one — reject instead.
    const existingRow = this.store.getWorker(args.workerId);
    if (existingRow && (existingRow.agent ?? "pi") !== agentKind) {
      throw new CommandError(
        "agent_mismatch",
        `worker ${args.workerId} already ran as ${existingRow.agent ?? "pi"}; workerIds are never reused across agents`,
      );
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
    if (args.mode === "write" && repo.writePolicy.concurrency === "serial") {
      const holder = this.writeSlotHolder(args.repoId, args.workerId);
      if (holder) {
        this.store.upsertWorker({
          workerId: args.workerId,
          threadId: args.threadId,
          repoId: args.repoId,
          agent: agentKind,
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
   * cmd_result, the pump breaks the worker instead).
   *
   * The `starting` row is written BEFORE the first await: from the serial queue check in
   * startWorker to this claim there is no await, so overlapping start_worker commands can
   * never both see an empty slot (review finding 1 — commands run concurrently in the
   * client, only the single JS turn serializes them). The same claim closes the stop-vs-pump
   * window (finding 3): a stop landing after the claim sees `starting`, not `queued`. */
  private async launchWorker(commandId: string, args: StartWorkerArgs, repo: RegisteredRepo): Promise<StartWorkerResult> {
    const adapter = this.adapterFor(args.agent); // unknown agents never reach a lock or a row
    // --- One process per session (§4.3): lock file, `lock_held` when alive, stale removed.
    const lock = acquireLock(this.stateDir, args.workerId);
    if (!lock.ok) {
      throw new CommandError("lock_held", `worker ${args.workerId} is locked by pid ${lock.pid}`, true);
    }
    this.launching.add(args.workerId);

    // Synchronous slot claim: the row exists (state `starting`) before any await, so a
    // concurrent start_worker / stop_process / pump decision reads this launch, not a void.
    this.store.upsertWorker({
      workerId: args.workerId,
      threadId: args.threadId,
      repoId: args.repoId,
      agent: args.agent ?? "pi",
      mode: args.mode,
      state: "starting",
    });

    let handle: WorkerHandle | undefined;
    let worktree: string | undefined;
    let branch: string | undefined;
    let base: string | undefined;
    let readonlyWorktree = false;
    try {
      // --- §8.2 workspace resolution. Write + worktree/serial → a dedicated worktree; write +
      // main, and readonly runs without a relay base (§8.3) → the repository's own checkout.
      // Readonly + base → a DETACHED-HEAD worktree at that base (issue #8): a review leg
      // continues from the write leg's branch without checking anything out in the owner's
      // working directory.
      const useWorktree = useWorktreeFor(repo, args);
      let cwd = repo.path;
      if (useWorktree) {
        try {
          if (args.mode === "readonly") {
            // The base is the previous leg's branch — resolve it to a commit first so the
            // detached HEAD pins the exact tip even if the branch moves while this runs.
            const resolved = await resolveCommitish(repo.path, args.base!);
            const ro = await createReadonlyWorktree(repo.path, {
              worktreesRoot: join(this.stateDir, "worktrees"),
              base: resolved,
              threadId: args.threadId,
            });
            cwd = ro.path;
            worktree = ro.path;
            base = ro.base;
            readonlyWorktree = true;
          } else {
            const created = await this.worktrees.create({ repoPath: repo.path, threadId: args.threadId, base: args.base });
            cwd = created.path;
            branch = created.branch;
            base = created.base;
            worktree = created.path;
          }
          if (this.stopRequested.has(args.workerId)) throw new CommandError("aborted", "worker was stopped during startup");
        } catch (err) {
          if (err instanceof CommandError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          throw new CommandError("worktree_failed", `could not create worktree: ${message}`);
        }
      }
      // `main` mode ignores `base`: the checkout is whatever the owner left it at — the
      // connector never checks branches out in the user's own working directory.
      if (this.stopRequested.has(args.workerId)) {
        throw new CommandError("aborted", "worker was stopped during startup");
      }

      this.active.set(args.workerId, { repoId: args.repoId, worktree, branch, base });
      // The original task prompt, so a stall respawn can resend it with the continuation
      // note (issue #13); cleared when the run ends or the launch fails.
      this.runPrompts.set(args.workerId, args.prompt);

      const spec: StartSpec = {
        workerId: args.workerId,
        threadId: args.threadId,
        cwd,
        mode: args.mode,
        prompt: args.prompt,
        commandId,
        // §6.3/§10: fires between get_state and the prompt RPC — the earliest moment the
        // session exists. From here on, a crash leaves decidable evidence behind: the
        // worker's tail baseline, and the command's write-ahead marker expectation.
        onSession: (sessionFile, lastKnownEntryId) => {
          if (sessionFile) this.store.setSessionObservation(args.workerId, sessionFile, lastKnownEntryId);
          this.expectCommandMarker(commandId, args.workerId, sessionFile, lastKnownEntryId);
        },
        // §13: approveProject comes from the repo's local config, never from the command.
        approveProject: repo.approved === true ? true : undefined,
        images: args.images,
        model: args.model,
      };

      try {
        handle = await adapter.start(spec);
      } catch (err) {
        if (this.stopRequested.has(args.workerId)) {
          // The stop could not kill what had not spawned; the start raced it and lost.
          throw new CommandError("aborted", "worker was stopped during startup");
        }
        throw err;
      }
      if (this.stopRequested.has(args.workerId)) {
        // The process did spawn after all — reclaim it, leave the stop's bookkeeping alone.
        await adapter.stopProcess(args.workerId).catch(() => undefined);
        throw new CommandError("aborted", "worker was stopped during startup");
      }

      const result: StartWorkerResult = {
        sessionId: handle.sessionId,
        branch,
        cwd,
        worktree,
        ...(readonlyWorktree ? { base } : {}),
      };
      this.stopRequested.delete(args.workerId);
      this.store.upsertWorker({
        workerId: args.workerId,
        threadId: args.threadId,
        repoId: args.repoId,
        agent: args.agent ?? "pi",
        mode: args.mode,
        state: "running",
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile ?? null,
        branch,
        worktree,
        base,
      });
      this.startSnapshotLoop();
      this.watchdog.start();
      // `started` (§11.1): successful start — the run is live, progress follows.
      await this.emitEvent(args.workerId, "started", {
        sessionId: handle.sessionId,
        cwd,
        branch,
        ...(readonlyWorktree ? { base } : {}),
      });
      return result;
    } catch (err) {
      releaseLock(this.stateDir, args.workerId);
      this.active.delete(args.workerId);
      // The launch failed (or was aborted by a stop): the original prompt is void either way.
      this.runPrompts.delete(args.workerId);
      if (err instanceof CommandError && err.code === "aborted") {
        // A stop settled this worker (idle + settled:aborted) while the launch was in
        // flight; the launch must not overwrite that with broken/running state or events.
        this.stopRequested.delete(args.workerId);
        await this.discardLaunchArtifacts(args.workerId, repo, { worktree, branch, base }, handle !== undefined);
        throw err;
      }
      this.store.setWorkerState(args.workerId, "broken");
      const code = (err as { code?: string }).code ?? "startup_failed";
      const message = err instanceof Error ? err.message : String(err);
      throw new CommandError(code, message);
    } finally {
      this.launching.delete(args.workerId);
      // PR #43 review N1: a stop can land between the launch's last marker check and this
      // finally (it saw `running` + `launching` and had to assume a launch in flight). Past
      // this point every stop settles itself through the adapter, so the marker must never
      // outlive the launch — a stale one would abort-and-strand the NEXT start of this
      // workerId at `starting`, deadlocking a serial repo all over again.
      this.stopRequested.delete(args.workerId);
    }
  }

  /** PR #43 review N3: a launch that aborts before `started` leaves its just-allocated
   * worktree behind. Before the process ever ran, the allocation is undone on the spot —
   * the directory holds only the base checkout, no agent ever touched it, so this is
   * undoing our own allocation, not an automatic delete of anyone's work. After a process
   * ran in it, the columns are backfilled on the row (without touching state — the stop's
   * settle stands) so the explicit cleanup_worktree command can deal with what's there. */
  private async discardLaunchArtifacts(
    workerId: string,
    repo: RegisteredRepo,
    created: { worktree?: string; branch?: string; base?: string },
    processRan: boolean,
  ): Promise<void> {
    if (!created.worktree) return;
    if (!processRan) {
      await this.worktrees.cleanup(repo.path, created.worktree, { force: true }).catch((err) => {
        console.error(`[sig] could not undo the allocated worktree ${created.worktree}:`, err);
      });
      return;
    }
    this.store.setWorkerWorktree(workerId, {
      worktree: created.worktree,
      branch: created.branch ?? null,
      base: created.base ?? null,
    });
  }

  /** stop_process (§6.1): reclaim the process, keep the session on disk.
   *
   * Bookkeeping by state (review findings 2/3):
   * - `queued` (§8.2): no process yet — drop the pending start so the queue does not launch
   *   a task the user tried to stop. Race-free: a concurrent pump flips the row to `starting`
   *   synchronously before its first await, so this branch can only win the row outright.
   * - in flight or `lost`: the run ends here — an expected process_exit carries no state and
   *   no settled event, so without this the worker (and a serial repo's write slot) would be
   *   stuck `running` until a connector restart. The worker settles `aborted`, stays idle
   *   (resumable), a pending auto-resume is cancelled, and the serial queue is pumped.
   * - otherwise (idle-hot reclaim, broken): the memory play it always was — nothing to settle. */
  async stopProcess(workerId: string): Promise<void> {
    this.cancelIdleReclaim(workerId);
    const worker = this.store.getWorker(workerId);
    if (worker?.state === "queued") {
      this.store.deleteQueuedStart(workerId);
      this.store.setWorkerState(workerId, "idle", "stopped_while_queued");
      await this.emitEvent(workerId, "settled", { outcome: "aborted" });
      return;
    }
    const inFlight = worker ? IN_FLIGHT_STATES.has(worker.state) || worker.state === "lost" : false;
    if (inFlight && this.launching.has(workerId)) this.stopRequested.add(workerId);
    // Cancel a pending automatic resume: the stop is the user's final word for this run.
    const timer = this.resumeTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.resumeTimers.delete(workerId);
    }
    // §3 degradation: a stop is the one intervention every agent must honor — fan out to
    // every adapter when the row is gone OR its agent is no longer wired (PR #59 review
    // finding 6: claude uninstalled between boots must not strand the row's stop_process);
    // adapters that do not own the worker no-op.
    const owner = worker ? this.adapterOfWorkerOrNull(worker) : null;
    if (owner) await owner.stopProcess(workerId);
    else await this.stopProcessEverywhere(workerId);
    // process_exit handler releases the lock; a §3 no-steer agent's deferred texts come
    // back to the steward instead of silently relaunching a worker the user just stopped.
    await this.flushDeferredSends(workerId, "stopped");
    // §9.3: a stop that had to escalate to SIGKILL may have orphaned tool children.
    await this.cleanupOrphans(workerId);
    if (inFlight) {
      this.store.setWorkerState(workerId, "idle", "stopped");
      // The run ended at the user's word: stall strikes and the stall-respawn prompt are
      // void (a later strike on a fresh run of this id must start at strike 1 again).
      this.watchdog.forget(workerId);
      this.runPrompts.delete(workerId);
      await this.emitEvent(workerId, "settled", { outcome: "aborted" });
      // §8.2: the serial write slot freed with the runner.
      this.pumpQueuedWorkers();
    }
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

  /** §8.2 (issue #16 merge with #45): whether ANOTHER write worker holds this worker's
   * serial repo slot — the condition under which a continuation (send-relaunch, hot prompt,
   * manual resume) must wait instead of putting a second live write run in the repo. */
  private serialSlotHeldByAnother(worker: WorkerRow): boolean {
    if (worker.mode !== "write") return false; // readonly tasks are never isolated (§8.3)
    const repo = this.store.getRepo(worker.repoId);
    return repo?.writePolicy.concurrency === "serial" && this.writeSlotHolder(worker.repoId, worker.workerId) !== undefined;
  }

  /** Starts the next queued write worker of every repo whose slot freed up. Triggered by
   * settle/break transitions, reconciliation, and queue-loss cleanup — never by a timer.
   * Best-effort by design: it runs from void-fired continuations (including after a
   * shutdown), so a failed kick is logged, never thrown. */
  private pumpQueuedWorkers(): void {
    if (this.crashed) return;
    try {
      const repos = new Set(
        this.store
          .listWorkers()
          .filter((w) => w.state === "queued" && !this.pumpingRepos.has(w.repoId))
          .map((w) => w.repoId),
      );
      for (const repoId of repos) {
        this.pumpOnce(repoId);
      }
      // Parked sends (§8.2 serial, the deliverSend guard above): a slot that freed with no
      // queued worker may still owe a send-relaunch. Idle workers only — entries parked for
      // a starting/lost run drain from their own transition's finally, not from here.
      for (const workerId of [...this.pendingSends.keys()]) {
        const worker = this.store.getWorker(workerId);
        if (worker?.state === "idle" && !this.serialSlotHeldByAnother(worker)) {
          void this.drainPendingSends(workerId);
        }
      }
    } catch (err) {
      console.error("[sig] serial queue pump failed:", err);
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
      if (err instanceof CommandError && err.code === "aborted") {
        // A stop_process settled this worker while the launch was between its synchronous
        // claim and the spawn — the stop's bookkeeping (idle + settled:aborted) stands.
        return;
      }
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
    // Settled but still idle-hot: the process is alive inside that directory — never delete
    // under it (review finding 5's other half; also keeps resume-after-cleanup cold). An
    // unwired agent (PR #59 finding 6) cannot have a live process here by construction.
    const owner = this.adapterOfWorkerOrNull(worker);
    if (owner?.isRunning?.(workerId) === true) {
      throw new CommandError(
        "worker_running",
        `worker ${workerId} still has a live (idle) process in its worktree; stop_process first`,
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

  // --- pr_worker (connector-pi.md §6.1, issue #21: the consent gate's machine half) ------------------

  /** `pr_worker`: push the worker's branch and run `gh pr create` in its worktree. The
   *  command only exists because the user tapped [同意] on the done card; the connector
   *  never pushes on its own (§7.3 rule 4). The result rides the event stream —
   *  `pr_created{url}` / `pr_failed{stage,message}` — so the chat hears it asynchronously
   *  even though the command result settles with the URL too. */
  async prWorker(commandId: string, workerId: string, title: string, body: string): Promise<{ url: string; branch: string }> {
    const worker = this.requireWorker(workerId);
    if (!worker.worktree || !worker.branch) {
      throw new CommandError(
        "no_worktree",
        `worker ${workerId} has no worktree branch to open a PR from (readonly task or main-checkout repo)`,
      );
    }
    if (SERIAL_SLOT_STATES.has(worker.state)) {
      throw new CommandError(
        "worker_running",
        `worker ${workerId} is ${worker.state}${
          worker.state === "lost"
            ? " (crashed; its automatic resume is pending)"
            : ""
        }; let the run settle before opening a PR`,
      );
    }
    if (!this.store.getRepo(worker.repoId)) {
      throw new CommandError("not_registered_repo", `repo '${worker.repoId}' is not registered on this machine`);
    }
    // No per-worker mutex is needed here: the steward's cross-card guard (branchState) means
    // at most one pr_worker per worker is ever in flight, and redeliveries dedupe on cmdId
    // (§6.3) before reaching this method.
    //
    // `gh pr create` deliberately gets no `--base`: relay legs are cut from sig/*
    // branches that are typically unpushed (the whole point of this gate), so targeting one
    // would fail with "base branch not found". The repo's default branch shows the thread's
    // whole stacked work — the PR the user expects to review.
    let url: string;
    try {
      url = (
        await openPr({
          worktree: worker.worktree,
          branch: worker.branch,
          title: title || worker.branch,
          body,
          ...(this.prOptions?.exec !== undefined ? { exec: this.prOptions.exec } : {}),
          ...(this.prOptions?.timeoutMs !== undefined ? { timeoutMs: this.prOptions.timeoutMs } : {}),
        })
      ).url;
    } catch (err) {
      // The failure card's inputs (issue #21 AC4): the event carries the classified stage;
      // the command still fails loudly so the steward's outbox row settles. The emit is
      // best-effort — a store already closed at shutdown must not mask the real error.
      const stage = err instanceof PrError ? err.stage : "create";
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await this.emitEvent(workerId, "pr_failed", { cmdId: commandId, stage, message }).catch(() => undefined);
      const code =
        stage === "gh_missing"
          ? "gh_missing"
          : stage === "auth"
            ? "gh_auth"
            : stage === "push"
              ? "push_rejected"
              : "pr_create_failed";
      // create-stage failures are the unclassified residue (timeouts included) — plausibly
      // transient, so the result says a retry is reasonable.
      throw new CommandError(code, message, stage === "create");
    }
    // Review finding 4: the PR exists from here on — a failing success-emit (store closed at
    // shutdown) must NOT be reported as a PR failure. Best-effort only: the cmd_result still
    // carries the URL, and the steward's ok-result backstop delivers the card without the
    // event.
    await this.emitEvent(workerId, "pr_created", { cmdId: commandId, url, branch: worker.branch }).catch(() => undefined);
    return { url, branch: worker.branch };
  }

  // --- §6.1/§6.2: send and interrupt -----------------------------------------------------------

  /** Tracks an in-flight start/resume so an interrupt can wait it out and the send queue
   *  drains exactly once when the transition settles (success or failure). Transitions on
   *  one worker chain — the second runs only after the first settles — so the map keeps its
   *  "one live transition per worker" invariant for interrupt-waiting, and two transitions
   *  can never race the process or the lock (PR #45 review round 2, R2-1). */
  private async withTransition<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.transitions.get(workerId);
    const run = (async () => {
      // Serialize: fn starts only after the previous transition settles, so the map's
      // "one live transition per worker" invariant holds for interrupt-waiting and no two
      // transitions race the process or the lock (PR #45 review round 2, R2-1).
      await previous?.catch(() => undefined);
      return fn();
    })();
    const transition = run.finally(() => {
      // Identity-keyed: never delete a *later* transition's registration.
      if (this.transitions.get(workerId) === transition) this.transitions.delete(workerId);
    });
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
    // §3 gate (PR #59 review finding 2): the images check is NOT start_worker-only — every
    // delivery path (steer, follow-up, deferral, hot prompt, cold relaunch) would otherwise
    // carry images an images=false agent silently drops. Refuse at the entrance instead.
    if (args.images && args.images.length > 0) {
      const owner = this.adapterOfWorkerOrNull(worker);
      if (owner && !owner.capabilities.images) {
        throw new CommandError(
          "unsupported_capability",
          `agent '${worker.agent ?? "pi"}' cannot take images (capability images=false); send text only or dispatch to another agent`,
        );
      }
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
    // §8.2 serial repos (issue #16): an idle/reviving write worker must re-acquire the
    // repo's single write slot before it may run again — a hot prompt or cold relaunch
    // while another write task holds the slot would put two live write runs in a repo the
    // owner pinned to one-at-a-time. The send parks in the same pendingSends queue that
    // holds sends for lost/recovering workers and drains when the slot frees (the serial
    // pump calls drainPendingSends); it is never dropped and never races the holder.
    if (this.serialSlotHeldByAnother(worker)) {
      return new Promise<SendResult>((resolve, reject) => {
        const queue = this.pendingSends.get(workerId) ?? [];
        this.pendingSends.set(workerId, queue);
        queue.push({
          commandId,
          text: input.text,
          intent: input.intent,
          images: input.images,
          resolve,
          reject,
        });
      });
    }
    const adapter = this.adapterOfWorker(worker);
    const hot = adapter.isRunning?.(workerId) ?? false;
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
      const capable = input.intent === "after" ? adapter.capabilities.followUp : adapter.capabilities.steer;
      if (!capable) {
        // §3 degradation (issue #17): headless agents have no mid-run channel. The send
        // parks until the run settles and is then delivered as the next prompt; the command
        // result says so (effect: after_run_end) so the steward never promises a steer.
        // (No marker check here: nothing is written to the agent yet — the deferred
        // delivery runs its own expectCommandMarker when it relaunches.)
        return this.deferSendUntilRunEnd(worker, commandId, input, how);
      }
      this.expectCommandMarker(commandId, workerId);
      await adapter.send(workerId, { text: input.text, images: input.images, commandId }, how);
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
    this.expectCommandMarker(commandId, workerId);
    try {
      await this.adapterOfWorker(worker).send(workerId, { text: input.text, images: input.images, commandId }, "prompt");
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
    // §10 gate before any state claim: a refusal (session_in_use) must leave the worker
    // exactly as it was — idle, lock released — so a retry after the holder exits works.
    try {
      await this.checkSessionBeforeRelaunch(worker);
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      throw err;
    }
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
      onSession: (sessionFile, lastKnownEntryId) => {
        if (sessionFile) this.store.setSessionObservation(workerId, sessionFile, lastKnownEntryId);
        this.expectCommandMarker(commandId, workerId, sessionFile, lastKnownEntryId);
      },
      // §13: approveProject comes from the repo's local config on every spawn — the
      // send-relaunch path included (issue #16 merge stitch).
      approveProject: repo?.approved === true ? true : undefined,
      images: input.images,
      // The worker already has a session: agents whose session id is not the workerId
      // (Claude Code) resume it instead of deriving a fresh one (issue #17).
      resumeSessionId: worker.sessionId ?? undefined,
    };
    try {
      const handle = await this.adapterOfWorker(worker).start(spec);
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
    const worker = this.requireWorker(args.workerId);
    const adapter = this.adapterOfWorker(worker);
    this.cancelIdleReclaim(args.workerId);
    this.supersedePendingSends(args.workerId);
    // §3 degradation (issue #17): an agent that cannot interrupt at all fails loudly — the
    // command error is what tells the steward (and the user) that this run cannot be
    // stopped here, only waited out (or stop_process-ed out from under the session).
    if (!adapter.capabilities.interrupt) {
      throw new CommandError(
        "unsupported_capability",
        `agent '${worker.agent ?? "pi"}' cannot interrupt a running task (capability interrupt=false); wait for it to settle or stop the process`,
      );
    }
    // A start/resume still in flight owns the process; let it land (bounded by its own
    // timeouts) so the abort hits a known state — "stop that one" right after dispatch.
    const transition = this.transitions.get(args.workerId);
    if (transition) await transition.catch(() => undefined);
    let returned: string[] = [];
    let aborted = false;
    let then: SendResult | undefined;
    try {
      // §3 (issue #17): texts parked on a no-steer agent were never delivered — the
      // interrupt supersedes them, so they come back with the queue instead of vanishing.
      const deferred = this.takeDeferredSends(args.workerId);
      if (deferred.length > 0) {
        returned = deferred.map((send) => send.text);
        await this.emitEvent(args.workerId, "queue_returned", { texts: returned, reason: "interrupted" });
      }
      if (adapter.isRunning?.(args.workerId)) {
        let interruptResult: Awaited<ReturnType<AgentAdapter["interrupt"]>>;
        try {
          interruptResult = await adapter.interrupt(args.workerId);
        } catch (err) {
          // R2-3: clear_queue may already have emptied the agent's queue — the retrieved
          // texts ride a PartialInterruptError; surface them as queue_returned before
          // failing, or they are lost (the agent holds no copy either).
          if (err instanceof PartialInterruptError && err.returned.length > 0) {
            await this.emitEvent(args.workerId, "queue_returned", { texts: err.returned });
          }
          throw err;
        }
        returned = [...returned, ...interruptResult.returned];
        if (interruptResult.returned.length > 0) {
          await this.emitEvent(args.workerId, "queue_returned", { texts: interruptResult.returned });
        }
        // PR #59 review finding 4: an interrupt that landed in the agent's post-result
        // window did not abort anything — the run settled and its report is on the wire.
        // Report aborted:false so the steward never says「已停止」next to the report card.
        aborted = interruptResult.alreadySettled !== true;
        // Wait out the abort only when a run window is open — an interrupt on an idle-hot
        // worker has nothing settling, and the wait must not stall the command (§6.2).
        if (adapter.isStreaming?.(args.workerId)) await this.waitForAbortSettle(args.workerId);
      }
      if (args.then !== undefined) {
        const worker = await this.awaitSettleBeforeThen(args.workerId);
        if (worker.state === "broken") {
          throw new CommandError("broken_worker", `worker ${args.workerId} is broken and needs a human decision`);
        }
        const runWindowOpen = this.adapterOfWorker(worker).isStreaming?.(args.workerId) ?? false;
        const storeSettled = worker.state !== "running" && worker.state !== "recovering";
        if (!runWindowOpen && !storeSettled) {
          // PR #45 review #2: the settle pipeline stalled past the bound while pi's run window
          // is observably closed. §6.2 says then = prompt — force the idle-hot prompt cell (a
          // prompt into an idle process is safe); a steer would park the then-text in pi's
          // queue with no run left to apply it.
          try {
            then = await this.deliverHotPrompt(worker, commandId, { text: args.then });
          } catch (err) {
            if ((err as { code?: string }).code !== "not_running") throw err;
            // R2-2: the process died during the settle wait — fall through to the state
            // table, whose fresh row now reads idle-cold and cold-relaunches with the
            // then-text instead of failing the command.
            const fresh = this.requireWorker(args.workerId);
            if (fresh.state === "broken") {
              throw new CommandError("broken_worker", `worker ${args.workerId} is broken and needs a human decision`);
            }
            then = await this.deliverSend(fresh, commandId, { text: args.then, intent: "auto" });
          }
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
    const streaming = () => {
      const worker = this.requireWorker(workerId);
      return { worker, open: this.adapterOfWorker(worker).isStreaming?.(workerId) ?? false };
    };
    let { worker, open } = streaming();
    if (open) return worker; // a run window is open: §6.2's table applies
    if (worker.state !== "running" && worker.state !== "recovering") return worker; // store already caught up
    // The settle is in flight — poll for it instead of betting on one event (PR #59 review
    // finding 5): a kill-based interrupt emits its settled DURING adapter.interrupt(), so
    // an event-registered waiter can miss it and stall the full abortSettleTimeoutMs. The
    // store flip and any re-opened window both resolve within one 25 ms tick.
    const deadline = Date.now() + this.abortSettleTimeoutMs;
    while (Date.now() < deadline && !this.crashed) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      ({ worker, open } = streaming());
      if (open) return worker;
      if (worker.state !== "running" && worker.state !== "recovering") return worker;
    }
    return this.requireWorker(workerId); // timed out: the caller's §6.2 branches handle it
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

  // --- §3 degradation: sends deferred past run end (issue #17) ------------------------------

  /** Parks a mid-run send on a no-steer agent; the command settles immediately with the
   *  degradation note so the steward can tell the user when the text will land. */
  private async deferSendUntilRunEnd(
    worker: WorkerRow,
    commandId: string,
    input: { text: string; images?: SendArgs["images"] },
    how: Delivery,
  ): Promise<SendResult> {
    const queue = this.deferredSends.get(worker.workerId) ?? [];
    this.deferredSends.set(worker.workerId, queue);
    queue.push({ commandId, text: input.text, images: input.images });
    return {
      delivery: "queued",
      effect: "after_run_end",
      degraded: `${worker.agent ?? "pi"} cannot ${how} mid-run; the text is delivered as the next prompt when the current run ends`,
    };
  }

  /** Delivers a no-steer agent's deferred sends once its run settled (the settled handler
   *  calls this). Serial by nature: a delivery that lands while the NEXT run is already
   *  going simply defers again — never lost, never racing. */
  private async drainDeferredSends(workerId: string): Promise<void> {
    const queue = this.deferredSends.get(workerId);
    if (!queue || queue.length === 0) return;
    this.deferredSends.delete(workerId);
    for (const [index, send] of queue.entries()) {
      if (this.crashed) {
        // A shutdown mid-drain: the remaining texts keep their slot for the next life —
        // they were promised delivery, so they are never silently dropped.
        this.deferredSends.set(workerId, queue.slice(index));
        return;
      }
      try {
        const worker = this.requireWorker(workerId);
        if (worker.state === "broken") throw new CommandError("broken_worker", `worker ${workerId} is broken`);
        await this.deliverSend(worker, send.commandId, { text: send.text, intent: "auto", images: send.images });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[sig] deferred send failed for ${workerId}: ${message}`);
        await this.emitEvent(workerId, "queue_returned", { texts: [send.text], reason: "undeliverable" });
      }
    }
  }

  /** Takes the deferred texts out (interrupt path: they ride `queue_returned`). */
  private takeDeferredSends(workerId: string): DeferredSend[] {
    const queue = this.deferredSends.get(workerId) ?? [];
    this.deferredSends.delete(workerId);
    return queue;
  }

  /** Returns the deferred texts to the steward as `queue_returned` — the run (or the
   *  worker) ended in a way that will not deliver them (stop, broken, shutdown). */
  private async flushDeferredSends(workerId: string, why: string): Promise<void> {
    const queue = this.takeDeferredSends(workerId);
    if (queue.length === 0) return;
    await this.emitEvent(workerId, "queue_returned", { texts: queue.map((s) => s.text), reason: why });
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
    if (!(this.adapterOfWorkerOrNull(worker)?.isRunning?.(workerId) ?? false)) return;
    await this.stopProcess(workerId).catch((err) => {
      console.error(`[sig] idle reclaim failed for ${workerId}:`, err);
    });
  }

  /**
   * On-demand raw history (connector-pi.md §11.4): while the process is running, increments
   * come from `get_entries{since}` over RPC; otherwise the session JSONL is parsed directly
   * along the current branch. Normalized, truncated, capped at maxBytes, cursor-addressed.
   */
  async history(workerId: string, since: string | undefined, maxBytes: number, format?: "full"): Promise<HistoryPage> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    if (format === "full") {
      // The agent's own record on this machine, whether or not its process is still running.
      let path: string | null = worker.sessionFile ?? null;
      if (worker.agent === "claude-code") {
        const cwd = worker.worktree ?? this.store.getRepo(worker.repoId)?.path;
        path = worker.sessionId && cwd ? claudeSessionPath(cwd, worker.sessionId) : null;
      }
      if (!path) throw new CommandError("no_history", "This worker has not recorded a local session yet.");
      return readFullSessionHistory(path, since, maxBytes);
    }
    const adapter = this.adapterOfWorker(worker);
    if (typeof adapter.history === "function" && adapter.isRunning?.(workerId)) {
      try {
        return await adapter.history(workerId, since, maxBytes);
      } catch (err) {
        // The process died between the isRunning check and the RPC: the run is over, so the
        // session file is now the truth — fall through instead of surfacing the race.
        if ((err as { code?: string }).code !== "not_running") throw err;
      }
    }
    if (!worker.sessionFile) {
      throw new CommandError("no_history", `worker ${workerId} has no session file to read`);
    }
    return readSessionHistory(worker.sessionFile, { since, maxBytes });
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
        this.recordSessionTail(worker.workerId); // §10 baseline for the resume's comparison
        this.scheduleAutoResume(worker.workerId, "connector_restart");
        continue;
      }
      if (!IN_FLIGHT_STATES.has(worker.state)) continue;
      try {
        await this.reconcileWorkerTail(worker);
      } catch (err) {
        console.error(`[sig] session-tail reconciliation failed for ${worker.workerId}:`, err);
      }
    }
    // Queued write workers whose runner settled or broke over the restart can start now.
    this.pumpQueuedWorkers();
  }

  private async reconcileWorkerTail(worker: WorkerRow): Promise<void> {
    // Issue #17: agents that keep their own session store (Claude Code: ~/.claude) have no
    // sessionFile to tail. With a sessionId the run had started — the crash killed it, so
    // the §9.2 resume path applies (--resume). Without one the start never completed, the
    // same verdict the empty-tail check gives pi.
    if (!worker.sessionFile) {
      if (worker.sessionId) {
        this.store.setWorkerState(worker.workerId, "lost", "restart");
        await this.emitEvent(worker.workerId, "lost", { reason: "connector_restart" });
        this.scheduleAutoResume(worker.workerId, "connector_restart");
        return;
      }
      await this.breakWorker(
        worker.workerId,
        "unknown",
        "Connector restarted during startup; the task never began. Re-dispatch it.",
        "startup_interrupted",
      );
      return;
    }
    const tail = this.inspectTailFn(worker.sessionFile);
    this.recordSessionTail(worker.workerId); // §10: adopt the crashed run's own entries before any resume
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
      // Tracked as a transition: queued sends (§6.2) drain when the resume completes, and an
      // interrupt waits it out instead of racing the relaunch.
      await this.withTransition(workerId, () => this.resumeWorker(workerId, reason, count, { commandId: `auto-${workerId}-${count}-${this.now()}` }));
    } catch (err) {
      if (err instanceof CommandError && err.code === "aborted") {
        // PR #43 review N2: a stop_process settled this worker while the resume relaunch was
        // in flight. That is the user's stop, not a resume failure — write nothing here (the
        // stop owns the row and its settled:aborted) and let it be.
        return;
      }
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
  private async resumeWorker(
    workerId: string,
    reason: string,
    count: number,
    options: { commandId?: string } = {},
  ): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    const adapter = this.adapterOfWorker(worker);
    if (worker.state === "queued") {
      // §8.2: a queued write worker has no session yet — there is nothing to resume. It
      // starts on its own when the repo's serial slot frees.
      throw new CommandError("not_started", `worker ${workerId} is queued behind another write task; it starts when that one settles`);
    }
    // §8.2 (issue #16 merge with #45): a manual resume is a continuation that must
    // re-acquire a serial repo's write slot; retriable because the holder settles on its
    // own. The automatic path never trips this — a `lost` worker holds its own slot until
    // it breaks, so no other write worker can have taken it.
    if (this.serialSlotHeldByAnother(worker)) {
      throw new CommandError(
        "slot_busy",
        `another write task holds this serial repo's single write slot; resume again once it settles`,
        true,
      );
    }
    if (adapter.isRunning?.(workerId)) {
      const commandId = options.commandId;
      if (commandId) this.expectCommandMarker(commandId, workerId);
      await adapter.resume(workerId, reason, commandId ? { commandId } : undefined);
      this.recordSessionTail(workerId);
      this.store.setWorkerState(workerId, "running");
      await this.emitEvent(workerId, "resumed", { reason, count });
      return;
    }
    const repo = this.store.getRepo(worker.repoId);
    // Review finding 5: a write worker whose worktree was explicitly cleaned up must not
    // silently resume in the owner's main checkout. (A NULL worktree alone is not the
    // signal — legacy rows never had one; only the cleanup marker counts.)
    if (
      worker.mode === "write" &&
      repo &&
      repo.writePolicy.isolation !== "in-place" &&
      !worker.worktree &&
      worker.worktreeCleanedAt
    ) {
      throw new CommandError(
        "no_worktree",
        `worker ${workerId}'s worktree was cleaned up; re-dispatch the task instead of resuming`,
      );
    }
    const cwd = worker.worktree ?? repo?.path;
    if (!cwd) throw new CommandError("startup_failed", `no worktree or repo path to resume worker ${workerId} in`);
    const lock = acquireLock(this.stateDir, workerId);
    if (!lock.ok) throw new CommandError("lock_held", `worker ${workerId} is locked by pid ${lock.pid}`, true);
    // The stop-vs-launch window opens with the lock: a stop landing anywhere past this point
    // must find `launching` set (review N2's invariant), including across the §10 pre-launch
    // check's awaits — otherwise it settles the worker while the relaunch still spawns.
    this.launching.add(workerId);
    try {
      await this.checkSessionBeforeRelaunch(worker);
      if (this.stopRequested.has(workerId)) {
        // The stop landed during the §10 check's awaits: bail before spawning, leaving the
        // stop's bookkeeping (it settled the worker) as the final word.
        throw new CommandError("aborted", "worker was stopped during resume");
      }
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      this.launching.delete(workerId);
      throw err;
    }
    const spec: StartSpec = {
      workerId,
      threadId: worker.threadId,
      cwd,
      mode: worker.mode === "readonly" ? "readonly" : "write",
      prompt: RESUME_PROMPT,
      commandId: options.commandId ?? `resume-${count}-${this.now()}`,
      onSession: (sessionFile, lastKnownEntryId) => {
        if (sessionFile) this.store.setSessionObservation(workerId, sessionFile, lastKnownEntryId);
        this.expectCommandMarker(options.commandId, workerId, sessionFile, lastKnownEntryId);
      },
      // §13: the repo's local trust applies to resumes exactly like first starts.
      approveProject: repo?.approved === true ? true : undefined,
      // The session exists (this is a resume): Claude Code resumes its UUID session
      // instead of deriving a fresh one (issue #17).
      resumeSessionId: worker.sessionId ?? undefined,
    };
    this.active.set(workerId, {
      repoId: worker.repoId,
      worktree: worker.worktree ?? undefined,
      branch: worker.branch ?? undefined,
      base: worker.base ?? undefined,
    });
    try {
      let handle: WorkerHandle;
      try {
        handle = await adapter.start(spec);
      } catch (err) {
        if (this.stopRequested.has(workerId)) throw new CommandError("aborted", "worker was stopped during resume");
        throw err;
      }
      if (this.stopRequested.has(workerId)) {
        await adapter.stopProcess(workerId).catch(() => undefined);
        throw new CommandError("aborted", "worker was stopped during resume");
      }
      this.stopRequested.delete(workerId);
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
      this.watchdog.start();
      await this.emitEvent(workerId, "resumed", { reason, count });
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      this.active.delete(workerId);
      if (err instanceof CommandError && err.code === "aborted") {
        // The stop already settled this worker (idle + settled:aborted); leave its
        // bookkeeping untouched (review finding 3, same window on the resume path).
        this.stopRequested.delete(workerId);
      }
      throw err;
    } finally {
      // N1, same invariant as launchWorker: markers never outlive their launch window.
      this.launching.delete(workerId);
      this.stopRequested.delete(workerId);
    }
  }

  /** Terminal `broken` (§5.1/§9.2): automatic recovery is over. The `settled` error event is
   * the signal the steward routes to the user (auth-class failures tell them to fix
   * credentials on the machine; everything else asks for a decision). */
  private async breakWorker(workerId: string, errorClass: ErrorClass, detail: string, lastOutcome: string): Promise<void> {
    this.watchdog.forget(workerId);
    this.runPrompts.delete(workerId);
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
    // §3 (issue #17): texts deferred past run end can never deliver on a broken worker —
    // hand them back instead of dropping them.
    await this.flushDeferredSends(workerId, "broken");
    await this.emitEvent(workerId, "settled", { outcome: "error", errorClass, lastText: detail });
    // §8.2: a broken write worker frees the repo's serial slot for the next queued one.
    this.pumpQueuedWorkers();
  }

  // --- Stall watchdog (issue #13, ADR-0001) --------------------------------------------------

  /** Live processes in lifecycle states the watchdog may declare stalled. */
  private watchdogCandidates(): WatchdogCandidate[] {
    if (this.crashed) return [];
    // Every agent's live processes (issue #17): the watchdog is agent-agnostic.
    const activity = [...this.adapters.values()].flatMap((a) => a.workerActivity?.() ?? []);
    return activity.filter(({ workerId }) => {
      const worker = this.store.getWorker(workerId);
      return worker !== null && (worker.state === "running" || worker.state === "recovering");
    });
  }

  /**
   * A confirmed stall (silent past the threshold on two cold CPU samples). Strike 1: respawn
   * in place — same worktree, same session id, the original prompt plus a continuation note.
   * Strike 2 (the respawned run stalled too): terminal `error:stall`, routed to the user by
   * the settled event. The stall detection itself rides a `progress` event out first so the
   * ledger (and the DO's own stall alarm) sees the respawn as activity.
   */
  private async handleStallStrike(workerId: string, strike: 1 | 2, why: string): Promise<void> {
    if (this.crashed) return;
    const worker = this.store.getWorker(workerId);
    if (!worker || (worker.state !== "running" && worker.state !== "recovering")) return; // run ended meanwhile
    await this.emitEvent(workerId, "progress", { phase: "tool", tool: "stall-watchdog", target: why.slice(0, 80) });
    if (strike === 1) {
      this.store.setWorkerState(workerId, "recovering", "stall");
      await this.reclaimStalledProcess(workerId); // expected exit: releases the lock, no lost/auto-resume
      try {
        // Inside withTransition (PR #46 review round 3): a send parked on `recovering` during
        // the strike window drains the moment the respawn lands — without this the user's
        // message would sit in pendingSends until the run settled hours later.
        await this.withTransition(workerId, () => this.respawnStalled(workerId, why));
      } catch (err) {
        // A stop is not a transition and can settle the run mid-respawn (idle +
        // settled:aborted); respawnStalled also aborts itself when its `recovering` was
        // consumed. The user's stop is the verdict then — never a terminal error:stall on
        // top of it (two settles for one run).
        const settled = this.store.getWorker(workerId);
        if (err instanceof CommandError && err.code === "aborted" && settled && settled.state !== "running" && settled.state !== "recovering") {
          this.watchdog.forget(workerId);
          this.runPrompts.delete(workerId);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        await this.breakWorker(workerId, "stall", `stall watchdog respawn failed: ${message}`, "error:stall");
      }
      return;
    }
    await this.reclaimStalledProcess(workerId);
    // The same stop-race guard as strike 1: if a stop settled this run while the wedged
    // process was being reclaimed, its aborted settle is the verdict — not a stall error.
    const settled = this.store.getWorker(workerId);
    if (!settled || (settled.state !== "running" && settled.state !== "recovering")) {
      this.watchdog.forget(workerId);
      this.runPrompts.delete(workerId);
      return;
    }
    await this.breakWorker(workerId, "stall", `${why}; still wedged after one automatic restart`, "error:stall");
  }

  /** The raw process reclaim the stall strikes need: close the process, sweep §9.3 orphans,
   *  release the lock — and NOTHING else. The public stopProcess (issue #16/#9) additionally
   *  settles an in-flight worker as `aborted`; for a stall respawn that settle would be a lie
   *  (the run continues in place) and for strike 2 it would race the terminal error:stall
   *  settle, so both paths bypass it. */
  private async reclaimStalledProcess(workerId: string): Promise<void> {
    this.cancelIdleReclaim(workerId);
    const timer = this.resumeTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      this.resumeTimers.delete(workerId);
    }
    const worker = this.store.getWorker(workerId);
    const owner = worker ? this.adapterOfWorkerOrNull(worker) : null;
    if (owner) await owner.stopProcess(workerId);
    else await this.stopProcessEverywhere(workerId);
    await this.cleanupOrphans(workerId);
    // The process_exit handler's releaseLock rides a microtask; release again rather than
    // race it — releaseLock on an already-removed file is a no-op.
    releaseLock(this.stateDir, workerId);
  }

  /** Relaunches a stalled worker's session with the original task plus the continue note. */
  private async respawnStalled(workerId: string, why: string): Promise<void> {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    const repo = this.store.getRepo(worker.repoId);
    const cwd = worker.worktree ?? repo?.path;
    if (!cwd) throw new CommandError("startup_failed", `no worktree or repo path to respawn worker ${workerId} in`);
    const lock = acquireLock(this.stateDir, workerId); // released by the expected process_exit above
    if (!lock.ok) throw new CommandError("lock_held", `worker ${workerId} is locked by pid ${lock.pid}`, true);
    const original = this.runPrompts.get(workerId) ?? RESUME_PROMPT;
    const spec: StartSpec = {
      workerId,
      threadId: worker.threadId,
      cwd,
      mode: worker.mode === "readonly" ? "readonly" : "write",
      prompt: `${original}\n\n${stallContinueNote(why)}`,
      commandId: `stall-respawn-${this.now()}`,
      // §13: reproduce the original launch's trust mode — the respawn is the same run.
      approveProject: repo?.approved === true ? true : undefined,
      // Same session as the stalled run (issue #17: Claude Code resumes its UUID).
      resumeSessionId: worker.sessionId ?? undefined,
    };
    this.active.set(workerId, {
      repoId: worker.repoId,
      worktree: worker.worktree ?? undefined,
      branch: worker.branch ?? undefined,
      base: worker.base ?? undefined,
    });
    try {
      const handle = await this.adapterOfWorker(worker).start(spec);
      // A stop is not a transition and can land while adapter.start is in flight: it settles
      // the worker (idle + settled:aborted) and its verdict must survive (the resume path
      // applies the same check). If this strike's `recovering` is gone the stop won the race
      // — reclaim the just-spawned process, emit nothing, let the caller honor the stop
      // (PR #46 review round 3, finding 2b).
      const current = this.store.getWorker(workerId);
      if (!current || current.state !== "recovering") {
        await this.adapterOfWorker(worker).stopProcess(workerId).catch(() => undefined); // expected exit: no settle
        throw new CommandError("aborted", `worker ${workerId} was stopped during the stall respawn`);
      }
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
      this.watchdog.start();
      await this.emitEvent(workerId, "resumed", { reason: "stall", count: 1 });
    } catch (err) {
      releaseLock(this.stateDir, workerId);
      this.active.delete(workerId);
      throw err;
    }
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
    // Every agent's live processes (issue #17): orphan snapshots are agent-agnostic.
    const pids = [...this.adapters.values()].flatMap((a) => a.workerPids?.() ?? []);
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

  /** Graceful shutdown: stop background loops and take the manager out of service — no
   * further queue pumps, launches, or event handling (a late void-fired continuation must
   * never spawn work after the caller closed the store). Worker processes are left to the
   * OS — on connector exit stdin closes and pi disposes of its tool tree itself (§9.1). */
  stop(): void {
    this.crashed = true;
    this.stopSnapshotLoop();
    this.watchdog.stop();
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
    this.watchdog.stop();
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const adapter of this.adapters.values()) adapter.simulateCrash?.();
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
        this.recordSessionTail(event.workerId); // §10 baseline: everything up to this settle is ours
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
        this.watchdog.forget(event.workerId);
        this.runPrompts.delete(event.workerId);
        if (event.outcome === "error" && event.errorClass === "transient") {
          // §5.2/§9.2: one automatic resume for transient-class errors (backoff + budget apply).
          this.scheduleAutoResume(event.workerId, "error:transient");
        } else {
          // §8.2: a settled write worker frees the repo's serial slot. (A transient error's
          // resume keeps the slot — the run is still in flight from the queue's viewpoint.)
          this.pumpQueuedWorkers();
        }
        // §3 (issue #17): a no-steer agent's deferred sends now have an idle worker to
        // deliver into — the promised after-run-end prompt.
        await this.drainDeferredSends(event.workerId);
        return;
      }
      case "process_exit": {
        this.recordSessionTail(event.workerId); // §10: adopt whatever the process wrote before dying
        await this.emitEvent(event.workerId, "process_exit", { code: event.code, signal: event.signal });
        releaseLock(this.stateDir, event.workerId);
        this.throttles.delete(event.workerId);
        this.active.delete(event.workerId);
        this.cancelIdleReclaim(event.workerId); // the process is gone; nothing to reclaim
        // Deliberately NOT forgetting watchdog strikes here: an expected exit is often the
        // stall respawn's own stop (forgetting would reset strike 2 to strike 1 and loop
        // forever), and after an unexpected exit + auto-resume the same task keeps its
        // strikes (spike semantics). Strikes reset when the RUN ends: settled / broken /
        // a fresh start_worker.
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

  /** §10: refresh the worker's external-activity baseline from the session tail. Called at
   *  every settle and process exit — anything appended after this point was not us. */
  private recordSessionTail(workerId: string): void {
    const worker = this.store.getWorker(workerId);
    if (!worker?.sessionFile) return;
    const observation = observeSession(worker.sessionFile);
    if (observation.lastEntryId) this.store.setSessionObservation(workerId, worker.sessionFile, observation.lastEntryId);
  }

  /** Hands the event to the transport's persist-and-send (§11.3: EventLog seq first, then wire). */
  private async emitEvent(workerId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    this.emit?.(workerId, { type, ...clean });
  }

  /** §6.3 write-ahead: record, BEFORE anything is written to pi, that this command's id must
   *  appear in the session (as the ADR-0001 custom entry) — plus the session file and the
   *  tail entry id a later recovery proves absence after. Arming the expectation here is
   *  what makes a crash mid-`sending` decidable instead of ambiguous. */
  private expectCommandMarker(
    commandId: string | undefined,
    workerId: string,
    sessionFile?: string | null,
    afterEntryId?: string | null,
  ): void {
    if (!commandId) return; // internal launches (auto-resume) have no steward command
    const worker = this.store.getWorker(workerId);
    const file = sessionFile ?? worker?.sessionFile ?? null;
    // The tail id RIGHT NOW: recovery looks for the marker only after this entry, so a
    // marker from an earlier delivery of the same commandId (a redelivery) never counts.
    const after = afterEntryId ?? (file ? observeSession(file).lastEntryId : worker?.lastKnownEntryId ?? null);
    this.onExpectMarker?.(commandId, { sessionFile: file, afterEntryId: after });
  }

  /** §10 pre-launch check: refuse when another live process is using the session, and emit
   *  `external_activity` (count, timestamps, coarse summary) when the tail moved past the
   *  last entry the connector recorded. Runs under the worker's lock; the launch proceeds
   *  only when the session is free. */
  private async checkSessionBeforeRelaunch(worker: WorkerRow): Promise<void> {
    if (!worker.sessionFile) return;
    // Every agent's live pids (issue #17): the holders check is agent-agnostic.
    const live = [...this.adapters.values()].flatMap((a) => a.workerPids?.() ?? []).map((p) => p.pid);
    const holders = await this.findSessionHoldersFn(worker.workerId, worker.sessionFile, live);
    if (holders.length > 0) {
      throw new CommandError(
        "session_in_use",
        `session ${worker.sessionId ?? worker.workerId} is being used by another live pi process ` +
          `(pid ${holders[0]!.pid}, args: ${holders[0]!.args.slice(0, 160)}); ` +
          `the owner may be working on this machine right now`,
        true,
      );
    }
    const observation = observeSession(worker.sessionFile);
    if (!observation.readable) return; // nothing to compare against; the launch itself will fail or adopt
    const activity = externalActivity(observation, worker.lastKnownEntryId);
    if (!activity) return;
    if (!worker.lastKnownEntryId) {
      // No baseline yet (a pre-#15 row): adopt the tail silently rather than invent activity.
      this.store.setSessionObservation(worker.workerId, worker.sessionFile, observation.lastEntryId);
      return;
    }
    if (activity.lastTimestamp !== null) {
      const last = Date.parse(activity.lastTimestamp);
      if (Number.isFinite(last) && Math.abs(this.now() - last) <= this.sessionInUseWindowMs) {
        // Fresh writes by someone else: treat as in-use too — the writer is alive right now.
        throw new CommandError(
          "session_in_use",
          `session ${worker.sessionId ?? worker.workerId} received new entries moments ago; ` +
            `another pi process appears to be using it right now`,
          true,
        );
      }
    }
    await this.emitEvent(worker.workerId, "external_activity", {
      entries: activity.entryCount,
      firstAt: activity.firstTimestamp,
      lastAt: activity.lastTimestamp,
      summary: activity.summary,
      changedFiles: activity.changedFiles,
      partial: activity.partial || undefined,
    });
    this.store.setSessionObservation(worker.workerId, worker.sessionFile, observation.lastEntryId);
  }

  private requireWorker(workerId: string): WorkerRow {
    const worker = this.store.getWorker(workerId);
    if (!worker) throw new CommandError("not_found", `worker ${workerId} is unknown on this machine`);
    return worker;
  }
}

/** Does this task get an isolated `git worktree`, or run directly in `repo.path`?
 *  Write tasks follow the repo's configured write policy — `isolation !== "in-place"` is
 *  always false for a plain (non-Git) repo by construction (a plain repo's `writePolicy`
 *  can only ever be `"in-place"`), so no separate capability check is needed for that half.
 *  Readonly tasks with a relay `base` always isolate into a detached-HEAD worktree (diffing
 *  against a base commit needs a real Git ancestry — there is no in-place equivalent), and
 *  that genuinely requires a Git-backed repo, checked explicitly here since the type of
 *  `args.base` alone can't express it. */
function useWorktreeFor(repo: RegisteredRepo, args: Pick<StartWorkerArgs, "mode" | "base">): boolean {
  if (args.mode === "readonly") {
    if (!args.base) return false;
    if (repo.capability.kind !== "git") {
      throw new CommandError(
        "unsupported_base",
        `'${repo.name}' is a plain workspace (no Git); a relay base requires Git ancestry to review, which this directory doesn't have`,
      );
    }
    return true;
  }
  return repo.writePolicy.isolation !== "in-place";
}

function commandWorkerId(args: Record<string, unknown>, envelopeWorkerId: string | undefined, kind: string): string {
  const workerId = typeof args.workerId === "string" && args.workerId.length > 0 ? args.workerId : envelopeWorkerId;
  if (!workerId) throw new CommandError("bad_request", `${kind} requires a workerId`);
  return workerId;
}

/** §8.2/§13 (issue #16): local-only settings arriving inside a command are rejected before
 * anything runs — even a fully authenticated steward must not flip approveProject or the
 * workspace mode from afar; the owner sets them with `sig repo-config` on the machine. */
function rejectLocalOnlyArgs(args: Record<string, unknown>): void {
  for (const key of LOCAL_ONLY_ARGS) {
    if (key in args) {
      throw new CommandError(
        "local_only_setting",
        `'${key}' is a connector-local setting; set it on the machine with 'sig repo-config' (§13)`,
      );
    }
  }
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
  if (typeof args.agent === "string" && args.agent.length > 0) parsed.agent = args.agent;
  if (typeof args.base === "string" && args.base.length > 0) parsed.base = args.base;
  if (typeof args.model === "string" && args.model.length > 0) parsed.model = args.model;
  return parsed;
}
