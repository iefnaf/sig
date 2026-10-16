// Command dedup log (connector-pi.md §6.3): the DO re-delivers queued/sent/ack-timeout-failed
// commands at hello, so the connector must dedup on cmdId and answer `duplicate` with the
// original result. A row stuck in `sending` across a restart is undecidable → `ambiguous`.
import type { DatabaseSync } from "node:sqlite";
import { inspectCommandDelivery } from "./session-observation.ts";

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

export interface CommandMeta {
  /** The worker the command addresses (envelope or args), when one is known. */
  workerId?: string | null;
  kind?: string | null;
  /** Recovery evidence (§6.3): the session a commandId marker lands in, and the entry id
   * that closes the tail window a marker must appear after to prove absence. */
  sessionFile?: string | null;
  afterEntryId?: string | null;
  /** True when delivery puts the commandId into the session as a custom entry. */
  markerExpected?: boolean;
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
  begin(cmdId: string, meta: CommandMeta): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO command (cmdId, state, result, createdAt, workerId, kind, sessionFile, afterEntryId, markerExpected)
       VALUES (?, 'accepted', NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cmdId,
      Date.now(),
      meta.workerId ?? null,
      meta.kind ?? null,
      meta.sessionFile ?? null,
      meta.afterEntryId ?? null,
      meta.markerExpected ? 1 : 0,
    );
  }

  marker(
    cmdId: string,
    meta: { sessionFile?: string | null; afterEntryId?: string | null; markerExpected?: boolean } = {},
  ): void {
    this.db
      .prepare(
        "UPDATE command SET sessionFile = COALESCE(?, sessionFile), afterEntryId = COALESCE(?, afterEntryId), markerExpected = MAX(markerExpected, ?) WHERE cmdId = ?",
      )
      .run(meta.sessionFile ?? null, meta.afterEntryId ?? null, meta.markerExpected ? 1 : 0, cmdId);
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

  // Startup reconciliation (connector-pi.md §6.3): a crash mid-`sending` leaves the outcome
  // undecidable in general. Commands carrying the ADR-0001 commandId marker are decided from
  // the session tail — delivered when the marker is present, not_delivered when its absence
  // is proven by a fully-read tail — and every other command is honestly reported as
  // ambiguous: the connector never re-runs a crashed command, and never re-sends one.
  reconcileCrashed(): Array<CommandRecord & { recovery: "delivered" | "not_delivered" | "ambiguous" }> {
    const rows = this.db
      .prepare(
        `SELECT cmdId, state, result, kind, workerId, sessionFile, afterEntryId, markerExpected
         FROM command WHERE state IN ('accepted', 'sending')`,
      )
      .all() as Array<{
        cmdId: string; state: CommandState; result: string | null; kind: string | null; workerId: string | null;
        sessionFile: string | null; afterEntryId: string | null; markerExpected: number;
      }>;
    return rows.map((row) => {
      let recovery: "delivered" | "not_delivered" | "ambiguous" = "ambiguous";
      if (row.state === "accepted") {
        // The handler never started: nothing was sent to the agent.
        recovery = "not_delivered";
      } else if (row.markerExpected === 1) {
        recovery = inspectCommandDelivery(row.sessionFile, row.cmdId, row.afterEntryId);
      }
      const result: CommandResult | null =
        recovery === "delivered"
          ? { ok: true, data: { recovered: "delivered_after_connector_restart" } }
          : recovery === "not_delivered"
            ? { ok: false, error: { code: "not_delivered", message: "connector restarted before the command reached the agent", retriable: true } }
            : null;
      this.db
        .prepare(
          "UPDATE command SET state = ?, result = ?, recovered = 1 WHERE cmdId = ?",
        )
        .run(recovery === "delivered" ? "done" : recovery === "not_delivered" ? "failed" : "ambiguous", result ? JSON.stringify(result) : null, row.cmdId);
      return {
        cmdId: row.cmdId,
        state: recovery === "delivered" ? "done" : recovery === "not_delivered" ? "failed" : "ambiguous",
        result,
        recovery,
      };
    });
  }

  // hello.pendingAcks (protocol §6.1): every command not yet terminally settled, so the DO can
  // resolve rows whose cmd_ack/cmd_result were lost with the crash.
  pendingAcks(): Array<{ cmdId: string; state: CommandState; recovered?: boolean }> {
    return (
      this.db
        .prepare("SELECT cmdId, state, recovered FROM command WHERE state NOT IN ('done', 'failed') OR recovered = 1")
        .all() as Array<{ cmdId: string; state: CommandState; recovered: number }>
    ).map((row) => ({ cmdId: row.cmdId, state: row.state, ...(row.recovered ? { recovered: true } : {}) }));
  }
}
