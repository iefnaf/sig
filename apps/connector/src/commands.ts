// Command dedup log (connector-pi.md §6.3): the DO re-delivers queued/sent/ack-timeout-failed
// commands at hello, so the connector must dedup on cmdId and answer `duplicate` with the
// original result. A row stuck in `sending` across a restart is undecidable → `ambiguous`.
import type { DatabaseSync } from "node:sqlite";

export type CommandState = "accepted" | "sending" | "done" | "failed" | "ambiguous";

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

export interface CommandRecord {
  cmdId: string;
  state: CommandState;
  result: CommandResult | null;
}

const TERMINAL: ReadonlySet<CommandState> = new Set(["done", "failed", "ambiguous"]);

export class CommandLog {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(cmdId: string): CommandRecord | null {
    const row = this.db.prepare("SELECT cmdId, state, result FROM command WHERE cmdId = ?").get(cmdId) as
      | { cmdId: string; state: CommandState; result: string | null }
      | undefined;
    if (!row) return null;
    return { cmdId: row.cmdId, state: row.state, result: row.result ? (JSON.parse(row.result) as CommandResult) : null };
  }

  // Persist-first (protocol §4.2): the row exists before cmd_ack goes out, so a crash between
  // the two still leaves evidence for post-restart reconciliation.
  begin(cmdId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO command (cmdId, state, result, createdAt) VALUES (?, 'accepted', NULL, ?)").run(
      cmdId,
      Date.now(),
    );
  }

  markSending(cmdId: string): void {
    this.db.prepare("UPDATE command SET state = 'sending' WHERE cmdId = ? AND state = 'accepted'").run(cmdId);
  }

  settle(cmdId: string, result: CommandResult): void {
    const state = result.ok ? "done" : "failed";
    this.db.prepare("UPDATE command SET state = ?, result = ? WHERE cmdId = ? AND state IN ('accepted', 'sending')").run(
      state,
      JSON.stringify(result),
      cmdId,
    );
  }

  isTerminal(record: CommandRecord): boolean {
    return TERMINAL.has(record.state);
  }

  // Startup reconciliation: a crash mid-`sending` leaves the outcome undecidable. The connector
  // never re-runs such a command; it reports `ambiguous` and lets the steward decide.
  reconcileCrashed(): CommandRecord[] {
    const stuck = this.db
      .prepare("SELECT cmdId, state, result FROM command WHERE state = 'sending'")
      .all() as Array<{ cmdId: string; state: CommandState; result: string | null }>;
    const update = this.db.prepare("UPDATE command SET state = 'ambiguous' WHERE cmdId = ?");
    return stuck.map((row) => {
      update.run(row.cmdId);
      return { cmdId: row.cmdId, state: "ambiguous" as const, result: null };
    });
  }

  // hello.pendingAcks (protocol §6.1): every command not yet terminally settled, so the DO can
  // resolve rows whose cmd_ack/cmd_result were lost with the crash.
  pendingAcks(): Array<{ cmdId: string; state: CommandState }> {
    return (
      this.db
        .prepare("SELECT cmdId, state FROM command WHERE state NOT IN ('done', 'failed')")
        .all() as Array<{ cmdId: string; state: CommandState }>
    ).map((row) => ({ cmdId: row.cmdId, state: row.state }));
  }
}
