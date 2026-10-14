// Minimal database facade: the same core code runs on node:sqlite here and on the Durable
// Object's ctx.storage.sql later. Positional ? parameters, prepare-style calls only.
export interface Db {
	exec(sql: string): void;
	run(sql: string, ...params: unknown[]): void;
	get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
	all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}
