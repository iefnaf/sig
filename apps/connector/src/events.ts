// Persistent event log (protocol §4.3, connector-pi.md §11.3): events are written to LocalStore
// before being sent; per-worker seq counters persist across restarts (ADR-0001: the DO dedups
// on (workerId, seq), so renumbering from 1 after a restart silently drops everything); rows
// are truncated only after a cumulative ack (events_ack or welcome.acks).
import type { DatabaseSync } from "node:sqlite";

export interface StoredEvent {
  workerId: string;
  seq: number;
  payload: string;
}

// Per-worker cap (connector-pi.md §11.3): the oldest rows are evicted beyond this; a `resync`
// for evicted seqs produces an `events_gap` report instead of a replay.
const MAX_ROWS_PER_WORKER = 5000;

export class EventLog {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // Assigns the next per-worker seq (persisted before the event is returned) and stores the row.
  append(workerId: string, payloadFields: Record<string, unknown>): { workerId: string; seq: number; payload: string } {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("INSERT INTO worker_seq (workerId, nextSeq, ackedUpTo) VALUES (?, 1, 0) ON CONFLICT(workerId) DO NOTHING")
        .run(workerId);
      const { nextSeq } = this.db.prepare("SELECT nextSeq FROM worker_seq WHERE workerId = ?").get(workerId) as {
        nextSeq: number;
      };
      this.db.prepare("UPDATE worker_seq SET nextSeq = ? WHERE workerId = ?").run(nextSeq + 1, workerId);
      const event = { workerId, seq: nextSeq, ts: Date.now(), ...payloadFields };
      const payload = JSON.stringify(event);
      this.db
        .prepare("INSERT INTO event (workerId, seq, payload, createdAt) VALUES (?, ?, ?, ?)")
        .run(workerId, nextSeq, payload, Date.now());
      this.enforceCap(workerId);
      this.db.exec("COMMIT");
      return { workerId, seq: nextSeq, payload };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  nextSeq(workerId: string): number {
    const row = this.db.prepare("SELECT nextSeq FROM worker_seq WHERE workerId = ?").get(workerId) as
      | { nextSeq: number }
      | undefined;
    return row?.nextSeq ?? 1;
  }

  // Rows with seq > ackedUpTo, i.e. everything the DO has not cumulatively acknowledged.
  pending(workerId: string): StoredEvent[] {
    const { ackedUpTo } = this.db.prepare("SELECT ackedUpTo FROM worker_seq WHERE workerId = ?").get(workerId) as {
      ackedUpTo: number;
    };
    return this.db
      .prepare("SELECT workerId, seq, payload FROM event WHERE workerId = ? AND seq > ? ORDER BY seq")
      .all(workerId, ackedUpTo) as unknown as StoredEvent[];
  }

  workers(): string[] {
    return (this.db.prepare("SELECT workerId FROM worker_seq").all() as Array<{ workerId: string }>).map((r) => r.workerId);
  }

  // A cumulative ack (events_ack / welcome.acks): everything <= upTo is durably persisted by
  // the DO, so those rows may finally be truncated from the local log.
  truncate(workerId: string, upTo: number): void {
    this.db
      .prepare("INSERT INTO worker_seq (workerId, nextSeq, ackedUpTo) VALUES (?, ?, ?) ON CONFLICT(workerId) DO UPDATE SET ackedUpTo = max(ackedUpTo, excluded.ackedUpTo)")
      .run(workerId, 1, upTo);
    this.db.prepare("DELETE FROM event WHERE workerId = ? AND seq <= ?").run(workerId, upTo);
  }

  ackedUpTo(workerId: string): number {
    const row = this.db.prepare("SELECT ackedUpTo FROM worker_seq WHERE workerId = ?").get(workerId) as
      | { ackedUpTo: number }
      | undefined;
    return row?.ackedUpTo ?? 0;
  }

  oldestSeq(workerId: string): number | null {
    const row = this.db.prepare("SELECT MIN(seq) AS m FROM event WHERE workerId = ?").get(workerId) as { m: number | null };
    return row.m ?? null;
  }

  // A resync asks for a replay from `from`; if the local log already evicted that range the
  // caller must report events_gap{from, to} instead (protocol §4.3).
  rangeAvailable(from: number, workerId: string): { replay: StoredEvent[]; gapFrom: number | null; gapTo: number | null } {
    const oldest = this.oldestSeq(workerId);
    const pending = this.pending(workerId).filter((e) => e.seq >= from);
    if (oldest !== null && oldest > from) {
      return { replay: pending, gapFrom: from, gapTo: oldest - 1 };
    }
    return { replay: pending, gapFrom: null, gapTo: null };
  }

  private enforceCap(workerId: string): void {
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM event WHERE workerId = ?").get(workerId) as { n: number };
    if (n <= MAX_ROWS_PER_WORKER) return;
    this.db
      .prepare(
        "DELETE FROM event WHERE workerId = ? AND seq <= (SELECT MIN(seq) FROM (SELECT seq FROM event WHERE workerId = ? ORDER BY seq DESC LIMIT ?))",
      )
      .run(workerId, workerId, MAX_ROWS_PER_WORKER);
  }
}
