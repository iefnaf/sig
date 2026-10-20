---
name: verify-sweep-grid
description: Exhaustively verify the steward's worker-maintenance decision (sweepWorkers — stall notices and worker reaping) against its documented policy. Use when a change touches Steward.sweepWorkers or the armWorkerSweeps block in apps/steward/src/steward.ts, the worker-lifecycle ledger methods in apps/steward/src/ledger.ts (silentSince, notifyStall, reapWorker, markStartFailed, markResumeFailed, markResumeCancelled, settleWithdrawnStart), the sweep thresholds (STALL_ALARM_MS / REAP_OFFLINE_MS / REAP_SILENT_MS / WORKER_SWEEP_INTERVAL_S), or the sh_worker / outbox / sh_machine table shapes those reads depend on.
---

# Verify the worker sweep grid

## What this guards, in one sentence each

**Property (safety):** the maintenance sweep must never close a worker that may still run or be delivered — a `starting` worker whose command is still `queued`/`sent`, a `queued` (serial-park) worker on an online machine, and any active worker inside its silence/offline clocks survive every sweep untouched.

**Property (liveness):** every wedged active worker is closed *some* sweep: machine offline a measured 10 minutes (or online-but-silent 45 min, for `running`/`recovering`/undecidable `starting`) → `lost` quietly; a failed start → `broken` with a push; a failed/expired resume send → back to `idle`.

**Property (exactly-once):** a given stall notifies once; a closed worker is never re-closed; a second sweep over an unchanged world changes nothing.

**Harm if broken:** reaping a live worker erases the record of running work and opens the duplicate-dispatch door (two agents in one repo — this exact bug class is review findings 3 and 4, PR #46 findings 1/4, PR #54 blocker 3 in steward.ts's comments); never reaping wedges a Thread in "running" forever.

## Run it

```bash
pnpm -C apps/steward test test/verify-sweep-grid.test.ts
```

~7 s (the 2700-cell grid itself runs in about a second inside one Durable Object call; three realism anchors through the real dispatch flow take the rest). It also runs as part of `pnpm -C apps/steward test` (cost table entry `verify-sweep-grid.test.ts`).

## How it works and what makes it exhaustive

`Steward.sweepWorkers` is a pure *decision* over observable facts: worker.state, the command row (`outbox.kind` × `outbox.state`), the machine's `online` flag, and two clocks it only ever compares to three constants (`STALL_ALARM_MS` 20 min, `REAP_OFFLINE_MS` 10 min, `REAP_SILENT_MS` 45 min; the `silentSince` query gate is min(offline, stall) = 10 min). The check enumerates **every** combination the code can distinguish — 4 worker states × 15 command shapes × 5 machine shapes × 9 silence shapes = 2700 cells — seeds the real `sh_worker`/`outbox`/`sh_machine` rows inside the real Durable Object (workerd, real SQLite), runs the real `sweepWorkers` twice per cell, and compares against an oracle transcribed from the *documented* policy (each oracle line cites its doc-comment source), not from the code's control flow. Clocks are bucketed with points one minute to either side of each threshold, so every real timestamp maps to a cell and a threshold-value drift of about a minute or more flips one; there is no Kani/ESBMC-style verifier for TypeScript at repo scale, so enumerating the real code's full decision space replaces a hand model with zero drift. The three "realism anchor" tests at the bottom of the file drive the same promises through the real dispatch flow (`dispatchForTest` + `FakeConnector`) to prove the seeded rows match production shapes.

## Reading a failure

A failing cell prints as `[starting|start_worker/sent|off@11m|silent 11m] sweep1.reaped 1, want 0` — read it as: worker state `starting`, command kind/state `start_worker`/`sent`, machine offline with lastSeen 11 min ago, silent 11 min; the sweep reaped when the policy says keep. Every id uses the code's own nouns (`queued`/`starting`/`running`/`recovering`, cmd `queued`/`sent`/`accepted`/`done`/`failed`/`expired`/`ambiguous`, `on@`/`off@<lastSeen minutes>`, `silent<minutes>m` or `silent∅<minutes>m` when no event ever arrived).

- **A cell fails and the cited doc-comment agrees with the oracle** → real bug in `sweepWorkers` or a ledger method. Do not weaken the oracle; report the cell as the counterexample.
- **A cell fails and the *docs* disagree with the oracle** → oracle drift: the policy was restated here, not in the code's contract comments. Fix the oracle's transcription (each line cites its source — update the citation too), never the check's coverage.
- **The anchors fail but the grid passes** → the seeded rows no longer match what the real dispatch flow writes (a schema or reducer change); update the seed SQL in `collectGrid` to the new shapes and re-run.
- **Everything fails with workerd/SQL errors** → a migration renamed or reshaped a table the seeds write; same fix as above.

## When the policy *intentionally* changes

Edit the sweep in `steward.ts` and its doc-comment contract together, then update the matching oracle line in `expected()` in `test/verify-sweep-grid.test.ts` ( KEEP / REAP_QUIET / STALL / START_FAILED / RESUME_FAILED / WITHDRAWN_START / RESUME_CANCELLED ) and any new grid dimension if a new observable fact (a new command state, a new threshold) enters the decision. Add the dimension to the loops in `collectGrid` — completeness is the whole point, so never sample a new dimension. Then move the sync commit below forward to your commit.

## Coverage record

| Covered | Where |
| --- | --- |
| `sweepWorkers` (the whole decision), `commandState` | `apps/steward/src/steward.ts` |
| `silentSince`, `notifyStall`, `reapWorker`, `markStartFailed`, `markResumeFailed`, `markResumeCancelled`, `settleWithdrawnStart`, `recomputeThreadState`, `recordBrokenQuestion` (as reached by the sweep) | `apps/steward/src/ledger.ts` |
| The reads' inputs: `sh_worker`, `outbox`, `sh_machine` columns the sweep and those methods touch | `apps/steward/src/schema.ts` |

**Sync commit: `4e392003`** ("test: exhaustive decision-space check for the worker sweep") — the last commit at which the grid was confirmed to describe this code. When you change any covered file and the grid still passes (or you update it per the section above), move this line to your commit hash. If the covered code has changed since this commit, treat the grid's pass as unconfirmed until you run it.

## Scope and assumptions (what a pass does NOT cover)

- **Threshold values are pinned to bucket resolution.** The grid proves the decision *structure* at the documented 20/10/45-minute values; a threshold change is caught once it crosses a bucket boundary (buckets sit at ±1 min around each threshold), so sub-minute drift is invisible. An intentional threshold change should update the oracle constants (`STALL_ALARM_MIN`/`REAP_OFFLINE_MIN`/`REAP_SILENT_MIN`) and the doc comments together.
- **One sweep pass per world state, twice per cell.** Multi-step interleavings — a hello reconciliation or worker event landing *between* sweep reads and ledger writes — are not covered; that race is what the cmdId guards in `markResumeFailed`/`markResumeCancelled` defend against, and single-threaded DO execution cannot produce it inside one call. Existing suites (`stall-reap.test.ts`, `reconcile.test.ts`, `crash-window.test.ts`) cover those paths behaviorally.
- **Alarm arming is out of scope.** `armWorkerSweeps`/`lastSweepArmAt` scheduling math (the interval − 1 s window) is only incidentally exercised; `alarm.test.ts` owns it.
- **Notification delivery is stubbed during the grid** (`drainNotifications` is patched to a no-op and restored in `finally`), so the check asserts *queued intents* (`sh_notify` kinds), not rendered cards. Rendering is covered by `card-snapshots.test.ts` and the anchors.
- **Hello-snapshot reconciliation of reaped workers** (`resolveReapPending`, `sh_reap_pending`) is a different state machine — out of scope here.
- The `off@0m` corner (offline flag set, lastSeen now) encodes a deliberate policy: an offline machine's workers wait out the 10-minute offline clock *even past 45 min of silence*, and never get a stall notice. If that ever changes intentionally, update the oracle's running/recovering branch.

## After changes that did not recheck this

If covered code moved and nobody ran this skill, load `/maintain-formal-verification-skill` and follow it to bring the grid back in line before trusting a pass.
