// Ledger schema (steward.md §2.2, M1 subset). All tables prefixed sh_.
export const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sh_machine (
		deviceId TEXT PRIMARY KEY, name TEXT, online INTEGER NOT NULL DEFAULT 0,
		lastSeen INTEGER, capabilities TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_repo (
		repoId TEXT PRIMARY KEY, deviceId TEXT, path TEXT, name TEXT,
		defaultBranch TEXT, remote TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_thread (
		threadId TEXT PRIMARY KEY, title TEXT, goal TEXT, summary TEXT, summaryAt INTEGER,
		state TEXT NOT NULL DEFAULT 'idle', unread INTEGER NOT NULL DEFAULT 0,
		lastActivityAt INTEGER, archived INTEGER NOT NULL DEFAULT 0, createdFromMsg TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_thread_repo (
		threadId TEXT, repoId TEXT, PRIMARY KEY (threadId, repoId))`,
	`CREATE TABLE IF NOT EXISTS sh_worker (
		workerId TEXT PRIMARY KEY, threadId TEXT, deviceId TEXT, repoId TEXT, agent TEXT,
		mode TEXT, state TEXT, sessionId TEXT, branch TEXT, parentWorker TEXT,
		lastOutcome TEXT, lastEventAt INTEGER, lastProgress TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_report (
		workerId TEXT, seq INTEGER, status TEXT, summary TEXT, changes TEXT, decisions TEXT,
		leftovers TEXT, tests TEXT, question TEXT, next TEXT, git TEXT, receivedAt INTEGER,
		PRIMARY KEY (workerId, seq))`,
	`CREATE TABLE IF NOT EXISTS sh_timeline (
		id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT, ts INTEGER, kind TEXT, text TEXT, refs TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_question (
		qid TEXT PRIMARY KEY, threadId TEXT, workerId TEXT, text TEXT, options TEXT,
		status TEXT NOT NULL DEFAULT 'open', askedAt INTEGER, answeredAt INTEGER, source TEXT)`,
	`CREATE TABLE IF NOT EXISTS sh_event (
		workerId TEXT, seq INTEGER, payload TEXT, receivedAt INTEGER, PRIMARY KEY (workerId, seq))`,
	`CREATE TABLE IF NOT EXISTS sh_worker_ack (
		workerId TEXT PRIMARY KEY, upTo INTEGER NOT NULL DEFAULT 0, processedUpTo INTEGER NOT NULL DEFAULT 0)`,
	`CREATE TABLE IF NOT EXISTS sh_inbound (
		channel TEXT, msgId TEXT, receivedAt INTEGER, PRIMARY KEY (channel, msgId))`,
	`CREATE TABLE IF NOT EXISTS sh_outbound (
		id TEXT PRIMARY KEY, channel TEXT, kind TEXT, threadId TEXT, payload TEXT,
		urgency TEXT NOT NULL DEFAULT 'quiet', status TEXT NOT NULL DEFAULT 'queued',
		attempts INTEGER NOT NULL DEFAULT 0, nextAttemptAt INTEGER, providerMsgId TEXT, createdAt INTEGER)`,
	`CREATE TABLE IF NOT EXISTS sh_intent (
		id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, template TEXT, threadId TEXT,
		workerId TEXT, questionId TEXT, payload TEXT, status TEXT NOT NULL DEFAULT 'pending',
		dueAt INTEGER, createdAt INTEGER)`,
	`CREATE INDEX IF NOT EXISTS sh_timeline_thread ON sh_timeline (threadId, id)`,
	`CREATE INDEX IF NOT EXISTS sh_outbound_status ON sh_outbound (status, nextAttemptAt)`,
];
