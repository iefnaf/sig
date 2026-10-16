// LocalStore (ADR-0001 decision 13): device credentials, the connEpoch counter, the command
// dedup log (connector-pi.md §6.3), and the persistent event log with per-worker seq counters —
// all in node:sqlite so they survive connector restarts (the spike's seqs.json bug: the DO
// dedups on (workerId, seq), so a restart that renumbers events silently drops them all).
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

  clearCredentials(): void {
    this.db.exec("DELETE FROM credentials");
  }

  close(): void {
    this.db.close();
  }
}
