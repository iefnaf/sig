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
    // Ledger core (issue #5, steward.md §2.2 / §5): the sh_* tables the memory module owns.
    // Callers reach them only through ledger.ts — never with raw SQL.
    id: "004_ledger_core",
    up: (sql) => {
      // Machines. `online` derives from live connections, never asserted by anyone else.
      // `reliability` (online habits) is record-only in the MVP (steward.md §2.2).
      sql`CREATE TABLE IF NOT EXISTS sh_machine (
        deviceId TEXT PRIMARY KEY, name TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 0,
        lastSeen INTEGER, agents TEXT, maxWorkers INTEGER NOT NULL DEFAULT 1,
        reliability TEXT
      )`;
      // Repositories reported by connectors at hello; one row per (repo, machine).
      sql`CREATE TABLE IF NOT EXISTS sh_repo (
        repoId TEXT NOT NULL, deviceId TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
        defaultBranch TEXT, remote TEXT, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (repoId, deviceId)
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_repo_name ON sh_repo (name)`;
      // Threads. `state` is derived (steward.md §5.2): recomputed by the reducer after every
      // change, never set directly by the LLM or the user. `lastMachine` is dispatch affinity
      // (spike bug 4): a continuation goes back to the same machine and queues while offline.
      sql`CREATE TABLE IF NOT EXISTS sh_thread (
        threadId TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT,
        state TEXT NOT NULL DEFAULT 'idle', unread INTEGER NOT NULL DEFAULT 0,
        lastMachine TEXT, lastActivityAt INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, createdFromMsg TEXT, createdAt INTEGER NOT NULL
      )`;
      sql`CREATE TABLE IF NOT EXISTS sh_thread_repo (
        threadId TEXT NOT NULL, repoId TEXT NOT NULL, PRIMARY KEY (threadId, repoId)
      )`;
      // One row per worker session (steward.md §2.2; parentWorker/relay arrives with M2).
      sql`CREATE TABLE IF NOT EXISTS sh_worker (
        workerId TEXT PRIMARY KEY, threadId TEXT NOT NULL, deviceId TEXT NOT NULL, repoId TEXT,
        agent TEXT NOT NULL, mode TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'starting', sessionId TEXT, branch TEXT, cmdId TEXT,
        lastOutcome TEXT, lastEventAt INTEGER, lastProgress TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_worker_thread ON sh_worker (threadId)`;
      // A worker's structured closing report (the protocol `report` event); raw material for
      // handoff briefs and the deterministic done-report card. Keyed (workerId, seq): the
      // reducer only ever processes a seq once (worker_ack.processedUpTo).
      sql`CREATE TABLE IF NOT EXISTS sh_report (
        workerId TEXT NOT NULL, seq INTEGER NOT NULL, threadId TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL,
        changes TEXT, decisions TEXT, leftovers TEXT, tests TEXT, question TEXT, next TEXT, git TEXT,
        receivedAt INTEGER NOT NULL,
        PRIMARY KEY (workerId, seq)
      )`;
      // Summary-level timeline (L2): user instructions, dispatches, reports, questions,
      // system notes. No raw transcripts.
      sql`CREATE TABLE IF NOT EXISTS sh_timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, ts INTEGER NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, refs TEXT
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_timeline_thread ON sh_timeline (threadId, id)`;
      // Open questions; the basis of the "waiting for you" state (steward.md §5.2).
      sql`CREATE TABLE IF NOT EXISTS sh_question (
        qid TEXT PRIMARY KEY, threadId TEXT NOT NULL, workerId TEXT,
        text TEXT NOT NULL, options TEXT, status TEXT NOT NULL DEFAULT 'open',
        askedAt INTEGER NOT NULL, answeredAt INTEGER
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_question_thread ON sh_question (threadId, status)`;
      // Notification intents: written inside the reducer's transaction, drained afterwards
      // into sh_outbound (steward.md §5.1 step 4). A crash between commit and send leaves the
      // row pending; the next wake drains it — done reports must not depend on in-memory state.
      sql`CREATE TABLE IF NOT EXISTS sh_notify (
        id INTEGER PRIMARY KEY AUTOINCREMENT, dedupeKey TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, threadId TEXT NOT NULL, workerId TEXT,
        createdAt INTEGER NOT NULL, sentAt INTEGER
      )`;
      // Reducer watermark (protocol §4.3 "processing decoupled from persistence"): events are
      // persisted to event_inbox + acked by the transport, then applied to the ledger exactly
      // once per (workerId, seq), in order, stopping at gaps.
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE worker_ack ADD COLUMN processedUpTo INTEGER NOT NULL DEFAULT 0`;
      });
      // "Reply to this message → which Thread" (steward.md §3.1 signal 1).
      sql`CREATE INDEX IF NOT EXISTS sh_outbound_provider_msg ON sh_outbound (providerMsgId)`;
    },
  },
  {
    // QR-code onboarding (issue #24, steward.md §9.0): the device-flow state machine lives in
    // `sh_qr_setup` (one row — a deployment runs one onboarding); the resulting per-app facts
    // (brand, source, webhook-switch progress) extend the `sh_channel` row.
    id: "005_qr_onboarding",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        // `source` distinguishes the QR flow (owner bound at scan time; setup stays open until
        // webhook delivery is verified) from the manual flow (closed on the owner's first DM).
        // NULL reads as 'manual' — the pre-#24 rows and SERVER_KEY-rotation recoveries.
        sql`ALTER TABLE sh_channel ADD COLUMN source TEXT`;
        sql`ALTER TABLE sh_channel ADD COLUMN brand TEXT NOT NULL DEFAULT 'feishu'`;
        sql`ALTER TABLE sh_channel ADD COLUMN webhookStatus TEXT`;
        sql`ALTER TABLE sh_channel ADD COLUMN webhookPatchedAt INTEGER`;
        sql`ALTER TABLE sh_channel ADD COLUMN webhookVerifiedAt INTEGER`;
      });
      // phase: awaiting_scan (QR #1) -> awaiting_scope_scan (QR #2) -> scope_added (PATCH
      // pending/failed) -> webhook_patched (console republish + first event awaited) -> done;
      // failed is terminal for the create flow (restart offered), created = scan #1 done but
      // scan #2 not begun. `origin` is the setup page's origin — the source of the PATCH's
      // request_url and of the prefilled, deployment-distinguishing bot name.
      sql`CREATE TABLE IF NOT EXISTS sh_qr_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        phase TEXT NOT NULL,
        flow TEXT NOT NULL,
        deviceCode TEXT NOT NULL,
        brand TEXT NOT NULL DEFAULT 'feishu',
        intervalS INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        qrUrl TEXT NOT NULL,
        userCode TEXT,
        origin TEXT,
        lastError TEXT,
        updatedAt INTEGER NOT NULL
      )`;
    },
  },
  {
    // The steward LLM (issue #6, steward.md §4-§6): thread summaries for bookkeeping, the
    // durable wake_request queue with its merge window (§5.1/§5.4), and sh_run — the run
    // bookkeeping that decides how a settled run's text is handled (reply vs discard, §6.2).
    id: "006_steward_llm",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_thread ADD COLUMN summary TEXT`;
        sql`ALTER TABLE sh_thread ADD COLUMN summaryAt INTEGER`;
      });
      // Wake_requests: written inside the reducer's transaction, submitted by the drain alarm
      // after the merge window. `operationId` is fixed at queue time — harness.submit
      // deduplicates on it, so replays/crash-restarts never create a second steward input.
      // `dedupeKey` makes the reducer's own queueing idempotent; `status='merged' rows were
      // folded into an earlier still-pending wake's text (§5.4).
      sql`CREATE TABLE IF NOT EXISTS sh_wake (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operationId TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        dedupeKey TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        dueAt INTEGER NOT NULL,
        mergedInto INTEGER,
        createdAt INTEGER NOT NULL,
        submittedAt INTEGER
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_wake_due ON sh_wake (status, dueAt)`;
      // One row per steward input (§6.3): kind=user runs reply with the settled final text;
      // event/routine/followup runs keep the text for audit and never send it (§6.2).
      // routedThreadId records the quote-routed Thread (§3.1 signal 1) resolved at submit time.
      sql`CREATE TABLE IF NOT EXISTS sh_run (
        operationId TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        replyTo TEXT,
        channel TEXT,
        routedThreadId TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        resultStatus TEXT,
        resultReason TEXT,
        resultText TEXT,
        replyOutboundId TEXT,
        createdAt INTEGER NOT NULL,
        settledAt INTEGER
      )`;
    },
  },
];
