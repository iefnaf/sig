// The ledger (steward.md §2). M1: schema, workers/threads lifecycle helpers, views.
// The reducer lives in reducer.ts; templates and outbound live in their own modules.
import type { Db } from "./db.ts";
import { SCHEMA } from "./schema.ts";
import type { WorkerEvent } from "./types.ts";

const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, fallback: T): T => (v == null ? fallback : (JSON.parse(String(v)) as T));

export interface NewWorker {
	workerId: string; threadId: string; deviceId: string; repoId?: string;
	agent?: string; mode?: "write" | "readonly"; branch?: string; title?: string;
}

export class Memory {
	db: Db;

	constructor(db: Db) {
		this.db = db;
		for (const ddl of SCHEMA) db.exec(ddl);
	}

	// ---- setup helpers for tests and callers ----

	registerMachine(deviceId: string, name: string) {
		this.db.run(
			`INSERT INTO sh_machine (deviceId, name, online, lastSeen) VALUES (?, ?, 1, ?)
			 ON CONFLICT(deviceId) DO UPDATE SET name = excluded.name, online = 1, lastSeen = excluded.lastSeen`,
			deviceId, name, Date.now(),
		);
	}

	createThread(threadId: string, title: string, goal: string, createdFromMsg?: string) {
		this.db.run(
			`INSERT INTO sh_thread (threadId, title, goal, state, unread, lastActivityAt, createdFromMsg)
			 VALUES (?, ?, ?, 'idle', 0, ?, ?)`,
			threadId, title, goal, Date.now(), createdFromMsg ?? null,
		);
		this.timeline(threadId, "thread_created", `创建「${title}」`);
	}

	registerWorker(w: NewWorker) {
		this.db.run(
			`INSERT OR IGNORE INTO sh_worker (workerId, threadId, deviceId, repoId, agent, mode, branch, state)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`,
			w.workerId, w.threadId, w.deviceId, w.repoId ?? null, w.agent ?? "pi", w.mode ?? "write", w.branch ?? null,
		);
	}

	worker(workerId: string) {
		return this.db.get<{ workerId: string; threadId: string; deviceId: string; state: string | null; branch: string | null; lastOutcome: string | null; lastProgress: string | null }>(
			`SELECT workerId, threadId, deviceId, state, branch, lastOutcome, lastProgress FROM sh_worker WHERE workerId = ?`, workerId,
		);
	}

	question(qid: string) {
		const row = this.db.get<{ qid: string; threadId: string; workerId: string; text: string; status: string }>(
			`SELECT qid, threadId, workerId, text, status FROM sh_question WHERE qid = ?`, qid,
		);
		return row;
	}

	answerQuestion(qid: string, now = Date.now()) {
		this.db.run(`UPDATE sh_question SET status = 'answered', answeredAt = ? WHERE qid = ? AND status = 'open'`, now, qid);
		this.recomputeThreadStates();
	}

	markThreadUnread(threadId: string) {
		this.db.run(`UPDATE sh_thread SET unread = 1 WHERE threadId = ?`, threadId);
	}

	// ---- event intake (dedup + inbox bookkeeping) ----

	/** Returns false when (workerId, seq) was already received. */
	acceptEvent(e: WorkerEvent): boolean {
		const before = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sh_event WHERE workerId = ? AND seq = ?`, e.workerId, e.seq)!.n;
		if (before) return false;
		this.db.run(`INSERT INTO sh_event (workerId, seq, payload, receivedAt) VALUES (?, ?, ?, ?)`, e.workerId, e.seq, j(e), Date.now());
		this.db.run(
			`INSERT INTO sh_worker_ack (workerId, upTo, processedUpTo) VALUES (?, ?, ?)
			 ON CONFLICT(workerId) DO UPDATE SET upTo = MAX(upTo, excluded.upTo)`,
			e.workerId, e.seq, e.seq,
		);
		return true;
	}

	// ---- ledger writes used by the reducer ----

	setWorkerState(workerId: string, state: string, lastOutcome?: string, now = Date.now()) {
		this.db.run(
			`UPDATE sh_worker SET state = ?, lastOutcome = COALESCE(?, lastOutcome), lastEventAt = ? WHERE workerId = ?`,
			state, lastOutcome ?? null, now, workerId,
		);
	}

	setProgress(workerId: string, text: string, now = Date.now()) {
		this.db.run(`UPDATE sh_worker SET lastProgress = ?, lastEventAt = ? WHERE workerId = ?`, text, now, workerId);
	}

	saveReport(e: Extract<WorkerEvent, { type: "report" }>) {
		this.db.run(
			`INSERT OR REPLACE INTO sh_report (workerId, seq, status, summary, changes, decisions, leftovers, tests, question, next, git, receivedAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			e.workerId, e.seq, e.status, e.summary, j(e.changes), j(e.decisions), j(e.leftovers), j(e.tests), e.question ?? null, e.next ?? null, j(e.git), Date.now(),
		);
	}

	latestReport(workerId: string) {
		const row = this.db.get<{ status: string; summary: string; changes: string; decisions: string; leftovers: string; tests: string; question: string | null; next: string | null; git: string }>(
			`SELECT status, summary, changes, decisions, leftovers, tests, question, next, git FROM sh_report WHERE workerId = ? ORDER BY seq DESC LIMIT 1`, workerId,
		);
		if (!row) return undefined;
		return { ...row, changes: pj<string[]>(row.changes, []), decisions: pj<string[]>(row.decisions, []), leftovers: pj<string[]>(row.leftovers, []), tests: pj<{ ran: boolean; passed?: boolean } | null>(row.tests, null), git: pj<{ branch?: string; ahead?: number; dirty?: number; pushed?: boolean } | null>(row.git, null) };
	}

	openQuestion(threadId: string) {
		return this.db.get<{ qid: string }>(`SELECT qid FROM sh_question WHERE threadId = ? AND status = 'open' LIMIT 1`, threadId);
	}

	createQuestion(qid: string, threadId: string, workerId: string | null, text: string, source: string, now = Date.now()) {
		this.db.run(
			`INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, status, askedAt, source) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
			qid, threadId, workerId, text, now, source,
		);
	}

	timeline(threadId: string, kind: string, text: string, refs?: Record<string, unknown>) {
		this.db.run(`INSERT INTO sh_timeline (threadId, ts, kind, text, refs) VALUES (?, ?, ?, ?, ?)`, threadId, Date.now(), kind, text, j(refs));
	}

	touchThread(threadId: string, now = Date.now()) {
		this.db.run(`UPDATE sh_thread SET lastActivityAt = ? WHERE threadId = ?`, now, threadId);
	}

	// ---- derived state (steward.md §5.2), recomputed after every batch ----

	recomputeThreadStates() {
		this.db.exec(`
			UPDATE sh_thread SET state = 'idle'
			WHERE state != 'idle'`);
		this.db.exec(`
			UPDATE sh_thread SET state = 'running'
			WHERE threadId IN (
				SELECT threadId FROM sh_worker
				WHERE state IN ('starting', 'running', 'recovering'))`);
		this.db.exec(`
			UPDATE sh_thread SET state = 'waiting_you'
			WHERE state = 'idle'
			  AND threadId IN (SELECT threadId FROM sh_question WHERE status = 'open')`);
	}

	markThreadRead(threadId: string) {
		this.db.run(`UPDATE sh_thread SET unread = 0 WHERE threadId = ?`, threadId);
	}

	// ---- intents ----

	addIntent(i: Intent["type"], fields: Partial<Intent> & { payload?: Record<string, unknown> }, now = Date.now()) {
		this.db.run(
			`INSERT INTO sh_intent (type, template, threadId, workerId, questionId, dueAt, payload, status, createdAt)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
			i, fields.template ?? null, fields.threadId ?? null, fields.workerId ?? null, fields.questionId ?? null, fields.dueAt ?? null, j(fields.payload), now,
		);
	}

	pendingIntents() {
		return this.db.all<{ id: number; type: string; template: string | null; threadId: string | null; workerId: string | null; questionId: string | null; dueAt: number | null; payload: string | null; status: string }>(
			`SELECT id, type, template, threadId, workerId, questionId, dueAt, payload, status FROM sh_intent WHERE status = 'pending' ORDER BY id`,
		).map((r) => ({ ...r, payload: r.payload ? pj<Record<string, unknown>>(r.payload, {}) : {} }));
	}

	completeIntent(id: number) {
		this.db.run(`UPDATE sh_intent SET status = 'done' WHERE id = ?`, id);
	}

	// ---- views ----

	situation() {
		const threads = this.db.all<{ threadId: string; title: string; state: string; unread: number; lastActivityAt: number }>(
			`SELECT threadId, title, state, unread, lastActivityAt FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC LIMIT 30`,
		);
		const workers = this.db.all<{ workerId: string; threadId: string; state: string | null; lastProgress: string | null }>(
			`SELECT workerId, threadId, state, lastProgress FROM sh_worker ORDER BY workerId`,
		);
		return { threads, workers };
	}
}
