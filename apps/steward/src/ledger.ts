// The memory module's ledger half (issue #5, steward.md §2): every sh_* table belongs to this
// file and callers reach it only through the returned interface — never with raw SQL. The
// event reducer (§5.1-5.3) is deterministic, runs in one transaction, and recomputes Thread
// derived state (`running / waiting_you / idle`) plus unread after every change. Notes (the
// knowledge half, issue #18) live in notes.ts behind the `notes` handle below — same rule:
// sh_note* is reached only through the memory module. The situation brief's character
// budget is brief.ts's.
import { ulid } from "@alexlikevibe/protocol";
import type { GitFacts, HelloMessage } from "@alexlikevibe/protocol";
import { createBudget } from "./budget.ts";
import { createNotes, type NoteRow } from "./notes.ts";
import { assembleBrief, type BriefDecision, type HandoffBrief } from "./handoff.ts";
import { eventWakeText, externalActivityWakeText, queueReturnedWakeText } from "./wake-text.ts";
import { createMachineStatus, type MachineReliability } from "./machine-status.ts";
import type { StartWorkerInput } from "./dispatch.ts";
import type { QuietSection } from "./report-template.ts";

/** Tagged-template SQL over the DO's SQLite (same shape schema.ts migrations use). */
export type LedgerSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** Thread summaries are capped (steward.md §2.6). */
export const MAX_THREAD_SUMMARY = 600;
/** §2.6: the module keeps the last N summary versions per Thread. */
export const SUMMARY_VERSIONS_KEPT = 5;
/** §2.6: every Nth cumulative summary update is a from-scratch rewrite (anti-drift). */
export const SUMMARY_REWRITE_EVERY = 10;
/** The wake merge window (steward.md §5.1/§5.4): events within it become one steward input. */
export const WAKE_MERGE_MS = 3_000;
/** The quiet merge window (issue #11, spec §7.6 / steward.md §6.4): `urgency: quiet` outbound
 *  holds this long per channel+receiver, so notifications landing together leave as one. */
export const QUIET_MERGE_MS = 60_000;
/** steward.md §5.3: external_activity wakes merge over a 10-minute window (low priority). */
export const EXTERNAL_ACTIVITY_MERGE_MS = 10 * 60_000;
/** Blocked reports give the steward this long before the core forwards the question. */
export const QUESTION_WINDOW_MS = 90_000;
/** The workspace shows this many recent messages and per-Thread timeline entries; decisions
 *  stay listed while they are open, but cards older than this window are never offered. */
export const WORKSPACE_MESSAGES = 120;
export const WORKSPACE_TIMELINE = 40;
export const WORKSPACE_DECISION_WINDOW_MS = 60 * 86_400_000;

/** Runs a synchronous closure atomically (`ctx.storage.transactionSync`, steward.md §1). */
export interface LedgerDeps {
  sql: LedgerSql;
  tx: <T>(fn: () => T) => T;
  now?: () => number;
  /** The quiet merge window (issue #11); overridable so tests shrink it. */
  quietWindowMs?: () => number;
}

// ---- relay (issue #8, spec §5.3) ------------------------------------------------------------------

export type { HandoffBrief };
export type { BriefDecision };

// ---- domain shapes (subset of steward.md §2.2 columns) -----------------------------------------

export type ThreadState = "running" | "waiting_you" | "idle";
/** Worker states that keep a Thread `running` (steward.md §5.2); lost/broken do not count. */
export const ACTIVE_WORKER_STATES = ["queued", "starting", "running", "recovering"] as const;

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
  /** A disconnected machine does not imply the session failed. */
  unreachable?: boolean;
  sessionId: string | null;
  branch: string | null;
  cmdId: string | null;
  /** The worker this one continues from — the relay relationship (issue #8, §2.2). */
  parentWorker: string | null;
  lastOutcome: string | null;
  lastEventAt: number | null;
  lastProgress: string | null;
  /** Last-reported context usage in percent (settled.usage.contextUsage) — the
   *  resume-vs-new-session input for high context usage (issue #8, connector-pi §11.2). */
  contextPercent: number | null;
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
  answer: string | null;
}

/** Git facts merged into the report event by the connector (connector-pi.md §7.2).
 *  Imported from @alexlikevibe/protocol so both ends share one shape (issue #8 adds the
 *  pointer fields; they are optional for connectors predating relay briefs). */
export type { GitFacts };

export interface QuestionRow {
  qid: string;
  /** Null for ask_user's threadless routing questions (issue #7, steward.md §3.3). */
  threadId: string | null;
  workerId: string | null;
  text: string;
  status: "open" | "answered";
  askedAt: number;
  answeredAt: number | null;
  kind: "steward" | "report" | "failure" | "unreported";
  fallbackDueAt: number | null;
  handledAt: number | null;
}

/** The ask_user question's button mapping (issue #7): what each card button means. */
export interface AskCandidates {
  options: string[];
  candidates: Array<{ threadId: string; label: string }>;
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
  reliability?: MachineReliability | null;
}

export interface OfflineDispatchRow {
  cmdId: string;
  threadId: string;
  deviceId: string;
  input: StartWorkerInput;
  status: "offered" | "waiting" | "switching" | "switched" | "cancelled";
  choices: string[];
}

/** A notification intent persisted by the reducer (steward.md §5.1 step 4). */
export interface NotifyRow {
  id: number;
  dedupeKey: string;
  kind:
    | "done_report"
    | "attention_report"
    | "failure_push"
    | "stall_notice"
    | "machine_offline"
    | "machine_online"
    | "waited_started"
    | "pr_created"
    | "pr_failed";
  threadId: string;
  workerId: string | null;
  questionId: string | null;
  /** Issue #21: render inputs that belong to the intent (a pr_created's url/branch, a
   *  pr_failed's stage/message) — JSON, read by the renderer, written by the reducer. */
  payload: string | null;
}

/** The consent gate's durable state (issue #21): the user's tap on a done card's
 *  [同意]/[先不要], the pr_worker command it sent, and the async result that came back. */
export interface PrConsentRow {
  workerId: string;
  seq: number;
  threadId: string;
  decision: "approved" | "declined";
  cmdId: string | null;
  attempts: number;
  url: string | null;
  failure: string | null;
  decidedAt: number;
  updatedAt: number;
}

/** A worker in an active state, plus its machine's connection state (issue #13 review: the
 * reap sweep needs WHEN the machine went offline, not just that it is offline now). */
export interface SilentWorker extends WorkerRow {
  machineOnline: boolean;
  machineLastSeen: number;
}

/** A durable wake_request (steward.md §5.1 step 4): one future steward input. */
export interface WakeRow {
  id: number;
  operationId: string;
  kind: "event" | "routine" | "followup";
  dedupeKey: string;
  text: string;
  priority: "low" | "normal" | "high";
  /** 'skipped' = the daily budget cap kept this wake from the model (issue #28, steward.md §12). */
  status: "pending" | "merged" | "submitted" | "skipped";
  dueAt: number;
  mergedInto: number | null;
  createdAt: number;
  submittedAt: number | null;
}

/** One steward run (steward.md §6.3): a submitted input and how its outcome is handled. */
export interface RunRow {
  operationId: string;
  kind: "user" | "event" | "routine" | "followup" | "verify";
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
  /** Real dispatches inside this run (settle-time verification, issue #7). */
  dispatchCount: number;
  createdAt: number;
  settledAt: number | null;
}

// ---- routing (steward.md §3, issue #7) -----------------------------------------------------------

/** One row of findCandidates' answer. */
export interface RouteCandidate {
  threadId: string;
  title: string;
  /** One-line summary (null when the thread has none yet). */
  summary: string | null;
  repos: string[];
  state: ThreadState;
  lastActivityAt: number;
  /** Why this candidate is here: 进行中 / 等你拍板 / 关键词命中 / 最近活跃 / 回复指向. */
  matchReason: string;
  /** Below the recall cutoff's confidence band — attach on it alone is exactly the guess
   *  the confidence gate exists to stop (spike eval tuning). */
  weak: boolean;
}

/** §3.2's answer: an explicit short-circuit, or the assembled candidate set. */
export interface RouteCandidates {
  confidence: "explicit" | "candidates";
  /** Set iff confidence is "explicit": the one thread signals 1–2 resolved to. */
  explicitThread: RouteCandidate | null;
  candidates: RouteCandidate[];
}

/** How many threads each recall bucket contributes (§3.2). */
export const FTS_RECALL_LIMIT = 8;
export const RECENT_RECALL_LIMIT = 5;
/** The assembled set never exceeds this (§3.2). */
export const CANDIDATE_CAP = 12;
/** Bigram overlap at or above this counts as a real match (the spike eval's cutoff). */
export const RECALL_SCORE_CUTOFF = 2;
/** Weak below this — informative, but never attachable alone. */
export const RECALL_WEAK_BELOW = 5;

const routeSummaryOf = (summary: string | null): string | null =>
  summary && summary.length > 0 ? (summary.length > 120 ? `${summary.slice(0, 119)}…` : summary) : null;

/**
 * The recall scorer behind findCandidates (spike-final's eval-tuned algorithm, ported):
 * CJK has no spaces, so overlap is scored by character-bigram hits plus latin word matches —
 * 「依赖升级…」 finds 「升级依赖」, and 「文档补完」 finds 「补 API 文档」. It covers the
 * 2-character queries the trigram FTS index cannot match, and ranks the FTS-recalled bucket.
 */
export function recallScore(query: string, haystack: string): number {
  const q = query.toLowerCase();
  const hay = haystack.toLowerCase();
  const gramSet = (text: string): Set<string> => {
    const set = new Set<string>();
    const chars = [...text];
    for (let i = 0; i < chars.length - 1; i++) {
      if (!/\s/.test(chars[i]!) && !/\s/.test(chars[i + 1]!)) set.add(chars[i]! + chars[i + 1]!);
    }
    return set;
  };
  const grams = gramSet(q);
  const hayGrams = gramSet(hay);
  const gramHits = [...grams].filter((g) => hayGrams.has(g)).length;
  const latin = q.match(/[a-z0-9_./-]{2,}/g) ?? [];
  const latinHits = latin.filter((t) => hay.includes(t)).length;
  return gramHits + latinHits * 2;
}

/** The FTS5 MATCH expression for findCandidates: latin segments ≥3 chars stay whole (word
 *  matches), CJK text contributes every 3-character window (the trigram index matches
 *  substrings, so a whole long phrase would never hit). Quotes are stripped so user text can
 *  never inject FTS operators; terms dedupe; the count stays bounded for long inputs. */
export function ftsMatchExpression(text: string): string | null {
  const terms = new Set<string>();
  for (const segment of text.split(/[\s\p{P}\p{S}]+/u)) {
    const clean = segment.replace(/"/g, "").trim();
    if (clean.length === 0) continue;
    if (/^[a-z0-9_./-]+$/i.test(clean)) {
      if ([...clean].length >= 3) terms.add(clean.toLowerCase());
      continue;
    }
    const chars = [...clean];
    for (let i = 0; i + 2 < chars.length; i++) terms.add(chars.slice(i, i + 3).join(""));
    if (chars.length === 3) terms.add(clean);
  }
  const ordered = [...terms].slice(0, 24);
  if (ordered.length === 0) return null;
  return ordered.map((term) => `"${term}"`).join(" OR ");
}

// ---- proactive behavior (issue #20, steward.md §8) ----------------------------------------------

export type RoutineKind = "digest" | "instruction";
export type RoutineStatus = "active" | "paused" | "done" | "cancelled";
export type FollowupStatus = "open" | "fired" | "cancelled";

export interface RoutineRow {
  routineId: string;
  kind: RoutineKind;
  createdFromMsg: string;
  scheduleKind: "cron" | "once";
  cron: string | null;
  onceAt: number | null;
  instruction: string;
  repoId: string | null;
  threadId: string | null;
  status: RoutineStatus;
  scheduleId: string | null;
  lastRunAt: number | null;
  /** The latest processed `routine:<id>:<fireTime>` — the fire-level idempotency key. */
  lastFireKey: string | null;
  lastResult: string | null;
  outcomeRecorded: boolean;
  createdAt: number;
}

export interface FollowupRow {
  followupId: string;
  threadId: string;
  dueAt: number;
  reason: string;
  createdBy: "user" | "steward";
  sourceRef: string;
  status: FollowupStatus;
  scheduleId: string | null;
  /** When it fired — the freshness bound for using it as a provenance ref (review #47-5). */
  firedAt: number | null;
  lastResult: string | null;
  outcomeRecorded: boolean;
  createdAt: number;
}

/** A routine suggestion waiting for the owner's button tap (steward.md §8.5). */
export interface RoutineOfferRow {
  offerId: string;
  spec: RoutineSpecStored;
  sourceMsg: string;
  status: "offered" | "accepted" | "dismissed";
  outboundId: string | null;
  createdAt: number;
}

/** The offer's stored spec (JSON in sh_routine_offer.spec). */
export interface RoutineSpecStored {
  instruction: string;
  kind: RoutineKind;
  cron?: string;
  onceAt?: number;
  threadId?: string;
  repoId?: string;
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
  /** Stable id for eval/world seeding; generated when omitted. */
  threadId?: string;
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
  /** Relay (issue #8): the worker this session continues from. */
  parentWorker?: string;
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
  reliability: jsonOrNull<MachineReliability>(r.reliability as string | null),
});

const viewWorker = (r: Record<string, unknown>): WorkerRow => ({
  workerId: r.workerId as string,
  threadId: r.threadId as string,
  deviceId: r.deviceId as string,
  repoId: (r.repoId as string | null) ?? null,
  agent: r.agent as string,
  mode: r.mode as string,
  state: r.state as string,
  unreachable: !!r.unreachable,
  sessionId: (r.sessionId as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  cmdId: (r.cmdId as string | null) ?? null,
  parentWorker: (r.parentWorker as string | null) ?? null,
  lastOutcome: (r.lastOutcome as string | null) ?? null,
  lastEventAt: (r.lastEventAt as number | null) ?? null,
  lastProgress: (r.lastProgress as string | null) ?? null,
  contextPercent: (r.contextPercent as number | null) ?? null,
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
  answer: (r.answer as string | null) ?? null,
});

const viewQuestion = (r: Record<string, unknown>): QuestionRow => ({
  qid: r.qid as string,
  threadId: (r.threadId as string | null) ?? null,
  workerId: (r.workerId as string | null) ?? null,
  text: r.text as string,
  status: r.status as QuestionRow["status"],
  askedAt: r.askedAt as number,
  answeredAt: (r.answeredAt as number | null) ?? null,
  kind: (r.kind as QuestionRow["kind"]) ?? "steward",
  fallbackDueAt: (r.fallbackDueAt as number | null) ?? null,
  handledAt: (r.handledAt as number | null) ?? null,
});

const viewPrConsent = (r: Record<string, unknown>): PrConsentRow => ({
  workerId: r.workerId as string,
  seq: r.seq as number,
  threadId: r.threadId as string,
  decision: r.decision === "approved" ? "approved" : "declined",
  cmdId: (r.cmdId as string | null) ?? null,
  attempts: (r.attempts as number) ?? 0,
  url: (r.url as string | null) ?? null,
  failure: (r.failure as string | null) ?? null,
  decidedAt: r.decidedAt as number,
  updatedAt: r.updatedAt as number,
});

const viewRoutine = (r: Record<string, unknown>): RoutineRow => ({
  routineId: r.routineId as string,
  kind: r.kind as RoutineKind,
  createdFromMsg: r.createdFromMsg as string,
  scheduleKind: r.scheduleKind as RoutineRow["scheduleKind"],
  cron: (r.cron as string | null) ?? null,
  onceAt: (r.onceAt as number | null) ?? null,
  instruction: r.instruction as string,
  repoId: (r.repoId as string | null) ?? null,
  threadId: (r.threadId as string | null) ?? null,
  status: r.status as RoutineStatus,
  scheduleId: (r.scheduleId as string | null) ?? null,
  lastRunAt: (r.lastRunAt as number | null) ?? null,
  lastFireKey: (r.lastFireKey as string | null) ?? null,
  lastResult: (r.lastResult as string | null) ?? null,
  outcomeRecorded: !!r.outcomeRecorded,
  createdAt: r.createdAt as number,
});

const viewFollowup = (r: Record<string, unknown>): FollowupRow => ({
  followupId: r.followupId as string,
  threadId: r.threadId as string,
  dueAt: r.dueAt as number,
  reason: r.reason as string,
  createdBy: r.createdBy as FollowupRow["createdBy"],
  sourceRef: r.sourceRef as string,
  status: r.status as FollowupStatus,
  scheduleId: (r.scheduleId as string | null) ?? null,
  firedAt: (r.firedAt as number | null) ?? null,
  lastResult: (r.lastResult as string | null) ?? null,
  outcomeRecorded: !!r.outcomeRecorded,
  createdAt: r.createdAt as number,
});

const viewOffer = (r: Record<string, unknown>): RoutineOfferRow => ({
  offerId: r.offerId as string,
  spec: jsonOrNull<RoutineSpecStored>(r.spec as string | null) ?? { instruction: "", kind: "instruction" },
  sourceMsg: r.sourceMsg as string,
  status: r.status as RoutineOfferRow["status"],
  outboundId: (r.outboundId as string | null) ?? null,
  createdAt: r.createdAt as number,
});

export function createLedger(deps: LedgerDeps) {
  const { sql, tx } = deps;
  const now = deps.now ?? Date.now;
  const quietWindowMs = deps.quietWindowMs ?? (() => QUIET_MERGE_MS);

  // The notes half of the memory module (issue #18, steward.md §2.3-§2.5): layered
  // knowledge with a two-phase write. Same SQL handle, same transaction wrapper.
  const notes = createNotes({ sql, tx, now });
  const machineStatus = createMachineStatus({
    sql,
    tx,
    now,
    timelineAdd: (threadId, kind, text, refs) => timeline.add(threadId, kind, text, refs),
  });

  // The daily budget counter (issue #28, steward.md §12): sh_usage_day / sh_usage_cursor.
  // Same SQL handle, same transaction wrapper.
  const budget = createBudget({ sql, tx, now });

  /** §2.6 (issue #8): records one landed summary version, keeping the last
   *  SUMMARY_VERSIONS_KEPT. The version number is also the cumulative update count;
   *  `previous` (the summary before this update) backfills history for threads that
   *  predate versioning. */
  const recordSummaryVersion = (threadId: string, summary: string, previous: string | null): void => {
    tx(() => {
      const max =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m;
      // Backfill: a thread that predates versioning enters history with its prior summary
      // as version 1, so the counter never lies about how many updates landed.
      if (max === 0 && previous !== null) {
        sql`INSERT OR IGNORE INTO sh_thread_summary (threadId, version, summary, at) VALUES (${threadId}, 1, ${previous}, ${now()})`;
      }
      const next =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m + 1;
      sql`INSERT INTO sh_thread_summary (threadId, version, summary, at) VALUES (${threadId}, ${next}, ${summary}, ${now()})`;
      const stale = sql<{ version: number }>`
        SELECT version FROM sh_thread_summary WHERE threadId = ${threadId} ORDER BY version DESC LIMIT -1 OFFSET ${SUMMARY_VERSIONS_KEPT}
      `;
      for (const row of stale) {
        sql`DELETE FROM sh_thread_summary WHERE threadId = ${threadId} AND version = ${row.version}`;
      }
    });
  };

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

  function recordRepository(deviceId: string, repo: HelloMessage["repos"][number]): void {
    sql`
      INSERT OR REPLACE INTO sh_repo (repoId, deviceId, name, path, defaultBranch, remote, updatedAt)
      VALUES (${repo.repoId}, ${deviceId}, ${repo.name}, ${repo.path}, ${repo.defaultBranch}, ${repo.remote}, ${now()})
    `;
  }

  const machines = {
    /** Upserts machine facts + the full repo snapshot from a hello, and marks it online. */
    upsertFromHello(hello: HelloMessage): void {
      const ts = now();
      machineStatus.setOnline(hello.deviceId, true, hello.machine.name);
      sql`
        INSERT INTO sh_machine (deviceId, name, online, lastSeen, agents, maxWorkers, bootId)
        VALUES (${hello.deviceId}, ${hello.machine.name}, 1, ${ts}, ${JSON.stringify(hello.agents.map((a) => a.kind))}, ${hello.limits.maxWorkers}, ${hello.bootId})
        ON CONFLICT (deviceId) DO UPDATE SET
          name = excluded.name, online = 1, lastSeen = excluded.lastSeen,
          agents = excluded.agents, maxWorkers = excluded.maxWorkers, bootId = excluded.bootId
      `;
      // Slots occupied by sessions outside this ledger also count; tracked sessions are
      // counted live so a subsequent dispatch/settle immediately changes the free slots.
      const trackedRunning = hello.workers.filter((w) =>
        (ACTIVE_WORKER_STATES as readonly string[]).includes(w.state) && workers.get(w.workerId) !== null).length;
      sql`UPDATE sh_machine SET otherRunning = ${Math.max(0, hello.limits.running - trackedRunning)} WHERE deviceId = ${hello.deviceId}`;
      // hello.repos is a full snapshot: replace this machine's rows so removals stick.
      sql`DELETE FROM sh_repo WHERE deviceId = ${hello.deviceId}`;
      for (const repo of hello.repos) recordRepository(hello.deviceId, repo);
    },
    /** Online derives from live connections only (issue #5): onConnect marks, onClose clears. */
    setOnline(deviceId: string, online: boolean, fallbackName?: string): void {
      machineStatus.setOnline(deviceId, online, fallbackName);
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
      `[0]!.n + (sql<{ n: number }>`SELECT otherRunning AS n FROM sh_machine WHERE deviceId = ${deviceId}`[0]?.n ?? 0);
    },
  };

  const repos = {
    recordRegistration: recordRepository,
    /** Machines that have a repo matching `ref` by name or exact repoId (routing signal 2). */
    machinesHaving(ref: string): { deviceId: string; repoId: string; repoName: string }[] {
      return sql<{ deviceId: string; repoId: string; repoName: string }>`
        SELECT deviceId, repoId, name AS repoName FROM sh_repo
        WHERE name = ${ref} OR repoId = ${ref} OR path = ${ref}
        ORDER BY repoId
      `;
    },
    /** All registered repos (the brief's repos line, issue #7). */
    list(): Array<{ repoId: string; deviceId: string; name: string; online: boolean }> {
      return sql<{ repoId: string; deviceId: string; name: string; online: boolean }>`
        SELECT r.repoId, r.deviceId, r.name, COALESCE(m.online, 0) AS online
        FROM sh_repo r LEFT JOIN sh_machine m ON m.deviceId = r.deviceId
        ORDER BY r.name, r.repoId
      `;
    },
  };

  // ---- threads / workers -----------------------------------------------------------------------

  const threads = {
    create(input: NewThreadInput): ThreadRow {
      const threadId = input.threadId ?? `t_${ulid()}`;
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
    addRepo(threadId: string, repoId: string): void {
      sql`INSERT OR IGNORE INTO sh_thread_repo (threadId, repoId) VALUES (${threadId}, ${repoId})`;
    },
    /** Bug 4: dispatch affinity — the machine the Thread last ran on. */
    setLastMachine(threadId: string, deviceId: string): void {
      sql`UPDATE sh_thread SET lastMachine = ${deviceId}, lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    /** Reply or card click on the Thread's message = the user has seen it (§6.5). */
    markRead(threadId: string): void {
      sql`UPDATE sh_thread SET unread = 0 WHERE threadId = ${threadId}`;
    },
    /** The steward's bookkeeping update (§2.6): summaries capped at 600 characters; each
     *  landed summary is versioned (last 5 kept) and the Nth-bounded updates trigger the
     *  from-scratch rewrite prompt. A blank or unchanged summary does not count as an
     *  update — only real rewrites move the counter. */
    update(threadId: string, patch: { title?: string; goal?: string; summary?: string }): boolean {
      if (patch.summary !== undefined && patch.summary.length > MAX_THREAD_SUMMARY) return false;
      if (patch.summary !== undefined && patch.summary.trim().length === 0) return false;
      const before = sql<ThreadRow>`SELECT * FROM sh_thread WHERE threadId = ${threadId}`[0];
      if (!before) return false;
      const changedSummary = patch.summary !== undefined && patch.summary !== before.summary;
      sql`
        UPDATE sh_thread SET
          title = COALESCE(${patch.title ?? null}, title),
          goal = COALESCE(${patch.goal ?? null}, goal),
          summary = COALESCE(${patch.summary ?? null}, summary),
          summaryAt = CASE WHEN ${patch.summary ?? null} IS NULL THEN summaryAt ELSE ${now()} END
        WHERE threadId = ${threadId}
      `;
      if (changedSummary) recordSummaryVersion(threadId, patch.summary!, before.summary);
      return true;
    },
    /** §2.6 (issue #8): the retained summary versions, newest first. */
    summaryVersions(threadId: string): Array<{ version: number; summary: string; at: number }> {
      return sql<{ version: number; summary: string; at: number }>`
        SELECT version, summary, at FROM sh_thread_summary WHERE threadId = ${threadId} ORDER BY version DESC
      `;
    },
    /** §2.6 (issue #8): cumulative summary updates so far, and whether the NEXT one lands on
     *  the every-10th boundary that must be written from scratch (timeline + reports), not
     *  edited out of the current summary — the anti-drift rule. */
    summaryStatus(threadId: string): { updates: number; rewriteDue: boolean } {
      const updates =
        sql<{ m: number }>`SELECT COALESCE(MAX(version), 0) AS m FROM sh_thread_summary WHERE threadId = ${threadId}`[0]!.m;
      return { updates, rewriteDue: (updates + 1) % SUMMARY_REWRITE_EVERY === 0 };
    },

    /**
     * threads.findCandidates (§3.2, issue #7): routing candidates for one utterance.
     *
     * 1. Signal 1 (reply-to / card click) never reaches here in production — the input is
     *    routed before the model — but `explicitThreadId` short-circuits the same way when
     *    the caller knows it. Signal 2 (explicit mention): the text contains exactly one
     *    thread's title or a thread id (or `hints` name repos/machines that pin one thread).
     *    A unique hit returns as `confidence: "explicit"` with just that thread.
     * 2. Otherwise: all running + waiting-you threads, then the FTS-recalled top 8 over the
     *    text (trigram index, ranked by the bigram scorer so 2-char queries count too), then
     *    the 5 most recent — deduped, capped at 12, each with a match reason.
     */
    findCandidates(input: { text: string; hints?: string[]; explicitThreadId?: string | null }): RouteCandidates {
      const all = sql<Record<string, unknown>>`
        SELECT * FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC, threadId
      `.map(threadFromRow);
      const reposOf = (threadId: string): string[] =>
        sql<{ repoId: string }>`SELECT repoId FROM sh_thread_repo WHERE threadId = ${threadId}`.map((r) => r.repoId);
      const toCandidate = (thread: ThreadRow, matchReason: string, weak = false): RouteCandidate => ({
        threadId: thread.threadId,
        title: thread.title,
        summary: routeSummaryOf(thread.summary),
        repos: reposOf(thread.threadId),
        state: thread.state,
        lastActivityAt: thread.lastActivityAt,
        matchReason,
        weak,
      });

      // ---- signal 1: the caller already resolved the thread (reply / card click) ----
      if (input.explicitThreadId) {
        const routed = all.find((t) => t.threadId === input.explicitThreadId);
        if (routed) {
          return {
            confidence: "explicit",
            explicitThread: toCandidate(routed, "回复/按钮显式指向"),
            candidates: [toCandidate(routed, "回复/按钮显式指向")],
          };
        }
      }

      // ---- signal 2: explicit mention — the text names exactly one thread ----
      const lower = input.text.toLowerCase();
      const mentioned = all.filter((t) => t.title.length > 1 && lower.includes(t.title.toLowerCase()));
      const byId = all.filter((t) => lower.includes(t.threadId.toLowerCase()));
      // Hints (§3.1 signal 2): repo or machine names pin the thread set.
      const hintThreads = new Set<string>();
      for (const hint of input.hints ?? []) {
        for (const row of repos.machinesHaving(hint)) {
          for (const t of all) if (reposOf(t.threadId).includes(row.repoId)) hintThreads.add(t.threadId);
        }
        for (const machine of machines.list()) {
          if (machine.name === hint || machine.deviceId === hint) {
            for (const w of sql<{ threadId: string }>`SELECT DISTINCT threadId FROM sh_worker WHERE deviceId = ${machine.deviceId}`) {
              hintThreads.add(w.threadId);
            }
          }
        }
      }
      const explicitPicks = [...new Set([...mentioned, ...byId].map((t) => t.threadId))];
      const explicitUnique =
        explicitPicks.length === 1
          ? (all.find((t) => t.threadId === explicitPicks[0]) ?? null)
          : hintThreads.size === 1
            ? (all.find((t) => t.threadId === [...hintThreads][0]) ?? null)
            : null;
      if (explicitUnique) {
        const reason = mentioned.some((t) => t.threadId === explicitUnique.threadId)
          ? "消息里点名了它的标题"
          : byId.some((t) => t.threadId === explicitUnique.threadId)
            ? "消息里带了它的 id"
            : "仓库/机器指向它";
        const candidate = toCandidate(explicitUnique, reason);
        return { confidence: "explicit", explicitThread: candidate, candidates: [candidate] };
      }

      // ---- assembly (§3.2 step 2) ----
      const active = all.filter((t) => t.state === "running" || t.state === "waiting_you");
      const picked = new Set<string>(active.map((t) => t.threadId));
      const candidates: RouteCandidate[] = active
        .sort((a, b) => (a.state === b.state ? b.lastActivityAt - a.lastActivityAt : a.state === "running" ? -1 : 1))
        .map((t) => toCandidate(t, t.state === "running" ? "进行中" : "等你拍板"));

      // Recall: FTS over the text (trigram index), ranked by the bigram scorer; the scorer
      // alone stands in when the index has no ≥3-char segment to match (or the runtime's
      // SQLite lacks FTS5 — findCandidates must never throw over recall).
      const scored = all
        .map((thread) => {
          const report = sql<{ summary: string | null }>`
            SELECT summary FROM sh_report WHERE threadId = ${thread.threadId} ORDER BY receivedAt DESC, seq DESC LIMIT 1
          `[0]?.summary;
          const hay = `${thread.title} ${thread.goal ?? ""} ${thread.summary ?? ""} ${report ?? ""}`;
          return { thread, score: recallScore(input.text, hay) + (thread.state !== "idle" ? 1 : 0) };
        })
        .filter((entry) => entry.score >= RECALL_SCORE_CUTOFF)
        .sort((a, b) => b.score - a.score || b.thread.lastActivityAt - a.thread.lastActivityAt);

      let ftsIds: string[] = [];
      const match = ftsMatchExpression(input.text);
      if (match !== null) {
        try {
          ftsIds = sql<{ threadId: string }>`
            SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH ${match} ORDER BY bm25(sh_thread_fts) LIMIT 32
          `.map((r) => r.threadId);
        } catch {
          ftsIds = []; // no FTS5 / tokenizer in this runtime: the scorer above is the recall
        }
      }
      const recallOrder = new Map<string, number>();
      ftsIds.forEach((id, index) => recallOrder.set(id, index));
      const recalled = [...scored]
        .sort((a, b) => {
          // The bigram scorer ranks (spike-eval-tuned); FTS presence is the recall net and
          // bm25 order only breaks scorer ties — bm25 over OR'd trigrams is too noisy to lead.
          const sa = recallOrder.has(a.thread.threadId) ? recallOrder.get(a.thread.threadId)! : 999;
          const sb = recallOrder.has(b.thread.threadId) ? recallOrder.get(b.thread.threadId)! : 999;
          return b.score - a.score || sa - sb || b.thread.lastActivityAt - a.thread.lastActivityAt;
        })
        .slice(0, FTS_RECALL_LIMIT);
      for (const entry of recalled) {
        if (picked.has(entry.thread.threadId)) continue;
        if (candidates.length >= CANDIDATE_CAP) break;
        picked.add(entry.thread.threadId);
        candidates.push(toCandidate(entry.thread, `关键词命中（${entry.score}）`, entry.score < RECALL_WEAK_BELOW));
      }

      for (const thread of all.slice(0, RECENT_RECALL_LIMIT)) {
        if (picked.has(thread.threadId)) continue;
        if (candidates.length >= CANDIDATE_CAP) break;
        picked.add(thread.threadId);
        candidates.push(toCandidate(thread, "最近活跃", true));
      }

      return { confidence: "candidates", explicitThread: null, candidates };
    },
  };

  const workers = {
    register(input: NewWorkerInput): WorkerRow {
      const ts = now();
      sql`
        INSERT INTO sh_worker (workerId, threadId, deviceId, repoId, agent, mode, state, cmdId, parentWorker, createdAt, updatedAt)
        VALUES (${input.workerId}, ${input.threadId}, ${input.deviceId}, ${input.repoId ?? null},
                ${input.agent}, ${input.mode}, 'starting', ${input.cmdId ?? null}, ${input.parentWorker ?? null}, ${ts}, ${ts})
      `;
      // A fresh run of this id: any deferred reap-reconcile verdict is void.
      sql`DELETE FROM sh_reap_pending WHERE workerId = ${input.workerId}`;
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
    /** The Thread's most recent worker that actually has a branch — the relay base when the
     *  latest leg ran readonly or never started (issue #8, spec §5.3). `target` filters out
     *  same-machine/different-repo rows: relaying repo-A's branch name into repo-B's clone
     *  would just fail the start (PR #54 review finding 3); cross-machine rows stay — the
     *  branch may exist there after a push+fetch, and the dispatch flags `crossMachine`. */
    latestBranchOnThread(threadId: string, target?: { deviceId: string; repoId: string | null }): WorkerRow | null {
      const row = target
        ? sql<Record<string, unknown>>`
            SELECT * FROM sh_worker WHERE threadId = ${threadId} AND branch IS NOT NULL
              AND NOT (deviceId = ${target.deviceId} AND repoId IS NOT NULL AND ${target.repoId} IS NOT NULL AND repoId != ${target.repoId})
            ORDER BY createdAt DESC, workerId DESC LIMIT 1
          `[0]
        : sql<Record<string, unknown>>`
            SELECT * FROM sh_worker WHERE threadId = ${threadId} AND branch IS NOT NULL
            ORDER BY createdAt DESC, workerId DESC LIMIT 1
          `[0];
      return row ? viewWorker(row) : null;
    },
    /** The worker a new relay session continues FROM (issue #8): the previous leg. Same
     *  machine must also mean same repo — continuing a thread into another repository of
     *  one machine silently relays the wrong repo's branch, so such a worker yields null
     *  and the session starts fresh. */
    relaySource(threadId: string, target: { deviceId: string; repoId: string | null }): WorkerRow | null {
      const previous = workers.latestOnThread(threadId);
      if (!previous) return null;
      if (previous.deviceId === target.deviceId && previous.repoId !== null && target.repoId !== null && previous.repoId !== target.repoId) {
        return null;
      }
      return previous;
    },
    reportsForWorker(workerId: string): ReportRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE workerId = ${workerId} ORDER BY seq
      `.map(viewReport);
    },
    byCommand(cmdId: string): WorkerRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_worker WHERE cmdId = ${cmdId}`[0];
      return row ? viewWorker(row) : null;
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
      const rows = sql<WorkerRow>`
        SELECT * FROM sh_worker WHERE deviceId = ${deviceId}
      `;
      for (const worker of rows) {
        const snap = snapshots.find((s) => s.workerId === worker.workerId);
        if (!snap) continue; // not this deployment's business (pruned / other device)
        const processed =
          sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${worker.workerId}`[0]
            ?.processedUpTo ?? 0;
        if (snap.lastSeq > processed) {
          // The event stream is still telling the story — but if this worker was reaped by
          // the DO while its machine was offline, park the snapshot's verdict: once the
          // stream catches up (resolveReapPending), the verdict applies without waiting for
          // another hello that may never come (issue #13 review finding 2).
          if (worker.state === "lost" && worker.lastOutcome === "reaped") {
            sql`
              INSERT OR REPLACE INTO sh_reap_pending (workerId, threadId, snapState, lastSeq, createdAt)
              VALUES (${worker.workerId}, ${worker.threadId}, ${snap.state}, ${snap.lastSeq}, ${now()})
            `;
          }
          continue;
        }
        if (snap.state === 'broken' && worker.state !== 'broken') {
          recordBrokenQuestion(worker, `q_broken_${worker.workerId}_${processed}`, '自动恢复未成功（连接器对账），需要你决定下一步。');
        }
        // Back online (issue #14): the connector's snapshot re-states this worker's truth —
        // the DO-side unreachable mark from the drop must not outlive the reconnection.
        sql`UPDATE sh_worker SET unreachable = 0 WHERE workerId = ${worker.workerId}`;
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
          sql`
            UPDATE sh_worker SET state = ${snap.state},
                                lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                                updatedAt = ${now()}
            WHERE workerId = ${worker.workerId}
          `;
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
     * A resume dispatch in flight (issue #8): the ledger flips an idle worker to `starting`
     * when the continuation reuses its session, so the Thread reads running-shaped right
     * away. `lost` stays lost — the connector's §9.2 resume owns that state, and the
     * pending send queues behind it.
     */
    markResumePending(workerId: string, cmdId: string): void {
      sql`
        UPDATE sh_worker SET state = CASE WHEN state = 'idle' THEN 'starting' ELSE state END,
                            cmdId = ${cmdId}, lastEventAt = ${now()}, updatedAt = ${now()}
        WHERE workerId = ${workerId}
      `;
    },

    /**
     * A still-queued resume was withdrawn (the user cancelled, issue #8): revert the
     * resume-pending `starting` back to `idle` silently — the user's own click, nothing to
     * report. Same cmdId guard as markResumeFailed.
     */
    markResumeCancelled(workerId: string, cmdId: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.cmdId !== cmdId || worker.state !== "starting") return false;
      sql`UPDATE sh_worker SET state = 'idle', updatedAt = ${now()} WHERE workerId = ${workerId}`;
      timeline.add(worker.threadId, "note", "用户取消：接续指令在送出前撤回，原会话未受影响", { workerId, cmdId });
      recomputeThreadState(worker.threadId);
      return true;
    },

    /**
     * The resume send failed at the connector (rejected / failed cmd_result / sweep, issue
     * 8): a resume-pending `starting` worker reverts to `idle` — the session itself is intact
     * — and the failure is surfaced. A resume sent into a still-`running` worker (intent
     * "after") cannot revert the state (the run goes on); the undelivered task is still
     * recorded on the timeline and pushed to the user — the promise "会汇报" must not
     * silently evaporate (PR #54 review finding 8). Idempotent on the cmdId; only the
     * command that the worker row still points at may settle it.
     */
    markResumeFailed(workerId: string, cmdId: string, reason: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.cmdId !== cmdId) return false;
      if (worker.state === "starting") {
        sql`
          UPDATE sh_worker SET state = 'idle', lastOutcome = ${`resume_failed:${reason}`}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "note", `接续原会话失败（${reason}）；原会话未受影响，重新派发即可`, {
          workerId,
          cmdId,
        });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(`resume_failed:${cmdId}`, "failure_push", worker.threadId, workerId);
        recomputeThreadState(worker.threadId);
        return true;
      }
      if (worker.state === "running" || worker.state === "recovering") {
        // The current run is unaffected; only the queued-in task was lost. State stays; the
        // outcome marker routes the deterministic failure card (and the next report/settled
        // overwrites it).
        sql`UPDATE sh_worker SET lastOutcome = ${`resume_failed:${reason}`}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
        timeline.add(worker.threadId, "note", `接续指令未送达（${reason}）；当前运行不受影响，但新任务没有交给它`, {
          workerId,
          cmdId,
        });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(`resume_failed:${cmdId}`, "failure_push", worker.threadId, workerId);
        recomputeThreadState(worker.threadId);
        return true;
      }
      return false;
    },

    /**
     * A start_worker the connector rejected or that failed (cmd_ack rejected / cmd_result
     * ok:false). Marks the worker broken, records it on the timeline, and queues a failure
     * push — deterministic, idempotent (duplicate cmd_results re-settle the same command).
     * `cmdId` may be null when the command row never came to exist (enqueue threw): the
     * dedupe key then falls back to the workerId.
     */
    markStartFailed(workerId: string, cmdId: string | null, reason: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.state === "broken") return false;
      // Issue #14: a start that dies while an offline ask was open settles the ask too —
      // the offer row must not sit `offered`/`waiting` on top of a broken worker, and the
      // `offline:` question would otherwise pin the Thread in waiting_you forever.
      const askCmdId = cmdId ?? worker.cmdId;
      if (askCmdId !== null && offlineDispatches.transition(askCmdId, "offered", "cancelled")) {
        questions.close(`offline:${askCmdId}`, "派发未能开始");
      }
      if (askCmdId !== null && offlineDispatches.transition(askCmdId, "waiting", "cancelled")) {
        questions.close(`offline:${askCmdId}`, "派发未能开始");
      }
      sql`
        UPDATE sh_worker SET state = 'broken', lastOutcome = ${`start_failed:${reason}`}, updatedAt = ${now()}
        WHERE workerId = ${workerId}
      `;
      timeline.add(worker.threadId, "note", `派发失败（${reason}）`, { workerId, cmdId });
      sql`UPDATE sh_thread SET unread = 1, lastActivityAt = ${now()} WHERE threadId = ${worker.threadId}`;
      recordBrokenQuestion(worker, `q_start_${cmdId ?? workerId}`, `派发失败：${reason}。需要你决定下一步。`);
      recomputeThreadState(worker.threadId);
      return true;
    },

    /**
     * Active workers silent for at least `silentMs` (silence counts from lastEventAt, or
     * createdAt when no event ever arrived), with their machine's online flag — the shared
     * query of the DO-side stall alarm (§8.4) and the reap sweep (spike-conclusions §2).
     */
    silentSince(silentMs: number): SilentWorker[] {
      const cutoff = now() - silentMs;
      return sql<Record<string, unknown>>`
        SELECT w.*, CASE WHEN m.online = 1 THEN 1 ELSE 0 END AS machineOnline,
               COALESCE(m.lastSeen, 0) AS machineLastSeen
        FROM sh_worker w LEFT JOIN sh_machine m ON m.deviceId = w.deviceId
        WHERE w.state IN ('queued', 'starting', 'running', 'recovering')
          AND COALESCE(w.lastEventAt, w.createdAt) <= ${cutoff}
        ORDER BY w.workerId
      `.map((r) => ({ ...viewWorker(r), machineOnline: r.machineOnline === 1, machineLastSeen: Number(r.machineLastSeen ?? 0) }));
    },

    /**
     * The §8.4 stall alarm firing for one worker: one timeline entry and one stall_notice
     * intent — "a given stall notifies only once". The dedupe key carries lastEventAt, so the
     * next event (which rewrites that timestamp) arms a fresh stall naturally. Idempotent.
     */
    notifyStall(workerId: string, silentMs: number): boolean {
      const worker = workers.get(workerId);
      if (!worker || !(ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)) return false;
      const dedupeKey = `stall:${workerId}:${worker.lastEventAt ?? 0}`;
      if (notifications.seen(dedupeKey)) return false;
      return tx(() => {
        if (notifications.seen(dedupeKey)) return false; // re-check inside the transaction
        const minutes = Math.max(1, Math.round(silentMs / 60_000));
        timeline.add(worker.threadId, "stall", `worker 已经 ${minutes} 分钟没有任何动静`, { workerId, silentMs });
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(dedupeKey, "stall_notice", worker.threadId, workerId);
        return true;
      });
    },

    /**
     * The reap sweep's verdict (issue #13): a worker wedged in an active state — its machine
     * offline, or online but long silent — becomes `lost` so the Thread stops pretending to
     * be running. Timeline only, never a push (spec §9: lost contact, not failed). Idempotent;
     * when the machine returns, hello.workers reconciliation decides resumed vs ended.
     */
    reapWorker(workerId: string, online: boolean): boolean {
      const worker = workers.get(workerId);
      if (!worker || !(ACTIVE_WORKER_STATES as readonly string[]).includes(worker.state)) return false;
      return tx(() => {
        sql`UPDATE sh_worker SET state = 'lost', lastOutcome = 'reaped', updatedAt = ${now()} WHERE workerId = ${workerId}`;
        timeline.add(
          worker.threadId,
          "lost",
          online ? "机器在线但 worker 长时间无事件，视为失联（DO 兜底回收）" : "机器离线超过 10 分钟，worker 视为失联（DO 兜底回收）",
          { workerId, reaped: true },
        );
        recomputeThreadState(worker.threadId);
        return true;
      });
    },

    /**
     * Applies deferred hello-workers verdicts whose event stream has caught up (see
     * reconcileFromSnapshot's gated branch). A `lost`+`reaped` worker whose parked snapshot
     * is active resumes; one whose snapshot says the run ended accepts that verdict. Ordered
     * by seq only — never by connector timestamps, which may skew. Idempotent.
     */
    resolveReapPending(): number {
      let resolved = 0;
      for (const pending of sql<{ workerId: string; threadId: string; snapState: string; lastSeq: number }>`
        SELECT workerId, threadId, snapState, lastSeq FROM sh_reap_pending
      `) {
        const processed =
          sql<{ processedUpTo: number }>`SELECT processedUpTo FROM worker_ack WHERE workerId = ${pending.workerId}`[0]
            ?.processedUpTo ?? 0;
        if (pending.lastSeq > processed) continue; // still gated
        const worker = workers.get(pending.workerId);
        // One verdict, one transaction (PR #46 review finding 3): the delete and the state
        // writes commit together — a crash between them would lose the parked verdict and
        // leave the worker lost+reaped with nothing left to resolve it.
        tx(() => {
          sql`DELETE FROM sh_reap_pending WHERE workerId = ${pending.workerId}`;
          resolved += 1;
          if (!worker || worker.state !== "lost" || worker.lastOutcome !== "reaped") return; // the story moved on
          const snapActive = (ACTIVE_WORKER_STATES as readonly string[]).includes(pending.snapState);
          if (snapActive) {
            sql`
              UPDATE sh_worker SET state = 'running', lastOutcome = NULL, updatedAt = ${now()}
              WHERE workerId = ${pending.workerId}
            `;
            timeline.add(pending.threadId, "resumed", "已恢复运行（回收后按连接器快照对账）", {
              workerId: pending.workerId,
              reconciled: true,
            });
          } else {
            // The connector says the run ended while it was unreachable: take its word for it.
            sql`
              UPDATE sh_worker SET state = ${pending.snapState}, updatedAt = ${now()}
              WHERE workerId = ${pending.workerId}
            `;
            timeline.add(pending.threadId, "note", `对账：连接器报告运行已结束（${pending.snapState}）`, {
              workerId: pending.workerId,
              reconciled: true,
            });
          }
          if (pending.snapState === 'broken') {
            recordBrokenQuestion(worker, `q_broken_${worker.workerId}_${processed}`, '自动恢复未成功（回收后对账），需要你决定下一步。');
          }
          recomputeThreadState(pending.threadId);
        });
      }
      return resolved;
    },

    /**
     * A start_worker the user withdrew (the dispatcher's `expired` — its only writer) ends
     * its still-`starting` worker quietly — timeline only, no push: the user already knows
     * they cancelled. Opens the Thread for a fresh dispatch instead of wedging it behind a
     * worker that will never run. (notAfter queue timeouts are `failed/not_after` and route
     * through markStartFailed with a push — the owner did NOT ask for that one.)
     */
    settleWithdrawnStart(workerId: string): boolean {
      const worker = workers.get(workerId);
      if (!worker || worker.state !== "starting") return false;
      sql`UPDATE sh_worker SET state = 'idle', lastOutcome = 'cancelled', updatedAt = ${now()} WHERE workerId = ${workerId}`;
      timeline.add(worker.threadId, "note", "派发命令已撤回，worker 未启动", { workerId, withdrawn: true });
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
    /** The Thread's reports, oldest first (receivedAt then arrival order — a same-ms burst
     *  stays in the order the connector sent it). Raw material for handoff briefs (§2.6). */
    listByThread(threadId: string): ReportRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_report WHERE threadId = ${threadId} ORDER BY receivedAt, rowid
      `.map(viewReport);
    },
  };

  // ---- handoff briefs (steward.md §2.6, issue #8) -------------------------------------------------

  const handoff = {
    /**
     * Assembles the deterministic brief for a new session on a Thread (§2.6): goal,
     * current state, deduped decisions with their source worker, the latest leftovers, and
     * git pointers — pointers, not content. The steward adds only the task at hand
     * afterwards (handoff.renderHandoffBrief leaves the section open for exactly that).
     *
     * `fromWorker` names the leg to continue from; it defaults to the Thread's latest
     * worker. Pointers fall back to the Thread's latest reported git facts when that leg
     * reported none (connector-pi.md §7.2: facts come from git, never the model).
     */
    build(threadId: string, fromWorker?: string): HandoffBrief | null {
      const thread = threads.get(threadId);
      if (!thread) return null;
      const all = workers.listByThread(threadId);
      if (all.length === 0) return null;
      const named = fromWorker !== undefined ? all.find((w) => w.workerId === fromWorker) : undefined;
      const fromWorkerRow = named ?? all.at(-1)!;
      const threadReports = reports.listByThread(threadId);
      const latestGit = threadReports.filter((r): r is ReportRow & { git: GitFacts } => r.git !== null).at(-1) ?? null;
      // A readonly from-leg has no branch of its own: its predecessor's pointers carry the
      // relay (finding 4) — same resolution the dispatcher uses for the base.
      const pointerWorker = fromWorkerRow.branch ? fromWorkerRow : workers.latestBranchOnThread(threadId);
      return assembleBrief({
        threadId,
        goal: thread.goal ?? thread.title,
        state: thread.summary,
        fromWorker: fromWorkerRow,
        ...(pointerWorker ? { pointerWorker } : {}),
        reports: threadReports,
        latestGit,
      });
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
    get(qid: string): QuestionRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_question WHERE qid = ${qid}`[0];
      return row ? viewQuestion(row) : null;
    },
    openForWorker(workerId: string): QuestionRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE workerId = ${workerId} AND status = 'open' ORDER BY askedAt, qid
      `.map(viewQuestion);
    },
    markHandled(qid: string): void {
      sql`UPDATE sh_question SET handledAt = COALESCE(handledAt, ${now()}) WHERE qid = ${qid}`;
    },
    setOptions(qid: string, options: string[]): void {
      sql`UPDATE sh_question SET options = ${JSON.stringify(options)} WHERE qid = ${qid} AND status = 'open'`;
    },
    /** Atomic timeout → intent. A reset can only replay the same durable intent. */
    queueFallbacks(): void {
      tx(() => {
        for (const q of sql<QuestionRow>`
          SELECT * FROM sh_question WHERE status = 'open' AND handledAt IS NULL AND fallbackDueAt <= ${now()}
        `) {
          if (q.threadId) notifications.queue(`question:${q.qid}`, 'attention_report', q.threadId, q.workerId, q.qid);
          questions.markHandled(q.qid);
        }
      });
    },
    nextFallback(): number | null {
      return sql<{ at: number | null }>`
        SELECT MIN(fallbackDueAt) AS at FROM sh_question WHERE status = 'open' AND handledAt IS NULL
      `[0]?.at ?? null;
    },
    /** Open, unhandled questions — the sweep's working set (§5.3). */
    unhandled(): QuestionRow[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_question WHERE status = 'open' AND handledAt IS NULL AND fallbackDueAt IS NOT NULL ORDER BY fallbackDueAt, qid
      `.map(viewQuestion);
    },
    /** Test seam: shrink/extend the window of an already-open question (mirrors the reducer). */
    setFallbackWindow(qid: string, ms: number): void {
      const q = questions.get(qid);
      if (!q) return;
      sql`UPDATE sh_question SET fallbackDueAt = ${q.askedAt + ms} WHERE qid = ${qid} AND status = 'open'`;
    },
    /** The ask_user button mapping (issue #7): plain options + routing candidates. */
    payload(qid: string): AskCandidates | null {
      const row = sql<{ options: string | null; candidates: string | null }>`
        SELECT options, candidates FROM sh_question WHERE qid = ${qid}
      `[0];
      if (!row) return null;
      return {
        options: jsonOrNull<string[]>(row.options) ?? [],
        candidates: jsonOrNull<AskCandidates["candidates"]>(row.candidates) ?? [],
      };
    },
    /** ask_user's insert (issue #7): threadId null for a threadless routing ask. */
    insert(input: { qid: string; threadId: string | null; workerId?: string | null; text: string; options?: string[]; candidates?: AskCandidates["candidates"]; kind?: QuestionRow["kind"]; fallbackDueAt?: number }): void {
      sql`
        INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, options, candidates, status, askedAt, kind, fallbackDueAt)
        VALUES (${input.qid}, ${input.threadId}, ${input.workerId ?? null}, ${input.text},
                ${JSON.stringify(input.options ?? [])}, ${JSON.stringify(input.candidates ?? [])}, 'open', ${now()},
                ${input.kind ?? 'steward'}, ${input.fallbackDueAt ?? null})
      `;
      if (input.threadId) recomputeThreadState(input.threadId);
    },
    /** Marks one question answered with what settled it (a click's chosen label). */
    close(qid: string, answer: string): boolean {
      sql`
        UPDATE sh_question SET status = 'answered', answeredAt = ${now()}
        WHERE qid = ${qid} AND status = 'open'
      `;
      const changed = sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      const row = changed ? questions.get(qid) : null;
      if (row?.threadId) {
        timeline.add(row.threadId, "note", `问题已回答：${answer.slice(0, 120)}`, { qid });
        recomputeThreadState(row.threadId);
      }
      return changed;
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
    /** A summary event. `threadId` null = a Thread-less record (a routine fire, §8.6) — kept
     *  for audit; thread pages filter by id so it never leaks into a Thread's timeline. */
    add(threadId: string | null, kind: string, text: string, refs: Record<string, unknown> | null): void {
      sql`
        INSERT INTO sh_timeline (threadId, ts, kind, text, refs)
        VALUES (${threadId}, ${now()}, ${kind}, ${text}, ${refs ? JSON.stringify(refs) : null})
      `;
      if (threadId !== null) sql`UPDATE sh_thread SET lastActivityAt = ${now()} WHERE threadId = ${threadId}`;
    },
    list(threadId: string): TimelineRow[] {
      return sql<TimelineRow>`SELECT id, threadId, ts, kind, text FROM sh_timeline WHERE threadId = ${threadId} ORDER BY id`;
    },
    /** The newest `limit` entries, oldest first — the workspace's compact view of a Thread. */
    recent(threadId: string, limit: number): TimelineRow[] {
      return sql<TimelineRow>`
        SELECT id, threadId, ts, kind, text FROM sh_timeline WHERE threadId = ${threadId} ORDER BY id DESC LIMIT ${limit}
      `.reverse();
    },
  };

  const offlineDispatches = {
    get(cmdId: string): OfflineDispatchRow | null {
      const row = sql<{ cmdId: string; threadId: string; deviceId: string; input: string; status: OfflineDispatchRow["status"]; choices: string | null }>`
        SELECT * FROM sh_offline_dispatch WHERE cmdId = ${cmdId}`[0];
      return row ? { ...row, input: JSON.parse(row.input), choices: JSON.parse(row.choices ?? "[]") } : null;
    },
    create(input: StartWorkerInput, threadId: string, deviceId: string): void {
      sql`INSERT OR IGNORE INTO sh_offline_dispatch (cmdId, threadId, deviceId, input)
        VALUES (${input.cmdId}, ${threadId}, ${deviceId}, ${JSON.stringify(input)})`;
    },
    transition(cmdId: string, from: OfflineDispatchRow["status"], to: OfflineDispatchRow["status"], choices: string[] = []): boolean {
      sql`UPDATE sh_offline_dispatch SET status = ${to}, choices = ${JSON.stringify(choices)} WHERE cmdId = ${cmdId} AND status = ${from}`;
      return sql<{ n: number }>`SELECT changes() AS n`[0]!.n > 0;
    },
    /** Flips switching → switched WITHOUT touching the stored choices, and `reopen` flips
     *  it back the same way (PR #51 review finding 8): the picker's buttons index into the
     *  choices, so any transition that rewrote them — including the forward one — would
     *  strand a refused switch exactly as before the fix. */
    markSwitched(cmdId: string, to: "switched" | "switching" = "switched"): boolean {
      const from = to === "switched" ? "switching" : "switched";
      sql`UPDATE sh_offline_dispatch SET status = ${to} WHERE cmdId = ${cmdId} AND status = ${from}`;
      return sql<{ n: number }>`SELECT changes() AS n`[0]!.n > 0;
    },
  };

  // ---- notification intents (§5.1 step 4) --------------------------------------------------------

  const notifications = {
    /** INSERT OR IGNORE on dedupeKey: the reducer transaction may be re-entered after a crash.
     *  `questionId` links #10's resolution window to its question row; `dueAt` is the
     *  machine-status debounce (§5.3) — such intents are data until the state has held for
     *  the window, and the drain re-checks them, not a timer promise. `payload` is #21's
     *  pr-intent render input (url/stage/message) — data the renderer reads, not state. */
    queue(
      dedupeKey: string,
      kind: NotifyRow["kind"],
      threadId: string,
      workerId: string | null,
      questionId: string | null = null,
      payload: string | null = null,
      dueAt?: number,
    ): void {
      // The debounced variants add the dueAt column; interpolation would bind a parameter,
      // not SQL text, so the statement is chosen before the template runs. Both variants
      // write payload — the column exists for everyone once migration 018 has run.
      const stmt =
        dueAt === undefined
          ? sql`INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, createdAt, questionId, payload)
                VALUES (${dedupeKey}, ${kind}, ${threadId}, ${workerId}, ${now()}, ${questionId}, ${payload})`
          : sql`INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, questionId, dueAt, createdAt, payload)
                VALUES (${dedupeKey}, ${kind}, ${threadId}, ${workerId}, ${questionId}, ${dueAt}, ${now()}, ${payload})`;
      void stmt;
    },
    /** Whether a row with this dedupeKey exists (sent or pending) — "already notified". */
    seen(dedupeKey: string): boolean {
      return sql`SELECT 1 AS one FROM sh_notify WHERE dedupeKey = ${dedupeKey}`.length > 0;
    },
    pending(): NotifyRow[] {
      return sql<NotifyRow>`SELECT id, dedupeKey, kind, threadId, workerId, questionId, payload FROM sh_notify WHERE sentAt IS NULL AND (dueAt IS NULL OR dueAt <= ${now()}) ORDER BY id`;
    },
    markSent(id: number): void {
      sql`UPDATE sh_notify SET sentAt = ${now()} WHERE id = ${id} AND sentAt IS NULL`;
    },
    /** A dropped intent (its news evaporated — a healed blip) is REMOVED, not marked sent:
     *  sentAt means "the owner was told", and later notices key off exactly that. */
    drop(id: number): void {
      sql`DELETE FROM sh_notify WHERE id = ${id} AND sentAt IS NULL`;
    },
  };

  // ---- PR consent gate (issue #21, spike-conclusions §2) ---------------------------------------

  const prConsent = {
    get(workerId: string, seq: number): PrConsentRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE workerId = ${workerId} AND seq = ${seq}
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    byCmd(cmdId: string): PrConsentRow | null {
      if (!cmdId) return null;
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE cmdId = ${cmdId} ORDER BY updatedAt DESC LIMIT 1
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    latestForWorker(workerId: string): PrConsentRow | null {
      const row = sql<Record<string, unknown>>`
        SELECT * FROM sh_pr_consent WHERE workerId = ${workerId} ORDER BY updatedAt DESC, seq DESC LIMIT 1
      `[0];
      return row ? viewPrConsent(row) : null;
    },
    /** Cross-card view of one worker's PR (review finding 5): consent rows are per report,
     *  but the PR is per worker/branch — any row's url answers for every card of that worker,
     *  and any approved-but-unresolved row means a dispatch is in flight. `pendingCmdId`
     *  names the in-flight command so a tap can prove liveness against the outbox. */
    branchState(workerId: string): { url: string | null; pending: boolean; pendingCmdId: string | null } {
      const rows = sql<{ url: string | null; decision: string; failure: string | null; cmdId: string | null }>`
        SELECT url, decision, failure, cmdId FROM sh_pr_consent WHERE workerId = ${workerId}
      `;
      const pendingRow = rows.find((r) => r.decision === "approved" && r.url === null && r.failure === null);
      return {
        url: rows.find((r) => r.url !== null)?.url ?? null,
        pending: pendingRow !== undefined,
        pendingCmdId: pendingRow?.cmdId ?? null,
      };
    },
    /** Records the user's tap. An upsert, never a silent re-create: a declined row may be
     *  approved later, and a failed approved row re-approved for another attempt (which
     *  clears the failure — the retry gets a fresh command id). */
    record(input: {
      workerId: string;
      seq: number;
      threadId: string;
      decision: "approved" | "declined";
      cmdId?: string | null;
      attempts?: number;
    }): void {
      sql`
        INSERT INTO sh_pr_consent (workerId, seq, threadId, decision, cmdId, attempts, url, failure, decidedAt, updatedAt)
        VALUES (${input.workerId}, ${input.seq}, ${input.threadId}, ${input.decision}, ${input.cmdId ?? null},
                ${input.attempts ?? 0}, NULL, NULL, ${now()}, ${now()})
        ON CONFLICT (workerId, seq) DO UPDATE SET
          decision = excluded.decision, cmdId = excluded.cmdId, attempts = excluded.attempts,
          url = NULL, failure = NULL, updatedAt = ${now()}
      `;
    },
    /** The pr_created landing: the loop's async answer (issue #21 AC2). */
    settleUrl(workerId: string, seq: number, url: string): void {
      sql`
        UPDATE sh_pr_consent SET url = ${url}, failure = NULL, updatedAt = ${now()}
        WHERE workerId = ${workerId} AND seq = ${seq}
      `;
    },
    /** The cmd_result(ok) backstop (review finding 4): the connector settles pr_worker with
     *  the URL even when the pr_created event was lost (its emit raced a shutdown). This
     *  delivers the card without the event; idempotent against the event path — whichever
     *  lands first wins, the other no-ops on the already-set url. */
    settleFromCommand(cmdId: string, url: string, branch: string): boolean {
      const row = prConsent.byCmd(cmdId);
      if (!row || (row.url !== null && row.url !== "")) return false;
      prConsent.settleUrl(row.workerId, row.seq, url);
      notifications.queue(
        `pr_created:cmd:${cmdId}`,
        "pr_created",
        row.threadId,
        row.workerId,
        null,
        JSON.stringify({ url, branch }),
      );
      timeline.add(row.threadId, "note", `PR 已创建：${url}${branch ? `（分支 ${branch}）` : ""}`, { workerId: row.workerId, cmdId });
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${row.threadId}`;
      recomputeThreadState(row.threadId);
      return true;
    },
    /** The failure sink both paths share — the pr_failed event AND a failed pr_worker
     *  command row (rejected at the door, or never delivered to an offline machine).
     *  Idempotent: only the FIRST failure on a decided row notifies; the duplicate that
     *  can follow (cmd_result after the event, or the event after the cmd path) must not
     *  push a second card. */
    fail(input: { workerId: string; cmdId?: string | null; stage: string; message: string }): boolean {
      const row = (input.cmdId ? prConsent.byCmd(input.cmdId) : null) ?? prConsent.latestForWorker(input.workerId);
      // url set = the PR exists: not a failure, whatever a racing duplicate says (it would
      // also clobber the good url with failure/NULL).
      if (!row || row.failure !== null || row.url !== null) return false;
      const message = input.message.slice(0, 280);
      sql`
        UPDATE sh_pr_consent SET failure = ${message}, url = NULL, updatedAt = ${now()}
        WHERE workerId = ${row.workerId} AND seq = ${row.seq}
      `;
      notifications.queue(
        // Attempt-scoped (review finding 1): the retry's failure must reach the owner too —
        // the row-level `failure IS NULL` guard alone deduped both attempts onto one card
        // because record() clears the marker between them. Both sinks of ONE attempt (the
        // pr_failed event and the failed cmd_result) still share this key: one card each.
        `prfail:${row.workerId}:${row.seq}:${row.attempts}`,
        "pr_failed",
        row.threadId,
        row.workerId,
        null,
        JSON.stringify({ stage: input.stage, message }),
      );
      timeline.add(
        row.threadId,
        "note",
        `推送/创建 PR 失败（${input.stage}）：${message}`,
        { workerId: row.workerId, ...(input.cmdId ? { cmdId: input.cmdId } : {}) },
      );
      sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${row.threadId}`;
      recomputeThreadState(row.threadId);
      return true;
    },
  };

  // ---- outbound queue rows (sh_outbound is ledger-owned; delivery policy lives in steward.ts)

  const outbound = {
    enqueue(input: {
      kind: "text" | "card";
      to: string;
      threadId?: string | null;
      questionId?: string | null;
      text?: string;
      card?: unknown;
      urgency?: "push" | "quiet";
      /** Structured merge section (issue #11): carried in the payload so a quiet group folds
       *  into one card that keeps each thread's three parts. */
      part?: QuietSection;
      /** The text carries a credential or is channel setup chatter: delivered, but kept out of
       *  the workspace's conversation. */
      private?: boolean;
      /** Stable dedupe key (review #6): same id → same row (INSERT OR IGNORE), never a second
       *  message; the id doubles as the provider-side uuid. Omitted: a fresh one-of message. */
      id?: string;
    }): string {
      // Issue #11 (steward.md §6.4): `urgency: push` is due NOW; a quiet row holds for the
      // merge window, ANCHORED at the oldest still-open quiet row for this channel+receiver —
      // arrivals inside an open window join it, later ones start their own.
      let dueAt = now();
      if ((input.urgency ?? "quiet") === "quiet") {
        const windowMs = quietWindowMs();
        const anchor = sql<{ at: number | null }>`
          SELECT MIN(createdAt) AS at FROM sh_outbound
          WHERE channel = 'local' AND receiveId = ${input.to} AND urgency = 'quiet'
            AND status = 'queued' AND createdAt > ${now() - windowMs}
        `[0]?.at;
        dueAt = anchor !== null && anchor !== undefined ? anchor + windowMs : now() + windowMs;
      }
      const payload = JSON.stringify({ text: input.text, card: input.card, part: input.part, ...(input.private ? { private: true } : {}) });
      if (input.id !== undefined) {
        sql`
          INSERT OR IGNORE INTO sh_outbound (id, channel, kind, receiveId, threadId, questionId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
          VALUES (${input.id}, 'local', ${input.kind}, ${input.to}, ${input.threadId ?? null}, ${input.questionId ?? null},
                  ${payload}, ${input.urgency ?? "quiet"}, 'queued', 0, ${dueAt}, ${now()})
        `;
        return input.id;
      }
      const id = ulid(); // stable across retries; doubles as the provider-side uuid
      sql`
        INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, questionId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
        VALUES (${id}, 'local', ${input.kind}, ${input.to}, ${input.threadId ?? null}, ${input.questionId ?? null},
                ${payload}, ${input.urgency ?? "quiet"}, 'queued', 0, ${dueAt}, ${now()})
      `;
      return id;
    },
    /** §3.1 signal 1: reply-to / card-callback routing, never data stuffed into the card.
     *  A MERGED card (issue #11) spans several threads — no single owner — so it routes to
     *  the conversation and the steward decides which matter the reply belongs to. */
    threadIdForProviderMsg(providerMsgId: string): string | null {
      const rows = outbound.threadIdsForProviderMsg(providerMsgId);
      return rows.length === 1 ? rows[0]! : null;
    },
    /** Every thread bound to a provider message (issue #11): one for single cards, several
     *  for a merged card — a reply to it means ALL of them were seen (§6.5). */
    threadIdsForProviderMsg(providerMsgId: string): string[] {
      return sql<{ threadId: string }>`
        SELECT DISTINCT threadId FROM sh_outbound WHERE providerMsgId = ${providerMsgId} AND threadId IS NOT NULL
      `.map((row) => row.threadId);
    },
    /** The full routing row behind a provider message: id (button actions key off it — e.g.
     *  `offer:` ids resolve a routine suggestion) plus its Thread, when bound. */
    rowForProviderMsg(providerMsgId: string): { id: string; threadId: string | null; questionId: string | null } | null {
      return sql<{ id: string; threadId: string | null; questionId: string | null }>`
        SELECT id, threadId, questionId FROM sh_outbound WHERE providerMsgId = ${providerMsgId}
      `[0] ?? null;
    },
    row(id: string): Record<string, unknown> | null {
      return sql<Record<string, unknown>>`SELECT * FROM sh_outbound WHERE id = ${id}`[0] ?? null;
    },
    /** Cards that may still hold a decision for the owner (the workspace's "Needs you"):
     *  questions, routine offers, offline asks, memory suggestions and PR consent. The
     *  caller decides which are still open; this only narrows the scan to what could be. */
    decisionCards(sinceMs: number): Record<string, unknown>[] {
      return sql<Record<string, unknown>>`
        SELECT * FROM sh_outbound
        WHERE kind = 'card' AND createdAt > ${sinceMs} AND (
          id LIKE 'offer:%' OR id LIKE 'offline:%' OR id LIKE 'switch:%' OR id LIKE 'noteask:%'
          OR (id LIKE 'notify:report:%' AND payload LIKE '%pr_approve%')
          OR questionId IS NOT NULL OR payload LIKE '%"action":"ask:%' OR payload LIKE '%"action":"asknew:%'
        )
        ORDER BY createdAt, id
      `;
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
    /** Due rows WITH their routing keys (issue #11): the delivery pass groups quiet rows by
     *  channel+receiver so one window leaves as one merged message. */
    dueRows(nowMs: number, batch: number): Array<{ id: string; urgency: string; channel: string; receiveId: string }> {
      return sql<{ id: string; urgency: string; channel: string; receiveId: string }>`
        SELECT id, urgency, channel, receiveId FROM sh_outbound
        WHERE status = 'queued' AND nextAttemptAt <= ${nowMs}
        ORDER BY createdAt, id LIMIT ${batch}
      `;
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
   *  the same kind without extending its dueAt, so wake latency stays bounded.
   *  `opts.operationId` (routine/follow-up fires): a fixed id with NO merging — each fire is
   *  its own steward input, and the operationId itself is the dedup (§8.2/§11). */
  const wakes = {
    queue(kind: WakeRow["kind"], dedupeKey: string, text: string, opts: { priority?: WakeRow["priority"]; mergeMs?: number; operationId?: string; dueAt?: number } = {}): void {
      const ts = now();
      if (sql`SELECT 1 FROM sh_wake WHERE dedupeKey = ${dedupeKey}`.length > 0) return;
      if (opts.operationId !== undefined) {
        sql`
          INSERT OR IGNORE INTO sh_wake (operationId, kind, dedupeKey, text, priority, status, dueAt, createdAt)
          VALUES (${opts.operationId}, ${kind}, ${dedupeKey}, ${text}, ${opts.priority ?? "normal"}, 'pending', ${opts.dueAt ?? ts}, ${ts})
        `;
        return;
      }
      const mergeMs = opts.mergeMs ?? WAKE_MERGE_MS;
      // Merge only within the same window class: a 10-minute external_activity wake must not
      // swallow a 3-second report wake (and vice versa) — their latencies answer different
      // needs (steward.md §5.3/§5.4). dueAt - createdAt is the row's own merge window.
      const open = sql<{ id: number; text: string }>`
        SELECT id, text FROM sh_wake
        WHERE kind = ${kind} AND status = 'pending' AND dueAt > ${ts}
          AND dueAt - createdAt >= ${Math.max(mergeMs - 1, 1)} AND dueAt - createdAt <= ${mergeMs + 1}
        ORDER BY id LIMIT 1
      `[0];
      if (open) {
        // §5.4: events within the window become ONE wake-up — append this block to the
        // pending row's text. The row keeps its operationId: one steward input, ever.
        sql`UPDATE sh_wake SET text = ${open.text + "\n" + text},
          priority = CASE WHEN ${opts.priority ?? 'normal'} = 'high' THEN 'high' ELSE priority END,
          dueAt = MIN(dueAt, ${ts + mergeMs}) WHERE id = ${open.id}`;
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
        SELECT * FROM sh_wake WHERE status = 'pending' AND dueAt <= ${nowMs} ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, dueAt, id
      `;
    },
    /** Earliest pending dueAt (the next moment the drain alarm must fire), or null. */
    earliestDue(nowMs: number): number | null {
      return sql<{ at: number | null }>`SELECT MIN(dueAt) AS at FROM sh_wake WHERE status = 'pending'`[0]?.at ?? null;
    },
    markSubmitted(id: number): void {
      sql`UPDATE sh_wake SET status = 'submitted', submittedAt = ${now()} WHERE id = ${id} AND status = 'pending'`;
    },
    /** Issue #28 (steward.md §12): the daily budget cap kept this wake from the model. The
     *  row is done — 'skipped' never re-drains — and its audit trail stays in sh_channel_log
     *  (plus sh_routine/sh_followup.lastResult for fires, which own an outcome either way). */
    markSkipped(id: number): void {
      sql`UPDATE sh_wake SET status = 'skipped', submittedAt = ${now()} WHERE id = ${id} AND status = 'pending'`;
    },
  };

  const ownerInputs = {
    record(channel: "local" | "web" | "feishu", msgId: string, text: string | null, threadId: string | null = null): void {
      sql`
        INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text, threadId)
        VALUES (${channel}, ${msgId}, ${msgId}, 'message', ${now()}, 1, ${text}, ${threadId})
        ON CONFLICT(channel, msgId) DO UPDATE SET text = COALESCE(sh_inbound.text, excluded.text),
          threadId = COALESCE(sh_inbound.threadId, excluded.threadId), ownerAuthorized = 1
      `;
    },
  };

  const webRequests = {
    get(id: string): { payload: string; status: string } | null {
      return sql<{ payload: string; status: string }>`SELECT payload, status FROM sh_web_request WHERE id = ${id}`[0] ?? null;
    },
    start(id: string, payload: string): void {
      sql`INSERT OR IGNORE INTO sh_web_request (id, payload, createdAt) VALUES (${id}, ${payload}, ${now()})`;
    },
    complete(id: string): void {
      sql`UPDATE sh_web_request SET status = 'done' WHERE id = ${id}`;
    },
    pending(): Array<{ id: string; payload: string }> {
      return sql<{ id: string; payload: string }>`SELECT id, payload FROM sh_web_request WHERE status = 'pending' ORDER BY createdAt`;
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
    /** One more real dispatch happened inside this run (settle-time verification, issue #7). */
    countDispatch(operationId: string): void {
      sql`UPDATE sh_run SET dispatchCount = dispatchCount + 1 WHERE operationId = ${operationId}`;
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

  // ---- routines / follow-ups / offers (issue #20, steward.md §8) -------------------------------

  const routines = {
    create(input: {
      routineId: string;
      kind: RoutineKind;
      createdFromMsg: string;
      scheduleKind: "cron" | "once";
      cron?: string | null;
      onceAt?: number | null;
      instruction: string;
      threadId?: string | null;
      repoId?: string | null;
    }): RoutineRow {
      const ts = now();
      sql`
        INSERT OR IGNORE INTO sh_routine (routineId, kind, createdFromMsg, scheduleKind, cron, onceAt, instruction, repoId, threadId, status, createdAt)
        VALUES (${input.routineId}, ${input.kind}, ${input.createdFromMsg}, ${input.scheduleKind}, ${input.cron ?? null}, ${input.onceAt ?? null},
                ${input.instruction}, ${input.repoId ?? null}, ${input.threadId ?? null}, 'active', ${ts})
      `;
      return routines.get(input.routineId)!;
    },
    get(routineId: string): RoutineRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_routine WHERE routineId = ${routineId}`[0];
      return row ? viewRoutine(row) : null;
    },
    list(): RoutineRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_routine ORDER BY createdAt, routineId`.map(viewRoutine);
    },
    exists(routineId: string): boolean {
      return sql`SELECT 1 AS one FROM sh_routine WHERE routineId = ${routineId}`.length > 0;
    },
    setScheduleId(routineId: string, scheduleId: string): void {
      sql`UPDATE sh_routine SET scheduleId = ${scheduleId} WHERE routineId = ${routineId}`;
    },
    setStatus(routineId: string, status: RoutineStatus): boolean {
      sql`UPDATE sh_routine SET status = ${status} WHERE routineId = ${routineId}`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /**
     * The fire-level gate (§8.2/§11): claims this exact fire (`routine:<id>:<fireTime>`)
     * atomically. False = already processed — the SDK re-dispatched the job, or the alarm
     * replayed it — and the caller must do nothing. Also stamps lastRunAt/lastResult and
     * retires once-routines (a re-armed past onceAt must never fire twice).
     */
    beginFire(routineId: string, operationId: string, initialResult: string): boolean {
      return tx(() => {
        const row = sql<{ status: string; lastFireKey: string | null; scheduleKind: string }>`
          SELECT status, lastFireKey, scheduleKind FROM sh_routine WHERE routineId = ${routineId}
        `[0];
        if (!row || row.status !== "active" || row.lastFireKey === operationId) return false;
        sql`
          UPDATE sh_routine SET lastFireKey = ${operationId}, lastRunAt = ${now()}, lastResult = ${initialResult},
                                outcomeRecorded = 0,
                                status = CASE WHEN scheduleKind = 'once' THEN 'done' ELSE status END
          WHERE routineId = ${routineId}
        `;
        return true;
      });
    },
    /** The run's outcome (explicit no_action, or the settle fallback). Explicit wins. */
    recordOutcome(routineId: string, outcome: string): void {
      sql`
        UPDATE sh_routine SET lastResult = ${outcome}, outcomeRecorded = 1
        WHERE routineId = ${routineId} AND outcomeRecorded = 0
      `;
    },
  };

  const followups = {
    create(input: {
      followupId: string;
      threadId: string;
      dueAt: number;
      reason: string;
      createdBy: "user" | "steward";
      sourceRef: string;
    }): FollowupRow {
      sql`
        INSERT OR IGNORE INTO sh_followup (followupId, threadId, dueAt, reason, createdBy, sourceRef, status, createdAt)
        VALUES (${input.followupId}, ${input.threadId}, ${input.dueAt}, ${input.reason}, ${input.createdBy}, ${input.sourceRef}, 'open', ${now()})
      `;
      return followups.get(input.followupId)!;
    },
    get(followupId: string): FollowupRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_followup WHERE followupId = ${followupId}`[0];
      return row ? viewFollowup(row) : null;
    },
    listByThread(threadId: string): FollowupRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_followup WHERE threadId = ${threadId} ORDER BY createdAt`.map(viewFollowup);
    },
    list(): FollowupRow[] {
      return sql<Record<string, unknown>>`SELECT * FROM sh_followup ORDER BY createdAt, followupId`.map(viewFollowup);
    },
    exists(followupId: string): boolean {
      return sql`SELECT 1 AS one FROM sh_followup WHERE followupId = ${followupId}`.length > 0;
    },
    setScheduleId(followupId: string, scheduleId: string): void {
      sql`UPDATE sh_followup SET scheduleId = ${scheduleId} WHERE followupId = ${followupId}`;
    },
    setStatus(followupId: string, status: FollowupStatus): boolean {
      sql`UPDATE sh_followup SET status = ${status} WHERE followupId = ${followupId}`;
      return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    },
    /** The fire gate: only an `open` follow-up fires exactly once (status flips to `fired`). */
    beginFire(followupId: string, initialResult: string): boolean {
      return tx(() => {
        sql`
          UPDATE sh_followup SET status = 'fired', firedAt = ${now()}, lastResult = ${initialResult}, outcomeRecorded = 0
          WHERE followupId = ${followupId} AND status = 'open'
        `;
        return sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      });
    },
    recordOutcome(followupId: string, outcome: string): void {
      sql`
        UPDATE sh_followup SET lastResult = ${outcome}, outcomeRecorded = 1
        WHERE followupId = ${followupId} AND outcomeRecorded = 0
      `;
    },
  };

  const offers = {
    create(input: { offerId: string; spec: RoutineSpecStored; sourceMsg: string; outboundId: string }): RoutineOfferRow {
      sql`
        INSERT OR IGNORE INTO sh_routine_offer (offerId, spec, sourceMsg, status, outboundId, createdAt)
        VALUES (${input.offerId}, ${JSON.stringify(input.spec)}, ${input.sourceMsg}, 'offered', ${input.outboundId}, ${now()})
      `;
      return offers.get(input.offerId)!;
    },
    get(offerId: string): RoutineOfferRow | null {
      const row = sql<Record<string, unknown>>`SELECT * FROM sh_routine_offer WHERE offerId = ${offerId}`[0];
      return row ? viewOffer(row) : null;
    },
    /** The tap consumes the offer exactly once; false = already handled or unknown. */
    consume(offerId: string, status: "accepted" | "dismissed"): RoutineOfferRow | null {
      const row = offers.get(offerId);
      if (!row || row.status !== "offered") return null;
      sql`UPDATE sh_routine_offer SET status = ${status} WHERE offerId = ${offerId} AND status = 'offered'`;
      return { ...row, status };
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

    // Issue #13 review finding 2: a worker reaped by the DO that produces an event is alive.
    // If a hello-snapshot verdict is parked for this worker (its stream was behind at
    // reconnect), that verdict — not this event, which may predate the reap — decides once
    // the stream catches up (workers.resolveReapPending).
    const resurrectable =
      worker.state === "lost" &&
      worker.lastOutcome === "reaped" &&
      sql`SELECT 1 AS one FROM sh_reap_pending WHERE workerId = ${workerId}`.length === 0;

    // Issue #14: an event from the machine is contact, whatever the DO believed during the
    // drop — the unreachable mark dies with the first real news.
    sql`UPDATE sh_worker SET unreachable = 0 WHERE workerId = ${workerId}`;
    switch (type) {
      case "queued": {
        // §8.2 serial repos (issue #16): the connector parked this write worker behind the
        // repo's current one; `started` follows when the slot frees. Not a failure — the
        // Thread stays running-shaped. A reaped worker that re-parks is provably alive:
        // clear the marker like every other resume path.
        sql`
          UPDATE sh_worker SET state = 'queued',
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, "note", "排队中：等同一仓库的前一个写任务结束（serial 模式）", {
          workerId,
          seq,
          behind: event.behind ?? null,
        });
        break;
      }
      case "started": {
        // branch COALESCEs: a resumed session's started event carries no branch (the hot
        // prompt path, connector-pi.md §6.2) and must not erase the branch the ledger
        // already holds — it is the relay base for the next leg (issue #8).
        sql`
          UPDATE sh_worker SET state = 'running', sessionId = ${str(event.sessionId)},
                              branch = COALESCE(${str(event.branch)}, branch),
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
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
        // Coarse progress only updates the worker; it never reaches the timeline (§5.3) —
        // except when it proves a reaped worker is alive (issue #13 review finding 2).
        const lastProgress = JSON.stringify({ phase: event.phase, tool: event.tool ?? null, target: event.target ?? null, turn: event.turn ?? null });
        if (resurrectable) {
          sql`
            UPDATE sh_worker SET state = 'running', lastOutcome = NULL, lastEventAt = ${ts},
                                lastProgress = ${lastProgress}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          timeline.add(worker.threadId, "resumed", "重新收到事件，恢复运行（回收后自动纠正）", { workerId, seq, resurrected: true });
          recomputeThreadState(worker.threadId);
        } else {
          sql`
            UPDATE sh_worker SET lastEventAt = ${ts}, lastProgress = ${lastProgress}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
        }
        sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
        return; // no further state change
      }
      case "report": {
        if (resurrectable) {
          // A report from a worker the DO reaped: it is alive (issue #13 review finding 2).
          sql`UPDATE sh_worker SET state = 'running', lastOutcome = NULL, updatedAt = ${now()} WHERE workerId = ${workerId}`;
          timeline.add(worker.threadId, "resumed", "重新收到事件，恢复运行（回收后自动纠正）", { workerId, seq, resurrected: true });
        }
        const status = (event.status === "blocked" || event.status === "needs_decision" ? event.status : "done") as ReportRow["status"];
        sql`
          INSERT OR IGNORE INTO sh_report (workerId, seq, threadId, status, summary, changes, decisions, leftovers, tests, question, next, git, answer, receivedAt)
          VALUES (${workerId}, ${seq}, ${worker.threadId}, ${status}, ${str(event.summary) ?? ""},
                  ${event.changes ? JSON.stringify(event.changes) : null},
                  ${event.decisions ? JSON.stringify(event.decisions) : null},
                  ${event.leftovers ? JSON.stringify(event.leftovers) : null},
                  ${event.tests ? JSON.stringify(event.tests) : null},
                  ${str(event.question)}, ${str(event.next)},
                  ${event.git ? JSON.stringify(event.git) : null}, ${str(event.answer)}, ${now()})
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
          questions.insert({
            qid: `q_${workerId}_${seq}`, threadId: worker.threadId, workerId,
            text: str(event.question) ?? str(event.summary) ?? '', kind: 'report',
            fallbackDueAt: now() + QUESTION_WINDOW_MS,
          });
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
            notified: status === "done",
            // issue #8: the anti-drift rewrite prompt rides the done-bookkeeping wake.
            ...(status === "done" && threads.summaryStatus(worker.threadId).rewriteDue ? { summaryRewriteDue: true } : {}),
            ...(status !== "done" ? { questionId: `q_${workerId}_${seq}` } : {}),
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
          const text = settledQuestionText(outcome, errorClass, event);
          const qid = `q_${workerId}_${seq}`;
          const unreported = outcome === 'unreported';
          questions.insert({ qid, threadId: worker.threadId, workerId, text, kind: unreported ? 'unreported' : 'failure' });
          sql`
            UPDATE sh_worker SET state = ${unreported || errorClass === 'context' ? 'idle' : 'broken'},
              lastOutcome = ${unreported ? 'unreported' : `error:${errorClass ?? outcome}`}, lastEventAt = ${ts}, updatedAt = ${now()}
            WHERE workerId = ${workerId}
          `;
          sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
          timeline.add(worker.threadId, "question", text, { workerId, seq, errorClass });
          if (!unreported) notifications.queue(`settled:${workerId}:${seq}`, "failure_push", worker.threadId, workerId, qid);
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
              notified: !unreported,
              questionId: qid,
            }),
            { priority: "high" },
          );
        }
        if (event.usage) {
          sql`UPDATE sh_worker SET lastProgress = ${JSON.stringify({ usage: event.usage })} WHERE workerId = ${workerId}`;
          // issue #8: context usage in percent — the resume-vs-new-session input
          // (connector-pi.md §11.2). percent wins; tokens/contextWindow stands in when
          // the connector did not compute one.
          const cu = (event.usage as { contextUsage?: { percent?: unknown; tokens?: unknown; contextWindow?: unknown } }).contextUsage;
          const percent =
            typeof cu?.percent === "number" && cu.percent >= 0
              ? cu.percent
              : typeof cu?.tokens === "number" && typeof cu.contextWindow === "number" && cu.contextWindow > 0
                ? (cu.tokens / cu.contextWindow) * 100
                : null;
          if (percent !== null) {
            sql`UPDATE sh_worker SET contextPercent = ${Math.round(percent)} WHERE workerId = ${workerId}`;
          }
        }
        break;
      }
      case "broken": {
        // The connector currently surfaces a broken worker through settled error events
        // (breakWorker emits error-class settles) and the hello/reap reconcile paths — this
        // explicit protocol event is the defensive shape for a future producer. Review note
        // (a): kept deliberately; the rules table's `broken` row is wired either way.
        sql`UPDATE sh_worker SET state = 'broken', lastOutcome = 'broken', lastEventAt = ${ts}, updatedAt = ${now()} WHERE workerId = ${workerId}`;
        recordBrokenQuestion(worker, `q_${workerId}_${seq}`, str(event.reason) ?? '自动恢复未成功，需要你决定下一步。');
        break;
      }
      case "lost":
      case "resumed": {
        // lost: not failed — the steward waits (spec §9). resumed: back to running (and a
        // resumed worker is by definition no longer reaped).
        sql`
          UPDATE sh_worker SET state = ${type === "lost" ? "lost" : "running"},
                              lastOutcome = CASE WHEN lastOutcome = 'reaped' THEN NULL ELSE lastOutcome END,
                              lastEventAt = ${ts}, updatedAt = ${now()}
          WHERE workerId = ${workerId}
        `;
        timeline.add(worker.threadId, type, lostResumedText(type, event), { workerId, seq });
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
        // §10: the connector compared the session tail against lastKnownEntryId before a
        // relaunch and found entries it did not write — the owner used the session at the
        // keyboard. Deterministic timeline note (counts, window, coarse summary); the steward
        // is woken at low priority to fold the summary into the Thread (steward.md §5.3),
        // merging over the §5.4 10-minute window.
        const count = Number(event.entries ?? 0);
        const changedFiles = (Array.isArray(event.changedFiles) ? event.changedFiles : []).map((f) => String(f));
        const summary = str(event.summary) ?? "";
        const window = [str(event.firstAt), str(event.lastAt)].filter((v) => v !== null).join(" ~ ");
        timeline.add(
          worker.threadId,
          "note",
          `会话在机器上被直接使用过：新增 ${count} 条记录${window ? `（${window}）` : ""}${changedFiles.length ? `，改动文件：${changedFiles.join("、")}` : ""}${summary ? `。${summary}` : ""}`,
          { workerId, seq, entries: count, firstAt: event.firstAt ?? null, lastAt: event.lastAt ?? null, changedFiles },
        );
        wakes.queue(
          "event",
          `external_activity:${workerId}:${seq}`,
          externalActivityWakeText({
            thread: threads.get(worker.threadId),
            worker: workers.get(workerId)!,
            machine: machines.get(worker.deviceId),
            count,
            window: window || null,
            changedFiles,
            summary,
          }),
          { priority: "low", mergeMs: EXTERNAL_ACTIVITY_MERGE_MS },
        );
        break;
      }
      case "pr_created": {
        // The consent gate's async answer (issue #21 AC2): the connector pushed the branch
        // and gh opened the PR. Deterministic card, no wake — there is nothing for the model
        // to decide; the URL is recorded on the consent row so a repeated [同意] answers
        // honestly instead of opening a second PR.
        const url = str(event.url) ?? "";
        const branch = str(event.branch);
        const consentRow = (str(event.cmdId) ? prConsent.byCmd(str(event.cmdId)!) : null) ?? prConsent.latestForWorker(workerId);
        // Review finding 4: the cmd_result(ok) backstop may have settled this URL already
        // (the event was lost once and replayed, or the two simply raced) — one card per PR.
        if (consentRow && url !== "" && consentRow.url === url) break;
        if (consentRow) prConsent.settleUrl(consentRow.workerId, consentRow.seq, url);
        timeline.add(
          worker.threadId,
          "note",
          `PR 已创建${url ? `：${url}` : ""}${branch ? `（分支 ${branch}）` : ""}`,
          { workerId, seq, url },
        );
        sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
        notifications.queue(
          `pr_created:${workerId}:${seq}`,
          "pr_created",
          worker.threadId,
          workerId,
          null,
          JSON.stringify({ url, branch: branch ?? "" }),
        );
        break;
      }
      case "pr_failed": {
        // The failure half (issue #21 AC4): the classified stage rides the payload so the
        // card can tell the owner what to fix on the machine. prConsent.fail owns the
        // timeline/unread/notify — it is shared with the failed-command path and dedupes
        // between the two.
        prConsent.fail({
          workerId,
          cmdId: str(event.cmdId) || null,
          stage: str(event.stage) ?? "unknown",
          message: str(event.message) ?? "",
        });
        break;
      }
      default:
        // process_exit and future event types carry no ledger semantics yet.
        break;
    }

    sql`UPDATE worker_ack SET processedUpTo = ${seq} WHERE workerId = ${workerId}`;
    recomputeThreadState(worker.threadId);
  }

  /** The terminal broken paths (event, rejected start, and snapshot reconciliation) agree. */
  function recordBrokenQuestion(worker: WorkerRow, qid: string, text: string): void {
    // A cmd_result and its failure event can describe the same terminal transition.
    if (questions.openForWorker(worker.workerId).some(q => q.kind === 'failure')) return;
    questions.insert({ qid, threadId: worker.threadId, workerId: worker.workerId, text, kind: 'failure' });
    timeline.add(worker.threadId, 'question', text, { qid, workerId: worker.workerId });
    sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${worker.threadId}`;
    notifications.queue(`question:${qid}`, 'failure_push', worker.threadId, worker.workerId, qid);
    wakes.queue('event', `question:${qid}`, eventWakeText({
      thread: threads.get(worker.threadId), worker, machine: machines.get(worker.deviceId),
      report: null, settled: { outcome: 'broken', errorClass: null, text }, notified: true, questionId: qid,
    }), { priority: 'high' });
  }

  /**
   * Thread derived state (steward.md §5.2): a pure function recomputed after every change,
   * never set by the LLM or the user. `unread` is set where the news lands, cleared on read.
   */
  function recomputeThreadState(threadId: string): void {
    sql`
      UPDATE sh_thread SET state = CASE
        WHEN EXISTS (
          SELECT 1 FROM sh_worker w WHERE w.threadId = sh_thread.threadId AND w.state IN ('queued', 'starting', 'running', 'recovering')
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
    /** Owner-facing data only: internal wake/run text and worker transcripts stay out. */
    workspace() {
      return {
        threads: threads.list().map((thread) => ({
          ...thread,
          repoIds: threads.repoIds(thread.threadId),
          workers: workers.listByThread(thread.threadId).map((worker) => ({
            ...withMachineName(worker),
            report: reports.latestForWorker(worker.workerId),
            consent: prConsent.latestForWorker(worker.workerId),
          })),
          timeline: timeline.recent(thread.threadId, WORKSPACE_TIMELINE),
        })),
        machines: machines.list().map((machine) => ({ ...machine, running: machines.runningCount(machine.deviceId) })),
        repos: repos.list(),
        inputs: sql<{ id: string; text: string; threadId: string | null; at: number; channel: string }>`
          SELECT i.msgId AS id, i.text, COALESCE(r.routedThreadId, i.threadId) AS threadId, i.receivedAt AS at, i.channel
          FROM sh_inbound i LEFT JOIN sh_run r ON r.operationId = 'user:' || i.msgId
          WHERE i.ownerAuthorized = 1 AND i.text IS NOT NULL ORDER BY i.receivedAt DESC, i.msgId DESC LIMIT ${WORKSPACE_MESSAGES}
        `.reverse(),
        outbound: sql<Record<string, unknown>>`
          SELECT * FROM sh_outbound ORDER BY createdAt DESC, id DESC LIMIT ${WORKSPACE_MESSAGES}
        `.reverse(),
        decisionCards: outbound.decisionCards(now() - WORKSPACE_DECISION_WINDOW_MS),
        activity: sql<TimelineRow>`SELECT id, threadId, ts, kind, text FROM sh_timeline ORDER BY id DESC LIMIT 20`.reverse(),
        /** The steward is working on something the owner asked for. */
        busy: runs.openRows().some((run) => run.kind === "user" || run.kind === "verify"),
      };
    },
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
      /** Every question row, threadless routing asks included (issue #7). */
      questions: QuestionRow[];
      /** The consent gate's rows (issue #21) — what the user tapped and what came back. */
      prConsent: PrConsentRow[];
      pendingNotifications: NotifyRow[];
      runs: RunRow[];
      wakes: WakeRow[];
      notes: NoteRow[];
      noteLog: Array<{ id: number; ts: number; op: string; noteId: string; text: string; reason: string | null; reportedAt: number | null }>;
      routines: RoutineRow[];
      followups: FollowupRow[];
      offers: RoutineOfferRow[];
      /** The newest timeline entries across ALL threads — routine fires may be Thread-less. */
      timelineRecent: Array<{ id: number; threadId: string | null; ts: number; kind: string; text: string }>;
      /** The open/answered offline asks (issue #14): cmdId → status + machine choices. */
      offlineDispatches: Array<{ cmdId: string; threadId: string; deviceId: string; status: string; choices: string[] }>;
    } {
      return {
        machines: machines.list(),
        threads: threads.list().map((t) => ({
          ...t,
          repoIds: threads.repoIds(t.threadId),
          workers: workers.listByThread(t.threadId),
          questions: sql<QuestionRow>`
            SELECT * FROM sh_question WHERE threadId = ${t.threadId} ORDER BY askedAt
          `,
          timeline: timeline.list(t.threadId),
        })),
        questions: sql<QuestionRow>`
          SELECT * FROM sh_question ORDER BY askedAt
        `,
        prConsent: sql<Record<string, unknown>>`SELECT * FROM sh_pr_consent ORDER BY decidedAt`.map(viewPrConsent),
        pendingNotifications: notifications.pending(),
        runs: runs.rows(),
        wakes: sql<WakeRow>`SELECT * FROM sh_wake ORDER BY id`,
        notes: sql<Record<string, unknown>>`SELECT * FROM sh_note ORDER BY createdAt, noteId`.map((r) => ({
          ...r,
          confirmed: !!r.confirmed,
          pinned: !!r.pinned,
        })) as unknown as NoteRow[],
        noteLog: sql<{ id: number; ts: number; op: string; noteId: string; text: string; reason: string | null; reportedAt: number | null }>`
          SELECT id, ts, op, noteId, text, reason, reportedAt FROM sh_note_log ORDER BY id
        `,
        routines: routines.list(),
        followups: followups.list(),
        offers: sql<Record<string, unknown>>`SELECT * FROM sh_routine_offer ORDER BY createdAt`.map(viewOffer),
        timelineRecent: sql<{ id: number; threadId: string | null; ts: number; kind: string; text: string }>`
          SELECT id, threadId, ts, kind, text FROM sh_timeline ORDER BY id DESC LIMIT 20
        `.reverse(),
        offlineDispatches: sql<{ cmdId: string; threadId: string; deviceId: string; status: string; choices: string | null }>`
          SELECT cmdId, threadId, deviceId, status, choices FROM sh_offline_dispatch ORDER BY cmdId
        `.map((r) => ({ ...r, choices: JSON.parse(r.choices ?? "[]") })),
      };
    },
  };

  return {
    machines, machineStatus, offlineDispatches, repos, threads, workers, reports, questions, timeline, notifications, outbound,
    runs, ownerInputs, webRequests, wakes, notes, budget, routines, followups, offers, handoff, views, applyPendingEvents, recomputeThreadState, debug,
    prConsent,
  };
}

export type Ledger = ReturnType<typeof createLedger>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Timeline text for `lost` / `resumed` events; `resumed` carries its reason when given. */
function lostResumedText(type: string, event: Record<string, unknown>): string {
  const reason = str(event.reason);
  if (type === "lost") return `失去联系（${reason ?? "未知原因"}）`;
  return reason ? `已恢复继续运行（${reason}）` : "已恢复继续运行";
}

/** The deterministic question text for failure-class settled events (steward.md §5.3). */
function settledQuestionText(outcome: string, errorClass: string | null, event: Record<string, unknown>): string {
  const lastText = typeof event.lastText === "string" && event.lastText.length > 0 ? event.lastText : "";
  const detail = lastText ? `（${lastText.slice(0, 160)}）` : "";
  if (outcome === "unreported") {
    return `worker 结束时没有产出汇报。${lastText ? `最后说：${lastText.slice(0, 300)}` : ""}`;
  }
  switch (errorClass) {
    case "auth":
      // §9.2: auth never auto-resumes — the detail says what the connector saw (e.g. a
      // failed resume), the base says what the user must do.
      return `机器上的模型凭据失效（401/403），需要你在那台机器上修复后重新派发。${detail}`;
    case "context":
      return "上下文超长，这个会话装不下了；建议开一个新会话，带上交接简报继续。";
    case "stall":
      // The connector's watchdog already gave the run one automatic restart (issue #13);
      // a stall reaching the user means even that did not bring it back.
      return `worker 长时间无输出且 CPU 近零，自动重启一次后仍然挂死，需要你决定下一步。${detail}`;
    default:
      // error:unknown — includes the connector's terminal §9.2 outcomes (resume failed /
      // budget exhausted / startup interrupted), whose reason rides in lastText.
      return `运行出错（${errorClass ?? "未知"}），需要你决定下一步。${detail}`;
  }
}
