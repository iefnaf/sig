import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Migration, SqlExecutor } from "../src/schema.ts";
import { MIGRATIONS, runMigrations } from "../src/schema.ts";
import type { Steward } from "../src/steward.ts";

describe("runMigrations", () => {
  it("adds a column via ALTER without losing existing data, and a full re-apply is a no-op (spike bug 2 regression)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);

    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);

      const v1: Migration = {
        id: "t001_create_widget",
        up: (sql) => {
          sql`CREATE TABLE IF NOT EXISTS widget (id TEXT PRIMARY KEY, name TEXT)`;
        },
      };
      const v2: Migration = {
        id: "t002_add_color",
        up: (sql) => {
          sql`ALTER TABLE widget ADD COLUMN color TEXT`;
        },
      };

      runMigrations(sql, [v1]);
      sql`INSERT INTO widget (id, name) VALUES ('w1', 'gadget')`;

      // `CREATE TABLE IF NOT EXISTS` alone would never add `color` to the already-existing
      // table — this is exactly spike bug 2. Applying v2 via ALTER must add it without
      // touching the row already there.
      runMigrations(sql, [v1, v2]);
      const rows = sql<{ id: string; name: string; color: string | null }>`
        SELECT id, name, color FROM widget WHERE id = 'w1'
      `;
      expect(rows).toEqual([{ id: "w1", name: "gadget", color: null }]);

      // Re-applying the full set again must be a no-op: the ledger must not re-run v2's
      // ALTER (which would otherwise fail with "duplicate column name").
      expect(() => runMigrations(sql, [v1, v2])).not.toThrow();
    });
  });

  it("017 adds sh_notify.dueAt to deployments that ran the pre-#14 004 (PR #51 review finding 1)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    // Warm the DO through a plain RPC first: runInDurableObject on a cold instance does not
    // await onStart, and the migration probe below must not race the boot migrations.
    await (env.Steward.get(id) as unknown as { channelLogEntries: (n: number) => Promise<unknown[]> }).channelLogEntries(1);

    await runInDurableObject(env.Steward.get(id), async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);

      // A deployment provisioned BEFORE this PR: every migration except 017 applied, and
      // its 004-era sh_notify has no dueAt column (a fresh database gets it from 017's
      // ALTER — which is exactly why the suite stays green while such upgrades need it too).
      // (also rewind the ledger row: a pre-#14 deployment never recorded 017)
      sql`DELETE FROM _migrations WHERE id = '017_offline_dispatch'`;
      sql`ALTER TABLE sh_notify DROP COLUMN dueAt`;
      const before = sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('sh_notify') WHERE name = 'dueAt'`;
      expect(before[0]!.n).toBe(0);

      // The upgrade path: 017's ALTER adds the column the debounced intents write to, and
      // pending()'s dueAt filter can read it.
      runMigrations(sql, MIGRATIONS);
      const after = sql<{ n: number }>`SELECT COUNT(*) AS n FROM pragma_table_info('sh_notify') WHERE name = 'dueAt'`;
      expect(after[0]!.n).toBe(1);
      expect(() => sql`SELECT id FROM sh_notify WHERE sentAt IS NULL AND (dueAt IS NULL OR dueAt <= 0)`).not.toThrow();

      // ignoringDuplicateColumn is what makes 017's ALTER safe on databases where the
      // column already exists — the exact 010_history_relay_cursor pattern; assert the
      // guard itself tolerates the duplicate.
      const dup: Migration = {
        id: "t017_dup_dueAt",
        up: (s) => {
          try {
            s`ALTER TABLE sh_notify ADD COLUMN dueAt INTEGER`;
          } catch (err) {
            if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
          }
        },
      };
      expect(() => runMigrations(sql, [dup])).not.toThrow();
    });
  });

  it("a migration that dies mid-flight rolls back completely when wrapped in a transaction (review #48 finding 3)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);

    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      // The same wrapping onStart uses: each migration + its ledger row in one commit.
      const tx = <T>(fn: () => T): T =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);

      const v1: Migration = {
        id: "r001_create_widget",
        up: (sql) => {
          sql`CREATE TABLE IF NOT EXISTS widget (id TEXT PRIMARY KEY, name TEXT)`;
        },
      };
      runMigrations(sql, [v1], tx);
      sql`INSERT INTO widget (id, name) VALUES ('w1', 'gadget')`;

      // Crash between the copy-drop-rename statements — exactly migration 010's sh_question
      // shape. Unwrapped, this strands the schema where neither a re-run (INSERT … FROM
      // widget after the DROP) nor the ledger row can ever land; the transaction must roll
      // the whole migration back instead.
      const dies: Migration = {
        id: "r002_rebuild_widget",
        up: (sql) => {
          sql`CREATE TABLE IF NOT EXISTS widget_v2 (id TEXT PRIMARY KEY, name TEXT, extra TEXT)`;
          sql`INSERT INTO widget_v2 SELECT id, name, NULL FROM widget`;
          sql`DROP TABLE widget`;
          sql`ALTER TABLE widget_v2 RENAME TO widget`;
          throw new Error("isolate died mid-migration");
        },
      };
      expect(() => runMigrations(sql, [v1, dies], tx)).toThrow("isolate died mid-migration");
      expect(sql<{ id: string; name: string }>`SELECT id, name FROM widget`).toEqual([{ id: "w1", name: "gadget" }]);
      expect(sql`SELECT 1 AS one FROM sqlite_master WHERE name = 'widget_v2'`).toEqual([]);
      expect(sql`SELECT 1 AS one FROM _migrations WHERE id = 'r002_rebuild_widget'`).toEqual([]);

      // The restart re-runs the (now healthy) migration and it applies cleanly.
      const heals: Migration = {
        id: "r002_rebuild_widget",
        up: (sql) => {
          sql`CREATE TABLE IF NOT EXISTS widget_v2 (id TEXT PRIMARY KEY, name TEXT, extra TEXT)`;
          sql`INSERT INTO widget_v2 SELECT id, name, NULL FROM widget`;
          sql`DROP TABLE widget`;
          sql`ALTER TABLE widget_v2 RENAME TO widget`;
        },
      };
      expect(() => runMigrations(sql, [v1, heals], tx)).not.toThrow();
      expect(sql<{ id: string; name: string; extra: string | null }>`SELECT id, name, extra FROM widget`).toEqual([
        { id: "w1", name: "gadget", extra: null },
      ]);
      expect(() => runMigrations(sql, [v1, heals], tx)).not.toThrow(); // ledger row landed with the commit
    });
  });

  it("010 backfills history_relay.cursor on a DO that ran the pre-review 009 (PR #42 review)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);

    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);

      // A DO that deployed head 1efaaf3: every migration up to the OLD 009 ran — its
      // history_relay had no `cursor` — and the ledger row marks 009 applied.
      const beforeRelay = MIGRATIONS.filter((m) => !m.id.startsWith("009") && !m.id.startsWith("010"));
      runMigrations(sql, beforeRelay);
      sql`CREATE TABLE IF NOT EXISTS history_relay (
        reqId TEXT PRIMARY KEY, webConnId TEXT NOT NULL, workerId TEXT NOT NULL,
        deviceId TEXT NOT NULL, maxBytes INTEGER NOT NULL,
        sentBytes INTEGER NOT NULL DEFAULT 0, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
      )`;
      sql`INSERT INTO _migrations (id, appliedAt) VALUES ('009_history_relay', ${Date.now()})`;

      // Upgrading to the reviewed code: 009 is skipped by the ledger (its CREATE TABLE edit
      // never re-runs), so 010's ALTER is what must add the column — otherwise the relay's
      // SELECT …, cursor, … throws and the whole L3 stream dies.
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
      sql`INSERT INTO history_relay (reqId, webConnId, workerId, deviceId, maxBytes, sentBytes, expiresAt, createdAt)
          VALUES ('r1', 'c1', 'w1', 'd1', 10, 0, ${Date.now()}, ${Date.now()})`;
      expect(sql<{ cursor: string | null }>`SELECT cursor FROM history_relay WHERE reqId = 'r1'`).toEqual([
        { cursor: null },
      ]);
      // And re-applying stays a no-op both for the backfilled and the fresh shape.
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
    });
  });

  it("migration 011 recovers from a crash between DROP and RENAME without losing the timeline (review #47-2)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      // Everything except 011 — this DO is then exactly a pre-#20 ledger.
      runMigrations(sql, MIGRATIONS.filter((m) => m.id !== "011_routines_followups"));
      sql`INSERT INTO sh_timeline (threadId, ts, kind, text) VALUES ('t_1', 1, 'note', '唯一副本的数据')`;
      sql`INSERT INTO sh_timeline (threadId, ts, kind, text) VALUES ('t_2', 2, 'report', '第二行')`;
      // Simulate the worst interruption: the rebuild's CREATE+COPY+DROP committed, then it
      // died before RENAME — sh_timeline_new (the NEW nullable schema) holds the ONLY copy.
      sql`CREATE TABLE sh_timeline_new (id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, refs TEXT)`;
      sql`INSERT INTO sh_timeline_new (id, threadId, ts, kind, text) SELECT id, threadId, ts, kind, text FROM sh_timeline`;
      sql`DROP TABLE sh_timeline`;
      // The rerun must RENAME the copy back, never drop it. No tx wrapper here on purpose:
      // this exercises the migration's own guard, independent of the runner's transaction.
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
      const rows = sql<{ text: string }>`SELECT text FROM sh_timeline ORDER BY id`;
      expect(rows.map((r) => r.text)).toEqual(["唯一副本的数据", "第二行"]);
      // …and the rebuilt table actually accepts Thread-less entries (the point of 011).
      sql`INSERT INTO sh_timeline (threadId, ts, kind, text) VALUES (NULL, 3, 'routine', '无 Thread 的例行记录')`;
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_timeline WHERE threadId IS NULL`[0]!.n).toBe(1);
    });
  });

  it("migration 011 drops a stale leftover sh_timeline_new and rebuilds from the intact original", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      runMigrations(sql, MIGRATIONS.filter((m) => m.id !== "011_routines_followups"));
      sql`INSERT INTO sh_timeline (threadId, ts, kind, text) VALUES ('t_1', 1, 'note', '原始数据')`;
      // A crash between CREATE _new and COPY left an empty _new next to the intact original.
      sql`CREATE TABLE sh_timeline_new (id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, refs TEXT)`;
      expect(() => runMigrations(sql, MIGRATIONS)).not.toThrow();
      const rows = sql<{ text: string }>`SELECT text FROM sh_timeline`;
      expect(rows.map((r) => r.text)).toEqual(["原始数据"]);
      expect(sql`SELECT name FROM sqlite_master WHERE name = 'sh_timeline_new'`.length).toBe(0);
    });
  });
});

describe("migration 010 (routing, issue #7)", () => {
  it("creates the FTS5 index with its triggers, the nullable-threadId question table, and sh_run.dispatchCount", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      runMigrations(sql, MIGRATIONS); // a fresh DO has not run onStart yet

      // The index exists and matches CJK substrings (trigram tokenizer).
      const fts = sql<{ threadId: string }>`SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH '限流中间'`;
      expect(fts).toEqual([]); // empty world, but the query must parse

      // Insert → trigger indexes; update → trigger re-indexes; report → trigger joins.
      sql`INSERT INTO sh_thread (threadId, title, goal, state, unread, lastActivityAt, archived, createdAt) VALUES ('t_1', '登录接口限流', '加 IP 限流', 'idle', 0, 1, 0, 1)`;
      expect(sql<{ threadId: string }>`SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH '接口限流'`).toEqual([{ threadId: "t_1" }]);
      sql`UPDATE sh_thread SET summary = '滑动窗口方案' WHERE threadId = 't_1'`;
      expect(sql<{ threadId: string }>`SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH '滑动窗口'`).toEqual([{ threadId: "t_1" }]);
      sql`INSERT INTO sh_worker (workerId, threadId, deviceId, agent, mode, state, createdAt, updatedAt) VALUES ('w_1', 't_1', 'd', 'pi', 'write', 'idle', 1, 1)`;
      sql`INSERT INTO sh_report (workerId, seq, threadId, status, summary, receivedAt) VALUES ('w_1', 1, 't_1', 'done', '白名单已加', 1)`;
      expect(sql<{ threadId: string }>`SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH '白名单'`).toEqual([{ threadId: "t_1" }]);
      // One row per thread, never duplicates from the re-index path.
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_thread_fts`[0]!.n).toBe(1);

      // Questions: threadId nullable (threadless routing asks) + the candidates column.
      sql`INSERT INTO sh_question (qid, threadId, text, options, candidates, status, askedAt) VALUES ('q_1', NULL, '指哪件事？', '[]', '[{"threadId":"t_1","label":"a"}]', 'open', 1)`;
      expect(sql<{ threadId: string | null }>`SELECT threadId FROM sh_question WHERE qid = 'q_1'`[0]!.threadId).toBeNull();

      // Runs carry the dispatch counter.
      sql`INSERT INTO sh_run (operationId, kind, text, status, createdAt) VALUES ('r_1', 'user', 'x', 'open', 1)`;
      expect(sql<{ dispatchCount: number }>`SELECT dispatchCount FROM sh_run WHERE operationId = 'r_1'`[0]!.dispatchCount).toBe(0);
    });
  });

  it("014_worker_questions: pre-#10 open questions are marked handled — the upgrade never re-pushes them", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      const tx = <T>(fn: () => T): T =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);

      // A deployment that predates #10, with the two question shapes it could hold open.
      const pre = MIGRATIONS.filter((m) => m.id !== "014_worker_questions");
      runMigrations(sql, pre, tx);
      sql`INSERT INTO sh_thread (threadId, title, state, unread, lastActivityAt, archived, createdAt) VALUES ('t_1', '旧任务', 'idle', 0, 1, 0, 1)`;
      sql`INSERT INTO sh_worker (workerId, threadId, deviceId, agent, mode, state, createdAt, updatedAt) VALUES ('w_1', 't_1', 'd', 'pi', 'write', 'broken', 1, 1)`;
      sql`INSERT INTO sh_report (workerId, seq, threadId, status, summary, receivedAt) VALUES ('w_1', 3, 't_1', 'blocked', '卡住', 1)`;
      // A blocked-report question (qid matches q_<worker>_<seq> of a real report row) and a
      // failure-class one (no matching report) — both already pushed by the M1 core.
      sql`INSERT INTO sh_question (qid, threadId, workerId, text, status, askedAt) VALUES ('q_w_1_3', 't_1', 'w_1', '旧提问', 'open', 1)`;
      sql`INSERT INTO sh_question (qid, threadId, workerId, text, status, askedAt) VALUES ('q_w_1_9', 't_1', 'w_1', '凭据失效', 'open', 1)`;
      // A steward question (no worker): must NOT be touched.
      sql`INSERT INTO sh_question (qid, threadId, text, options, status, askedAt) VALUES ('q_steward_x', 't_1', '指哪件事？', '[]', 'open', 1)`;

      runMigrations(sql, MIGRATIONS, tx);
      const rows = sql<{ qid: string; kind: string; fallbackDueAt: number | null; handledAt: number | null }>`
        SELECT qid, kind, fallbackDueAt, handledAt FROM sh_question ORDER BY qid
      `;
      expect(rows.find((r) => r.qid === "q_w_1_3")).toMatchObject({ kind: "report", handledAt: 1 });
      expect(rows.find((r) => r.qid === "q_w_1_9")).toMatchObject({ kind: "failure", handledAt: 1 });
      // Handled at ask time ⇒ no fallback deadline in play, and the sweep skips them.
      for (const r of rows) if (r.qid !== "q_steward_x") expect(r.handledAt).toBe(1);
      expect(rows.find((r) => r.qid === "q_steward_x")).toMatchObject({ kind: "steward", handledAt: null });
      // Re-run is a no-op.
      expect(() => runMigrations(sql, MIGRATIONS, tx)).not.toThrow();
    });
  });

  it("upgrades a pre-#7 database inside one transaction: old questions survive the rebuild with candidates NULL", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      const tx = <T>(fn: () => T): T =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);

      // A deployment that predates #7: everything through 009 applied, real rows present.
      const pre = MIGRATIONS.filter((m) => m.id !== "010_routing");
      runMigrations(sql, pre, tx);
      sql`INSERT INTO sh_thread (threadId, title, state, unread, lastActivityAt, archived, createdAt) VALUES ('t_old', '旧任务', 'idle', 0, 1, 0, 1)`;
      sql`INSERT INTO sh_question (qid, threadId, text, options, status, askedAt) VALUES ('q_old', 't_old', '旧问题', '["A"]', 'open', 1)`;
      sql`INSERT INTO sh_run (operationId, kind, text, status, createdAt) VALUES ('r_old', 'user', 'x', 'settled', 1)`;

      // The restart after deploy: onStart applies 010 in one transaction.
      runMigrations(sql, MIGRATIONS, tx);
      expect(
        sql<{ threadId: string | null; candidates: string | null }>`SELECT threadId, candidates FROM sh_question WHERE qid = 'q_old'`,
      ).toEqual([{ threadId: "t_old", candidates: null }]);
      expect(sql<{ dispatchCount: number }>`SELECT dispatchCount FROM sh_run WHERE operationId = 'r_old'`[0]!.dispatchCount).toBe(0);
      // The pre-existing thread was backfilled into the FTS index (not only trigger-synced).
      expect(sql<{ threadId: string }>`SELECT threadId FROM sh_thread_fts WHERE sh_thread_fts MATCH '旧任务'`).toEqual([{ threadId: "t_old" }]);

      // Another restart is a no-op — the ledger row committed with the rebuild.
      expect(() => runMigrations(sql, MIGRATIONS, tx)).not.toThrow();
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_question`[0]!.n).toBe(1);
    });
  });

  it("019_web_workspace: past messages reappear in the transcript from their runs, less the routing note", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      const tx = <T>(fn: () => T): T =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);

      // A deployment from before the workspace: messages recorded for dedup only, their text
      // living in the run each one started (with the steward's routing note in front).
      runMigrations(sql, MIGRATIONS.filter((m) => m.id !== "019_web_workspace"), tx);
      for (const [msgId, at] of [["om_plain", 1], ["om_routed", 2], ["om_unanswered", 3]] as const) {
        sql`INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized) VALUES ('feishu', ${msgId}, ${msgId}, 'message', ${at}, 1)`;
      }
      sql`INSERT INTO sh_run (operationId, kind, text, status, createdAt) VALUES ('user:om_plain', 'user', '修一下登录', 'settled', 1)`;
      sql`INSERT INTO sh_run (operationId, kind, text, status, createdAt) VALUES ('user:om_routed', 'user', ${"（系统注：这条消息是对 Thread「登录」（t_1）消息的回复，已确定归属该 Thread。）\n继续"}, 'settled', 2)`;
      sql`INSERT INTO sh_run (operationId, kind, text, status, createdAt) VALUES ('event:x', 'event', '⟦event⟧ a worker finished', 'settled', 3)`;

      runMigrations(sql, MIGRATIONS, tx);
      expect(sql<{ msgId: string; text: string | null }>`SELECT msgId, text FROM sh_inbound ORDER BY msgId`).toEqual([
        { msgId: "om_plain", text: "修一下登录" },
        { msgId: "om_routed", text: "继续" },
        { msgId: "om_unanswered", text: null }, // nothing to restore it from: it stays out of the transcript
      ]);
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_web_request`[0]!.n).toBe(0);
      expect(() => runMigrations(sql, MIGRATIONS, tx)).not.toThrow();
    });
  });
});
