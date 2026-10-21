// Exhaustive verification of the worker-maintenance decision (issue #13): `sweepWorkers`
// in steward.ts plus the ledger methods it calls (silentSince, notifyStall, reapWorker,
// markStartFailed, settleWithdrawnStart, markResumeFailed, markResumeCancelled).
//
// Why exhaustive: this one function decides, for every wedged worker, between "wait" and
// "close", and its documented policy (see sweepWorkers' own comment block: review findings
// 3 and 4, PR #46 findings 1 and 4, PR #54 blocker 3) has already been broken six times in
// exactly the corners a hand-written test does not reach. The sweep's decision depends only
// on: worker.state, the command row (kind × state), the machine's online flag, and two
// clocks compared against three constants (STALL_ALARM 20 min, REAP_OFFLINE 10 min,
// REAP_SILENT 45 min — plus the 10-minute silentSince query gate, min(offline, stall)).
// So bucketing the clocks by those constants makes the grid below cover EVERY input the
// code can distinguish, with buckets sitting one minute to either side of each threshold
// so a threshold-value drift of ~a minute or more flips a cell: 4 states × 15 command
// shapes × 5 machine shapes × 9 silence shapes = 2700 cases, each swept twice (the second
// sweep must be a no-op: dedupe + terminal states). No verifier like Kani/ESBMC runs on
// TypeScript, so this enumerates the real code's entire decision space instead of
// modeling it.
//
// The expectations below are transcribed from the documented policy (the doc comments and
// issue history cited inline), NOT from the code's control flow — that is the point.
//
// Realism anchors at the bottom drive the same promises through the real dispatch flow
// (FakeConnector + dispatchForTest), proving the SQL-seeded grid rows match production
// shapes. Kept in this repo as a permanent regression gate: run with
//   pnpm -C apps/steward test test/verify-sweep-grid.test.ts
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  ownerStub,
  pairDevice,
  resetLedgerState,
} from "./helpers.ts";

const MIN = 60_000;
const STALL_ALARM_MIN = 20; // STALL_ALARM_MS in steward.ts
const REAP_OFFLINE_MIN = 10; // REAP_OFFLINE_MS
const REAP_SILENT_MIN = 45; // REAP_SILENT_MS

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

// ---- the grid -----------------------------------------------------------------------------------

interface GridCase {
  id: string;
  state: string;
  cmdKind: string | null;
  cmdState: string | null;
  online: boolean;
  lastSeenMin: number;
  silentMin: number;
  noEvent: boolean;
}

interface GridResult {
  c: GridCase;
  sweep1: { stalled: number; reaped: number };
  sweep2: { stalled: number; reaped: number };
  row1: { state: string; lastOutcome: string | null };
  row2: { state: string; lastOutcome: string | null };
  timelineKinds: string[];
  notifyKinds: string[];
}

/** Runs every grid case inside the DO in one pass: seed the real tables, sweep twice, read
 *  back. The async notification drain is stubbed (and restored in `finally`) so the
 *  sh_notify rows this file asserts on cannot be drained mid-case; the sweep's own decisions
 *  are untouched. */
async function collectGrid(): Promise<GridResult[]> {
  return runInDurableObject(ownerStub(), async (instance: Steward, state: DurableObjectState) => {
    const exec = (query: string) => state.storage.sql.exec(query);
    const knobs = instance as unknown as { drainNotifications: () => Promise<void> };
    const realDrain = knobs.drainNotifications;
    knobs.drainNotifications = async () => {};
    try {
      const states = ["queued", "starting", "running", "recovering"];
      const cmdStates = ["queued", "sent", "accepted", "done", "failed", "expired", "ambiguous"];
      const cmds: Array<{ kind: string; st: string } | null> = [
        null,
        ...["start_worker", "send"].flatMap((kind) => cmdStates.map((st) => ({ kind, st }))),
      ];
      const machines = [
        { online: 1, seen: 0 },
        { online: 1, seen: 11 },
        { online: 0, seen: 0 },
        { online: 0, seen: 9 },
        { online: 0, seen: 11 },
      ];
      const silences = [
        { min: 5, noEvent: false },
        { min: 9, noEvent: false },
        { min: 11, noEvent: false },
        { min: 19, noEvent: false },
        { min: 21, noEvent: false },
        { min: 44, noEvent: false },
        { min: 46, noEvent: false },
        { min: 11, noEvent: true },
        { min: 46, noEvent: true },
      ];
      const results: GridResult[] = [];
      for (const state_ of states) {
        for (const cmd of cmds) {
          for (const machine of machines) {
            for (const silence of silences) {
              const id = `${state_}|${cmd ? `${cmd.kind}/${cmd.st}` : "nocmd"}|${machine.online ? "on" : "off"}@${machine.seen}m|silent${silence.noEvent ? "∅" : ""}${silence.min}m`;
              const now = Date.now();
              for (const table of [
                "sh_worker", "sh_thread", "sh_machine", "outbox", "sh_notify", "sh_timeline",
                "sh_question", "sh_wake", "sh_offline_dispatch", "sh_reap_pending", "event_inbox",
                "worker_ack", "sh_thread_repo", "sh_repo",
              ]) {
                exec(`DELETE FROM ${table}`);
              }
              exec(`INSERT INTO sh_machine (deviceId, name, online, lastSeen) VALUES ('dev1', 'm1', ${machine.online}, ${now - machine.seen * MIN})`);
              exec(`INSERT INTO sh_thread (threadId, title, lastActivityAt, createdAt) VALUES ('th1', 'grid', ${now}, ${now})`);
              // Silence counts from lastEventAt, or createdAt when no event ever arrived
              // (silentSince's COALESCE). A worker is created before its last event.
              const lastEventAt = silence.noEvent ? null : now - silence.min * MIN;
              const createdAt = silence.noEvent ? now - silence.min * MIN : now - (silence.min + 1) * MIN;
              exec(`INSERT INTO sh_worker (workerId, threadId, deviceId, agent, mode, state, cmdId, lastEventAt, createdAt, updatedAt)
                    VALUES ('w1', 'th1', 'dev1', 'pi', 'write', '${state_}', ${cmd ? "'c1'" : "null"}, ${lastEventAt ?? "null"}, ${createdAt}, ${now})`);
              if (cmd) {
                const failReason = cmd.st === "failed" ? "'rejected'" : "null";
                exec(`INSERT INTO outbox (cmdId, deviceId, workerId, cseq, kind, payload, notAfter, held, state, failReason, createdAt)
                      VALUES ('c1', 'dev1', 'w1', 1, '${cmd.kind}', '{}', null, 0, '${cmd.st}', ${failReason}, ${now})`);
              }
              const sweep1 = await instance.sweepWorkers();
              const readRow = () => {
                const rows = [...exec("SELECT state, lastOutcome FROM sh_worker WHERE workerId = 'w1'")];
                return (rows[0] ?? { state: "<gone>", lastOutcome: null }) as { state: string; lastOutcome: string | null };
              };
              const readKinds = (table: string, column: string, extra: string) =>
                [...exec(`SELECT ${column} FROM ${table} WHERE ${extra}`)].map(
                  (r) => String((r as Record<string, string>)[column]),
                );
              const row1 = readRow();
              const timelineKinds = readKinds("sh_timeline", "kind", "threadId = 'th1'");
              const notifyKinds = readKinds("sh_notify", "kind", "1 = 1 GROUP BY kind");
              const sweep2 = await instance.sweepWorkers();
              const row2 = readRow();
              results.push({
                c: { id, state: state_, cmdKind: cmd?.kind ?? null, cmdState: cmd?.st ?? null, online: machine.online === 1, lastSeenMin: machine.seen, silentMin: silence.min, noEvent: silence.noEvent },
                sweep1, sweep2, row1, row2, timelineKinds, notifyKinds,
              });
            }
          }
        }
      }
      return results;
    } finally {
      knobs.drainNotifications = realDrain;
      // The sweeps arm the maintenance alarm; leave no schedule rows behind for later files.
      for (const row of await instance.listSchedules()) {
        if ((row as unknown as { callback?: string }).callback === "sweepWorkers") {
          await instance.cancelSchedule(row.id).catch(() => undefined);
        }
      }
    }
  });
}

// ---- the documented policy, as an oracle ---------------------------------------------------------

interface Expected {
  stalled: number;
  reaped: number;
  final: string;
  /** Prefix the worker's lastOutcome must start with; null means "must stay null". */
  outcomePrefix: string | null;
  outcomeNull: boolean;
  lost: boolean;
  stall: boolean;
  push: boolean;
  stallNotice: boolean;
}

const KEEP = (state: string): Expected => ({
  stalled: 0, reaped: 0, final: state, outcomePrefix: null, outcomeNull: true,
  lost: false, stall: false, push: false, stallNotice: false,
});
const REAP_QUIET: Expected = {
  stalled: 0, reaped: 1, final: "lost", outcomePrefix: "reaped", outcomeNull: false,
  lost: true, stall: false, push: false, stallNotice: false,
};
const STALL = (state: string): Expected => ({
  stalled: 1, reaped: 0, final: state, outcomePrefix: null, outcomeNull: true,
  lost: false, stall: true, push: false, stallNotice: true,
});
const START_FAILED: Expected = {
  stalled: 0, reaped: 1, final: "broken", outcomePrefix: "start_failed:", outcomeNull: false,
  lost: false, stall: false, push: true, stallNotice: false,
};
const RESUME_FAILED: Expected = {
  stalled: 0, reaped: 1, final: "idle", outcomePrefix: "resume_failed:", outcomeNull: false,
  lost: false, stall: false, push: true, stallNotice: false,
};
const WITHDRAWN_START: Expected = {
  stalled: 0, reaped: 1, final: "idle", outcomePrefix: "cancelled", outcomeNull: false,
  lost: false, stall: false, push: false, stallNotice: false,
};
const RESUME_CANCELLED: Expected = {
  stalled: 0, reaped: 1, final: "idle", outcomePrefix: null, outcomeNull: true,
  lost: false, stall: false, push: false, stallNotice: false,
};

/** The promise, transcribed from sweepWorkers' documented rules (steward.ts §"Worker
 *  maintenance") and the ledger methods' contracts — every line cites its source. */
function expected(c: GridCase): Expected {
  // silentSince(min(REAP_OFFLINE, STALL_ALARM)) is the query gate: below 10 min of silence
  // the sweep never even sees the worker.
  const gate = c.silentMin >= REAP_OFFLINE_MIN;
  // "machine offline for a REAL 10 minutes (measured from the offline transition)"
  const offDue = !c.online && c.lastSeenMin >= REAP_OFFLINE_MIN;
  // "online-but-silent 45 min"
  const silentDue = c.silentMin >= REAP_SILENT_MIN;
  // §8.4 stall alarm: 20 min of silence, online machine, running/recovering only.
  const stallDue = c.silentMin >= STALL_ALARM_MIN;
  // "a start_worker that can still be delivered means the worker is queued, not lost"
  // (and the same wait-online rule covers a deliverable resume send).
  const deliverable = c.cmdState === "queued" || c.cmdState === "sent";
  if (!gate) return KEEP(c.state);

  // "silent BY DESIGN while the slot is held — no silence clock may ever touch it. Only the
  //  machine measurably disappearing closes it" — the command row is irrelevant to queued.
  if (c.state === "queued") return offDue ? REAP_QUIET : KEEP(c.state);

  if (c.state === "starting") {
    // "A resume-pending worker (issue #8): ... a failed/expired send must revert the worker
    //  to idle (never broken, never a push for expired)".
    if (c.cmdKind === "send" && c.cmdState === "failed") return RESUME_FAILED;
    if (c.cmdKind === "send" && c.cmdState === "expired") return RESUME_CANCELLED;
    // "Failed undelivered — ... the owner must hear that it never started."
    if (c.cmdKind !== "send" && c.cmdState === "failed") return START_FAILED;
    // "expired is the dispatcher's cancel state ... close quietly, no push (they already know)."
    if (c.cmdKind !== "send" && c.cmdState === "expired") return WITHDRAWN_START;
    // "Still deliverable — the run is queued, not lost": no clock, no stall, no reap.
    if (deliverable) return KEEP(c.state);
    // done/accepted/ambiguous/nocmd: "Close only at the online-but-silent horizon OR the
    // measured-offline clock"; with no command row at all the start can never happen.
    if (silentDue || offDue) return c.cmdState === null ? START_FAILED : REAP_QUIET;
    return KEEP(c.state);
  }

  // running / recovering: "machine offline for a real 10 minutes ... or online-but-silent
  // 45 min". An offline machine's workers are the reap sweep's territory alone: they skip
  // the stall notice on purpose and wait out the offline clock even past 45 min of silence
  // ("recently dropped, or not yet due: wait out the offline clock") — lastSeen is measured
  // from the offline transition, so a connection blip never reaps (review finding 4).
  if (!c.online) return offDue ? REAP_QUIET : KEEP(c.state);
  if (silentDue) return REAP_QUIET;
  if (stallDue) return STALL(c.state);
  return KEEP(c.state);
}

function checkCase(r: GridResult): string[] {
  const c = r.c;
  const exp = expected(c);
  const errs: string[] = [];
  const want = (ok: boolean, what: string) => {
    if (!ok) errs.push(what);
  };
  want(r.sweep1.stalled === exp.stalled, `sweep1.stalled ${r.sweep1.stalled}, want ${exp.stalled}`);
  want(r.sweep1.reaped === exp.reaped, `sweep1.reaped ${r.sweep1.reaped}, want ${exp.reaped}`);
  want(r.row1.state === exp.final, `state ${r.row1.state}, want ${exp.final}`);
  if (exp.outcomeNull) want(r.row1.lastOutcome === null, `lastOutcome ${JSON.stringify(r.row1.lastOutcome)}, want null`);
  else if (exp.outcomePrefix !== null) {
    want((r.row1.lastOutcome ?? "").startsWith(exp.outcomePrefix), `lastOutcome ${JSON.stringify(r.row1.lastOutcome)}, want prefix ${JSON.stringify(exp.outcomePrefix)}`);
  }
  want(r.timelineKinds.includes("lost") === exp.lost, `timeline lost=${r.timelineKinds.includes("lost")}, want ${exp.lost}`);
  want(r.timelineKinds.includes("stall") === exp.stall, `timeline stall=${r.timelineKinds.includes("stall")}, want ${exp.stall}`);
  want(r.notifyKinds.includes("failure_push") === exp.push, `failure_push=${r.notifyKinds.includes("failure_push")}, want ${exp.push}`);
  want(r.notifyKinds.includes("stall_notice") === exp.stallNotice, `stall_notice=${r.notifyKinds.includes("stall_notice")}, want ${exp.stallNotice}`);
  // The second sweep over the same unchanged world must be a complete no-op: "a given stall
  // notifies only once" and every closure lands in a non-active state.
  want(r.sweep2.stalled === 0 && r.sweep2.reaped === 0, `sweep2 ${JSON.stringify(r.sweep2)}, want {stalled:0,reaped:0}`);
  want(r.row2.state === r.row1.state && r.row2.lastOutcome === r.row1.lastOutcome, `sweep2 moved the row: ${JSON.stringify(r.row1)} → ${JSON.stringify(r.row2)}`);
  return errs.map((e) => `  [${c.id}] ${e}`);
}

describe("sweepWorkers: every case in its decision space (2700 cells × 2 sweeps)", () => {
  it("matches the documented reap/stall policy in every cell, and the second sweep is a no-op", async () => {
    const results = await collectGrid();
    expect(results.length).toBe(4 * 15 * 5 * 9);
    const failures = results.flatMap(checkCase);
    if (failures.length > 0) {
      const shown = failures.slice(0, 25);
      throw new Error(
        `${failures.length} cell(s) violate the policy:\n${shown.join("\n")}` +
          (failures.length > shown.length ? `\n  … and ${failures.length - shown.length} more` : ""),
      );
    }
  }, 240_000);
});

// ---- realism anchors: the same promises through the real dispatch flow ---------------------------

async function connectMachine(): Promise<FakeConnector> {
  const { deviceId, token } = await pairDevice("mac-grid");
  const fake = new FakeConnector({
    deviceId,
    token,
    repos: [{ repoId: "/srv/repo-a", name: "repo-a" }],
    run: null,
    autorun: false,
  });
  await fake.connect();
  return fake;
}

async function workerRow(workerId: string) {
  const snap = await ownerStub().debugSnapshot();
  for (const thread of snap.threads) {
    const worker = thread.workers.find((w) => w.workerId === workerId);
    if (worker) return { thread, worker };
  }
  return null;
}

async function waitForWorkerState(workerId: string, state: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await workerRow(workerId);
    if (row?.worker.state === state) return row;
    if (Date.now() > deadline) throw new Error(`worker ${workerId} stuck at "${row?.worker.state}", want "${state}"`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function backdateWorker(workerId: string, minutes: number): Promise<void> {
  await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_worker SET lastEventAt = ${Date.now() - minutes * MIN} WHERE workerId = '${workerId}'`);
  });
}

async function waitMachineOffline(timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    if (snap.machines.every((m) => !m.online)) return;
    if (Date.now() > deadline) throw new Error("machine never went offline");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function backdateMachine(minutes: number): Promise<void> {
  await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE sh_machine SET online = 0, lastSeen = ${Date.now() - minutes * MIN}`);
  });
}

describe("sweepWorkers: realism anchors through the real dispatch flow", () => {
  it("grid cell running|online|silent 21m: one stall notice, worker survives (grid says: STALL)", async () => {
    const fake = await connectMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "静默锚点", repoRef: "repo-a", newTitle: "静默锚点" });
    if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
    const [cmd] = await fake.waitForCmds(1);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    const { workerId } = outcome;
    await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a", branch: "sig/th-1" });
    await waitForWorkerState(workerId, "running");

    await backdateWorker(workerId, 21);
    expect(await ownerStub().sweepWorkers()).toEqual({ stalled: 1, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("running");
    expect(await ownerStub().sweepWorkers()).toEqual({ stalled: 0, reaped: 0 });
    expect((await workerRow(workerId))!.worker.state).toBe("running");
    fake.close();
  }, 30_000);

  it("grid cell running|offline@11m|silent 11m: quiet reap to lost (grid says: REAP_QUIET)", async () => {
    const fake = await connectMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "离线锚点", repoRef: "repo-a", newTitle: "离线锚点" });
    if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
    const [cmd] = await fake.waitForCmds(1);
    fake.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    const { workerId } = outcome;
    await fake.emit("started", workerId, { sessionId: workerId, cwd: "/srv/repo-a", branch: "sig/th-1" });
    await waitForWorkerState(workerId, "running");

    fake.close();
    await waitMachineOffline();
    await backdateMachine(11);
    await backdateWorker(workerId, 11);
    expect(await ownerStub().sweepWorkers()).toEqual({ stalled: 0, reaped: 1 });
    const row = await workerRow(workerId);
    expect(row!.worker.state).toBe("lost");
    expect(row!.worker.lastOutcome).toBe("reaped");
    expect(row!.thread.state).toBe("idle");
  }, 30_000);

  it("grid cell starting|start_worker/sent|offline@11m|silent 11m: deliverable, never reaped (grid says: KEEP)", async () => {
    const fake = await connectMachine();
    const outcome = await ownerStub().dispatchForTest({ prompt: "待送达锚点", repoRef: "repo-a", newTitle: "待送达锚点" });
    if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${outcome.kind}`);
    const { workerId } = outcome;
    await fake.waitForCmds(1); // the command left as `sent`; no ack, no started event
    await waitForWorkerState(workerId, "starting");

    fake.close();
    await waitMachineOffline();
    await backdateMachine(11);
    // No event ever arrived: silence counts from createdAt (the grid's silent∅ cells).
    await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec(`UPDATE sh_worker SET createdAt = ${Date.now() - 11 * MIN} WHERE workerId = '${workerId}'`);
    });
    expect(await ownerStub().sweepWorkers()).toEqual({ stalled: 0, reaped: 0 });
    const row = await workerRow(workerId);
    expect(row!.worker.state).toBe("starting"); // the duplicate-dispatch door stays shut
    expect(await ownerStub().sweepWorkers()).toEqual({ stalled: 0, reaped: 0 });
  }, 30_000);
});
