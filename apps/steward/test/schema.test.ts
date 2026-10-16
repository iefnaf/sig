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
});
