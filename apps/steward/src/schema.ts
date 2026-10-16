// Idempotent migration runner (spike bug 2: `CREATE TABLE IF NOT EXISTS` never adds columns
// to an existing table; a ledger of applied migration ids plus plain ALTER statements fixes it).
export interface SqlExecutor {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[];
}

export interface Migration {
  id: string;
  up: (sql: SqlExecutor) => void;
}

export function runMigrations(sql: SqlExecutor, migrations: readonly Migration[]): void {
  sql`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, appliedAt INTEGER)`;
  for (const migration of migrations) {
    const applied = sql<{ id: string }>`SELECT id FROM _migrations WHERE id = ${migration.id}`;
    if (applied.length > 0) continue;
    migration.up(sql);
    sql`INSERT INTO _migrations (id, appliedAt) VALUES (${migration.id}, ${Date.now()})`;
  }
}

// SQLite has no "ADD COLUMN IF NOT EXISTS"; this tolerates re-applying an ALTER if the
// `_migrations` ledger and the schema ever drift (e.g. a crash right after `up()` runs but
// before the ledger row is written).
export function ignoringDuplicateColumn(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_device_and_pairing",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS device (
        deviceId TEXT PRIMARY KEY, name TEXT, epoch INTEGER NOT NULL DEFAULT 1,
        revoked INTEGER NOT NULL DEFAULT 0, createdAt INTEGER
      )`;
      sql`CREATE TABLE IF NOT EXISTS pairing (
        code TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      )`;
    },
  },
  {
    id: "002_outbox_and_event_inbox",
    up: (sql) => {
      // state machine: queued -> sent -> accepted -> done/failed/expired/ambiguous (protocol §4.2).
      // failReason distinguishes failed rows hello should redeliver (ack_timeout) from terminal
      // ones it should not (rejected by the connector, or idle-expired while the device was offline).
      sql`CREATE TABLE IF NOT EXISTS outbox (
        cmdId TEXT PRIMARY KEY, deviceId TEXT NOT NULL, workerId TEXT, cseq INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, notAfter INTEGER,
        state TEXT NOT NULL DEFAULT 'queued', failReason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, sentAt INTEGER, ackDeadline INTEGER,
        result TEXT, createdAt INTEGER NOT NULL
      )`;
      sql`CREATE INDEX IF NOT EXISTS outbox_device_cseq ON outbox (deviceId, cseq)`;
      // unique on (workerId, seq): the DO's half of at-least-once delivery (protocol §4.3).
      sql`CREATE TABLE IF NOT EXISTS event_inbox (
        workerId TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, receivedAt INTEGER NOT NULL,
        PRIMARY KEY (workerId, seq)
      )`;
      sql`CREATE TABLE IF NOT EXISTS worker_ack (workerId TEXT PRIMARY KEY, upTo INTEGER NOT NULL DEFAULT 0)`;
    },
  },
];
