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
