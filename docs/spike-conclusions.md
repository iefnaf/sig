# Spike-Phase Conclusions

> Status: **concluded** (2026-10-15). This document distills everything the `spikes/` phase validated, written for whoever implements the real system (human or agent): read this plus the [spec](spec.md) and the [design docs](design/) and you can start building — **no spike code reading required**. All code is sealed under git tag `spike-final`; consult it on demand with `git show spike-final:<path>`.

## 0. Bottom line

Every critical design assumption was **validated in practice**: the steward protocol on Durable Objects, real-model routing, adjudication and branch relay across pi and Claude Code workers, the reliability layer (watchdog/heartbeat/orphan sweep/reap), Feishu card interactions (including the consent gate), one-click deploy, and no-LLM routines. The system ran the full loop live in production and survived a 4-hour cloud platform incident (zero data loss, automatic recovery). **The real implementation can begin.** Sections 2 and 3 below are the answers bought with real pain — read them first.

## 1. What each spike validated

| Spike | What it validated | Key output |
|---|---|---|
| `do-protocol` | DO↔connector WebSocket protocol skeleton (pairing, outbox, acks, resend) | Protocol design corrections; see [research/do-protocol-spike.md](research/do-protocol-spike.md) |
| `pi-rpc` | pi `--mode rpc` event and control surfaces | Event shapes; adjudication inputs |
| `feishu-webhook` / `feishu` | Feishu inbound webhook, outbound cards, button callbacks | Channel approach; [research/feishu-channel.md](research/feishu-channel.md) |
| `steward-m1` | Steward core: ledger (SQLite on DO), reducer, report templates, outbound queue | 15/15 tests; the `sh_*` table prototypes |
| `steward-m2` | The steward as a pi-durable extension: tool set, policy hooks, real-model routing | Routing eval **100/106 (94.3%)**; settle-time dispatch verification |
| `e2e` | The full loop deployed live: Feishu → steward → connector → real worker → card | One-command bootstrap; the M3 reliability layer; the 11-bug list |

## 2. Integration pitfalls (answers the design docs don't contain)

Every item below was hit live. The real implementation should handle these up front:

**pi RPC**
- Responses use the `success` field, **not `ok`**; check `r.success === false || r.error`.
- Event stream: `agent_start` / `tool_execution_start{toolName,args}` / `message_end` / `auto_retry_end` / `agent_settled{aborted,outcome}`.

**Claude Code headless**
- Invocation shape: `claude -p --output-format stream-json --verbose --mcp-config <cfg> --append-system-prompt <text>` (permission bypass is a product decision; the spike used `--dangerously-skip-permissions`).
- **The stdin prompt is only processed on EOF**: after writing you must call `stdin.end()`, or the process hangs forever (hit this in practice).
- MCP tool calls arrive **namespaced** (`mcp__shepherd__report`); never match on the bare name `report` — use suffix matching like `endsWith("__report")`.
- Stream events: `system/init`, `assistant{message:{content:[tool_use|text]}}`, `result{subtype,is_error}`; stop_reason maps as `{end_turn→stop, tool_use→tool_use, max_tokens→length}`.
- A custom MCP server (e.g. the report tool) is just LF-delimited JSON-RPC over stdio: initialize → tools/list → tools/call, ~40 lines.
- Claude workers and pi workers can mix in one ledger with an identical adjudication path (verified: a relay branch handed off across agent types).

**Cloudflare DO deployment reality**
- **A resident isolate pins old code and old secrets**: minutes after `wrangler deploy` returns, a DO held alive by WebSockets/alarms still runs the previous version. After rotating secrets, evict it (disconnect + idle) before verifying. Recovery for a sick isolate: redeploy the same code to force eviction.
- `CREATE TABLE IF NOT EXISTS` does not add columns to existing tables — live migrations need idempotent `ALTER TABLE`.
- When DO storage fails (platform incident) every request 1101s while **plain Worker routes keep working** — use this to tell the layers apart.
- Don't use env-var auth for pi-ai inside Workers: `createProvider` with inline `auth.apiKey.resolve`; `PiModel` is `{provider, id}`.

**Connector reliability (the four that matter most)**
- **Half-dead TCP is the norm**: both ends' `send()` raises nothing, the bytes just never arrive. The only cure: bidirectional application-level heartbeats (uplink ping / downlink pong + inter-frame timeout forcing teardown and reconnect), plus idempotent cmdId dedup and re-delivery of `failed` commands at hello. A real home-network outage self-healed through exactly this path.
- **The DO dedups events**, so after a connector restart the event sequence **must continue** (persist seqs.json) — restarting at 1 gets every event silently dropped.
- **Stall detection**: no stdout for the threshold **and** two CPU samples <5% (`ps -p PID -o %cpu=`) — quiet-but-hot is a build, not a stall. One automatic respawn (same worktree, injecting a "continue from where it broke" note), second strike → settle as `error:stall`.
- On connector crash/restart, in-flight workers are recognized as orphans via **lock files + leftover worktrees**: lock present = alive at crash → report lost; clean worktrees get removed. The DO-side backstop is the reap sweep (running + offline 10 min, or online-but-silent 45 min → lost).

**Relay depends on thread routing**
- Branch relay is a thread-scoped lookup: if a continuation message routes to a **new thread**, the base lookup finds nothing and leg-2 starts from HEAD — the plan document isn't even on disk.
- The fix lives in the prompt: an explicit steward rule — "implement per plan X / continue X / build on X, where X is a thread's output → attach to that thread" — while counter-examples (X is an external document) still create new threads. 6/6 relay eval cases pass.
- The relay mechanism itself: the DO sends `base = the thread's latest worker branch` with start_worker; the connector runs `git worktree add -b shepherd/<id> <dir> <base>`.

**Feishu card interactions**
- A button callback only carries `open_message_id` — resolve the thread by looking it up in the outbound table via `providerMsgId`; don't stuff the thread id into the button value (Feishu rewrites card JSON and it gets messy).
- Consent gate shape: report card [同意] ("approve") / [先不要] ("not yet") → callback → `pr_worker` command (push branch + `gh pr create`) → result lands back in the chat asynchronously. **The happy path was never click-verified live** (by design it requires the user's own click).
- Digest routines render **deterministically without an LLM** (running/questions/unread → card), stay silent when there's nothing to say; schedules are `every@Ns` / `daily@HH:MM UTC`, the routine reschedules its own alarm, and the owner can disable it.

**Protocol odds and ends**
- Outbox command state machine: `queued → sent → acked / failed(timeout|rejected)`; hello re-delivers queued+sent, **and timeout-failed too** (half-dead connection debris), with cmdId dedup against replays.
- Double-send race: outbound delivery uses claim tokens (conditional UPDATE + ownership check).
- Post-dispatch settle-time verification: compare the dispatchSeq counter against "dispatched" claims in reply text; on mismatch, run a corrective follow-up. Zero false positives observed.

## 3. Bug list → regression tests for the real implementation

All hit and fixed live during the spike (details: `spike-final`'s `spikes/e2e/README.md`):

1. Double-send race duplicating deliveries → claim tokens.
2. `CREATE TABLE IF NOT EXISTS` doesn't migrate existing tables → idempotent ALTER.
3. Feishu sends with no timeout and no retry hung event handling → 10s timeouts + alarm-driven retries.
4. Dispatch picked a dead device (isolate swap silently drops the socket) → a thread remembers its last machine and queues while offline.
5. Queued commands never retried → periodic sweep, deliver on device return, fail after ~30 idle minutes.
6. A resident DO pins old secrets/code → evict before judging a deploy.
7. pi-ai provider construction inside Workers (see above).
8. pi RPC `success` vs `ok` (see above).
9. The one-dispatch guard leaked across runs → the guard resets with provenance.
10. **The downlink can also die silently**: the DO sees a healthy connection, the command ack-times-out into failed, hello doesn't re-deliver failed → permanently lost. Fix: bidirectional heartbeat + failed re-delivery + cmdId dedup.
11. **Routing decides whether relay ever happens**: "implement per plan X" opening a new thread → the relay base is lost. Fix: the continuation rule in the prompt + eval cases.

## 4. Quantified results (the baseline for the real implementation)

- Routing eval (deepseek-flash, 106 cases): **94.3% pass**, wrong-route 1.9% (target <2%), missed asks 0%, unnecessary asks 4.2% (target <15%). Dataset at `spike-final:spikes/steward-m2/eval/dataset.ts` — **106 labeled cases with rationales; inherit them directly as the regression set**.
- Contract tests: connector 19/19, steward-m1 15/15, steward-m2 7/7. The fake-pi scenarios (happy/unreported/error×3/aborted/crash/throttle/stall×2/…) and mock-steward (ping counting, frame swallowing, disconnects) are good templates for the test infrastructure.
- Live: digest routines fired on schedule; a send changed a running worker's deliverable; an interrupt flipped a thread idle within seconds; the orphan sweep recovered 5 lost events; the reap sweep unstuck a wedged thread.

## 5. Field incidents

- **4-hour cloud platform incident** (Cloudflare "Elevated Errors in China Network Colos", 2026-10-15): every DO request 1101'd, redeploying didn't help (not an isolate problem), plain Worker routes stayed fine. The connector's 5s retry loop self-healed throughout — reconnect + hello the moment the DO returned, zero persisted-data loss, and the daily digest fired on time inside the recovery window. **Conclusion: DB-backed queues + idempotent retries is the right design; this class of outage needs no human intervention.**
- Two real worker stalls (1.4% CPU, silent for 20 minutes) → this is where the watchdog design came from.
- One real home-network outage → healed via the heartbeat path.

## 6. Handover gaps for the real implementation (by priority)

1. **Auto-resume on connector restart**: today a restart reports lost (orphan/reap sweeps) and the user re-dispatches. Upgrade the lock-file + process fingerprint into resumable session continuation.
2. **In-chat intervention**: send/interrupt are HTTP admin routes only today; they should become natural phrases in Feishu ("stop that one" / "use pnpm instead" → the steward calls interrupt/send).
3. **pr_worker happy path**: awaits one real [同意] ("approve") click to close the loop (keep the consent-gate design).
4. **Install and distribution**: the connector today is a bare script under nohup. Decide npm package / Tauri / launchd service, plus autostart and upgrades.
5. **Multi-machine scheduling**: the whitelist already supports multiple repos; cross-machine selection (load, online state, affinity) is unimplemented.
6. **Security hardening**: admin token over HTTP headers (no rotation), long-lived SERVER_KEY, key management for Feishu callback signature verification.
7. Natural-occurrence statistics for settle-time verification (zero false positives so far, but the sample is small).

## 7. Code disposition

`spikes/` was removed from the working tree (conclusions live in this document); git tag `spike-final` preserves the full history for reference. The local connector process has been stopped. The `shepherd-hook` worker remains deployed on Cloudflare with the Feishu webhook pointed at it — tear it down with `wrangler delete` (or leave it as a reference) when the real implementation takes over; `~/.shepherd-spike/` still holds the device token and two worktrees with untracked worker deliverables, pending cleanup.
