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
}

const TERMINAL: ReadonlySet<CommandState> = new Set(["done", "failed", "ambiguous"]);

/** Kinds whose every delivery path writes the commandId marker into the session: for these,
 *  `markerExpected = 0` at crash time means delivery never began (§6.3 write-ahead). */
const WRITE_AHEAD_KINDS: ReadonlySet<string> = new Set(["start_worker", "send", "resume"]);

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
      `INSERT OR IGNORE INTO command (cmdId, state, result, createdAt, workerId, kind)
       VALUES (?, 'accepted', NULL, ?, ?, ?)`,
    ).run(cmdId, Date.now(), meta.workerId ?? null, meta.kind ?? null);
  }

  /** §6.3 write-ahead: arm the marker expectation (and record where the marker must appear)
   *  before anything is written to pi. */
  expectMarker(cmdId: string, meta: { sessionFile?: string | null; afterEntryId?: string | null }): void {
    this.db
      .prepare(
        "UPDATE command SET sessionFile = COALESCE(?, sessionFile), afterEntryId = COALESCE(?, afterEntryId), markerExpected = 1 WHERE cmdId = ?",
      )
      .run(meta.sessionFile ?? null, meta.afterEntryId ?? null, cmdId);
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
      } else if (row.kind !== null && WRITE_AHEAD_KINDS.has(row.kind)) {
        // The write-ahead invariant: for these kinds the marker expectation is armed before
        // ANY write to pi, so an unarmed row at crash time proves nothing was written.
        recovery = "not_delivered";
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
  pendingAcks(): Array<{ cmdId: string; state: CommandState; code?: string; recovered?: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT cmdId, state, result, recovered FROM command WHERE state NOT IN ('done', 'failed') OR recovered = 1`,
      )
      .all() as Array<{ cmdId: string; state: CommandState; result: string | null; recovered: number }>;
    return rows.map((row) => {
      // A recovered failure carries its error code so the DO can surface not_delivered
      // without waiting for (or relying on) a cmd_result that died with the crash.
      let code: string | undefined;
      if (row.recovered === 1 && row.state === "failed" && row.result) {
        try {
          const parsed = (JSON.parse(row.result) as CommandResult).error as { code?: unknown } | undefined;
          if (typeof parsed?.code === "string") code = parsed.code;
        } catch {
          // unreadable result: the state still travels
        }
      }
      return { cmdId: row.cmdId, state: row.state, ...(code ? { code } : {}), ...(row.recovered ? { recovered: true } : {}) };
    });
  }
}
