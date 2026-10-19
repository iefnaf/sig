# ADR-0001: MVP implementation baseline

Status: accepted (2026-10-15). Decisions 4, 7 and 12 are amended by [ADR-0002](0002-pip-web-workspace.md) (the Pip web workspace). Decisions 4, 7–9 and 12 are further amended by [ADR-0003](0003-web-entry-local-sessions.md) for the Web entry and local worker-session scope (implemented).

Context: the spike phase concluded ([spike-conclusions.md](../spike-conclusions.md)). Before the real implementation starts, the open choices left by the [spec](../spec.md) and the [design docs](../design/) were settled in one review session. Where a design doc and the spike's field results disagreed, the spike wins.

## Decisions

1. **Rewrite, don't evolve the spike.** The real code starts from scratch, following the design docs. Assets from `spike-final` are ported on demand: the 106-case routing eval dataset, fake-pi, mock-steward, and the 11-bug list as regression tests. *Why:* spike code carries throwaway structure; the conclusions doc already captures what it proved.
2. **pnpm monorepo** with three packages: `packages/protocol` (shared message types and validation), `apps/steward` (Worker + Durable Object), `apps/connector` (Node daemon). *Why:* the protocol is shared by both ends and must not drift.
3. **Agents: pi first, Claude Code immediately after**, both inside the MVP, behind the `AgentAdapter` contract. Codex stays out. *Why:* the spike already ran a relay across pi and Claude Code workers in one ledger.
4. **MVP scope = steward milestones M1–M4 + minimal web** (timeline, raw process, machine management). The memory page and the routine list page are deferred; notes and routines are managed in conversation.
5. **All spike handover gaps are in the MVP**: auto-resume on connector restart, in-chat intervention, the PR consent gate, connector distribution, multi-machine selection, and security hardening.
6. **Multi-machine selection is a deterministic rule**, overriding spec §9's "record only": among machines that have the repo, prefer the user-named machine > the Thread's last machine > online > most free worker slots. A unique winner is dispatched and the report says "put it on X"; a tie or no online machine goes to `ask_user`. Online-habit prediction stays out.
7. **No HTTP admin routes.** (the admin surface is now the SERVER_KEY-gated owner API — [ADR-0003](0003-owner-api-replaces-chat-channel.md)) Intervention goes through Feishu; management goes through the signed-link web. The only unauthenticated entry points are `/pair` and the Feishu webhook. `SERVER_KEY` must be rotatable.
8. **Onboarding bootstrap is guarded by `SETUP_TOKEN`** (superseded — no setup page, [ADR-0003](0003-owner-api-replaces-chat-channel.md)), a secret generated at deploy time. The setup page (Feishu QR code / manual credentials) opens only with it and closes permanently once the owner is bound. *Why:* before owner binding there is no IM to issue signed links, and first-come-first-served lets a leaked URL hijack the deployment.
9. **Feishu inbound is webhook only.** (superseded — the chat channel is removed, [ADR-0003](0003-owner-api-replaces-chat-channel.md)) The long-lived connection is deferred entirely. Manual App ID/Secret entry is implemented first (it is the permanent fallback); QR creation builds on it.
10. **Connector package is `@iefnaf/shepherd`** (public package/command superseded by [ADR-0002](0002-sig-brand-and-compatibility.md)) (`shepherd` is taken on npm). Pairing command: `npx @iefnaf/shepherd connect <url> <code>`. Background service on macOS (launchd) and Linux (systemd user unit); no Windows.
11. **Steward model: provider configurable, default deepseek-flash** (the eval baseline). Changing the model requires re-running the routing eval.
12. **Web is server-rendered HTML from the Worker**, with a little vanilla JS only for the raw-process stream. No frontend build chain.
13. **Connector LocalStore uses `node:sqlite`** (transactions for command state and event seqs; the spike's `seqs.json` bug shows why).
14. **Routing eval gate**: any change to the steward prompt, tool definitions, `findCandidates`, or the model must run the eval and meet the thresholds (wrong-route < 2%, missed asks < 3%, unnecessary asks < 15%) before merge. Regular CI runs deterministic tests only.
15. **Daily budget soft cap is in the MVP** (steward.md §12): past it, events stop waking the LLM; template reports and user messages continue.

## Design-doc corrections adopted from the spike

- **Bidirectional application-level heartbeat** (uplink ping / downlink pong, inter-frame timeout forces reconnect) replaces "protocol-level ping only" in the protocol doc §3.2.
- **`hello` re-delivers `failed(timeout)` commands** too, deduplicated by `cmdId` (spike bug 10).
- **Event `seq` is persisted** and continues across connector restarts (the DO dedups, so restarting at 1 drops everything).
- **Ambiguous-command detection** uses a marker: the pi extension writes the `commandId` into a `custom` session entry, replacing "last user message text matches" (connector-pi.md open question 2).
- **Stall detection** on the connector requires both silence and low CPU (two samples < 5%), with one automatic respawn before settling as `error:stall`.
