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

  it("a migration that dies mid-flight rolls back completely when wrapped in a transaction (review #48 finding 3)", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);

    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      // The same wrapping onStart uses: each migration + its ledger row in one commit.
      const tx = (fn: () => void): void => {
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);
      };

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

  it("upgrades a pre-#7 database inside one transaction: old questions survive the rebuild with candidates NULL", async () => {
    const id = env.Steward.idFromName(`test-migrations-${crypto.randomUUID()}`);
    const stub = env.Steward.get(id);
    await runInDurableObject(stub, async (instance: Steward) => {
      const sql = (instance as unknown as { sql: SqlExecutor }).sql.bind(instance);
      const tx = (fn: () => void): void => {
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(fn);
      };

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
});
