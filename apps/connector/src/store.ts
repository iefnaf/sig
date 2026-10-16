// LocalStore (ADR-0001 decision 13): device credentials, the connEpoch counter, the command
// dedup log (connector-pi.md §6.3), and the persistent event log with per-worker seq counters —
// all in node:sqlite so they survive connector restarts (the spike's seqs.json bug: the DO
// dedups on (workerId, seq), so a restart that renumbers events silently drops them all).
// The worker-pi slice adds the repo whitelist (§8.1) and worker lifecycle rows (§5.1); command
// and event persistence live in CommandLog/EventLog over the same database. Issue #12 adds
// the §9 recovery tables: descendant snapshots for orphan cleanup (§9.3) and the per-worker
// auto-resume budget (§9.2), both read at startup before the first hello.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcRef } from "./descendants.ts";

export interface Credentials {
  serverUrl: string;
  deviceId: string;
  token: string;
  connEpoch: number;
}

export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      serverUrl TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      token TEXT NOT NULL,
      connEpoch INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS command (
      cmdId TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      result TEXT,
      createdAt INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS event (
      workerId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (workerId, seq)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_seq (
      workerId TEXT PRIMARY KEY,
      nextSeq INTEGER NOT NULL DEFAULT 1,
      ackedUpTo INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS repo (
      repoId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      defaultBranch TEXT,
      remote TEXT,
      addedAt INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker (
      workerId TEXT PRIMARY KEY,
      threadId TEXT NOT NULL,
      repoId TEXT NOT NULL,
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      sessionId TEXT,
      sessionFile TEXT,
      branch TEXT,
      worktree TEXT,
      lastOutcome TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    // The worktree base (§8.2) persisted so a restarted connector can still collect git
    // facts for a retroactive report (§9.1) — spikes kept it only in memory.
    this.addColumnIfMissing("worker", "base", "TEXT");
    // §9.3: the latest 5-second descendant snapshot per running worker.
    this.db.exec(`CREATE TABLE IF NOT EXISTS orphan_snapshot (
      workerId TEXT PRIMARY KEY,
      refs TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
    // §9.2: auto-resume attempts; the ≤2/hour budget is computed over these rows.
    this.db.exec(`CREATE TABLE IF NOT EXISTS worker_resume (
      workerId TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS worker_resume_worker_at ON worker_resume (workerId, at)`);
    chmodSync(path, 0o600);
  }

  /** Idempotent ALTER for databases created before a column existed (spike bug 2 pattern). */
  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  // Shared with CommandLog / EventLog, which own their own tables' logic.
  get database(): DatabaseSync {
    return this.db;
  }

  saveCredentials(credentials: Omit<Credentials, "connEpoch">): void {
    this.db.exec("DELETE FROM credentials");
    this.db
      .prepare("INSERT INTO credentials (id, serverUrl, deviceId, token, connEpoch) VALUES (0, ?, ?, ?, 0)")
      .run(credentials.serverUrl, credentials.deviceId, credentials.token);
  }

  getCredentials(): Credentials | null {
    const row = this.db.prepare("SELECT serverUrl, deviceId, token, connEpoch FROM credentials WHERE id = 0").get() as
      | Credentials
      | undefined;
    return row ?? null;
  }

  // Increments and persists connEpoch, then returns the new value. Called once per connection
  // attempt (protocol §3.4): the DO supersedes any live connection with a lower connEpoch.
  nextConnEpoch(): number {
    const row = this.db.prepare("SELECT connEpoch FROM credentials WHERE id = 0").get() as { connEpoch: number } | undefined;
    if (!row) throw new Error("no credentials saved");
    const next = row.connEpoch + 1;
    this.db.prepare("UPDATE credentials SET connEpoch = ? WHERE id = 0").run(next);
    return next;
  }

  /** Replaces just the token — SERVER_KEY rotation (issue #27): the steward hands the
   * connector a rekeyed token on welcome; serverUrl/deviceId/epoch are unchanged. */
  updateToken(token: string): void {
    this.db.prepare("UPDATE credentials SET token = ? WHERE id = 0").run(token);
  }

  clearCredentials(): void {
    this.db.exec("DELETE FROM credentials");
  }

  close(): void {
    this.db.close();
  }

  // --- Repositories (connector-pi.md §8.1) ---------------------------------------------
  // The connector starts workers only in registered repositories, so even a compromised
  // steward cannot make it start an agent in an arbitrary directory.

  addRepo(repo: {
    repoId: string;
    name: string;
    path: string;
    defaultBranch: string | null;
    remote: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO repo (repoId, name, path, defaultBranch, remote, addedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repoId) DO UPDATE SET name = excluded.name, path = excluded.path,
           defaultBranch = excluded.defaultBranch, remote = excluded.remote`,
      )
      .run(repo.repoId, repo.name, repo.path, repo.defaultBranch, repo.remote, Date.now());
  }

  getRepo(repoId: string): RegisteredRepo | null {
    return (
      (this.db
        .prepare("SELECT repoId, name, path, defaultBranch, remote FROM repo WHERE repoId = ?")
        .get(repoId) as RegisteredRepo | undefined) ?? null
    );
  }

  listRepos(): RegisteredRepo[] {
    return this.db
      .prepare("SELECT repoId, name, path, defaultBranch, remote FROM repo ORDER BY repoId")
      .all() as unknown as RegisteredRepo[];
  }

  // --- Workers (connector-pi.md §5.1) ----------------------------------------------------

  upsertWorker(worker: WorkerRow): void {
    this.db
      .prepare(
        `INSERT INTO worker (workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, base, lastOutcome, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET state = excluded.state, sessionId = excluded.sessionId,
           sessionFile = excluded.sessionFile, branch = excluded.branch, worktree = excluded.worktree,
           base = excluded.base, lastOutcome = excluded.lastOutcome, updatedAt = excluded.updatedAt`,
      )
      .run(
        worker.workerId,
        worker.threadId,
        worker.repoId,
        worker.mode,
        worker.state,
        worker.sessionId ?? null,
        worker.sessionFile ?? null,
        worker.branch ?? null,
        worker.worktree ?? null,
        worker.base ?? null,
        worker.lastOutcome ?? null,
        worker.createdAt ?? Date.now(),
        Date.now(),
      );
  }

  getWorker(workerId: string): WorkerRow | null {
    return (
      (this.db
        .prepare(
          `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, base, lastOutcome, createdAt, updatedAt
           FROM worker WHERE workerId = ?`,
        )
        .get(workerId) as WorkerRow | undefined) ?? null
    );
  }

  setWorkerState(workerId: string, state: string, lastOutcome?: string): void {
    this.db
      .prepare("UPDATE worker SET state = ?, lastOutcome = COALESCE(?, lastOutcome), updatedAt = ? WHERE workerId = ?")
      .run(state, lastOutcome ?? null, Date.now(), workerId);
  }

  listWorkers(): WorkerRow[] {
    return this.db
      .prepare(
        `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, base, lastOutcome, createdAt, updatedAt
         FROM worker ORDER BY workerId`,
      )
      .all() as unknown as WorkerRow[];
  }

  // --- Recovery (connector-pi.md §9) -----------------------------------------------------

  setOrphanSnapshot(workerId: string, refs: ProcRef[]): void {
    this.db
      .prepare(
        `INSERT INTO orphan_snapshot (workerId, refs, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET refs = excluded.refs, updatedAt = excluded.updatedAt`,
      )
      .run(workerId, JSON.stringify(refs), Date.now());
  }

  getOrphanSnapshot(workerId: string): ProcRef[] | null {
    const row = this.db.prepare("SELECT refs FROM orphan_snapshot WHERE workerId = ?").get(workerId) as
      | { refs: string }
      | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.refs) as ProcRef[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  listOrphanSnapshots(): string[] {
    return (this.db.prepare("SELECT workerId FROM orphan_snapshot").all() as Array<{ workerId: string }>).map(
      (r) => r.workerId,
    );
  }

  deleteOrphanSnapshot(workerId: string): void {
    this.db.prepare("DELETE FROM orphan_snapshot WHERE workerId = ?").run(workerId);
  }

  /** Records one resume attempt at `now` and returns the count inside the window, this
   * attempt included — the ≤2/hour budget of §9.2, persisted so a crash mid-recovery
   * (a connector killed between two attempts) cannot reset it. */
  recordResume(workerId: string, windowMs = 3_600_000): number {
    this.db.prepare("INSERT INTO worker_resume (workerId, at) VALUES (?, ?)").run(workerId, Date.now());
    return this.countResumes(workerId, windowMs);
  }

  countResumes(workerId: string, windowMs = 3_600_000): number {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM worker_resume WHERE workerId = ? AND at > ?")
      .get(workerId, Date.now() - windowMs) as { n: number };
    return n;
  }

}

export interface RegisteredRepo {
  repoId: string;
  name: string;
  path: string;
  defaultBranch: string | null;
  remote: string | null;
}

export interface WorkerRow {
  workerId: string;
  threadId: string;
  repoId: string;
  mode: string;
  state: string;
  sessionId?: string | null;
  sessionFile?: string | null;
  branch?: string | null;
  worktree?: string | null;
  /** The commit-ish the worktree branch started from (§8.2); git-facts input after a restart. */
  base?: string | null;
  lastOutcome?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

