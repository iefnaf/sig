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
  {
    // Channel layer (steward.md §6.1, §9): the `sh_` names follow the design doc so the channel
    // queue is never confused with the connector protocol `outbox` above.
    id: "003_channel_feishu",
    up: (sql) => {
      // One row per channel once manual credentials are submitted (ADR-0001 decisions 8-9).
      // Secrets are AES-GCM sealed under SERVER_KEY (secretbox.ts); `ownerOpenId` NULL means
      // "credentials configured, awaiting the owner's first DM". Once set, setup is closed
      // forever — the row is never unbound.
      sql`CREATE TABLE IF NOT EXISTS sh_channel (
        channel TEXT PRIMARY KEY,
        appId TEXT NOT NULL,
        appSecretEnc TEXT NOT NULL,
        verificationTokenEnc TEXT NOT NULL,
        ownerOpenId TEXT,
        configuredAt INTEGER NOT NULL,
        boundAt INTEGER
      )`;
      // Inbound dedup, the persist-before-200 row (steward.md §9.1 / §11): Feishu retries
      // events, so (channel, msgId) is the idempotency key.
      sql`CREATE TABLE IF NOT EXISTS sh_inbound (
        channel TEXT NOT NULL, msgId TEXT NOT NULL, eventId TEXT, eventType TEXT,
        receivedAt INTEGER NOT NULL,
        PRIMARY KEY (channel, msgId)
      )`;
      // Outbound queue state machine: queued -> sending -> sent | failed. `claimToken` +
      // `claimExpiresAt` are the double-send guard (spike bug 1); `nextAttemptAt` drives the
      // alarm-backed exponential backoff (spike bug 3: 10s send timeouts + retries).
      sql`CREATE TABLE IF NOT EXISTS sh_outbound (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'feishu', kind TEXT NOT NULL,
        receiveId TEXT NOT NULL, threadId TEXT, payload TEXT NOT NULL,
        urgency TEXT NOT NULL DEFAULT 'quiet', status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0, claimToken TEXT, claimExpiresAt INTEGER,
        nextAttemptAt INTEGER NOT NULL, providerMsgId TEXT, lastError TEXT,
        createdAt INTEGER NOT NULL, sentAt INTEGER
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_outbound_due ON sh_outbound (status, nextAttemptAt)`;
      // "Everything else is ignored and logged": the audit trail for skipped inbound traffic.
      sql`CREATE TABLE IF NOT EXISTS sh_channel_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        channel TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT
      )`;
      // tenant_access_token cache (steward.md §9.2), refreshed ahead of expiry by an alarm.
      // The token is a Feishu bearer credential: sealed at rest (issue #27; the column is
      // renamed to tokenEnc by migration 004).
      sql`CREATE TABLE IF NOT EXISTS sh_channel_token (
        channel TEXT PRIMARY KEY, token TEXT NOT NULL, expiresAt INTEGER NOT NULL
      )`;
      // 5 QPS-per-receiver pacing (feishu-channel.md §4): last send time per receive_id.
      sql`CREATE TABLE IF NOT EXISTS sh_channel_pace (
        channel TEXT NOT NULL, receiveId TEXT NOT NULL, lastSendAt INTEGER NOT NULL,
        PRIMARY KEY (channel, receiveId)
      )`;
    },
  },
  {
    // Security hardening (issue #27): /pair brute-force lockout + sealed credentials.
    id: "004_security_hardening",
    up: (sql) => {
      // Sliding failure windows for /pair (protocol doc §5.2): 5 failures lock the bucket for
      // 15 minutes. One row per source IP (`scope='ip'`) plus one global bucket (`scope='all'`)
      // so a distributed guesser cannot sidestep the per-IP lock.
      sql`CREATE TABLE IF NOT EXISTS pair_fail (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        fails INTEGER NOT NULL DEFAULT 0,
        windowStart INTEGER NOT NULL,
        lockedUntil INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      )`;
      // Model provider credentials (spec §12.2 "model keys stored encrypted"): single row,
      // apiKey AES-GCM sealed under SERVER_KEY exactly like the Feishu secrets. The LLM wiring
      // (M2) reads it back through Steward.modelConfig(); nothing stores the raw key.
      sql`CREATE TABLE IF NOT EXISTS sh_model (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        provider TEXT NOT NULL,
        apiKeyEnc TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`;
      // The cached tenant_access_token is a Feishu bearer credential — seal it too. 003 always
      // ran before this (fresh and existing installs alike), so the rename never misses.
      sql`ALTER TABLE sh_channel_token RENAME COLUMN token TO tokenEnc`;
    },
  },
];
