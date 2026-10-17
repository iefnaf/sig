// Machine observations and debounced status notices (issue #14, steward.md §5.3, spec §9).
// No model and no scheduling prediction anywhere: reliability is just accumulated
// observations, and a notice exists only when in-flight work was affected. All state lives
// in SQLite — the DO may sleep between the transition and the debounced send.
import type { LedgerDeps } from "./ledger.ts";

/** The ledger's timeline writer, injected so machine transitions land on sh_timeline the
 *  same way every other entry does (lastActivityAt bump included) instead of raw SQL. */
export interface MachineStatusDeps extends LedgerDeps {
  timelineAdd: (threadId: string, kind: string, text: string, refs: Record<string, unknown> | null) => void;
}

/** spec §9 / steward.md §5.3: a drop shorter than this is entirely silent. */
export const MACHINE_NOTICE_DEBOUNCE_MS = 2 * 60_000;

/** The online habits record (spec §10.1, steward.md §2.2) — record-only in the MVP. */
export interface MachineReliability {
  observedSince: number;
  since: number;
  onlineMs: number;
  offlineMs: number;
  transitions: number;
}

export function emptyReliability(ts: number): MachineReliability {
  return { observedSince: ts, since: ts, onlineMs: 0, offlineMs: 0, transitions: 0 };
}

/**
 * The machine's connection status changed. One transaction per transition: the reliability
 * tally, the `unreachable` bit on the machine's in-flight workers, a timeline entry per
 * affected Thread, and the debounced notice intents (steward.md §5.1 step 4 — intents are
 * data; the drain turns the stable ones into cards).
 */
export function createMachineStatus({ sql, tx, now = Date.now, timelineAdd }: MachineStatusDeps) {
  const affectedWorkers = (deviceId: string) =>
    sql<{ workerId: string; threadId: string }>`
      SELECT workerId, threadId FROM sh_worker
      WHERE deviceId = ${deviceId} AND state IN ('queued', 'starting', 'running', 'recovering')
    `;

  return {
    setOnline(deviceId: string, online: boolean, fallbackName = deviceId): void {
      tx(() => {
        const ts = now();
        const before = sql<{ online: number; reliability: string | null }>`
          SELECT online, reliability FROM sh_machine WHERE deviceId = ${deviceId}
        `[0];
        const reliability: MachineReliability = before?.reliability
          ? JSON.parse(before.reliability)
          : emptyReliability(ts);
        const changed = before !== undefined && !!before.online !== online;
        const stretch = Math.max(0, ts - reliability.since);
        if (before?.online) reliability.onlineMs += stretch;
        else if (before) reliability.offlineMs += stretch;
        reliability.since = ts;
        if (changed) reliability.transitions += 1;
        sql`
          INSERT INTO sh_machine (deviceId, name, online, lastSeen, reliability)
          VALUES (${deviceId}, ${fallbackName}, ${online ? 1 : 0}, ${ts}, ${JSON.stringify(reliability)})
          ON CONFLICT (deviceId) DO UPDATE SET online = excluded.online, lastSeen = excluded.lastSeen,
            reliability = excluded.reliability
        `;
        if (!changed) return;

        // spec §9: “lost contact, not failed” — reachability is a flag, never a state swap;
        // the connector's hello snapshot re-states the truth at reconnect (reconcileFromSnapshot).
        sql`
          UPDATE sh_worker SET unreachable = ${online ? 0 : 1}
          WHERE deviceId = ${deviceId}
            AND state IN ('queued', 'starting', 'running', 'recovering')
        `;
        const affected = affectedWorkers(deviceId);
        if (affected.length === 0) return; // notices exist only when in-flight work is hit

        for (const threadId of [...new Set(affected.map((w) => w.threadId))]) {
          timelineAdd(
            threadId,
            "machine_status",
            online ? `机器重新上线（对账中，任务未按失败处理）` : `机器离线：正在运行的任务暂时无法联系（未判定失败）`,
            { deviceId, online },
          );
          if (!online) sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${threadId}`;
        }
        // The debounce (steward.md §5.3): the intent is due only if the machine is still in
        // this state 2 minutes later; the drain drops it when the worker recovered meanwhile.
        // The transitions counter in the key keeps at most one notice per transition.
        // One intent PER AFFECTED WORKER (PR #51 review finding 5): the key carries the
        // workerId, or UNIQUE + INSERT OR IGNORE would collapse a multi-worker machine into
        // its first thread and leave the rest unnotified. The transition counter still caps
        // the flapping, and the `:on:`/`:off:` pairing is what the recovery gate matches.
        for (const worker of affected) {
          sql`
            INSERT OR IGNORE INTO sh_notify (dedupeKey, kind, threadId, workerId, dueAt, createdAt)
            VALUES (
              ${`machine:${deviceId}:${reliability.transitions}:${online ? "on" : "off"}:${worker.workerId}`},
              ${online ? "machine_online" : "machine_offline"},
              ${worker.threadId}, ${worker.workerId}, ${ts + MACHINE_NOTICE_DEBOUNCE_MS}, ${ts}
            )
          `;
        }
      });
    },
  };
}
