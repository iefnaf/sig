// Notes: the memory module's knowledge half (issue #18, steward.md §2.3-§2.5, spec §10).
// Three layers — resident (always loaded, 2,400-char hard cap), project (per repo, 1,500),
// archive (superseded/demoted/evicted; never deleted, searched on demand) — written through
// a two-phase interface: propose() normalizes, dedupes, and surfaces similar entries plus
// eviction candidates; commit() is the only writer, enforcing caps and trust rules. Every
// change lands in sh_note_log; pending rows are relayed to the user with the next reply
// (drainPendingForReply) — the deterministic half of "silent memory is unacceptable"
// (spec §10.3), the announcement lines being the other half.
//
// Trust (spec §10.3, anti memory-poisoning): `user_said` may enter the resident layer;
// `connector` facts stay project-layer (live reports are the source of truth); and
// `worker_reported` / `inferred` entries stay unconfirmed in the project layer until the
// owner confirms — only then may they be promoted. The notes module enforces the layer
// rules deterministically; the evidence that the owner really confirmed (`user:<msgId>`)
// is verified one layer up, by the notes_commit / notes_confirm tools.
//
// All SQL here is owned by this module (sh_note, sh_note_fts, sh_note_log); callers reach
// notes only through the ledger's `notes` handle, like every other sh_* table.
import { ulid } from "@alexlikevibe/protocol";
import type { LedgerSql } from "./ledger.ts";

/** steward.md §2.3: resident-layer hard cap (characters of normalized text). */
export const RESIDENT_CAP = 2_400;
/** steward.md §2.3: project-layer cap, per repo. */
export const PROJECT_CAP_PER_REPO = 1_500;
/** steward.md §2.5: retention score source weights — the lower, the earlier evicted. */
export const SOURCE_WEIGHT: Record<NoteSource, number> = {
  user_said: 1.0,
  connector: 0.9,
  worker_reported: 0.4,
  inferred: 0.3,
};
/** steward.md §2.5: project entries unused this long are demoted to the archive. */
export const PROJECT_DEMOTE_AFTER_MS = 60 * 86_400_000;
/** steward.md §2.5: resident entries unused this long get a demotion *suggestion*. */
export const RESIDENT_SUGGEST_AFTER_MS = 90 * 86_400_000;
/** The suggestion must not re-fire daily while it waits for the user: quiet after 30 days. */
const SUGGEST_QUIET_MS = 30 * 86_400_000;
/** Propose surfaces at most this many similar entries (steward.md §2.4: "the closest few"). */
const MAX_SIMILAR = 3;
/** Trigram-Jaccard floor for "similar" — below it the entries are just neighbors. */
const SIMILAR_MIN = 0.25;
/** The relay block stays readable: at most this many clauses, then a count line. */
const MAX_RELAY_ITEMS = 10;
const RELAY_MAX_CHARS = 600;
/** One maintenance pass delivers at most this many pending rows of its own (issue #19):
 *  one bookkeeping text plus at most this many cards — the rest stays pending for the next
 *  pass or the next reply, never dropped, never a burst (PR #53 review finding 7). */
const MAX_MAINTENANCE_BATCH = 20;

export type NoteLayer = "resident" | "project" | "archive";
export type NoteKind = "preference" | "convention" | "environment" | "fact";
export type NoteSource = "user_said" | "connector" | "worker_reported" | "inferred";
export type NoteStatus = "active" | "superseded" | "removed";

/** The sources that may not enter the resident layer unconfirmed (steward.md §2.3). */
export const LOW_TRUST_SOURCES: readonly NoteSource[] = ["worker_reported", "inferred"];

export const isNoteSource = (v: string): v is NoteSource =>
  v === "user_said" || v === "connector" || v === "worker_reported" || v === "inferred";
export const isNoteKind = (v: string): v is NoteKind =>
  v === "preference" || v === "convention" || v === "environment" || v === "fact";

export interface NoteDraft {
  text: string;
  kind: NoteKind;
  source: NoteSource;
  /** Target layer at write time; `archive` is reached only by the module's own moves. */
  layer: "resident" | "project";
  /** Required for (and only meaningful at) the project layer. */
  scopeRepoId?: string;
  /** Where it came from: a `user:<msgId>` for user_said, a worker/report reference, … */
  evidence?: string | null;
  /** Set only when the owner has affirmed a low-trust entry (the tool layer verifies the ref). */
  confirmed?: boolean;
}

export interface NoteRow {
  noteId: string;
  layer: NoteLayer;
  scopeRepoId: string | null;
  kind: NoteKind;
  text: string;
  bytes: number;
  source: NoteSource;
  evidence: string | null;
  /** The owner's confirmation message (`user:<msgId>`), set by confirm() — the promoted
   *  row inherits this, so the audit trail does not depend on sh_note_log alone. */
  confirmedBy: string | null;
  confirmed: boolean;
  pinned: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
  status: NoteStatus;
  supersededBy: string | null;
}

export type NoteOp =
  | "noted"
  | "superseded"
  | "evicted"
  | "demoted"
  | "suggest_demote"
  | "pinned"
  | "unpinned"
  | "removed"
  | "confirmed"
  // issue #19 (steward.md §2.4): a user request for room the module could not honour yet;
  // resolved at the next maintenance pass either way (made room / could not).
  | "room_needed"
  | "room_refused";

/** How a log row reaches the owner (issue #19): `reply` rides the next user reply;
 *  `maintenance` is the daily pass's own durable outbound (text or decision card). */
export type NoteDelivery = "reply" | "maintenance";

/** A pending log row with its bookkeeping columns (log id + delivery class). */
export interface PendingChange {
  id: number;
  op: NoteOp;
  noteId: string | null;
  text: string;
  reason: string | null;
  delivery: NoteDelivery;
}

/** A change the module proactively reports; the steward relays it to the user (§2.1). */
export interface ChangeReport {
  op: NoteOp;
  noteId: string;
  /** Snapshot of the note text at change time (survives later edits/removals). */
  text: string;
  reason: string | null;
  /** Set for superseded/evicted: the note that took this one's place. */
  supersededBy?: string | null;
}

/** Why commit (and propose) refuse a draft. */
export type CommitRejectionCode = "invalid" | "trust" | "over_limit" | "capacity";

export interface ProposeResult {
  /** Set when the draft itself cannot be committed (shape/trust refusal, or a single note
   *  over the layer cap — no eviction can ever make that fit). Surfaces as a tool error so
   *  the model learns the refusal at propose time, not at commit (review finding 5). */
  rejected?: { code: CommitRejectionCode; message: string };
  /** Exact (normalized) match among loaded layers: commit will only bump its useCount. */
  duplicate: NoteRow | null;
  /** Closest active entries — same-meaning ones belong in commit.replaces (§2.4). */
  similar: NoteRow[];
  /** Lowest-scored eviction candidates (pinned excluded), empty when the write fits. */
  needsEviction: NoteRow[];
}

export type CommitResult =
  | { ok: true; note: NoteRow; changes: ChangeReport[]; /** true when a duplicate absorbed the write */ bumped: boolean }
  | {
      ok: false;
      code: CommitRejectionCode;
      message: string;
      /** For code='capacity': the same list propose returned. */
      needsEviction: NoteRow[];
    };

/** Resident notes + the project notes of the repos in play (§2.1 notes.context). */
export interface NotesContext {
  resident: NoteRow[];
  project: NoteRow[];
}

export interface NotesDeps {
  sql: LedgerSql;
  /** Wraps multi-statement writes atomically when available (the ledger passes tx). */
  tx?: <T>(fn: () => T) => T;
  now?: () => number;
}

/** Whitespace-collapsed text — the module's canonical form for dedup and byte counts. */
export function normalizeNoteText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const viewNote = (r: Record<string, unknown>): NoteRow => ({
  noteId: r.noteId as string,
  layer: r.layer as NoteLayer,
  scopeRepoId: (r.scope_repoId as string | null) ?? null,
  kind: r.kind as NoteKind,
  text: r.text as string,
  bytes: r.bytes as number,
  source: r.source as NoteSource,
  evidence: (r.evidence as string | null) ?? null,
  confirmedBy: (r.confirmedBy as string | null) ?? null,
  confirmed: !!r.confirmed,
  pinned: !!r.pinned,
  createdAt: r.createdAt as number,
  lastUsedAt: (r.lastUsedAt as number | null) ?? null,
  useCount: r.useCount as number,
  status: r.status as NoteStatus,
  supersededBy: (r.supersededBy as string | null) ?? null,
});

// ---- similarity: character trigram Jaccard --------------------------------------------------------
// Works identically for CJK and Latin script (word-boundary tokenizers do not segment
// Chinese). Only the loaded layers are ranked — a set bounded by the caps themselves — so
// this scan is exact and cheap; the unbounded archive is what sh_note_fts exists for.

const trigramsOf = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 3 <= lower.length; i += 1) out.add(lower.slice(i, i + 3));
  return out;
};

export function noteSimilarity(a: string, b: string): number {
  const ta = trigramsOf(a);
  const tb = trigramsOf(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Same claim, allowing rephrasing: identical normalized text, or trigram similarity at the
 *  "similar neighbors" floor. The promotion path uses this so a confirmation can only be
 *  spent on the claim it was given for (PR #44 review R1) — unrelated text fails it. */
export function sameClaim(a: string, b: string): boolean {
  const na = normalizeNoteText(a);
  const nb = normalizeNoteText(b);
  return na === nb || noteSimilarity(na, nb) >= SIMILAR_MIN;
}

/** steward.md §2.5: recency × usage × source trust × confirmation. Lower evicted first. */
export function retentionScore(note: NoteRow, now: number): number {
  const ageMs = Math.max(0, now - (note.lastUsedAt ?? note.createdAt));
  const recency = 1 / (1 + ageMs / 86_400_000);
  return recency * (1 + Math.log(1 + note.useCount)) * SOURCE_WEIGHT[note.source] * (note.confirmed ? 1 : 0.5);
}

/** Renders the ChangeReports relayed with the user's next reply (spec §10.3). */
export function renderChangeReports(changes: readonly ChangeReport[]): string {
  if (changes.length === 0) return "";
  const clause = (c: ChangeReport): string => {
    const t = clip(c.text, 40);
    switch (c.op) {
      case "noted":
        return `记住了「${t}」`;
      case "confirmed":
        return `「${t}」已确认`;
      case "superseded":
        return `「${t}」已被新记录取代（存档）`;
      case "evicted":
        return `为腾空间我忘了「${t}」（已移入档案，可搜索找回）`;
      case "demoted":
        return `「${t}」长期未用，已移入档案（可搜索找回）`;
      case "suggest_demote":
        return `「${t}」已 90 天未用，建议归档`;
      case "pinned":
        return `「${t}」已置顶`;
      case "unpinned":
        return `「${t}」已取消置顶`;
      case "removed":
        return `「${t}」已删除`;
      // issue #19: the forgetting reports, in the spec's "to make room, I forgot …" voice.
      case "room_needed":
        return `「${t}」所在的层已满，明天整理时我会腾出空间把它记下`;
      case "room_refused":
        return `「${t}」没能记下（层已满且其余条目都已置顶）`;
    }
  };
  const shown = changes.slice(0, MAX_RELAY_ITEMS).map(clause);
  if (changes.length > MAX_RELAY_ITEMS) shown.push(`…另有 ${changes.length - MAX_RELAY_ITEMS} 条记忆变更`);
  const body = `（记账：${shown.join("；")}）`;
  return body.length <= RELAY_MAX_CHARS ? body : `${body.slice(0, RELAY_MAX_CHARS - 1)}…）`;
}

type DraftCheck =
  | { ok: true; text: string; scopeRepoId: string | null; confirmed: number }
  | { ok: false; code: "invalid" | "trust"; message: string };

export function createNotes(deps: NotesDeps) {
  const { sql } = deps;
  const now = deps.now ?? Date.now;
  const tx: <T>(fn: () => T) => T = deps.tx ?? (((fn: () => unknown) => fn()) as <T>(fn: () => T) => T);

  const noteById = (noteId: string): NoteRow | null =>
    (sql<Record<string, unknown>>`SELECT * FROM sh_note WHERE noteId = ${noteId}`.map(viewNote)[0] ?? null);

  const loadedNotes = (): NoteRow[] =>
    sql<Record<string, unknown>>`
      SELECT * FROM sh_note WHERE status = 'active' AND layer IN ('resident', 'project')
      ORDER BY createdAt, noteId
    `.map(viewNote);

  const usageOf = (layer: "resident" | "project", scopeRepoId: string | null): number =>
    layer === "resident"
      ? sql<{ total: number }>`SELECT COALESCE(SUM(bytes), 0) AS total FROM sh_note WHERE layer = 'resident' AND status = 'active'`[0]!.total
      : sql<{ total: number }>`
          SELECT COALESCE(SUM(bytes), 0) AS total FROM sh_note
          WHERE layer = 'project' AND status = 'active' AND scope_repoId = ${scopeRepoId}
        `[0]!.total;

  const capFor = (layer: "resident" | "project"): number =>
    layer === "resident" ? RESIDENT_CAP : PROJECT_CAP_PER_REPO;
  const layerLabel = (layer: "resident" | "project") => (layer === "resident" ? "常驻层" : "项目层");

  const log = (
    op: NoteOp,
    note: NoteRow,
    reason: string | null,
    opts: { supersededBy?: string | null; delivery?: NoteDelivery; reported?: boolean } = {},
  ): ChangeReport => {
    sql`
      INSERT INTO sh_note_log (ts, op, noteId, text, reason, delivery, reportedAt)
      VALUES (${now()}, ${op}, ${note.noteId}, ${note.text}, ${reason}, ${opts.delivery ?? "reply"}, ${opts.reported === true ? now() : null})
    `;
    return { op, noteId: note.noteId, text: note.text, reason, ...(opts.supersededBy !== undefined ? { supersededBy: opts.supersededBy } : {}) };
  };

  const findExact = (text: string, layer: "resident" | "project", scopeRepoId: string | null): NoteRow | null =>
    layer === "resident"
      ? (sql<Record<string, unknown>>`
          SELECT * FROM sh_note WHERE status = 'active' AND layer = 'resident' AND text = ${text}
        `.map(viewNote)[0] ?? null)
      : (sql<Record<string, unknown>>`
          SELECT * FROM sh_note
          WHERE status = 'active' AND layer = 'project' AND scope_repoId = ${scopeRepoId} AND text = ${text}
        `.map(viewNote)[0] ?? null);

  /** §2.5 score, ascending; pinned entries never participate in eviction. */
  const evictableSorted = (layer: "resident" | "project", scopeRepoId: string | null, at: number): NoteRow[] =>
    (layer === "resident"
      ? sql<Record<string, unknown>>`
          SELECT * FROM sh_note WHERE layer = 'resident' AND status = 'active' AND pinned = 0
        `
      : sql<Record<string, unknown>>`
          SELECT * FROM sh_note
          WHERE layer = 'project' AND status = 'active' AND pinned = 0 AND scope_repoId = ${scopeRepoId}
        `
    )
      .map(viewNote)
      .sort((a, b) => retentionScore(a, at) - retentionScore(b, at));

  /** Enough lowest-scored candidates to free `needed` characters (may fall short when
   *  everything left is pinned — commit then rejects, which is the honest answer). */
  const evictionCandidates = (needed: number, layer: "resident" | "project", scopeRepoId: string | null, at: number): NoteRow[] => {
    const picked: NoteRow[] = [];
    let freed = 0;
    for (const note of evictableSorted(layer, scopeRepoId, at)) {
      if (freed >= needed) break;
      picked.push(note);
      freed += note.bytes;
    }
    return picked;
  };

  const similarTo = (text: string): NoteRow[] =>
    loadedNotes()
      .map((note) => ({ note, score: noteSimilarity(text, note.text) }))
      .filter((e) => e.score >= SIMILAR_MIN)
      .sort((a, b) => b.score - a.score || a.note.createdAt - b.note.createdAt)
      .slice(0, MAX_SIMILAR)
      .map((e) => e.note);

  /** Validates draft shape + trust rules (steward.md §2.3's layer table). */
  const checkDraft = (draft: NoteDraft): DraftCheck => {
    const text = normalizeNoteText(draft.text);
    if (text.length === 0) return { ok: false, code: "invalid", message: "笔记内容为空。" };
    if (draft.layer === "project" && !(draft.scopeRepoId ?? "").trim()) {
      return { ok: false, code: "invalid", message: "项目层笔记必须指明 repoId。" };
    }
    if (draft.layer === "resident" && draft.scopeRepoId) {
      return { ok: false, code: "invalid", message: "常驻层笔记是全局的，不能带 repoId。" };
    }
    if (draft.layer === "resident") {
      // user_said may reside; connector facts never do (live reports are the source of
      // truth); low-trust sources only after the owner's confirmation.
      if (draft.source === "connector") {
        return { ok: false, code: "trust", message: "connector 来源只进项目层（环境事实以连接器实时上报为准）。" };
      }
      if (LOW_TRUST_SOURCES.includes(draft.source) && !draft.confirmed) {
        return {
          ok: false,
          code: "trust",
          message: `${draft.source} 来源未经用户确认，不能进常驻层：先写进项目层，用户确认（notes_confirm）后再提升。`,
        };
      }
    }
    // High-trust sources need no confirmation gate; low-trust ones carry the flag through.
    const confirmed = draft.source === "user_said" || draft.source === "connector" ? 1 : draft.confirmed ? 1 : 0;
    return {
      ok: true,
      text,
      scopeRepoId: draft.layer === "project" ? (draft.scopeRepoId ?? "").trim() : null,
      confirmed,
    };
  };

  const bumpUse = (noteId: string, at: number): void => {
    sql`UPDATE sh_note SET useCount = useCount + 1, lastUsedAt = ${at} WHERE noteId = ${noteId}`;
  };

  /** Remembers a user request the layer had no room for — one row per DISTINCT request
   *  (PR #53 review finding 3: latest-wins used to erase an earlier promise without a
   *  report; coexisting requests are each resolved by the daily pass). `kind`/`evidence`/
   *  `replaces` ride along so the deferred write keeps the draft's shape, its verified
   *  provenance, and its supersession intent (finding 4). An identical retry is a true
   *  no-op: the promise is logged only when the row is new (the log-dup minor). */
  const recordPressure = (
    draft: NoteDraft,
    text: string,
    overBy: number,
    replaces: string[],
  ): void => {
    const scopeKey = draft.scopeRepoId?.trim() ?? "";
    const seen = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_note_pressure WHERE layer = ${draft.layer} AND scope_repoId = ${scopeKey} AND text = ${text}
    `[0]!.n;
    sql`
      INSERT INTO sh_note_pressure (layer, scope_repoId, text, chars, kind, evidence, replaces)
      VALUES (${draft.layer}, ${scopeKey}, ${text}, ${text.length}, ${draft.kind}, ${draft.evidence ?? null}, ${JSON.stringify(replaces)})
      ON CONFLICT (layer, scope_repoId, text) DO UPDATE SET chars = excluded.chars, kind = excluded.kind,
        evidence = excluded.evidence, replaces = excluded.replaces
    `;
    if (seen === 0) {
      log("room_needed", pressureShadow({ layer: draft.layer, scopeRepoId: scopeKey === "" ? null : scopeKey, text }), `over_by:${overBy}`);
    }
  };

  /** The parked request itself was satisfied — a same-claim write landed (PR #53 review
   *  finding 2: an unrelated successful write used to silently delete the promise, leaving
   *  it neither written nor reported). Nothing else clears at commit time: a write never
   *  makes room, and the daily pass's own satisfaction check covers removals and
   *  supersessions that genuinely do. */
  const clearPressureForClaim = (layer: "resident" | "project", scopeRepoId: string | null, text: string): void => {
    const scopeKey = scopeRepoId ?? "";
    for (const row of sql<{ text: string }>`
      SELECT text FROM sh_note_pressure WHERE layer = ${layer} AND scope_repoId = ${scopeKey}
    `) {
      if (sameClaim(text, row.text)) {
        sql`DELETE FROM sh_note_pressure WHERE layer = ${layer} AND scope_repoId = ${scopeKey} AND text = ${row.text}`;
      }
    }
  };

  /** A specific parked request is settled (the maintenance pass resolved or abandoned it). */
  const clearPressure = (layer: "resident" | "project", scopeRepoId: string | null, text: string): void => {
    sql`DELETE FROM sh_note_pressure WHERE layer = ${layer} AND scope_repoId = ${scopeRepoId ?? ""} AND text = ${text}`;
  };

  /** The pressure rows, oldest first (rowid = insertion order). */
  const pressureRows = (): Array<{
    layer: "resident" | "project";
    scopeRepoId: string;
    text: string;
    kind: string;
    evidence: string | null;
    replaces: string[];
  }> =>
    sql<{ layer: string; scope_repoId: string; text: string; kind: string; evidence: string | null; replaces: string | null }>`
      SELECT layer, scope_repoId, text, kind, evidence, replaces FROM sh_note_pressure ORDER BY rowid
    `.map((r) => ({
      layer: r.layer as "resident" | "project",
      scopeRepoId: r.scope_repoId,
      text: r.text,
      kind: r.kind,
      evidence: r.evidence,
      replaces: r.replaces === null ? [] : (JSON.parse(r.replaces) as string[]),
    }));

  /** A pressure row as a loggable stand-in (the log's text snapshot is what relays). */
  const pressureShadow = (p: { layer: "resident" | "project"; scopeRepoId: string | null; text: string }): NoteRow => ({
    noteId: "",
    layer: p.layer,
    scopeRepoId: p.scopeRepoId,
    kind: "fact",
    text: p.text,
    bytes: p.text.length,
    source: "user_said",
    evidence: null,
    confirmedBy: null,
    confirmed: true,
    pinned: false,
    createdAt: now(),
    lastUsedAt: null,
    useCount: 0,
    status: "active",
    supersededBy: null,
  });

  /** Resolves replace targets: active notes only (archived ones are ignored — replay-safe),
   *  duplicates dropped. Cross-layer targets are allowed: superseding a project note with a
   *  resident one is exactly the promotion path after confirmation. */
  const resolveTargets = (replaces: string[] | undefined): NoteRow[] =>
    [...new Set(replaces ?? [])]
      .map((id) => noteById(id))
      .filter((n): n is NoteRow => n !== null && n.status === "active");

  const propose = (draft: NoteDraft): ProposeResult => {
    const check = checkDraft(draft);
    if (!check.ok) return { rejected: { code: check.code, message: check.message }, duplicate: null, similar: [], needsEviction: [] };
    // A single note over the cap can never fit, whatever gets evicted (review finding 5):
    // refuse up front instead of handing out pointless eviction candidates.
    if (check.text.length > capFor(draft.layer)) {
      return {
        rejected: {
          code: "over_limit",
          message: `单条超过${layerLabel(draft.layer)}上限（${check.text.length} > ${capFor(draft.layer)} 字）。请压缩。`,
        },
        duplicate: null,
        similar: [],
        needsEviction: [],
      };
    }
    const at = now();
    const dup = findExact(check.text, draft.layer, check.scopeRepoId);
    if (dup) {
      bumpUse(dup.noteId, at);
      return { duplicate: noteById(dup.noteId)!, similar: [], needsEviction: [] };
    }
    const overBy = usageOf(draft.layer, check.scopeRepoId) + check.text.length - capFor(draft.layer);
    return {
      duplicate: null,
      similar: similarTo(check.text),
      needsEviction: overBy > 0 ? evictionCandidates(overBy, draft.layer, check.scopeRepoId, at) : [],
    };
  };

  const commit = (draft: NoteDraft, opts: { replaces?: string[] } = {}): CommitResult =>
    tx(() => {
      const check = checkDraft(draft);
      if (!check.ok) return { ok: false, code: check.code, message: check.message, needsEviction: [] };
      const at = now();

      // An exact match among the loaded layers absorbs the write: bump, nothing new noted.
      // (This is also what makes a replayed commit converge instead of duplicating.)
      const dup = findExact(check.text, draft.layer, check.scopeRepoId);
      if (dup) {
        bumpUse(dup.noteId, at);
        // A re-landed same-claim write satisfies the parked request it answers (finding 2).
        clearPressureForClaim(draft.layer, check.scopeRepoId, check.text);
        return { ok: true, note: noteById(dup.noteId)!, changes: [], bumped: true };
      }

      if (check.text.length > capFor(draft.layer)) {
        return {
          ok: false,
          code: "over_limit",
          message: `单条超过${layerLabel(draft.layer)}上限（${check.text.length} > ${capFor(draft.layer)} 字）。请压缩。`,
          needsEviction: [],
        };
      }

      const targets = resolveTargets(opts.replaces);
      // Pinned entries are never spendable as room — not as capacity, not as supersession
      // (PR #53 review finding 1: with the layer under cap, or with unpinned targets alone
      // covering the deficit, a pinned target used to sail through and get archived). The
      // check runs BEFORE any capacity math, and the loop below never sees a pinned target.
      const pinnedTarget = targets.find((t) => t.pinned);
      if (pinnedTarget !== undefined) {
        return {
          ok: false,
          code: "invalid",
          message: `「${clip(pinnedTarget.text, 30)}」已置顶，不能用来腾挪或取代；先经用户同意 notes_pin(id, false) 再试。`,
          needsEviction: [],
        };
      }
      // Only same-placement targets free capacity in the target layer: a cross-layer
      // replace (the promotion path) supersedes elsewhere and must not buy room here.
      const samePlacement = (target: NoteRow): boolean =>
        target.layer === draft.layer && (draft.layer === "resident" || target.scopeRepoId === check.scopeRepoId);
      const freed = targets.filter(samePlacement).reduce((sum, n) => sum + n.bytes, 0);
      const overBy = usageOf(draft.layer, check.scopeRepoId) + check.text.length - freed - capFor(draft.layer);
      if (overBy > 0) {
        // The module enforces the cap (§2.4): a write that does not fit is refused until the
        // steward carries the evictions it was told about in `replaces`.
        const candidates = evictionCandidates(overBy, draft.layer, check.scopeRepoId, at);
        const canFree = candidates.reduce((sum, n) => sum + n.bytes, 0);
        // A user's own request must not be silently dropped when the model ignores
        // `needsEviction` (spec §10.3): remember the pressure — WITH its supersession
        // intent, so the daily pass honours `replaces` instead of score-evicting around it
        // (finding 4) — and reports both halves (issue #19, §2.4/§2.5). Low-trust sources
        // are never worth that room (steward.md §2.3) and stay refused.
        if (draft.source === "user_said" && canFree + freed >= overBy) {
          recordPressure(draft, check.text, overBy, targets.map((t) => t.noteId));
          return {
            ok: false,
            code: "capacity",
            message: `写入会超出${layerLabel(draft.layer)}上限 ${overBy} 字（用户要求记住，已记下腾挪需求，日维护会自动腾出并告知用户）；现在想自己选，请在 replaces 里带上要腾挪/取代的旧条目。`,
            needsEviction: candidates,
          };
        }
        return {
          ok: false,
          code: "capacity",
          message:
            canFree < overBy
              ? `写入会超出${layerLabel(draft.layer)}上限 ${overBy} 字，且没有足够可腾挪的条目（可能都已置顶）。`
              : `写入会超出${layerLabel(draft.layer)}上限 ${overBy} 字：请在 replaces 里带上要腾挪/取代的旧条目。`,
          needsEviction: candidates,
        };
      }

      // A same-claim write satisfies the parked request it answers (finding 2: an UNRELATED
      // write must not silently delete the promise — a write never makes room).
      clearPressureForClaim(draft.layer, check.scopeRepoId, check.text);

      const noteId = `n_${ulid()}`;
      sql`
        INSERT INTO sh_note (noteId, layer, scope_repoId, kind, text, bytes, source, evidence, confirmed, pinned, createdAt, lastUsedAt, useCount, status)
        VALUES (${noteId}, ${draft.layer}, ${check.scopeRepoId}, ${draft.kind}, ${check.text}, ${check.text.length},
                ${draft.source}, ${draft.evidence ?? null}, ${check.confirmed}, 0, ${at}, ${at}, 0, 'active')
      `;
      const note = noteById(noteId)!;
      const changes: ChangeReport[] = [log("noted", note, draft.source)];

      // Which replaced entries were capacity victims (§2.5 eviction) vs semantic
      // supersessions: the ones the write genuinely needed to make room are 'evicted' (their
      // content stays valid — status keeps 'active', only the layer sinks), the rest are
      // 'superseded' (a newer note says it better — status marks the historical version).
      let stillOver = usageOf(draft.layer, check.scopeRepoId) - capFor(draft.layer);
      for (const target of targets) {
        const needed = samePlacement(target) && stillOver > 0;
        if (needed) {
          stillOver -= target.bytes;
          sql`
            UPDATE sh_note SET layer = 'archive', supersededBy = ${noteId}, lastUsedAt = ${at}
            WHERE noteId = ${target.noteId}
          `;
          changes.push(log("evicted", target, "capacity", { supersededBy: noteId }));
        } else {
          sql`
            UPDATE sh_note SET layer = 'archive', status = 'superseded', supersededBy = ${noteId}, lastUsedAt = ${at}
            WHERE noteId = ${target.noteId}
          `;
          changes.push(log("superseded", target, "supersession", { supersededBy: noteId }));
        }
      }
      return { ok: true, note, changes, bumped: false };
    });

  /** `evidence` is the user message that carried the confirmation (verified one layer up);
   *  it rides the log row so a later promotion's provenance stays traceable. */
  const confirm = (noteId: string, evidence?: string): { ok: boolean; changes: ChangeReport[] } =>
    tx(() => {
      const note = noteById(noteId);
      if (!note || note.status === "removed" || note.confirmed) return { ok: note !== null, changes: [] };
      sql`
        UPDATE sh_note SET confirmed = 1, confirmedBy = COALESCE(${evidence ?? null}, confirmedBy), lastUsedAt = ${now()}
        WHERE noteId = ${noteId}
      `;
      return { ok: true, changes: [log("confirmed", note, evidence ? `confirmed_by:${evidence}` : "owner_confirmed")] };
    });

  const pin = (noteId: string, pinned: boolean): { ok: boolean; changes: ChangeReport[] } =>
    tx(() => {
      const note = noteById(noteId);
      if (!note || note.status === "removed" || note.pinned === pinned) return { ok: note !== null, changes: [] };
      sql`UPDATE sh_note SET pinned = ${pinned ? 1 : 0} WHERE noteId = ${noteId}`;
      return { ok: true, changes: [log(pinned ? "pinned" : "unpinned", note, null)] };
    });

  /** Never a hard delete (spec §10.2: entries only sink): status='removed', searchable no more. */
  const remove = (noteId: string): { ok: boolean; changes: ChangeReport[] } =>
    tx(() => {
      const note = noteById(noteId);
      if (!note || note.status === "removed") return { ok: note !== null, changes: [] };
      sql`
        UPDATE sh_note SET status = 'removed', layer = 'archive', pinned = 0, supersededBy = NULL
        WHERE noteId = ${noteId}
      `;
      return { ok: true, changes: [log("removed", note, "user_removed")] };
    });

  const list = (filter: { layer?: NoteLayer | "all"; scopeRepoId?: string; includeRemoved?: boolean } = {}): NoteRow[] => {
    // The tagged template interpolates only values, so every shape is spelled out; never text.
    // Semantics (review finding 7): a scope filter narrows that layer's repo rows — except
    // with "all", where resident (global) rows stay in the listing alongside the repo's own.
    const rows =
      filter.layer === "archive"
        ? filter.scopeRepoId
          ? sql<Record<string, unknown>>`
              SELECT * FROM sh_note WHERE layer = 'archive' AND scope_repoId = ${filter.scopeRepoId}
              ORDER BY pinned DESC, createdAt, noteId
            `
          : sql<Record<string, unknown>>`
              SELECT * FROM sh_note WHERE layer = 'archive' ORDER BY pinned DESC, createdAt, noteId
            `
        : filter.layer === "all"
          ? filter.scopeRepoId
            ? sql<Record<string, unknown>>`
                SELECT * FROM sh_note
                WHERE layer = 'resident' OR (layer != 'resident' AND scope_repoId = ${filter.scopeRepoId})
                ORDER BY pinned DESC, createdAt, noteId
              `
            : sql<Record<string, unknown>>`
                SELECT * FROM sh_note ORDER BY pinned DESC, createdAt, noteId
              `
          : filter.layer === "project" && filter.scopeRepoId
            ? sql<Record<string, unknown>>`
                SELECT * FROM sh_note WHERE layer = 'project' AND scope_repoId = ${filter.scopeRepoId}
                ORDER BY pinned DESC, createdAt, noteId
              `
            : filter.layer !== undefined
              ? sql<Record<string, unknown>>`
                  SELECT * FROM sh_note WHERE layer = ${filter.layer}
                  ORDER BY pinned DESC, createdAt, noteId
                `
              : filter.scopeRepoId
                ? sql<Record<string, unknown>>`
                    SELECT * FROM sh_note
                    WHERE layer = 'resident' OR (layer = 'project' AND scope_repoId = ${filter.scopeRepoId})
                    ORDER BY pinned DESC, createdAt, noteId
                  `
                : sql<Record<string, unknown>>`
                    SELECT * FROM sh_note WHERE layer IN ('resident', 'project')
                    ORDER BY pinned DESC, createdAt, noteId
                  `;
    return rows.map(viewNote).filter((n) => n.status !== "removed" || filter.includeRemoved === true);
  };

  const search = (q: string, opts: { layers?: NoteLayer[] } = {}): NoteRow[] => {
    const needle = q.trim();
    if (needle.length === 0) return [];
    // Trigram needs ≥3 characters to match anything; shorter needles fall back to LIKE —
    // with % _ ! escaped (ESCAPE '!') so "100%" cannot match the world (review finding 6).
    const likeSafe = needle.replace(/[!%_]/g, (m) => `!${m}`);
    const rows =
      needle.length >= 3
        ? sql<Record<string, unknown>>`
            SELECT n.* FROM sh_note_fts f JOIN sh_note n ON n.rowid = f.rowid
            WHERE sh_note_fts MATCH ${`"${needle.replaceAll('"', '""')}"`}
              AND n.status != 'removed'
            ORDER BY n.createdAt DESC, n.noteId
          `
        : sql<Record<string, unknown>>`
            SELECT * FROM sh_note WHERE text LIKE ${`%${likeSafe}%`} ESCAPE '!' AND status != 'removed'
            ORDER BY createdAt DESC, noteId
          `;
    const notes = rows.map(viewNote);
    return opts.layers && opts.layers.length > 0 ? notes.filter((n) => opts.layers!.includes(n.layer)) : notes;
  };

  /** Resident notes + the project notes of the given repos; assembly counts as use (§2.5). */
  const context = (scope: { repoIds: string[] }): NotesContext => {
    const at = now();
    const resident = sql<Record<string, unknown>>`
      SELECT * FROM sh_note WHERE layer = 'resident' AND status = 'active'
      ORDER BY pinned DESC, createdAt, noteId
    `.map(viewNote);
    const project = [...new Set(scope.repoIds ?? [])].flatMap((repoId) =>
      sql<Record<string, unknown>>`
        SELECT * FROM sh_note
        WHERE layer = 'project' AND status = 'active' AND scope_repoId = ${repoId}
        ORDER BY pinned DESC, createdAt, noteId
      `.map(viewNote),
    );
    for (const note of [...resident, ...project]) {
      sql`UPDATE sh_note SET lastUsedAt = ${at} WHERE noteId = ${note.noteId}`;
    }
    return { resident, project };
  };

  /** The project notes for one fetch of the Threads that involve these repos (get_thread).
   *  Deliberately NOT context(): only the project rows are assembled here, so a get_thread
   *  call cannot reset the resident layer's 90-day decay clock (review finding 2) — resident
   *  notes count as used only when the layer is genuinely assembled (notes.context) or the
   *  entry is re-proposed. The always-rendered section likewise does not count as use, or
   *  resident notes could never age (§2.5 rule 3 would be dead code). */
  const forRepos = (repoIds: string[]): NoteRow[] => {
    const at = now();
    const rows = [...new Set(repoIds ?? [])].flatMap((repoId) =>
      sql<Record<string, unknown>>`
        SELECT * FROM sh_note
        WHERE layer = 'project' AND status = 'active' AND scope_repoId = ${repoId}
        ORDER BY pinned DESC, createdAt, noteId
      `.map(viewNote),
    );
    for (const note of rows) sql`UPDATE sh_note SET lastUsedAt = ${at} WHERE noteId = ${note.noteId}`;
    return rows;
  };

  /** The resident layer as a system-prompt section body (§4.1); empty string omits it. */
  const renderResidentSection = (): string => {
    const notes = sql<Record<string, unknown>>`
      SELECT * FROM sh_note WHERE layer = 'resident' AND status = 'active'
      ORDER BY pinned DESC, createdAt, noteId
    `.map(viewNote);
    if (notes.length === 0) return "";
    const label: Record<NoteSource, string> = {
      user_said: "用户说的",
      connector: "连接器上报",
      worker_reported: "worker 汇报",
      inferred: "推断",
    };
    const lines = notes.map((n) => `- ${n.pinned ? "📌 " : ""}${n.text}（${label[n.source]}${n.confirmed ? "" : "，待确认"}）`);
    return ["这些是用户的偏好与全局约定，影响你如何派发与回复（每轮可见）：", ...lines].join("\n");
  };

  const pendingChanges = (): ChangeReport[] =>
    sql<{ op: string; noteId: string; text: string; reason: string | null }>`
      SELECT op, noteId, text, reason FROM sh_note_log WHERE reportedAt IS NULL ORDER BY id
    `.map((r) => ({ op: r.op as NoteOp, noteId: r.noteId, text: r.text, reason: r.reason }));

  /** Pending rows the daily pass delivers itself (issue #19): id-ordered, capped so one
   *  runaway ledger cannot open an unbounded outbound burst — the excess stays pending
   *  for the next pass / the next reply, never silently dropped. */
  const pendingMaintenance = (): PendingChange[] =>
    sql<{ id: number; op: string; noteId: string; text: string; reason: string | null; delivery: string }>`
      SELECT id, op, noteId, text, reason, delivery FROM sh_note_log
      WHERE reportedAt IS NULL AND delivery = 'maintenance'
      ORDER BY id LIMIT ${MAX_MAINTENANCE_BATCH}
    `.map((r) => ({
      id: r.id,
      op: r.op as NoteOp,
      noteId: r.noteId,
      text: r.text,
      reason: r.reason,
      delivery: r.delivery as NoteDelivery,
    }));

  /** Renders the pending relay block WITHOUT marking anything (review finding 4): the
   *  caller marks via markPendingReported(upTo) only after the reply row is durably
   *  enqueued — a crash in between then costs at most a duplicate announcement, never a
   *  silent one (spec §10.3). `upTo` bounds the marking so a change that lands between
   *  render and mark stays pending and rides the reply after it.
   *
   *  An UNDECIDED actionable suggestion never rides a reply (PR #53 review finding 6):
   *  plain text would mark it reported while its decision card has never existed, and the
   *  30-day quiet window would then block the re-ask. It waits for the daily pass's own
   *  durable delivery (or its decision). Informational maintenance rows may ride a reply —
   *  earlier is fine, and the daily flush then finds nothing left. */
  const renderPendingForReply = (): { text: string; upTo: number } => {
    const rows = sql<{
      id: number;
      op: string;
      noteId: string;
      text: string;
      reason: string | null;
      delivery: string;
      decision: string | null;
    }>`SELECT id, op, noteId, text, reason, delivery, decision FROM sh_note_log WHERE reportedAt IS NULL ORDER BY id`;
    if (rows.length === 0) return { text: "", upTo: 0 };
    const relatable = rows
      .filter((r) => !(r.delivery === "maintenance" && r.op === "suggest_demote" && r.decision === null))
      .map((r) => ({ op: r.op as NoteOp, noteId: r.noteId, text: r.text, reason: r.reason }));
    return { text: renderChangeReports(relatable), upTo: rows[rows.length - 1]!.id };
  };

  /** Marks pending rows up to and including `upTo` as relayed — never an undecided
   *  actionable suggestion (finding 6): those belong to their decision card. */
  const markPendingReported = (upTo: number): void => {
    if (upTo <= 0) return;
    sql`
      UPDATE sh_note_log SET reportedAt = ${now()}
      WHERE reportedAt IS NULL AND id <= ${upTo}
        AND NOT (delivery = 'maintenance' AND op = 'suggest_demote' AND decision IS NULL)
    `;
  };

  /** The maintenance pass's marker (issue #19): touches ONLY its own delivery class — a
   *  pending `reply` row (e.g. a note an event-run just wrote) must still ride the owner's
   *  next reply, never be silently marked by the daily flush. */
  const markPendingMaintenanceReported = (upTo: number): void => {
    if (upTo <= 0) return;
    sql`UPDATE sh_note_log SET reportedAt = ${now()} WHERE reportedAt IS NULL AND id <= ${upTo} AND delivery = 'maintenance'`;
  };

  /** Render + mark in one step (tests, and callers that have nothing to lose by marking). */
  const drainPendingForReply = (): string => {
    const { text, upTo } = renderPendingForReply();
    markPendingReported(upTo);
    return text;
  };

  /** The owner's answer on a suggestion card (issue #19, spec §10.2): archive — or keep
   *  (renew) — a resident note. Returns what became of it. */
  const ownerArchive = (noteId: string, fromLogId: number, decision: string): { ok: true } | { ok: false; reason: string } => {
    const note = noteById(noteId);
    if (!note || note.status !== "active" || note.layer !== "resident") {
      return { ok: false, reason: "inactive" };
    }
    if (note.pinned) return { ok: false, reason: "pinned" };
    return tx(() => {
      sql`UPDATE sh_note SET layer = 'archive' WHERE noteId = ${noteId}`;
      // The tap's own reply IS the report — the log row is the audit trail, marked reported
      // so the next reply does not repeat a「长期未用，已移入档案」clause for a decision the
      // owner just made themselves (PR #53 review minor).
      log("demoted", note, decision, { delivery: "reply", reported: true });
      settleDecision(fromLogId, decision, noteId);
      return { ok: true };
    });
  };

  /** keep: the quiet clock restarts (this is a renewal, NOT a pin — the pin exemption stays
   *  the owner's explicit call). Validates like archive does (PR #53 review finding 8): a
   *  note sunk since the card went out cannot be "kept", and the ask settles either way so
   *  it can never re-nag about something the owner already answered. Idempotent. */
  const renewNote = (noteId: string, fromLogId: number): { ok: true } | { ok: false; reason: "inactive" | "settled" } => {
    const settled = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_note_log WHERE id = ${fromLogId} AND decision IS NOT NULL AND reportedAt IS NOT NULL
    `[0]!.n;
    if (settled > 0) return { ok: false, reason: "settled" };
    const note = noteById(noteId);
    if (!note || note.status !== "active" || note.layer !== "resident") {
      settleDecision(fromLogId, "note_gone", noteId);
      return { ok: false, reason: "inactive" };
    }
    const at = now();
    sql`UPDATE sh_note SET lastUsedAt = ${at} WHERE noteId = ${noteId} AND status = 'active'`;
    settleDecision(fromLogId, "note_keep", noteId);
    return { ok: true };
  };

  /** Settles a suggestion without an owner decision — the note sank before its card could
   *  go out (delivery-time check in the daily flush, PR #53 review finding 8). */
  const abandonAsk = (logId: number, noteId: string): void => {
    settleDecision(logId, "note_gone", noteId);
  };

  /** Whether a demotion suggestion still waits for the owner: undecided, and the note it
   *  names is still an active resident one. The workspace shows only such asks as pending. */
  const askOpen = (noteId: string, logId: number): boolean => {
    const undecided = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_note_log WHERE id = ${logId} AND noteId = ${noteId} AND op = 'suggest_demote' AND decision IS NULL
    `[0]!.n;
    if (undecided === 0) return false;
    const note = noteById(noteId);
    return note !== null && note.status === "active" && note.layer === "resident";
  };

  /** Settles a suggestion log row: decision text + delivered marker (idempotent). */
  const settleDecision = (logId: number, decision: string, noteId: string): void => {
    sql`UPDATE sh_note_log SET decision = ${decision}, reportedAt = COALESCE(reportedAt, ${now()}) WHERE id = ${logId} AND noteId = ${noteId}`;
  };

  /** Decay (60d project demotion), resident suggestions (90d), and the capacity backstop.
   *  Deterministic (§2.1: called by the daily alarm); every action reports through the log. */
  const maintenance = (at: number): ChangeReport[] =>
    tx(() => {
      const changes: ChangeReport[] = [];

      // 1. Project entries unused for 60 days (not pinned) sink to the archive.
      const stale = sql<Record<string, unknown>>`
        SELECT * FROM sh_note
        WHERE layer = 'project' AND status = 'active' AND pinned = 0
          AND COALESCE(lastUsedAt, createdAt) < ${at - PROJECT_DEMOTE_AFTER_MS}
        ORDER BY createdAt, noteId
      `.map(viewNote);
      for (const note of stale) {
        sql`UPDATE sh_note SET layer = 'archive' WHERE noteId = ${note.noteId}`;
        changes.push(log("demoted", note, "unused_60d", { delivery: "maintenance" }));
      }

      // 2. Capacity backstop (drift — e.g. a lowered cap or writes from older code): evict
      //    the lowest-scored unpinned entries until the layer fits again.
      const enforceCap = (layer: "resident" | "project", scopeRepoId: string | null): void => {
        for (;;) {
          const over = usageOf(layer, scopeRepoId) - capFor(layer);
          if (over <= 0) return;
          const [victim] = evictionCandidates(over, layer, scopeRepoId, at);
          if (!victim) return; // all pinned: leave it over rather than break a pin promise
          sql`UPDATE sh_note SET layer = 'archive', supersededBy = NULL WHERE noteId = ${victim.noteId}`;
          changes.push(log("evicted", victim, "maintenance_cap", { delivery: "maintenance" }));
        }
      };
      enforceCap("resident", null);
      const repos = sql<{ repoId: string }>`
        SELECT DISTINCT scope_repoId AS repoId FROM sh_note
        WHERE layer = 'project' AND status = 'active' AND scope_repoId IS NOT NULL
      `;
      for (const { repoId } of repos) enforceCap("project", repoId);

      // 3. Ignored capacity pressure (issue #19, §2.4): a user asked for room, the write
      //    was refused with needsEviction, and nobody came back. Honour each parked request
      //    — its named `replaces` first (finding 4: a parked correction must supersede its
      //    predecessor, not score-evict around it), then by score — and write what was
      //    asked for, reporting both halves with the daily delivery (finding 5). If even
      //    that cannot free enough, the request is honestly reported as unmet instead of
      //    rotting in the pressure table forever.
      for (const pressure of pressureRows()) {
        const scopeRepoId = pressure.scopeRepoId === "" ? null : pressure.scopeRepoId;
        const settledBy = (note: NoteRow): boolean =>
          note.status === "active" && samePlacement(note) && sameClaim(pressure.text, note.text);
        const samePlacement = (note: NoteRow): boolean =>
          note.layer === pressure.layer && (pressure.layer === "resident" || note.scopeRepoId === scopeRepoId);
        if (loadedNotes().some(settledBy)) {
          // A same-claim write landed (the steward retried successfully): satisfied.
          clearPressure(pressure.layer, scopeRepoId, pressure.text);
          continue;
        }
        // Honour the supersession intent: named targets sink as superseded versions of the
        // new note — unless the owner pinned one in the meantime (the pin always wins).
        let freed = 0;
        const named: NoteRow[] = [];
        for (const targetId of pressure.replaces) {
          const target = noteById(targetId);
          if (!target || target.status !== "active" || target.pinned) continue;
          named.push(target);
          freed += target.bytes;
        }
        const overBy = usageOf(pressure.layer, scopeRepoId) + pressure.text.length - freed - capFor(pressure.layer);
        if (overBy > 0) {
          const victims = evictionCandidates(overBy, pressure.layer, scopeRepoId, at).filter((v) => !named.some((n) => n.noteId === v.noteId));
          const canFree = victims.reduce((sum, n) => sum + n.bytes, 0);
          if (canFree + freed < overBy) {
            clearPressure(pressure.layer, scopeRepoId, pressure.text);
            changes.push(log("room_refused", pressureShadow(pressure), "no_room", { delivery: "maintenance" }));
            continue;
          }
          const noteId = `n_${ulid()}`;
          sql`
            INSERT INTO sh_note (noteId, layer, scope_repoId, kind, text, bytes, source, evidence, confirmed, pinned, createdAt, lastUsedAt, useCount, status)
            VALUES (${noteId}, ${pressure.layer}, ${scopeRepoId}, ${pressure.kind}, ${pressure.text}, ${pressure.text.length},
                    'user_said', ${pressure.evidence}, 1, 0, ${at}, ${at}, 0, 'active')
          `;
          const note = noteById(noteId)!;
          changes.push(log("noted", note, "user_said", { delivery: "maintenance" }));
          for (const target of named) {
            sql`
              UPDATE sh_note SET layer = 'archive', status = 'superseded', supersededBy = ${noteId}, lastUsedAt = ${at}
              WHERE noteId = ${target.noteId}
            `;
            changes.push(log("superseded", target, "parked_replaces", { supersededBy: noteId, delivery: "maintenance" }));
          }
          for (const victim of victims) {
            sql`UPDATE sh_note SET layer = 'archive', supersededBy = ${noteId} WHERE noteId = ${victim.noteId}`;
            changes.push(log("evicted", victim, "ignored_needsEviction", { supersededBy: noteId, delivery: "maintenance" }));
          }
        } else {
          // Room appeared since (a supersession, a removal): write it — still superseding
          // the named predecessors (the correction's intent does not evaporate).
          const noteId = `n_${ulid()}`;
          sql`
            INSERT INTO sh_note (noteId, layer, scope_repoId, kind, text, bytes, source, evidence, confirmed, pinned, createdAt, lastUsedAt, useCount, status)
            VALUES (${noteId}, ${pressure.layer}, ${scopeRepoId}, ${pressure.kind}, ${pressure.text}, ${pressure.text.length},
                    'user_said', ${pressure.evidence}, 1, 0, ${at}, ${at}, 0, 'active')
          `;
          const note = noteById(noteId)!;
          changes.push(log("noted", note, "user_said", { delivery: "maintenance" }));
          for (const target of named) {
            sql`
              UPDATE sh_note SET layer = 'archive', status = 'superseded', supersededBy = ${noteId}, lastUsedAt = ${at}
              WHERE noteId = ${target.noteId}
            `;
            changes.push(log("superseded", target, "parked_replaces", { supersededBy: noteId, delivery: "maintenance" }));
          }
        }
        clearPressure(pressure.layer, scopeRepoId, pressure.text);
      }

      // 4. Resident entries unused for 90 days: suggest, never demote on our own (§2.5 —
      //    broad impact; the owner decides on the card). Logged LAST (PR #53 review
      //    finding 8): the sinking passes above have already run, so a note suggested in
      //    this pass is still resident when its card goes out. Re-fires ≤ every 30 days.
      const sleepy = sql<Record<string, unknown>>`
        SELECT * FROM sh_note
        WHERE layer = 'resident' AND status = 'active' AND pinned = 0
          AND COALESCE(lastUsedAt, createdAt) < ${at - RESIDENT_SUGGEST_AFTER_MS}
        ORDER BY createdAt, noteId
      `.map(viewNote);
      for (const note of sleepy) {
        const recent = sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM sh_note_log
          WHERE op = 'suggest_demote' AND noteId = ${note.noteId} AND ts > ${at - SUGGEST_QUIET_MS}
        `[0]!.n;
        if (recent > 0) continue;
        changes.push(log("suggest_demote", note, "unused_90d", { delivery: "maintenance" }));
      }

      return changes;
    });

  return {
    propose,
    commit,
    confirm,
    pin,
    remove,
    demote: ownerArchive,
    renew: renewNote,
    get: noteById,
    list,
    search,
    context,
    forRepos,
    renderResidentSection,
    pendingChanges,
    pendingMaintenance,
    renderPendingForReply,
    markPendingReported,
    markPendingMaintenanceReported,
    drainPendingForReply,
    abandonAsk,
    askOpen,
    maintenance,
  };
}

export type Notes = ReturnType<typeof createNotes>;
