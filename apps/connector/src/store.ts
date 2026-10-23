// LocalStore (ADR-0001 decision 13): device credentials, the connEpoch counter, the command
// dedup log (connector-pi.md §6.3), and the persistent event log with per-worker seq counters —
// all in node:sqlite so they survive connector restarts (the spike's seqs.json bug: the DO
// dedups on (workerId, seq), so a restart that renumbers events silently drops them all).
// The worker-pi slice adds the repo whitelist (§8.1) and worker lifecycle rows (§5.1); command
// and event persistence live in CommandLog/EventLog over the same database. Issue #12 adds
// the §9 recovery tables: descendant snapshots for orphan cleanup (§9.3) and the per-worker
// auto-resume budget (§9.2), both read at startup before the first hello. Issue #16 adds the
// §8.2/§13 per-repo local settings — workspace mode and approveProject, CLI-settable only —
// plus the serial-mode write queue.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcRef } from "./descendants.ts";
import { normalizeProxyConfig, type ProxyConfig } from "./proxy.ts";

export interface Credentials {
  serverUrl: string;
  deviceId: string;
  token: string;
  connEpoch: number;
}

/** Per-repo workspace mode (connector-pi.md §8.2): how write tasks get a working directory. */
export type WorkspaceMode = "worktree" | "serial" | "main";

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ["worktree", "serial", "main"];

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return typeof value === "string" && (WORKSPACE_MODES as readonly string[]).includes(value);
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
    // Issue #17: which AgentAdapter owns the worker — set at start, immutable afterwards.
    this.addColumnIfMissing("worker", "agent", "TEXT NOT NULL DEFAULT 'pi'");
    // The worktree base (§8.2) persisted so a restarted connector can still collect git
    // facts for a retroactive report (§9.1) — spikes kept it only in memory.
    this.addColumnIfMissing("worker", "base", "TEXT");
    // Issue #15, §6.3/§10: crash-window evidence — the command's recovery context and the
    // session-entry watermark a pre-launch comparison starts from.
    this.addColumnIfMissing("worker", "lastKnownEntryId", "TEXT");
    for (const column of ["workerId", "kind", "sessionFile", "afterEntryId"]) {
      this.addColumnIfMissing("command", column, "TEXT");
    }
    this.addColumnIfMissing("command", "markerExpected", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("command", "recovered", "INTEGER NOT NULL DEFAULT 0");
    // §8.2/§13 (issue #16): per-repo local settings. Both are CLI-only — a command from the
    // steward gets their effects but can never set them.
    this.addColumnIfMissing("repo", "workspace", "TEXT NOT NULL DEFAULT 'worktree'");
    this.addColumnIfMissing("repo", "approved", "INTEGER NOT NULL DEFAULT 0");
    // Review finding 5 (PR #43): marks a worktree removed by cleanup_worktree, so a later
    // manual resume can be refused instead of silently running write-mode in the checkout.
    // A NULL worktree alone cannot carry that meaning — synthetic/legacy rows have it NULL.
    this.addColumnIfMissing("worker", "worktreeCleanedAt", "INTEGER");
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
    // §8.2 serial mode (issue #16): the start_worker args of write workers waiting for the
    // repo's serial slot, so a connector restart re-arms the queue instead of stranding the
    // Thread at `starting` forever (the command result already went out with queued:true).
    this.db.exec(`CREATE TABLE IF NOT EXISTS queued_start (
      workerId TEXT PRIMARY KEY,
      commandId TEXT NOT NULL,
      args TEXT NOT NULL,
      queuedAt INTEGER NOT NULL
    )`);
    // Issue #68: machine-local proxy config (key "proxy"). Stored here — not in the service
    // unit's environment — so the background daemon reads it at boot and both its channels
    // (fetch, ws) plus every child (git, pi workers via childEnv) follow it.
    this.db.exec(`CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
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

  // --- Machine-local config (issue #68) -------------------------------------------------------

  /** The stored proxy config, or null. A row that no longer parses is treated as absent
   *  (hand-edited or from a future format) rather than failing the daemon's boot. */
  getProxyConfig(): ProxyConfig | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'proxy'").get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { url?: unknown; noProxy?: unknown };
      if (typeof parsed.url !== "string") return null;
      return normalizeProxyConfig(parsed.url, typeof parsed.noProxy === "string" ? parsed.noProxy : undefined);
    } catch {
      return null;
    }
  }

  setProxyConfig(config: ProxyConfig): void {
    this.db
      .prepare("INSERT INTO config (key, value) VALUES ('proxy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(config));
  }

  clearProxyConfig(): void {
    this.db.prepare("DELETE FROM config WHERE key = 'proxy'").run();
  }

  close(): void {
    this.db.close();
  }

  // --- Repositories (connector-pi.md §8.1) ---------------------------------------------
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
    const row = this.db
      .prepare("SELECT repoId, name, path, defaultBranch, remote, workspace, approved FROM repo WHERE repoId = ?")
      .get(repoId) as ({ repoId: string; name: string; path: string; defaultBranch: string | null; remote: string | null; workspace: string; approved: number } | undefined);
    return row ? { ...row, workspace: row.workspace as WorkspaceMode, approved: row.approved === 1 } : null;
  }

  listRepos(): RegisteredRepo[] {
    return (
      this.db
        .prepare("SELECT repoId, name, path, defaultBranch, remote, workspace, approved FROM repo ORDER BY repoId")
        .all() as Array<{ repoId: string; name: string; path: string; defaultBranch: string | null; remote: string | null; workspace: string; approved: number }>
    ).map((row) => ({ ...row, workspace: row.workspace as WorkspaceMode, approved: row.approved === 1 }));
  }

  /** Updates the local-only per-repo settings (§8.2/§13). False when the repo is unknown. */
  setRepoConfig(repoId: string, patch: { workspace?: WorkspaceMode; approved?: boolean }): boolean {
    if (!this.getRepo(repoId)) return false;
    if (patch.workspace !== undefined) {
      this.db.prepare("UPDATE repo SET workspace = ? WHERE repoId = ?").run(patch.workspace, repoId);
    }
    if (patch.approved !== undefined) {
      this.db.prepare("UPDATE repo SET approved = ? WHERE repoId = ?").run(patch.approved ? 1 : 0, repoId);
    }
    return true;
  }

  // --- Workers (connector-pi.md §5.1) ----------------------------------------------------

  upsertWorker(worker: WorkerRow): void {
    this.db
      .prepare(
        `INSERT INTO worker (workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, branch, worktree, base, agent, lastOutcome, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET state = excluded.state, sessionId = excluded.sessionId,
           sessionFile = excluded.sessionFile, lastKnownEntryId = excluded.lastKnownEntryId,
           branch = excluded.branch, worktree = excluded.worktree,
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
        worker.lastKnownEntryId ?? null,
        worker.branch ?? null,
        worker.worktree ?? null,
        worker.base ?? null,
        worker.agent ?? "pi",
        worker.lastOutcome ?? null,
        worker.createdAt ?? Date.now(),
        Date.now(),
      );
  }

  getWorker(workerId: string): WorkerRow | null {
    return (
      (this.db
        .prepare(
          `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, branch, worktree, base, worktreeCleanedAt, agent, lastOutcome, createdAt, updatedAt
           FROM worker WHERE workerId = ?`,
        )
        .get(workerId) as WorkerRow | undefined) ?? null
    );
  }

  /** §10: refresh the worker's session file and external-activity baseline. */
  setSessionObservation(workerId: string, sessionFile: string, lastKnownEntryId: string | null): void {
    this.db
      .prepare("UPDATE worker SET sessionFile = ?, lastKnownEntryId = ?, updatedAt = ? WHERE workerId = ?")
      .run(sessionFile, lastKnownEntryId, Date.now(), workerId);
  }

  setWorkerState(workerId: string, state: string, lastOutcome?: string): void {
    this.db
      .prepare("UPDATE worker SET state = ?, lastOutcome = COALESCE(?, lastOutcome), updatedAt = ? WHERE workerId = ?")
      .run(state, lastOutcome ?? null, Date.now(), workerId);
  }

  listWorkers(): WorkerRow[] {
    // Creation order (workerId as tiebreak): the serial write queue drains FIFO on it.
    return this.db
      .prepare(
        `SELECT workerId, threadId, repoId, mode, state, sessionId, sessionFile, lastKnownEntryId, branch, worktree, base, worktreeCleanedAt, agent, lastOutcome, createdAt, updatedAt
         FROM worker ORDER BY createdAt, workerId`,
      )
      .all() as unknown as WorkerRow[];
  }

  /** Drops the worktree/branch columns after cleanup_worktree removed the directory. */
  clearWorkerWorktree(workerId: string): void {
    this.db
      .prepare(
        "UPDATE worker SET worktree = NULL, branch = NULL, base = NULL, worktreeCleanedAt = ?, updatedAt = ? WHERE workerId = ?",
      )
      .run(Date.now(), Date.now(), workerId);
  }

  /** Backfills the worktree columns on a row whose launch aborted around the spawn (PR #43
   * review N3: the stop's settle already wrote state/lastOutcome — this must touch ONLY the
   * worktree columns, never state, or the stop's bookkeeping gets clobbered). */
  setWorkerWorktree(
    workerId: string,
    fields: { worktree: string; branch: string | null; base: string | null },
  ): void {
    this.db
      .prepare(
        "UPDATE worker SET worktree = ?, branch = ?, base = ?, worktreeCleanedAt = NULL, updatedAt = ? WHERE workerId = ?",
      )
      .run(fields.worktree, fields.branch, fields.base, Date.now(), workerId);
  }

  // --- Serial write queue (connector-pi.md §8.2, issue #16) ----------------------------

  saveQueuedStart(workerId: string, commandId: string, args: unknown): void {
    this.db
      .prepare(
        `INSERT INTO queued_start (workerId, commandId, args, queuedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(workerId) DO UPDATE SET commandId = excluded.commandId, args = excluded.args, queuedAt = excluded.queuedAt`,
      )
      .run(workerId, commandId, JSON.stringify(args), Date.now());
  }

  getQueuedStart(workerId: string): { commandId: string; args: unknown } | null {
    const row = this.db.prepare("SELECT commandId, args FROM queued_start WHERE workerId = ?").get(workerId) as
      | { commandId: string; args: string }
      | undefined;
    if (!row) return null;
    try {
      return { commandId: row.commandId, args: JSON.parse(row.args) };
    } catch {
      return null;
    }
  }

  deleteQueuedStart(workerId: string): void {
    this.db.prepare("DELETE FROM queued_start WHERE workerId = ?").run(workerId);
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
  /** How write tasks get a directory (§8.2): a fresh worktree (default), one-at-a-time serial
   * worktrees, or the main checkout itself. */
  workspace: WorkspaceMode;
  /** approveProject (§13): run pi with --approve in this repo. Set on the machine only. */
  approved: boolean;
}

export interface WorkerRow {
  workerId: string;
  threadId: string;
  repoId: string;
  mode: string;
  state: string;
  /** Which agent owns the worker (issue #17); 'pi' for rows predating Claude Code. */
  agent?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
  /** §10: the last session entry id the connector saw (pre-launch external-change baseline). */
  lastKnownEntryId?: string | null;
  branch?: string | null;
  worktree?: string | null;
  /** The commit-ish the worktree branch started from (§8.2); git-facts input after a restart. */
  base?: string | null;
  /** Set by cleanup_worktree (review finding 5): the worktree is gone on purpose. */
  worktreeCleanedAt?: number | null;
  lastOutcome?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

