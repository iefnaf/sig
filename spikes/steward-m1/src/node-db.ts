// node:sqlite implementation of the Db facade. Kept in its own module so the core never
// imports node:sqlite and can later run inside the Durable Object unchanged.
import { DatabaseSync } from "node:sqlite";
import type { Db } from "./db.ts";

export function openNodeSqlite(path: string): Db {
	const db = new DatabaseSync(path);
	return {
		exec: (sql) => void db.exec(sql),
		run: (sql, ...params) => void db.prepare(sql).run(...params),
		get: (sql, ...params) => db.prepare(sql).get(...params) as Record<string, unknown> | undefined,
		all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
	};
}
