// Idempotent migration runner (spike bug 2: `CREATE TABLE IF NOT EXISTS` never adds columns
// to an existing table; a ledger of applied migration ids plus plain ALTER statements fixes it).
export interface SqlExecutor {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[];
}

export interface Migration {
  id: string;
  up: (sql: SqlExecutor) => void;
}

export function runMigrations(
  sql: SqlExecutor,
  migrations: readonly Migration[],
  /** Wraps each migration — its statements AND the `_migrations` ledger write — in one
   *  atomic commit (review #48 finding 3). Crash-safety for the copy-drop-rename shapes
   * (migration 010's `sh_question` rebuild): without it a crash mid-migration strands the
   * schema between statements that can neither re-run (`INSERT … FROM sh_question` after
   * the `DROP`) nor roll forward, and onStart then fails on every restart. The DO passes
   * `ctx.storage.transactionSync`; plain-SQL runtimes without one (node:sqlite eval worlds)
   * may omit it. */
  tx?: (fn: () => void) => void,
): void {
  sql`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, appliedAt INTEGER)`;
  for (const migration of migrations) {
    const applied = sql<{ id: string }>`SELECT id FROM _migrations WHERE id = ${migration.id}`;
    if (applied.length > 0) continue;
    const apply = (): void => {
      migration.up(sql);
      sql`INSERT INTO _migrations (id, appliedAt) VALUES (${migration.id}, ${Date.now()})`;
    };
    if (tx === undefined) apply();
    else tx(apply);
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
    // Security hardening (issue #27): /pair brute-force lockout + sealed credentials.
    id: "006_security_hardening",
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
  {
    // Issue #12 (connector-pi.md §9.1 / protocol §6.1): hello.bootId distinguishes “reconnect
    // after a network blip” (same bootId) from “connector restart” (new bootId — every pi
    // process died in between). Stored per machine; the workers snapshot that rides the same
    // hello is reconciled against sh_worker in ledger.ts (workers.reconcileFromSnapshot).
    id: "007_machine_boot_id",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_machine ADD COLUMN bootId TEXT`;
      });
    },
  },
  {
    // The steward LLM (issue #6, steward.md §4-§6): thread summaries for bookkeeping, the
    // durable wake_request queue with its merge window (§5.1/§5.4), and sh_run — the run
    // bookkeeping that decides how a settled run's text is handled (reply vs discard, §6.2).
    // Numbered 008: upstream took 006 (security hardening) and 007 (machine boot id).
    id: "008_steward_llm",
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
      // routedThreadId records the Thread this run belongs to (§3.1 signal 1 at submit time,
      // or the run's own dispatch backfilled); `notified` marks runs that already produced
      // user-facing output, so an empty final text is not mistaken for a failure (review #9).
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
        notified INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        settledAt INTEGER
      )`;
    },
  },
  {
    // The signed-link web (issue #22, spec §7.3/§12.2, steward.md §10): one-time links minted
    // for the owner's chat, the sessions they are exchanged for, and the deployment's public
    // origin (links and pairing commands need absolute URLs, and the DO only ever sees the
    // origin through the requests it serves). These tables belong to web.ts. Numbered 009:
    // #6's steward_llm took 008 first in the merge.
    id: "009_web",
    up: (sql) => {
      // Single-use enforcement for signed links: the token's HMAC covers target + expiry
      // statelessly; this row is the "already opened" bit. tokenHash = SHA-256(token).
      sql`CREATE TABLE IF NOT EXISTS sh_web_link (
        tokenHash TEXT PRIMARY KEY, target TEXT NOT NULL,
        expiresAt INTEGER NOT NULL, usedAt INTEGER, createdAt INTEGER NOT NULL
      )`;
      // Sessions are random ids in the DB (revocable by deletion), not self-signed claims;
      // the cookie carries `ws1.<sid>.<mac>` so the Worker layer can reject garbage probes
      // without waking the DO (ADR-0001 decision 7's stateless pre-check pattern).
      sql`CREATE TABLE IF NOT EXISTS sh_web_session (
        sid TEXT PRIMARY KEY, csrf TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
      )`;
      sql`CREATE TABLE IF NOT EXISTS sh_deploy (
        id INTEGER PRIMARY KEY CHECK (id = 1), origin TEXT NOT NULL, updatedAt INTEGER NOT NULL
      )`;
    },
  },
  {
    // Routing (issue #7, steward.md §3): the FTS5 index behind threads.findCandidates, the
    // question shape ask_user's candidate buttons need, and the per-run dispatch counter the
    // settle-time verification compares against "dispatched" claims (spike-conclusions §2).
    id: "010_routing",
    up: (sql) => {
      // §2.2: full-text index over title + goal + summary + the latest report summary. The
      // trigram tokenizer gives substring matching for both CJK and latin text (verified in
      // workerd and node:sqlite — see docs/routing-eval.md); queries under 3 characters are
      // covered by findCandidates' bigram scorer, never by this index alone.
      sql`CREATE VIRTUAL TABLE IF NOT EXISTS sh_thread_fts USING fts5(threadId UNINDEXED, body, tokenize='trigram')`;
      // Trigger-synced (§13 lists this as unverified before #7): every write path keeps the
      // index current — insert, title/goal/summary updates, delete, and each new report
      // (whose summary joins the body as the thread's freshest facet).
      sql`CREATE TRIGGER IF NOT EXISTS sh_thread_fts_ai AFTER INSERT ON sh_thread BEGIN
        INSERT INTO sh_thread_fts (threadId, body) VALUES (
          new.threadId,
          COALESCE(new.title, '') || ' ' || COALESCE(new.goal, '') || ' ' || COALESCE(new.summary, '')
        );
      END`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_thread_fts_au AFTER UPDATE OF title, goal, summary ON sh_thread BEGIN
        DELETE FROM sh_thread_fts WHERE threadId = new.threadId;
        INSERT INTO sh_thread_fts (threadId, body) VALUES (
          new.threadId,
          COALESCE(new.title, '') || ' ' || COALESCE(new.goal, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE((SELECT r.summary FROM sh_report r WHERE r.threadId = new.threadId ORDER BY r.receivedAt DESC, r.seq DESC LIMIT 1), '')
        );
      END`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_thread_fts_ad AFTER DELETE ON sh_thread BEGIN
        DELETE FROM sh_thread_fts WHERE threadId = old.threadId;
      END`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_thread_fts_report AFTER INSERT ON sh_report BEGIN
        DELETE FROM sh_thread_fts WHERE threadId = new.threadId;
        INSERT INTO sh_thread_fts (threadId, body) SELECT
          new.threadId,
          COALESCE(t.title, '') || ' ' || COALESCE(t.goal, '') || ' ' || COALESCE(t.summary, '') || ' ' || COALESCE(new.summary, '')
          FROM sh_thread t WHERE t.threadId = new.threadId;
      END`;
      // Backfill for deployments that already have threads (idempotent guard: only rows the
      // index does not have yet — INSERT OR IGNORE cannot dedupe here because fts5 rows have
      // no unique constraint on the UNINDEXED column, so delete-then-insert per missing row).
      sql`INSERT INTO sh_thread_fts (threadId, body)
        SELECT th.threadId, COALESCE(th.title, '') || ' ' || COALESCE(th.goal, '') || ' ' || COALESCE(th.summary, '') || ' ' ||
          COALESCE((SELECT r.summary FROM sh_report r WHERE r.threadId = th.threadId ORDER BY r.receivedAt DESC, r.seq DESC LIMIT 1), '')
        FROM sh_thread th
        WHERE NOT EXISTS (SELECT 1 FROM sh_thread_fts f WHERE f.threadId = th.threadId)`;

      // ask_user's routing questions belong to no particular Thread (steward.md §3.3): the
      // question row is rebuilt with a nullable threadId, and `candidates` stores the button
      // mapping ({threadId, label}[] JSON) the card-action handler resolves clicks against.
      // The copy-drop-rename below is the one non-reentrant stretch in this migration — the
      // runner wraps each migration in the caller's transaction (storage.transactionSync in
      // the DO), so a crash rolls the whole rebuild back instead of stranding the deployment
      // between the DROP and the RENAME (review #48 finding 3).
      sql`CREATE TABLE IF NOT EXISTS sh_question_v2 (
        qid TEXT PRIMARY KEY, threadId TEXT, workerId TEXT,
        text TEXT NOT NULL, options TEXT, candidates TEXT,
        status TEXT NOT NULL DEFAULT 'open', askedAt INTEGER NOT NULL, answeredAt INTEGER
      )`;
      sql`INSERT INTO sh_question_v2 (qid, threadId, workerId, text, options, candidates, status, askedAt, answeredAt)
        SELECT qid, threadId, workerId, text, options, NULL, status, askedAt, answeredAt FROM sh_question`;
      sql`DROP TABLE sh_question`;
      sql`ALTER TABLE sh_question_v2 RENAME TO sh_question`;
      sql`CREATE INDEX IF NOT EXISTS sh_question_thread ON sh_question (threadId, status)`;

      // Settle-time dispatch verification (spike-conclusions §2): how many real dispatches
      // happened inside this run. 0 + a reply claiming "dispatched" triggers the corrective
      // follow-up (see steward.ts settleRun).
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_run ADD COLUMN dispatchCount INTEGER NOT NULL DEFAULT 0`;
      });
    },
  },
];
