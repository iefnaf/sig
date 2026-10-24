// Idempotent migration runner (spike bug 2: `CREATE TABLE IF NOT EXISTS` never adds columns
// to an existing table; a ledger of applied migration ids plus plain ALTER statements fixes it).
export interface SqlExecutor {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[];
}

export interface Migration {
  id: string;
  up: (sql: SqlExecutor) => void;
}

/**
 * Idempotent migration runner (spike bug 2: `CREATE TABLE IF NOT EXISTS` never adds columns
 * to an existing table; a ledger of applied migration ids plus plain ALTER statements fixes it).
 *
 * `tx` (when provided — the DO passes `ctx.storage.transactionSync`) wraps each migration's
 * `up()` AND its `_migrations` ledger-row write in one atomic transaction, so a
 * multi-statement rebuild can never persist half of itself. Reviews #47-2 and #48 finding 3
 * hit the same DROP→RENAME window from two sides (the 011 timeline rebuild, the 010_routing
 * question rebuild). The ledger write stays INSIDE the transaction deliberately: with it
 * outside, a crash after commit but before the row write re-runs the migration — safe only
 * when every `up()` is re-run-safe, and the copy-drop-rename shapes are not (a re-run
 * re-copies with candidates→NULL and wipes in-flight ask buttons).
 */
export function runMigrations(sql: SqlExecutor, migrations: readonly Migration[], tx?: <T>(fn: () => T) => T): void {
  sql`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, appliedAt INTEGER)`;
  for (const migration of migrations) {
    const applied = sql<{ id: string }>`SELECT id FROM _migrations WHERE id = ${migration.id}`;
    if (applied.length > 0) continue;
    // The ledger row commits atomically with the migration (review #48 finding 3): the
    // copy-drop-rename migrations are not re-run-safe, so a crash-then-re-run would lose data.
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
      // Secrets are AES-GCM sealed under the deployment key (secretbox.ts); `ownerOpenId` NULL means
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
      // One row per worker session (steward.md §2.2; parentWorker — the relay relationship
      // — and contextPercent arrive with migration 013 / issue #8).
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
      // apiKey AES-GCM sealed under the deployment key exactly like the Feishu secrets. The LLM wiring
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
    // The browser web (issue #22; auth superseded by ADR-0010): card/login links, the shared
    // sessions they and password/passkey login open, and the deployment's public origin (links
    // and pairing commands need absolute URLs, and the DO only sees origin through requests).
    // These tables belong to web.ts. Numbered 009: #6's steward_llm took 008 first in the merge.
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
    // History relay (issue #23, protocol §6.6): bookkeeping only — which browser connection
    // asked, which worker/machine, the byte meter, and the deadline. Chunk CONTENT never
    // reaches this table (or any other): it passes through DO memory between sockets.
    // (Number 009 collides with 009_web — ids are unique, which is what the ledger keys on.)
    id: "009_history_relay",
    up: (sql) => {
      // state lives in SQLite because the DO may sleep between chunks (§6.6). `cursor` is the
      // last entry id forwarded — an id, not content — so a DO-side cap cut can still tell
      // the browser where it stopped and how to continue. (Created here on fresh databases;
      // 010's ALTER adds it on ones that ran the pre-review 009.)
      sql`CREATE TABLE IF NOT EXISTS history_relay (
        reqId TEXT PRIMARY KEY,
        webConnId TEXT NOT NULL,
        workerId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        maxBytes INTEGER NOT NULL,
        sentBytes INTEGER NOT NULL DEFAULT 0,
        cursor TEXT,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )`;
      sql`CREATE INDEX IF NOT EXISTS history_relay_conn ON history_relay (webConnId)`;
      sql`CREATE INDEX IF NOT EXISTS history_relay_device ON history_relay (deviceId)`;
    },
  },
  {
    // Issue #23 review: 009 originally shipped without `cursor` (head 1efaaf3) and was then
    // edited in place — but runMigrations skips by applied id, so any dev/preview DO that
    // already ran the old 009 would never see the new column and the relay's SELECT would
    // throw. This is the repo's spike-bug-2 pattern: the column is added by ALTER, and the
    // duplicate-column error on fresh databases (where 009's CREATE TABLE already made it)
    // is tolerated by ignoringDuplicateColumn.
    id: "010_history_relay_cursor",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE history_relay ADD COLUMN cursor TEXT`;
      });
    },
  },
  {
    // Proactive behavior (issue #20, steward.md §8, spec §8): routines (recurring or one-shot
    // prescriptions the owner made by conversation) and follow-ups (a Thread-scoped alarm the
    // steward sets itself). Every row traces back to something the owner said — createdFromMsg
    // / sourceRef are NOT NULL, the data-layer half of "proactive behavior must have
    // provenance" (spec §8.3). Suggestions (steward.md §8.5) send a button card only; the
    // offer row holds the spec until the owner taps it.
    // (Numbered 011: main's #23 took 009_history_relay/010_history_relay_cursor; ids are
    // unique, which is what the ledger keys on — the number just keeps the order readable.)
    id: "011_routines_followups",
    up: (sql) => {
      // kind: 'digest' (deterministic ledger summary, no LLM — spike-conclusions §2) or
      // 'instruction' (a ⟦routine⟧ steward input executes it).
      // status: active | paused | done (a once-routine that fired) | cancelled.
      // lastFireKey = the latest processed `routine:<id>:<fireTime>` — the SDK may re-dispatch
      // a job (retry after handler error); the key makes the whole fire idempotent.
      sql`CREATE TABLE IF NOT EXISTS sh_routine (
        routineId TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        createdFromMsg TEXT NOT NULL,
        scheduleKind TEXT NOT NULL,
        cron TEXT,
        onceAt INTEGER,
        instruction TEXT NOT NULL,
        repoId TEXT,
        threadId TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        scheduleId TEXT,
        lastRunAt INTEGER,
        lastFireKey TEXT,
        lastResult TEXT,
        outcomeRecorded INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      )`;
      // A Thread-scoped "look at this again in two hours" (steward.md §8.3). createdBy=
      // 'steward' rows must carry a sourceRef pointing at the user message or routine that
      // authorized them (verified at creation — checkProvenanceRef).
      sql`CREATE TABLE IF NOT EXISTS sh_followup (
        followupId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        dueAt INTEGER NOT NULL,
        reason TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        sourceRef TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        scheduleId TEXT,
        firedAt INTEGER,
        lastResult TEXT,
        outcomeRecorded INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      )`;
      // A suggestion sent as a button card (steward.md §8.5): the spec waits here until the
      // owner taps; the tap is the consent that create_routine would otherwise lack.
      sql`CREATE TABLE IF NOT EXISTS sh_routine_offer (
        offerId TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        sourceMsg TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offered',
        outboundId TEXT,
        createdAt INTEGER NOT NULL
      )`;
      // Routine fires may be Thread-less (a digest scans everything); the timeline's
      // threadId becomes nullable so every fire still leaves an auditable entry (§8.6).
      // Table rebuild: SQLite cannot relax NOT NULL in place. Each interruption point must
      // be recoverable even without a wrapping transaction (review #47-2) — most critically
      // the DROP→RENAME window, where sh_timeline_new holds the ONLY copy: a rerun RENAMES
      // it instead of dropping it. The runner's per-migration transactionSync (steward.ts)
      // makes the window unreachable in production; this guard covers non-transactional
      // callers (tests) and is harmless on re-runs.
      const tables = sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sh_timeline', 'sh_timeline_new')
      `.map((r) => r.name);
      if (tables.includes("sh_timeline_new")) {
        if (tables.includes("sh_timeline")) {
          sql`DROP TABLE sh_timeline_new`; // stale partial copy; the original is intact — redo
        } else {
          sql`ALTER TABLE sh_timeline_new RENAME TO sh_timeline`; // the copy is the only copy
        }
      } else if (tables.includes("sh_timeline")) {
        sql`CREATE TABLE sh_timeline_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT, ts INTEGER NOT NULL,
          kind TEXT NOT NULL, text TEXT NOT NULL, refs TEXT
        )`;
        sql`INSERT INTO sh_timeline_new (id, threadId, ts, kind, text, refs) SELECT id, threadId, ts, kind, text, refs FROM sh_timeline`;
        sql`DROP TABLE sh_timeline`;
        sql`ALTER TABLE sh_timeline_new RENAME TO sh_timeline`;
      } else {
        // Neither exists (a ledger that skipped 004 — unreachable in the ordered list, but
        // the rebuild must not be what explodes): create the nullable shape directly.
        sql`CREATE TABLE sh_timeline (
          id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT, ts INTEGER NOT NULL,
          kind TEXT NOT NULL, text TEXT NOT NULL, refs TEXT
        )`;
      }
      sql`CREATE INDEX IF NOT EXISTS sh_timeline_thread ON sh_timeline (threadId, id)`;
    },
  },
  {
    // Routing (issue #7, steward.md §3): the FTS5 index behind threads.findCandidates, the
    // question shape ask_user's candidate buttons need, and the per-run dispatch counter the
    // settle-time verification compares against "dispatched" claims (spike-conclusions §2).
    // (Stays numbered 010 from the branch: the ledger keys on the full id string, so it does
    // not collide with main's 010_history_relay_cursor — same precedent as 009_web vs
    // 009_history_relay above. Renaming it would re-run the NOT re-runnable sh_question
    // rebuild on every DO that already applied this branch's 010.)
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
  {
    // Notes: the layered memory (issue #18, steward.md §2.3-§2.5, spec §10). resident =
    // always-loaded preferences/conventions (2,400-char hard cap); project = per-repo
    // conventions (1,500 per repo); archive = superseded/demoted/evicted entries — never
    // deleted, fetched on demand. Writes are two-phase (notes_propose → notes_commit with
    // `replaces`); every change lands in sh_note_log and is relayed to the user with the
    // next reply (spec §10.3: silent memory is unacceptable).
    id: "012_notes",
    up: (sql) => {
      // status: 'active' = current knowledge (any layer — an evicted/demoted entry stays
      // valid content in the archive); 'superseded' = replaced by a newer note; 'removed' =
      // deleted at the user's word (kept as a tombstone; the layer always reads 'archive').
      // `bytes` is the normalized text's character count — the unit of both layer caps.
      sql`CREATE TABLE IF NOT EXISTS sh_note (
        noteId TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        scope_repoId TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        source TEXT NOT NULL,
        evidence TEXT,
        -- The message that carried the owner's confirmation (notes_confirm); the
        -- promotion path inherits this so the row itself says who confirmed it (PR #44 R3).
        confirmedBy TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        lastUsedAt INTEGER,
        useCount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        supersededBy TEXT
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_note_placement ON sh_note (layer, scope_repoId, status)`;
      // FTS5 trigram (verified against workerd for issue #18, incl. CJK substring matching
      // and trigger sync): substring search that works for Chinese text, where the default
      // unicode61 tokenizer would collapse whole sentences into single tokens. External
      // content table: the index can never drift from sh_note because only the triggers
      // below ever write it.
      sql`CREATE VIRTUAL TABLE IF NOT EXISTS sh_note_fts USING fts5(text, content = 'sh_note', content_rowid = 'rowid', tokenize = 'trigram')`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_note_fts_ai AFTER INSERT ON sh_note BEGIN
            INSERT INTO sh_note_fts (rowid, text) VALUES (new.rowid, new.text);
          END`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_note_fts_ad AFTER DELETE ON sh_note BEGIN
            INSERT INTO sh_note_fts (sh_note_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          END`;
      sql`CREATE TRIGGER IF NOT EXISTS sh_note_fts_au AFTER UPDATE OF text ON sh_note BEGIN
            INSERT INTO sh_note_fts (sh_note_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
            INSERT INTO sh_note_fts (rowid, text) VALUES (new.rowid, new.text);
          END`;
      // Every change (noted/superseded/evicted/demoted/suggest_demote/pinned/unpinned/
      // removed/confirmed) with a text snapshot, so the relay renders even after the note
      // itself changes. `reportedAt` = already relayed to the user; the next user reply
      // drains pending rows (steward.md §2.1: the module reports, the steward relays).
      sql`CREATE TABLE IF NOT EXISTS sh_note_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        op TEXT NOT NULL,
        noteId TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT,
        reportedAt INTEGER
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_note_log_pending ON sh_note_log (reportedAt, id)`;
      sql`CREATE INDEX IF NOT EXISTS sh_note_log_note ON sh_note_log (noteId, op, ts)`;
    },
  },
  {
    // Issue #13 review: when hello.workers reconciliation is gated behind undelivered events
    // (snap.lastSeq > processedUpTo), the DO remembers the pending verdict for a reaped
    // worker and applies it once the event stream catches up — otherwise a worker reaped
    // while its machine was offline stays `lost` forever even though it is alive (the events
    // that would prove it are exactly the ones that blocked the reconcile). Numbered 014:
    // main's #23 took 009/010, #20 took 011, #7 kept 010_routing, #18 took 012_notes, #19
    // took 013; ids are unique, which is what the ledger keys on — the number keeps the
    // order readable.
    id: "014_reap_reconcile",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS sh_reap_pending (
        workerId TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        snapState TEXT NOT NULL,
        lastSeq INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )`;
    },
  },
  {
    id: "013_notes_maintenance",
    up: (sql) => {
      // A refused write must not break the hard cap. Remember the request for room instead
      // (one row per distinct request — PR #53 review finding 3); the daily pass frees it
      // even if the model gives up.
      sql`CREATE TABLE IF NOT EXISTS sh_note_pressure (
        layer TEXT NOT NULL, scope_repoId TEXT NOT NULL, text TEXT NOT NULL, chars INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact', evidence TEXT, replaces TEXT,
        PRIMARY KEY (layer, scope_repoId, text)
      )`;
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_note_log ADD COLUMN delivery TEXT NOT NULL DEFAULT 'reply'`;
      });
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_note_log ADD COLUMN decision TEXT`;
      });
      // Lifecycle reports have their own durable delivery, including actionable resident
      // suggestions. Upgrade any unreported lifecycle rows left by #18 as well.
      sql`UPDATE sh_note_log SET delivery = 'maintenance'
          WHERE reportedAt IS NULL AND (op IN ('demoted', 'suggest_demote') OR reason = 'maintenance_cap')`;
    },
  },
  {
    // Worker questions (issue #10, steward.md §5.2-5.3): the durable 90-second window and
    // the question/message bindings the answer relay routes through. Numbered 014: main's
    // #53 took 013_notes_maintenance; ids are unique strings, which is what the migration
    // ledger keys on (same precedent as 009_web vs 009_history_relay) — the number just
    // keeps the order readable, and this one applies after the notes migration either way.
    id: "014_worker_questions",
    up: (sql) => {
      sql`ALTER TABLE sh_question ADD COLUMN kind TEXT NOT NULL DEFAULT 'steward'`;
      sql`ALTER TABLE sh_question ADD COLUMN fallbackDueAt INTEGER`;
      sql`ALTER TABLE sh_question ADD COLUMN handledAt INTEGER`;
      sql`ALTER TABLE sh_notify ADD COLUMN questionId TEXT`;
      sql`ALTER TABLE sh_outbound ADD COLUMN questionId TEXT`;
      sql`ALTER TABLE sh_inbound ADD COLUMN ownerAuthorized INTEGER NOT NULL DEFAULT 0`;
      sql`UPDATE sh_inbound SET ownerAuthorized = 1 WHERE EXISTS (
        SELECT 1 FROM sh_run r WHERE r.kind = 'user' AND r.operationId = 'user:' || sh_inbound.msgId
      )`;
      sql`CREATE INDEX sh_question_fallback ON sh_question (status, handledAt, fallbackDueAt)`;
      // Existing worker questions already had an immediate M1 push. Preserve their state
      // without issuing a second notification on upgrade.
      sql`UPDATE sh_question SET kind = CASE
        WHEN EXISTS (SELECT 1 FROM sh_report r WHERE r.workerId = sh_question.workerId
          AND sh_question.qid = 'q_' || r.workerId || '_' || r.seq) THEN 'report'
        ELSE 'failure' END, handledAt = askedAt WHERE workerId IS NOT NULL`;
    },
  },
  {
    // Daily budget soft cap (issue #28, steward.md §12, ADR-0001 decision 15): today's
    // counter and the cursor into pi's cumulative usage ledger. spend is an estimate derived
    // from token counts and catalog pricing — never a bill — and the day is the UTC calendar
    // date (the same clock as routine cron expressions). Numbered 015: main's #19 took
    // 013_notes_maintenance, #10 took 014_worker_questions, #13's review 014_reap_reconcile.
    id: "015_budget",
    up: (sql) => {
      // One row per UTC day that saw spend or a skip. costUsd accumulates pi.usage's
      // cost.total deltas; tokens its totalTokens deltas; skippedWakes counts the wakes the
      // cap kept from the model; overNotedAt marks the one reply the note rode that day.
      sql`CREATE TABLE IF NOT EXISTS sh_usage_day (
        day TEXT PRIMARY KEY,
        costUsd REAL NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        skippedWakes INTEGER NOT NULL DEFAULT 0,
        overNotedAt INTEGER,
        updatedAt INTEGER NOT NULL
      )`;
      // The last cumulative pi.usage total observed (budget.ts observe()): one row, and the
      // growth against it is what lands in today's row.
      sql`CREATE TABLE IF NOT EXISTS sh_usage_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        costUsd REAL NOT NULL DEFAULT 0,
        tokens INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      )`;
    },
  },
  {
    // Relay: handoff briefs and continuing on the previous branch (issue #8, spec §5.3,
    // steward.md §2.6). The worker rows learn their relay parent and the last-reported
    // context usage; summary updates become versioned (last 5 kept; every 10th update is
    // prompted as a from-scratch rewrite — steward.md §2.6's anti-drift rule). Existing
    // threads keep their current summary: it enters history as version 1 on the next
    // update, so the cumulative counter never reads zero on a thread with a past.
    // Numbered 016: main's #46/#19/#10/#28 took 013×2, 014, and 015; ids are unique, which
    // is what the ledger keys on — the number keeps the order readable.
    id: "016_relay_handoff",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_worker ADD COLUMN parentWorker TEXT`;
        sql`ALTER TABLE sh_worker ADD COLUMN contextPercent INTEGER`;
      });
      sql`CREATE TABLE IF NOT EXISTS sh_thread_summary (
        threadId TEXT NOT NULL,
        version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (threadId, version)
      )`;
    },
  },
  {
    // Offline dispatch (issue #14, protocol §7.3): the held-command ask. `outbox.held` parks
    // a start_worker (or resume send) written at an offline machine until the owner answers
    // (deliver refuses it); `sh_worker.unreachable` marks in-flight workers during a drop
    // (a flag — the connector's hello snapshot re-states the truth); `sh_machine.otherRunning`
    // counts worker slots the ledger does not track; `sh_offline_dispatch` binds each ask
    // card to exactly one command. `sh_notify.dueAt` carries the machine-status debounce:
    // 004's CREATE TABLE already has it on fresh databases, and the ALTER below adds it to
    // every deployment that ran the pre-#14 004 — the exact 010_history_relay_cursor hazard
    // this file documents (PR #51 review finding 1). Numbered 017: #13/#19 took the two
    // 013s, #10 took 014, #28 took 015_budget, #8 took 016_relay_handoff; ids are unique
    // strings, which is what the migration ledger keys on.
    id: "017_offline_dispatch",
    up: (sql) => {
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_notify ADD COLUMN dueAt INTEGER`; });
      ignoringDuplicateColumn(() => { sql`ALTER TABLE outbox ADD COLUMN held INTEGER NOT NULL DEFAULT 0`; });
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_worker ADD COLUMN unreachable INTEGER NOT NULL DEFAULT 0`; });
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_machine ADD COLUMN otherRunning INTEGER NOT NULL DEFAULT 0`; });
      sql`CREATE TABLE IF NOT EXISTS sh_offline_dispatch (
        cmdId TEXT PRIMARY KEY, threadId TEXT NOT NULL, deviceId TEXT NOT NULL,
        input TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offered', choices TEXT
      )`;
    },
  },
  {
    // The PR consent gate (issue #21, spike-conclusions §2): one row per done report that
    // offered [同意]/[先不要]. The tap is recorded here; the machine work is the `pr_worker`
    // command (cmdId + attempts, so a retry click after a failure sends a fresh command);
    // the asynchronous result lands back on the same row (url / failure) so a repeated
    // click can answer honestly. sh_notify gains a payload column: pr cards render from
    // event data (url / stage / message) that belongs to the intent itself, not to whatever
    // ledger row a later renderer might still find. Numbered 018: #14's offline dispatch
    // took 017 on main; ids are unique strings, which is what the migration ledger keys on.
    id: "018_pr_consent",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS sh_pr_consent (
        workerId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        threadId TEXT NOT NULL,
        decision TEXT NOT NULL,
        cmdId TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        failure TEXT,
        decidedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (workerId, seq)
      )`;
      sql`CREATE INDEX IF NOT EXISTS sh_pr_consent_cmd ON sh_pr_consent (cmdId)`;
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_notify ADD COLUMN payload TEXT`;
      });
    },
  },
  {
    // The web workspace (ADR-0004): the conversation the browser draws is the owner's
    // inputs (sh_inbound keeps their text from now on) plus the outbound rows; web requests
    // are made idempotent by the client's request id (sh_web_request). Existing messages
    // reappear in the transcript from the runs they started — less the routing note the
    // steward prepended to the run text, which was never the owner's words.
    id: "019_web_workspace",
    up: (sql) => {
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_inbound ADD COLUMN text TEXT`; });
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_inbound ADD COLUMN threadId TEXT`; });
      for (const run of sql<{ operationId: string; text: string }>`SELECT operationId, text FROM sh_run WHERE kind = 'user'`) {
        const text = run.text.replace(/^（系统注：[^\n]*）\n/, "");
        sql`UPDATE sh_inbound SET text = ${text} WHERE msgId = ${run.operationId.slice("user:".length)} AND text IS NULL`;
      }
      sql`CREATE TABLE IF NOT EXISTS sh_web_request (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL
      )`;
    },
  },
  {
    // The workspace's idempotent pairing mints (ADR-0004): a retried "add machine" request
    // gets the same one-time code back instead of a second one. The owner needs no row; the
    // deployment has one browser authority under ADR-0010.
    id: "020_web_owner",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS sh_web_session (
        sid TEXT PRIMARY KEY, csrf TEXT NOT NULL,
        createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL
      )`; // 009_web's table, restated so this migration never depends on running after it
      sql`CREATE TABLE IF NOT EXISTS sh_web_pairing (id TEXT PRIMARY KEY, code TEXT NOT NULL, expiresAt INTEGER NOT NULL)`;
    },
  },
  {
    // WebAuthn/passkey login (a second proof of the same owner, ADR-0003 — not multi-user):
    // registered credentials, and the single-use nonce for the WebAuthn challenge token's own
    // HMAC (mintWebauthnChallenge/verifyWebauthnChallenge, web.ts). Unlike sh_web_link, the
    // nonce row is written once, at verify time — the challenge token is fully self-describing
    // (purpose/sid/expiry/nonce, all HMAC'd), so nothing needs a pre-registered row to be
    // meaningful, only to be spent exactly once (web.ts's #consumeWebauthnNonce). `rpId` is
    // recorded per credential (not just trusted from the live request at verify time) purely
    // as a diagnostic: WebAuthn ties a credential to the RP ID it was registered under, so if
    // the deployment's effective hostname ever changes, every passkey stops working, and this
    // column is what tells the owner why.
    id: "021_webauthn",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS sh_web_credential (
        credentialId TEXT PRIMARY KEY,
        publicKeyCose TEXT NOT NULL,
        signCount INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL,
        transports TEXT,
        rpId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        lastUsedAt INTEGER
      )`;
      sql`CREATE TABLE IF NOT EXISTS sh_web_webauthn_nonce (
        nonce TEXT PRIMARY KEY,
        usedAt INTEGER NOT NULL
      )`;
    },
  },
  {
    // Runtime model switching (issue #70): the Settings page picks provider + modelId (and
    // optionally baseUrl) without a redeploy. Both columns are nullable — a row seeded only
    // from MODEL_KEY or an older setModelConfig(provider, apiKey) call keeps modelId/baseUrl
    // NULL, and the deploy-config vars.STEWARD_MODEL still supplies them (legacy precedence,
    // steward.ts ensureRootModel). An explicit switch fills both, and from then on wins over
    // vars entirely — that's the whole point of a runtime switch.
    id: "021_model_switch",
    up: (sql) => {
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_model ADD COLUMN modelId TEXT`; });
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_model ADD COLUMN baseUrl TEXT`; });
    },
  },
  {
    // Per-provider keys (issue #74): the credential registry lives in sh_provider_key, one
    // sealed row per provider, so switching back to a provider never re-asks for its key.
    // sh_model id=0 stays the active selection and keeps mirroring the selected provider's
    // key in apiKeyEnc — a reader on pre-074 code (rollback to an older worker) still sees a
    // consistent provider+key pair. An existing install's key moves over on migration.
    id: "022_provider_keys",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS sh_provider_key (
        provider TEXT PRIMARY KEY,
        apiKeyEnc TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`;
      sql`INSERT OR IGNORE INTO sh_provider_key (provider, apiKeyEnc, updatedAt)
        SELECT provider, apiKeyEnc, updatedAt FROM sh_model WHERE id = 0`;
    },
  },
  {
    id: "023_model_thinking",
    up: (sql) => {
      ignoringDuplicateColumn(() => { sql`ALTER TABLE sh_model ADD COLUMN thinkingLevel TEXT`; });
    },
  },
  {
    id: "024_report_answer",
    up: (sql) => {
      ignoringDuplicateColumn(() => {
        sql`ALTER TABLE sh_report ADD COLUMN answer TEXT`;
      });
    },
  },
  {
    id: "025_browser_login",
    up: (sql) => {
      sql`CREATE TABLE sh_auth_deployment (id INTEGER PRIMARY KEY CHECK(id = 0), mode TEXT NOT NULL, secret TEXT)`;
      sql`CREATE TABLE sh_auth_password (id INTEGER PRIMARY KEY CHECK(id = 0), salt TEXT NOT NULL, digest TEXT NOT NULL, revision TEXT NOT NULL)`;
      sql`CREATE TABLE sh_auth_limit (bucket TEXT PRIMARY KEY, windowStart INTEGER NOT NULL, attempts INTEGER NOT NULL, failures INTEGER NOT NULL, blockedUntil INTEGER NOT NULL, expiresAt INTEGER NOT NULL)`;
    },
  },
  {
    // Direct worker chat (issue #84, ADR-0011, protocol §6.8): bookkeeping only — which
    // browser connection issued a web-direct `worker_cmd`, so the real `cmd_ack`/`cmd_result`
    // (never fabricated) can be relayed back once the connector answers. Same shape and
    // lifetime idea as `history_relay` (009): short-lived, cleaned up on terminal settlement
    // or on the browser connection closing. (Numbered 026: 025_browser_login took 025 first —
    // same precedent as 009_web vs 009_history_relay above.)
    id: "026_web_cmd_relay",
    up: (sql) => {
      sql`CREATE TABLE IF NOT EXISTS web_cmd_relay (
        cmdId TEXT PRIMARY KEY,
        webConnId TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )`;
      sql`CREATE INDEX IF NOT EXISTS web_cmd_relay_conn ON web_cmd_relay (webConnId)`;
    },
  },
];
