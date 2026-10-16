// LocalStore (ADR-0001 decision 13): device credentials, the connEpoch counter, the command
// dedup log (connector-pi.md §6.3), and the persistent event log with per-worker seq counters —
// all in node:sqlite so they survive connector restarts (the spike's seqs.json bug: the DO
// dedups on (workerId, seq), so a restart that renumbers events silently drops them all).
// The worker-pi slice adds the repo whitelist (§8.1) and worker lifecycle rows (§5.1); command
// and event persistence live in CommandLog/EventLog over the same database.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    chmodSync(path, 0o600);
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
        `INSERT INTO worker (workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, lastOutcome, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET state = excluded.state, sessionId = excluded.sessionId,
           sessionFile = excluded.sessionFile, branch = excluded.branch, worktree = excluded.worktree,
           lastOutcome = excluded.lastOutcome, updatedAt = excluded.updatedAt`,
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
        worker.lastOutcome ?? null,
        worker.createdAt ?? Date.now(),
        Date.now(),
      );
  }

  getWorker(workerId: string): WorkerRow | null {
    return (
      (this.db
        .prepare(
          `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, lastOutcome, createdAt, updatedAt
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
        `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, branch, worktree, lastOutcome, createdAt, updatedAt
         FROM worker ORDER BY workerId`,
      )
      .all() as unknown as WorkerRow[];
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
  lastOutcome?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

