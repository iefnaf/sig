// The memory module's ledger half (issue #5, steward.md §2): every sh_* table belongs to this
// file and callers reach it only through the returned interface — never with raw SQL. The
// event reducer (§5.1-5.3) is deterministic, runs in one transaction, and recomputes Thread
// derived state (`running / waiting_you / idle`) plus unread after every change. Notes,
// retrieval, and the situation brief's character budget arrive with M3; the interface below
// is the M1 subset, shaped so those slot in without a rewrite.
import { ulid } from "@shepherd/protocol";
import type { HelloMessage } from "@shepherd/protocol";
import { eventWakeText, queueReturnedWakeText } from "./wake-text.ts";

/** Tagged-template SQL over the DO's SQLite (same shape schema.ts migrations use). */
export type LedgerSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** Thread summaries are capped (steward.md §2.6). */
export const MAX_THREAD_SUMMARY = 600;
/** The wake merge window (steward.md §5.1/§5.4): events within it become one steward input. */
export const WAKE_MERGE_MS = 3_000;

/** Runs a synchronous closure atomically (`ctx.storage.transactionSync`, steward.md §1). */
export interface LedgerDeps {
  sql: LedgerSql;
  tx: <T>(fn: () => T) => T;
  now?: () => number;
}

// ---- domain shapes (subset of steward.md §2.2 columns) -----------------------------------------

export type ThreadState = "running" | "waiting_you" | "idle";
/** Worker states that keep a Thread `running` (steward.md §5.2); lost/broken do not count. */
export const ACTIVE_WORKER_STATES = ["starting", "running", "recovering"] as const;

export interface ThreadRow {
  threadId: string;
  title: string;
  goal: string | null;
  summary: string | null;
  summaryAt: number | null;
  state: ThreadState;
  unread: boolean;
  lastMachine: string | null;
  lastActivityAt: number;
  archived: boolean;
  createdFromMsg: string | null;
  createdAt: number;
}

export interface WorkerRow {
  workerId: string;
  threadId: string;
  deviceId: string;
  repoId: string | null;
  agent: string;
  mode: string;
  state: string;
  sessionId: string | null;
  branch: string | null;
  cmdId: string | null;
  lastOutcome: string | null;
  lastEventAt: number | null;
  lastProgress: string | null;
  createdAt: number;
}

export interface ReportRow {
  workerId: string;
  seq: number;
  threadId: string;
  status: "done" | "blocked" | "needs_decision";
  summary: string;
  changes: string[] | null;
  decisions: string[] | null;
  leftovers: string[] | null;
  tests: { ran: boolean; passed?: boolean; note?: string } | null;
  question: string | null;
  next: string | null;
  git: GitFacts | null;
}

/** Git facts merged into the report event by the connector (connector-pi.md §7.2). */
export interface GitFacts {
  branch: string;
  base: string;
  ahead: number;
  dirty: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  pushed: boolean;
}

export interface QuestionRow {
  qid: string;
  threadId: string;
  workerId: string | null;
  text: string;
  status: "open" | "answered";
  askedAt: number;
  answeredAt: number | null;
}

export interface TimelineRow {
  id: number;
  threadId: string;
  ts: number;
  kind: string;
  text: string;
}

export interface MachineRow {
  deviceId: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  agents: string[];
  maxWorkers: number;
  /** The connector process generation (protocol §6.1): changes on every connector restart. */
  bootId: string | null;
}

/** A notification intent persisted by the reducer (steward.md §5.1 step 4). */
export interface NotifyRow {
  id: number;
  dedupeKey: string;
  kind: "done_report" | "attention_report" | "failure_push";
  threadId: string;
  workerId: string | null;
}

/** A durable wake_request (steward.md §5.1 step 4): one future steward input. */
export interface WakeRow {
  id: number;
  operationId: string;
  kind: "event" | "routine" | "followup";
  dedupeKey: string;
  text: string;
  priority: "normal" | "high";
  status: "pending" | "merged" | "submitted";
  dueAt: number;
  mergedInto: number | null;
  createdAt: number;
  submittedAt: number | null;
}

/** One steward run (steward.md §6.3): a submitted input and how its outcome is handled. */
export interface RunRow {
  operationId: string;
  kind: "user" | "event" | "routine" | "followup";
  replyTo: string | null;
  channel: string | null;
  routedThreadId: string | null;
  text: string;
  status: "open" | "settled";
  resultStatus: string | null;
  resultReason: string | null;
  resultText: string | null;
  replyOutboundId: string | null;
  /** The run already produced user-facing output (notify_user/ask_user) — an empty final
   *  text is then legitimate, not a failure (review #9). */
  notified: boolean;
  createdAt: number;
  settledAt: number | null;
}

// ---- web read model (steward.md §10: pages are served from the memory module's views) -------------

/** L2 Timeline view: thread header, its summary events, its workers with machine names. */
export interface TimelineView {
  thread: ThreadRow;
  entries: TimelineRow[];
  workers: Array<WorkerRow & { machineName: string }>;
  openQuestion: QuestionRow | null;
}

/** L1 Thread-list row: the thread plus the situation bits the index page shows (spec §7.4). */
export interface ThreadListEntry {
  thread: ThreadRow;
  lastWorker: (WorkerRow & { machineName: string }) | null;
  workerCount: number;
}

export interface NewThreadInput {
  title: string;
  goal: string;
  createdFromMsg?: string;
  repoIds?: string[];
}

export interface NewWorkerInput {
  workerId: string;
  threadId: string;
  deviceId: string;
  repoId?: string;
  agent: string;
  mode: string;
  cmdId?: string;
}

/** One event row lifted out of the protocol layer's `event_inbox`. */
interface InboxEventRow {
  workerId: string;
  seq: number;
  payload: string;
}

/** What a delivery pass needs to send one row, plus the claim token that proves ownership. */
export interface OutboundDeliveryRow {
  id: string;
  kind: string;
  channel: string;
  receiveId: string;
  attempts: number;
  payload: string;
  threadId: string | null;
  claim: string;
}

const jsonOrNull = <T>(value: string | null | undefined): T | null => {
  if (value === null || value === undefined || value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

const viewMachine = (r: Record<string, unknown>): MachineRow => ({
  deviceId: r.deviceId as string,
  name: r.name as string,
  online: !!r.online,
  lastSeen: (r.lastSeen as number | null) ?? null,
  agents: jsonOrNull<string[]>(r.agents as string | null) ?? [],
  maxWorkers: (r.maxWorkers as number | null) ?? 1,
  bootId: (r.bootId as string | null) ?? null,
});

const viewWorker = (r: Record<string, unknown>): WorkerRow => ({
  workerId: r.workerId as string,
  threadId: r.threadId as string,
  deviceId: r.deviceId as string,
  repoId: (r.repoId as string | null) ?? null,
  agent: r.agent as string,
  mode: r.mode as string,
  state: r.state as string,
  sessionId: (r.sessionId as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  cmdId: (r.cmdId as string | null) ?? null,
  lastOutcome: (r.lastOutcome as string | null) ?? null,
  lastEventAt: (r.lastEventAt as number | null) ?? null,
  lastProgress: (r.lastProgress as string | null) ?? null,
  createdAt: r.createdAt as number,
});

const viewReport = (r: Record<string, unknown>): ReportRow => ({
  workerId: r.workerId as string,
  seq: r.seq as number,
  threadId: r.threadId as string,
  status: r.status as ReportRow["status"],
  summary: r.summary as string,
  changes: jsonOrNull<string[]>(r.changes as string | null),
  decisions: jsonOrNull<string[]>(r.decisions as string | null),
  leftovers: jsonOrNull<string[]>(r.leftovers as string | null),
  tests: jsonOrNull<ReportRow["tests"]>(r.tests as string | null),
  question: (r.question as string | null) ?? null,
  next: (r.next as string | null) ?? null,
  git: jsonOrNull<GitFacts>(r.git as string | null),
});

const viewQuestion = (r: Record<string, unknown>): QuestionRow => ({
  qid: r.qid as string,
  threadId: r.threadId as string,
  workerId: (r.workerId as string | null) ?? null,
  text: r.text as string,
  status: r.status as QuestionRow["status"],
  askedAt: r.askedAt as number,
  answeredAt: (r.answeredAt as number | null) ?? null,
});

export function createLedger(deps: LedgerDeps) {
  const { sql, tx } = deps;
  const now = deps.now ?? Date.now;

  const threadFromRow = (r: Record<string, unknown>): ThreadRow => ({
    threadId: r.threadId as string,
    title: r.title as string,
    goal: (r.goal as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    summaryAt: (r.summaryAt as number | null) ?? null,
    state: r.state as ThreadState,
    unread: !!r.unread,
    lastMachine: (r.lastMachine as string | null) ?? null,
    lastActivityAt: r.lastActivityAt as number,
    archived: !!r.archived,
    createdFromMsg: (r.createdFromMsg as string | null) ?? null,
    createdAt: r.createdAt as number,
  });

  // ---- machines / repos (hello is the source of truth, protocol §6.1) --------------------------

  const machines = {
    /** Upserts machine facts + the full repo snapshot from a hello, and marks it online. */
    upsertFromHello(hello: HelloMessage): void {
      const ts = now();
      sql`
        INSERT INTO sh_machine (deviceId, name, online, lastSeen, agents, maxWorkers, bootId)
        VALUES (${hello.deviceId}, ${hello.machine.name}, 1, ${ts}, ${JSON.stringify(hello.agents.map((a) => a.kind))}, ${hello.limits.maxWorkers}, ${hello.bootId})
        ON CONFLICT (deviceId) DO UPDATE SET
          name = excluded.name, online = 1, lastSeen = excluded.lastSeen,
          agents = excluded.agents, maxWorkers = excluded.maxWorkers, bootId = excluded.bootId
      `;
      // hello.repos is a full snapshot: replace this machine's rows so removals stick.
      sql`DELETE FROM sh_repo WHERE deviceId = ${hello.deviceId}`;
      for (const repo of hello.repos) {
        sql`
          INSERT OR REPLACE INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
          VALUES (${repo.repoId}, ${hello.deviceId}, ${repo.name}, ${repo.path}, ${repo.defaultBranch}, ${repo.remote}, ${ts})
        `;
      }
    },
    /** Online derives from live connections only (issue #5): onConnect marks, onClose clears. */
    setOnline(deviceId: string, online: boolean, fallbackName?: string): void {
      sql`
        INSERT INTO sh_machine (deviceId, name, online, lastSeen)
        VALUES (${deviceId}, ${fallbackName ?? deviceId}, ${online ? 1 : 0}, ${now()})
        ON CONFLICT (deviceId) DO UPDATE SET online = ${online ? 1 : 0}, lastSeen = ${now()}
      `;
    },
    get(deviceId: string): MachineRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_machine WHERE deviceId = ${deviceId}`[0];
      return row ? viewMachine(row) : null;
    },
    list(): MachineRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_machine ORDER BY deviceId`.map(viewMachine);
    },
    /** Workers still consuming a slot (free-slot tiebreak, ADR-0001 decision 6). */
    runningCount(deviceId: string): number {
      return sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM sh_worker
        WHERE deviceId = ${deviceId} AND state IN ('starting', 'running', 'recovering')
      `[0]!.n;
    },
  };

  const repos = {
    /** Machines that have a repo matching `ref` by name or exact repoId (routing signal 2). */
    machinesHaving(ref: string): { deviceId: string; repoId: string; repoName: string }[] {
      return sql<{ deviceId: string; repoId: string; repoName: string }>`
        SELECT deviceId, repoId, name AS repoName FROM sh_repo
        WHERE name = ${ref} OR repoId = ${ref} OR path = ${ref}
        ORDER BY repoId
      `;
    },
  };

  // ---- threads / workers -----------------------------------------------------------------------

  const threads = {
    create(input: NewThreadInput): ThreadRow {
      const threadId = `t_${ulid()}`;
      const ts = now();
      sql`
        INSERT INTO sh_thread (threadId, title, goal, state, unread, lastActivityAt, createdFromMsg, createdAt)
        VALUES (${threadId}, ${input.title}, ${input.goal}, 'idle', 0, ${ts}, ${input.createdFromMsg ?? null}, ${ts})
      `;
      for (const repoId of input.repoIds ?? []) {
        sql`INSERT OR IGNORE INTO sh_thread_repo (threadId, repoId) VALUES (${threadId}, ${repoId})`;
      }
      return threads.get(threadId)!;
    },
    get(threadId: string): ThreadRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_thread WHERE threadId = ${threadId}`[0];
      return row ? threadFromRow(row) : null;
    },
    list(): ThreadRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC, threadId
      `.map(threadFromRow);
    },
    repoIds(threadId: string): string[] {
      return sql<{ repoId: string }>`SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId}`.map((r) => r.repoId);
    },
    /** Bug 4: dispatch affinity — the machine the Thread last ran on. */
    setLastMachine(threadId: string, deviceId: string): void {
      sql`UPDATE sh_thread SET lastMachine = ${deviceId}, lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    /** Reply or card click on the Thread's message = the user has seen it (§6.5). */
    markRead(threadId: string): void {
      sql`UPDATE sh_thread SET unread = 0 WHERE threadId = ${threadId}`;
    },
    /** The steward's bookkeeping update (§2.6): summaries capped at 600 characters. */
    update(threadId: string, patch: { title?: string; goal?: string; summary?: string }): boolean {
      if (patch.summary !== undefined && patch.summary.length > MAX_THREAD_SUMMARY) return false;
      const before = sql<ThreadRow>`SELECT * FROM sh_thread WHERE threadId = ${threadId}`[0];
      if (!before) return false;
      sql`
        UPDATE sh_thread SET
          title = COALESCE(${patch.title ?? null}, title),
          goal = COALESCE(${patch.goal ?? null}, goal),
          summary = COALESCE(${patch.summary ?? null}, summary),
          summaryAt = CASE WHEN ${patch.summary ?? null} IS NULL THEN summaryAt ELSE ${now()} END
        WHERE threadId = ${threadId}
      `;
      return true;
    },
  };

  const workers = {
    register(input: NewWorkerInput): WorkerRow {
      const ts = now();
      sql`
        INSERT INTO sh_worker (workerId, threadId, deviceId, repoId, agent, mode, state, cmdId, createdAt, updatedAt)
        VALUES (${input.workerId}, ${input.threadId}, ${input.deviceId}, ${input.repoId ?? null},
                ${input.agent}, ${input.mode}, 'starting', ${input.cmdId ?? null}, ${ts}, ${ts})
      `;
      return workers.get(input.workerId)!;
    },
    get(workerId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_worker WHERE workerId = ${workerId}`[0];
      return row ? viewWorker(row) : null;
    },
    listByThread(threadId: string): WorkerRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_worker WHERE threadId = ${threadId} ORDER BY createdAt, workerId
      `.map(viewWorker);
    },
    /** The Thread's most recent worker — continuation target and relay-base source (spec §5.3). */
    latestOnThread(threadId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_worker WHERE threadId = ${threadId} ORDER BY createdAt DESC, workerId DESC LIMIT 1
      `[0];
      return row ? viewWorker(row) : null;
    },
    reportsForWorker(workerId: string): ReportRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE workerId = ${workerId} ORDER BY seq
      `.map(viewReport);
    },
    /** Backfills the start_worker cmdId once the command exists (registration precedes it). */
    setCmdId(workerId: string, cmdId: string): void {
      sql`UPDATE sh_worker SET cmdId = ${cmdId}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
    },

    /**
     * Reconciles this device's workers against the hello.workers snapshot (issue #12,
     * connector-pi.md §9.1 step 4 / protocol §6.1): the backstop for states the event stream
     * never delivered (events lost beyond the connector's retention, or never emitted).
     *
     * Gated per worker on `lastSeq <= processedUpTo`: while events are still in flight the
     * stream is authoritative and reconciliation must not write under it. Transitions land
     * on the timeline but NEVER push — lost/resumed are facts, not interruptions of the
     * user's day (spec §9: “lost contact, not failed”). Idempotent by construction: once the
     * ledger matches the snapshot, later hellos take no branch.
     */
    reconcileFromSnapshot(deviceId: string, snapshots: HelloMessage["workers"]): void {
      const rows = sql<{ workerId: string; threadId: string; state: string }>`
        SELECT workerId, threadId, state FROM sh_worker WHERE deviceId = ${deviceId}
      `;
      for (const worker of rows) {
        const snap = snapshots.find((s) => s.workerId === worker.workerId);
        if (!snap) continue; // not this deployment's business (pruned / other device)
        const processed =
          sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${worker.workerId}`[0]
            ?.processedUpTo ?? 0;
        if (snap.lastSeq > processed) continue; // the event stream is still telling the story
        const ledgerActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state);
        const snapActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(snap.state);
        if (ledgerActive && !snapActive) {
          sql`UPDATE sh_worker SET state = ${snap.state}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          timeline.add(
            worker.threadId,
            snap.state === "lost" ? "lost" : "note",
            snap.state === "lost"
              ? "失去联系（连接器重启后对账）"
              : snap.state === "broken"
                ? "自动恢复未成功（连接器对账）"
                : "运行已结束（连接器重启后对账）",
            { workerId: worker.workerId, reconciled: true },
          );
          recomputeThreadState(worker.threadId);
        } else if (worker.state === "lost" && snapActive) {
          sql`UPDATE sh_worker SET state = ${snap.state}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          timeline.add(worker.threadId, "resumed", "已恢复运行（连接器重启后对账）", {
            workerId: worker.workerId,
            reconciled: true,
          });
          recomputeThreadState(worker.threadId);
        } else if (worker.state === "lost" && (snap.state === "broken" || snap.state === "idle")) {
          sql`UPDATE sh_worker SET state = ${snap.state}, updatedAt = ${now()} WHERE workerId = ${worker.workerId}`;
          timeline.add(
            worker.threadId,
            "note",
            snap.state === "broken" ? "自动恢复未成功（对账），需要你决定下一步" : "运行已结束（对账）",
            { workerId: worker.workerId, reconciled: true },
          );
          recomputeThreadState(worker.threadId);
        }
      }
    },

    /**
     * A start_worker the connector rejected or that failed (cmd_ack rejected / cmd_result
     * ok:false). Marks the worker broken, records it on the timeline, and queues a failure
     * push — deterministic, idempotent (duplicate cmd_results re-settle the same command).
     */
    markStartFailed(workerId: string, cmdId: string, reason: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.state === "broken") return false;
      sql`
        UPDATE sh_worker SET state = 'broken', lastOutcome = ${`start_failed:${reason}`}, updatedAt = ${now()}
        WHERE workerId = ${workerId}
      `;
      timeline.add(worker.threadId, "note", `派发失败（${reason}）`, { workerId, cmdId });
      sql`UPDATE sh_thread SET unread = 1, lastActivityAt = ${now()} WHERE threadId = ${worker.threadId}`;
      notifications.queue(`start_failed:${cmdId}`, "failure_push", worker.threadId, workerId);
      recomputeThreadState(worker.threadId);
      return true;
    },
  };

  const reports = {
    latestForWorker(workerId: string): ReportRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE workerId = ${workerId} ORDER BY seq DESC LIMIT 1
      `[0];
      return row ? viewReport(row) : null;
    },
  };

  const questions = {
    openForThread(threadId: string): QuestionRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE threadId = ${threadId} AND status = 'open'
        ORDER BY askedAt DESC LIMIT 1
      `[0];
      return row ? viewQuestion(row) : null;
    },
    /** A fresh dispatch supersedes what the Thread was waiting on (the user moved on). */
    closeOpen(threadId: string, reason: string): void {
      sql`
        UPDATE sh_question SET status = 'answered', answeredAt = ${now()}
        WHERE threadId = ${threadId} AND status = 'open'
      `;
      if (sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0) {
        timeline.add(threadId, "note", `问题已关闭：${reason}`, null);
        recomputeThreadState(threadId);
      }
    },
  };

  const timeline = {
    add(threadId: string, kind: string, text: string, refs: Record<string, unknown> | null): void {
      sql`
        INSERT INTO sh_timeline (threadId, ts, kind, text, refs)
        VALUES (${threadId}, ${now()}, ${kind}, ${text}, ${refs ? JSON.stringify(refs) : null})
      `;
      sql`UPDATE sh_thread SET lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    list(threadId: string): TimelineRow[] {
      return sql<TimelineRow>`SELECT id, threadId, ts, kind, text FROM sh_timeline WHERE threadId = ${threadId} ORDER BY id`;
    },
  };

  // ---- notification intents (§5.1 step 4) --------------------------------------------------------

  const notifications = {
    /** INSERT OR IGNORE on dedupeKey: the reducer transaction may be re-entered after a crash. */
    queue(dedupeKey: string, kind: NotifyRow["kind"], threadId: string, workerId: string | null): void {
      sql`
        INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, createdAt)
        VALUES (${dedupeKey}, ${kind}, ${threadId}, ${workerId}, ${now()})
      `;
    },
    pending(): NotifyRow[] {
      return sql<NotifyRow>`SELECT id, dedupeKey, kind, threadId, workerId FROM sh_notify WHERE sentAt IS NULL ORDER BY id`;
    },
    markSent(id: number): void {
      sql`UPDATE sh_notify SET sentAt = ${now()} WHERE id = ${id} AND sentAt IS NULL`;
    },
  };

  // ---- outbound queue rows (sh_outbound is ledger-owned; delivery policy lives in steward.ts)

  const outbound = {
    enqueue(input: {
      kind: "text" | "card";
      to: string;
      threadId?: string | null;
      text?: string;
      card?: unknown;
      urgency?: "push" | "quiet";
      /** Stable dedupe key (review #6): same id → same row (INSERT OR IGNORE), never a second
       *  message; the id doubles as the provider-side uuid. Omitted: a fresh one-of message. */
      id?: string;
    }): string {
      if (input.id !== undefined) {
        sql`
          INSERT OR IGNORE INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
          VALUES (${input.id}, 'feishu', ${input.kind}, ${input.to}, ${input.threadId ?? null},
                  ${JSON.stringify({ text: input.text, card: input.card })}, ${input.urgency ?? "quiet"}, 'queued', 0, ${now()}, ${now()})
        `;
        return input.id;
      }
      const id = ulid(); // stable across retries; doubles as the provider-side uuid
      sql`
        INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
        VALUES (${id}, 'feishu', ${input.kind}, ${input.to}, ${input.threadId ?? null},
                ${JSON.stringify({ text: input.text, card: input.card })}, ${input.urgency ?? "quiet"}, 'queued', 0, ${now()}, ${now()})
      `;
      return id;
    },
    /** §3.1 signal 1: reply-to / card-callback routing, never data stuffed into the card. */
    threadIdForProviderMsg(providerMsgId: string): string | null {
      return (
        sql<{ threadId: string }>`
          SELECT threadId FROM sh_outbound WHERE providerMsgId = ${providerMsgId} AND threadId IS NOT NULL
        `[0]?.threadId ?? null
      );
    },
    row(id: string): Record<string, unknown> | null {
      return sql<Record<string, unknown>>`SELECT * FROM sh_outbound WHERE id = ${id}`[0] ?? null;
    },
    rows(limit: number): Record<string, unknown>[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_outbound ORDER BY createdAt, id LIMIT ${limit}`;
    },

    // The rest are the delivery pass's state transitions on the same table (claims, retry
    // bookkeeping) — ledger-owned SQL so no caller ever writes sh_outbound by hand.

    /** Rows whose delivery pass died mid-send (claim expired): back to queued. */
    reclaimExpiredClaims(nowMs: number): void {
      sql`UPDATE sh_outbound SET status = 'queued' WHERE status = 'sending' AND claimExpiresAt <= ${nowMs}`;
    },
    dueIds(nowMs: number, batch: number): string[] {
      return sql<{ id: string }>`
        SELECT id FROM sh_outbound WHERE status = 'queued' AND nextAttemptAt <= ${nowMs}
        ORDER BY createdAt, id LIMIT ${batch}
      `.map((row) => row.id);
    },
    /** The claim (spike bug 1): one conditional UPDATE hands a row to exactly one pass. */
    claimForDelivery(id: string, nowMs: number, claimMs: number): OutboundDeliveryRow | null {
      const claim = crypto.randomUUID();
      sql`
        UPDATE sh_outbound SET status = 'sending', claimToken = ${claim}, claimExpiresAt = ${nowMs + claimMs}
        WHERE id = ${id} AND (status = 'queued' OR (status = 'sending' AND claimExpiresAt <= ${nowMs}))
      `;
      const row = sql<Omit<OutboundDeliveryRow, "claim">>`
        SELECT id, kind, channel, receiveId, attempts, payload, threadId
        FROM sh_outbound WHERE id = ${id} AND claimToken = ${claim}
      `[0];
      return row ? { ...row, claim } : null;
    },
    stillOwns(id: string, claim: string): boolean {
      return sql<{ claimToken: string | null }>`SELECT claimToken FROM sh_outbound WHERE id = ${id}`[0]?.claimToken === claim;
    },
    settleSent(id: string, claim: string, providerMsgId: string, nowMs: number): void {
      if (!outbound.stillOwns(id, claim)) return;
      sql`
        UPDATE sh_outbound SET status = 'sent', providerMsgId = ${providerMsgId}, sentAt = ${nowMs},
                               attempts = attempts + 1, claimToken = NULL, claimExpiresAt = NULL, lastError = NULL
        WHERE id = ${id}
      `;
    },
    /** `nextAttemptAt: null` settles the row permanently as failed. */
    settleFailure(id: string, claim: string, attempts: number, error: string, nextAttemptAt: number | null, nowMs: number): void {
      if (!outbound.stillOwns(id, claim)) return;
      if (nextAttemptAt === null) {
        sql`
          UPDATE sh_outbound SET status = 'failed', attempts = ${attempts}, lastError = ${error},
                                 claimToken = NULL, claimExpiresAt = NULL
          WHERE id = ${id}
        `;
        return;
      }
      sql`
        UPDATE sh_outbound SET status = 'queued', attempts = ${attempts}, nextAttemptAt = ${nextAttemptAt},
                               lastError = ${error}, claimToken = NULL, claimExpiresAt = NULL
        WHERE id = ${id}
      `;
    },
    /** Earliest moment the delivery alarm should fire again, or null when nothing is pending. */
    nextWake(nowMs: number): number | null {
      const nextDue = sql<{ at: number | null }>`
        SELECT MIN(nextAttemptAt) AS at FROM sh_outbound WHERE status = 'queued'
      `[0]?.at ?? null;
      const nextReclaim = sql<{ at: number | null }>`
        SELECT MIN(claimExpiresAt) AS at FROM sh_outbound WHERE status = 'sending'
      `[0]?.at ?? null;
      const candidates = [nextDue, nextReclaim].filter((v): v is number => v !== null);
      return candidates.length === 0 ? null : Math.min(...candidates);
    },
  };

  // ---- steward runs and wake_requests (steward.md §5.1 step 4, §6.3) --------------------------

  /** `mergeMs` is the 3-second merge window (§5.4); rows merge into a still-pending wake of
   *  the same kind without extending its dueAt, so wake latency stays bounded. */
  const wakes = {
    queue(kind: WakeRow["kind"], dedupeKey: string, text: string, opts: { priority?: WakeRow["priority"]; mergeMs?: number } = {}): void {
      const mergeMs = opts.mergeMs ?? WAKE_MERGE_MS;
      const ts = now();
      const open = sql<{ id: number; text: string }>`
        SELECT id, text FROM sh_wake WHERE kind = ${kind} AND status = 'pending' AND dueAt > ${ts} ORDER BY id LIMIT 1
      `[0];
      if (open) {
        // §5.4: events within the window become ONE wake-up — append this block to the
        // pending row's text. The row keeps its operationId: one steward input, ever.
        sql`UPDATE sh_wake SET text = ${open.text + "\n" + text} WHERE id = ${open.id}`;
        sql`
          INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, mergedInto, createdAt)
          VALUES (${"evt:" + ulid()}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'merged', ${ts + mergeMs}, ${open.id}, ${ts})
        `;
        return;
      }
      sql`
        INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, createdAt)
        VALUES (${"evt:" + ulid()}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'pending', ${ts + mergeMs}, ${ts})
      `;
    },
    due(nowMs: number): WakeRow[] {
      return sql<WakeRow>`
        SELECT * FROM sh_wake WHERE status = 'pending' AND dueAt <= ${nowMs} ORDER BY dueAt, id
      `;
    },
    /** Earliest pending dueAt (the next moment the drain alarm must fire), or null. */
    earliestDue(nowMs: number): number | null {
      return sql<{ at: number | null }>`SELECT MIN(dueAt) AS at FROM sh_wake WHERE status = 'pending'`[0]?.at ?? null;
    },
    markSubmitted(id: number): void {
      sql`UPDATE sh_wake SET status = 'submitted', submittedAt = ${now()} WHERE id = ${id} AND status = 'pending'`;
    },
  };

  const runs = {
    /** False when the operationId already ran/queued — the idempotency answer (§11). */
    open(
      operationId: string,
      kind: RunRow["kind"],
      text: string,
      opts: { replyTo?: string; channel?: string; routedThreadId?: string | null } = {},
    ): boolean {
      const exists = sql`SELECT 1 AS one FROM sh_run WHERE operationId = ${operationId}`;
      if (exists.length > 0) return false;
      sql`
        INSERT INTO sh_run (operationId, kind, replyTo, channel, routedThreadId, text, status, createdAt)
        VALUES (${operationId}, ${kind}, ${opts.replyTo ?? null}, ${opts.channel ?? null}, ${opts.routedThreadId ?? null},
                ${text}, 'open', ${now()})
      `;
      return true;
    },
    openRows(): RunRow[] {
      return sql<RunRow>`SELECT * FROM sh_run WHERE status = 'open' ORDER BY createdAt, operationId`;
    },
    get(operationId: string): RunRow | null {
      return (sql<RunRow>`SELECT * FROM sh_run WHERE operationId = ${operationId}`[0] ?? null);
    },
    rows(): RunRow[] {
      return sql<RunRow>`SELECT * FROM sh_run ORDER BY createdAt, operationId`;
    },
    /** Records the outcome. For kind=user the caller already queued the reply text. */
    settle(operationId: string, result: { status: string; reason?: string; text?: string }, replyOutboundId?: string): void {
      sql`
        UPDATE sh_run SET status = 'settled', resultStatus = ${result.status}, resultReason = ${result.reason ?? null},
                          resultText = ${result.text ?? null}, replyOutboundId = ${replyOutboundId ?? null}, settledAt = ${now()}
        WHERE operationId = ${operationId} AND status = 'open'
      `;
    },
  };

  // ---- the reducer (steward.md §5) ----------------------------------------------------------------

  /**
   * Applies every contiguous, unprocessed event from the protocol layer's inbox to the
   * ledger — one transaction, idempotent per (workerId, seq) via worker_ack.processedUpTo
   * (protocol §4.3: persistence and processing are decoupled; a crash between the events_ack
   * and this call leaves the rows pending, and the next wake drains them again).
   */
  function applyPendingEvents(): { applied: number } {
    return tx(() => {
      let applied = 0;
      const tracked = sql<{ workerId: string; processedUpTo: number }>`
        SELECT workerId, processedUpTo FROM worker_ack
      `;
      for (const { workerId } of tracked) {
        for (;;) {
          const next = nextInboxRow(workerId);
          if (!next) break; // gap or fully drained: stop in order (resync fills gaps later)
          applyEvent(JSON.parse(next.payload) as Record<string, unknown>);
          applied += 1;
        }
      }
      return { applied };
    });
  }

  function nextInboxRow(workerId: string): InboxEventRow | null {
    const row = sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${workerId}`[0];
    if (!row) return null;
    return (
      sql<InboxEventRow>`
        SELECT workerId, seq, payload FROM event_inbox WHERE workerId = ${workerId} AND seq = ${row.processedUpTo + 1}
      `[0] ?? null
    );
  }

  /** One event, already committed to the inbox. Deterministic; no LLM anywhere in here. */
  function applyEvent(event: Record<string, unknown>): void {
    const workerId = String(event.workerId ?? "");
    const seq = Number(event.seq ?? 0);
    const type = String(event.type ?? "");
    const ts = Number(event.ts ?? 0) || now();
    const worker = workers.get(workerId);
    if (!worker) {
      // Events for a worker this deployment never dispatched (stale device, other owner):
      // advance the watermark so the row never re-blocks the queue, and touch nothing else.
      sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
      return;
    }

    switch (type) {
      case "started": {
        sql`
          UPDATE sh_worker SET state = 'running', sessionId = ${str(event.sessionId)}, branch = ${str(event.branch)},
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "started", `worker 开始运行${event.branch ? `（分支 ${String(event.branch)}）` : ""}`, {
          workerId,
          seq,
        });
        break;
      }
      case "progress": {
        // Coarse progress only updates the worker; it never reaches the timeline (§5.3).
        sql`
          UPDATE sh_worker SET lastEventAt = ${ts},
                              lastProgress = ${JSON.stringify({ phase: event.phase, tool: event.tool ?? null, target: event.target ?? null, turn: event.turn ?? null })},
                              updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
        return; // no state change, no recompute needed
      }
      case "report": {
        const status = (event.status === "blocked" || event.status === "needs_decision" ? event.status : "done") as ReportRow["status"];
        sql`
          INSERT OR IGNORE INTO sh_report (workerId, seq, threadId, status, summary, changes, decisions, leftovers, tests, question, next, git, receivedAt)
          VALUES (${workerId}, ${seq}, ${worker.threadId}, ${status}, ${str(event.summary) ?? ""},
                  ${event.changes ? JSON.stringify(event.changes) : null},
                  ${event.decisions ? JSON.stringify(event.decisions) : null},
                  ${event.leftovers ? JSON.stringify(event.leftovers) : null},
                  ${event.tests ? JSON.stringify(event.tests) : null},
                  ${str(event.question)}, ${str(event.next)},
                  ${event.git ? JSON.stringify(event.git) : null}, ${now()})
        `;
        sql`
          UPDATE sh_worker SET lastOutcome = ${`reported:${status}`}, lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        timeline.add(worker.threadId, "report", `汇报（${status}）：${str(event.summary) ?? ""}`, { workerId, seq });
        if (status === "done") {
          notifications.queue(`report:${workerId}:${seq}`, "done_report", worker.threadId, workerId);
        } else {
          // M1 has no steward LLM, so the §5.3 90-second window is skipped: the deterministic
          // fallback push (worker's question, verbatim) is the only path. M2 adds the window.
          const qid = `q_${workerId}_${seq}`;
          sql`
            INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, status, askedAt)
            VALUES (${qid}, ${worker.threadId}, ${workerId}, ${str(event.question) ?? str(event.summary) ?? ""}, 'open', ${now()})
          `;
          notifications.queue(`report:${workerId}:${seq}`, "attention_report", worker.threadId, workerId);
        }
        // §5.3: report events wake the steward for bookkeeping (summary, notes). The
        // deterministic card above still goes out on its own — the LLM is not on its path.
        wakes.queue(
          "event",
          `report:${workerId}:${seq}`,
          eventWakeText({
            thread: threads.get(worker.threadId),
            worker: workers.get(workerId)!,
            machine: machines.get(worker.deviceId),
            report: {
              status,
              summary: str(event.summary) ?? "",
              changes: Array.isArray(event.changes) ? (event.changes as string[]) : null,
              decisions: Array.isArray(event.decisions) ? (event.decisions as string[]) : null,
              leftovers: Array.isArray(event.leftovers) ? (event.leftovers as string[]) : null,
              tests: (event.tests as ReportRow["tests"]) ?? null,
              question: str(event.question),
              git: (event.git as ReportRow["git"]) ?? null,
            },
            notified: true,
          }),
          { priority: status === "done" ? "normal" : "high" },
        );
        break;
      }
      case "settled": {
        const outcome = String(event.outcome ?? "");
        const errorClass = event.errorClass ? String(event.errorClass) : null;
        if (outcome === "reported" || outcome === "aborted") {
          sql`
            UPDATE sh_worker SET state = 'idle', lastOutcome = ${worker.lastOutcome ?? `settled:${outcome}`}, lastEventAt = ${ts}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          timeline.add(worker.threadId, "settled", outcome === "aborted" ? "运行被中断" : "运行结束", { workerId, seq });
        } else if (outcome === "error" && errorClass === "transient") {
          // The connector auto-resumes (connector-pi §9.2): the run is still in flight from
          // the Thread's point of view — state stays, nothing is sent.
          timeline.add(worker.threadId, "settled", "瞬时错误，连接器将自动重试", { workerId, seq, errorClass });
        } else {
          // error:auth / error:context / error:unknown / unreported — all need a human.
          const text = settledQuestionText(outcome, errorClass, event);
          const qid = `q_${workerId}_${seq}`;
          sql`
            INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, status, askedAt)
            VALUES (${qid}, ${worker.threadId}, ${workerId}, ${text}, 'open', ${now()})
          `;
          sql`
            UPDATE sh_worker SET state = 'broken', lastOutcome = ${`error:${errorClass ?? outcome}`}, lastEventAt = ${ts}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
          timeline.add(worker.threadId, "question", text, { workerId, seq, errorClass });
          notifications.queue(`settled:${workerId}:${seq}`, "failure_push", worker.threadId, workerId);
          // §5.3: failure-class settles wake the steward (it may classify, note, or add
          // context on top of the deterministic push the user already received).
          wakes.queue(
            "event",
            `settled:${workerId}:${seq}`,
            eventWakeText({
              thread: threads.get(worker.threadId),
              worker: workers.get(workerId)!,
              machine: machines.get(worker.deviceId),
              report: null,
              settled: { outcome, errorClass, text },
              notified: true,
            }),
            { priority: "high" },
          );
        }
        if (event.usage) {
          sql`UPDATE sh_worker SET lastProgress = ${JSON.stringify({ usage: event.usage })} WHERE workerId = ${workerId}`;
        }
        break;
      }
      case "lost":
      case "resumed": {
        // lost: not failed — the steward waits (spec §9). resumed: back to running.
        sql`
          UPDATE sh_worker SET state = ${type === "lost" ? "lost" : "running"}, lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, type, type === "lost" ? `失去联系（${str(event.reason) ?? "未知原因"}）` : "已恢复继续运行", {
          workerId,
          seq,
        });
        break;
      }
      case "queue_returned": {
        // §6.2: texts `clear_queue` handed back at interrupt time — they never reached the
        // worker. Recorded on the timeline, and the steward is woken to decide their fate
        // (resend with authorization, tell the user, or drop).
        const texts = (Array.isArray(event.texts) ? event.texts : []).map((t) => String(t).slice(0, 200));
        timeline.add(worker.threadId, "note", `中断时取回 ${texts.length} 条未送达消息：${texts.join("；") || "（空）"}`, {
          workerId,
          seq,
          texts,
        });
        if (texts.length > 0) {
          wakes.queue(
            "event",
            `queue_returned:${workerId}:${seq}`,
            queueReturnedWakeText({
              thread: threads.get(worker.threadId),
              worker: workers.get(workerId)!,
              machine: machines.get(worker.deviceId),
              texts,
            }),
          );
        }
        break;
      }
      case "external_activity": {
        timeline.add(worker.threadId, "note", "检测到会话在机器上被直接使用过", { workerId, seq });
        break;
      }
      default:
        // process_exit and future event types carry no ledger semantics yet.
        break;
    }

    sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
    recomputeThreadState(worker.threadId);
  }

  /**
   * Thread derived state (steward.md §5.2): a pure function recomputed after every change,
   * never set by the LLM or the user. `unread` is set where the news lands, cleared on read.
   */
  function recomputeThreadState(threadId: string): void {
    sql`
      UPDATE sh_thread SET state = CASE
        WHEN EXISTS (
          SELECT 1 FROM sh_worker w WHERE w.threadId = sh_thread.threadId AND w.state IN ('starting', 'running', 'recovering')
        ) THEN 'running'
        WHEN EXISTS (
          SELECT 1 FROM sh_question q WHERE q.threadId = sh_thread.threadId AND q.status = 'open'
        ) THEN 'waiting_you'
        ELSE 'idle'
      END, lastActivityAt = ${now()}
      WHERE threadId = ${threadId}
    `;
  }

  // ---- views: the web read model (steward.md §10) ------------------------------------------------

  const withMachineName = (worker: WorkerRow): WorkerRow & { machineName: string } => ({
    ...worker,
    machineName: machines.get(worker.deviceId)?.name ?? worker.deviceId,
  });

  const views = {
    /** `views.timeline` — the L2 page: thread, summary events, workers, the open question. */
    timeline(threadId: string): TimelineView | null {
      const thread = threads.get(threadId);
      if (!thread) return null;
      return {
        thread,
        entries: timeline.list(threadId),
        workers: workers.listByThread(threadId).map(withMachineName),
        openQuestion: questions.openForThread(threadId),
      };
    },
    /** The L1 index: threads.list plus each one's latest worker and situation bits. */
    threadList(): ThreadListEntry[] {
      return threads.list().map((thread) => ({
        thread,
        lastWorker: (worker => (worker ? withMachineName(worker) : null))(workers.latestOnThread(thread.threadId)),
        workerCount: workers.listByThread(thread.threadId).length,
      }));
    },
  };

  // ---- whole-ledger debug view for tests (read-only) ---------------------------------------------

  const debug = {
    snapshot(): {
      machines: MachineRow[];
      threads: Array<ThreadRow & { repoIds: string[]; workers: WorkerRow[]; questions: QuestionRow[]; timeline: TimelineRow[] }>;
      pendingNotifications: NotifyRow[];
      runs: RunRow[];
      wakes: WakeRow[];
    } {
      return {
        machines: machines.list(),
        threads: threads.list().map((t) => ({
          ...t,
          repoIds: threads.repoIds(t.threadId),
          workers: workers.listByThread(t.threadId),
          questions: sql<QuestionRow>`
            SELECT qid, threadId, workerId, text, status, askedAt, answeredAt
            FROM sh_question WHERE threadId = ${t.threadId} ORDER BY askedAt
          `,
          timeline: timeline.list(t.threadId),
        })),
        pendingNotifications: notifications.pending(),
        runs: runs.rows(),
        wakes: sql<WakeRow>`SELECT * FROM sh_wake ORDER BY id`,
      };
    },
  };

  return {
    machines, repos, threads, workers, reports, questions, timeline, notifications, outbound,
    runs, wakes, views, applyPendingEvents, recomputeThreadState, debug,
  };
}

export type Ledger = ReturnType<typeof createLedger>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The deterministic question text for failure-class settled events (steward.md §5.3). */
function settledQuestionText(outcome: string, errorClass: string | null, event: Record<string, unknown>): string {
  const lastText = typeof event.lastText === "string" && event.lastText.length > 0 ? event.lastText : "";
  const detail = lastText ? `（${lastText.slice(0, 160)}）` : "";
  if (outcome === "unreported") {
    return `worker 结束时没有产出汇报。${lastText ? `最后说：${lastText.slice(0, 120)}` : ""}`;
  }
  switch (errorClass) {
    case "auth":
      // §9.2: auth never auto-resumes — the detail says what the connector saw (e.g. a
      // failed resume), the base says what the user must do.
      return `机器上的模型凭据失效（401/403），需要你在那台机器上修复后重新派发。${detail}`;
    case "context":
      return "上下文超长，这个会话装不下了；建议开一个新会话接续（M2 的交接简报）。";
    default:
      // error:unknown — includes the connector's terminal §9.2 outcomes (resume failed /
      // budget exhausted / startup interrupted), whose reason rides in lastText.
      return `运行出错（${errorClass ?? "未知"}），需要你决定下一步。${detail}`;
  }
}
