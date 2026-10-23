# Sig Product Requirements Document (Spec)

> Status: draft v0.2.
>
> **Update (ADR-0003/0010):** the chat-channel requirement (Feishu) is deferred. The owner
> uses the browser workspace, whose optional programmatic API remains SERVER_KEY-gated;
> everything else in this document stands. The channel sections remain as the future-integration
> design.
>
> **Update (ADR-0004/0005):** the web workspace is the owner's everyday entry — one
> continuous conversation over the API's local channel, with Threads, "Needs you" decisions,
> and worker session records read on demand from their machines ([web entry](design/web-entry.md)).
>
> **Update (ADR-0010):** browser access now uses a deployment password or passkey at the public
> root URL. The one-time-link statements below record the earlier Feishu-era design. Card detail
> links remain; API-issued login links are now an explicit-key compatibility path.
> This document defines only **product requirements and boundaries** and does not cover specific technical implementation approaches. Technology-related assumptions and items to verify are collected in the "Items to Verify" section.

## 1. Overview

Sig is a personal agent "steward" deployed on a Cloudflare Durable Object, online 24/7.

It does not write code itself. Its job is:

1. Connect the coding agents scattered across the user's machines (Claude Code, Codex, pi, etc.).
2. Remember which agent on which machine each matter was assigned to, and in which session.
3. Let the user issue or append to a task at any time with a single sentence, and route it to the right place.
4. Report briefly to the user when something progresses, completes, or gets stuck.

The product is built on [pi-durable](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable`) and released as an open-source project: users fork it and one-click deploy to their own Cloudflare account, with all data staying in their own hands.

## 2. Target Users and Use Cases

**Target users**: developers already using coding agents such as Claude Code, Codex, and pi, who use Sig mainly on their phones.

Core insight: at the computer, the user can operate a specific agent directly; away from the computer, the user wants to say one sentence to the steward, have the matter handled and get a report back when it is done, without going back and forth with an agent over every detail.

Typical scenarios:

1. **Dispatching work**: "Have claude code fix the login bug in the xx repo on mac-studio."
2. **Picking up an earlier matter**: the next day, say "About that login bug from yesterday, add unit tests." The steward routes back to the corresponding machine and session.
3. **Passive reporting**: when a task completes or gets stuck, the user receives a brief report.
4. **Checking progress**: "What are the machines all doing right now?"
5. **Intervention**: "Stop that one." "Switch to pnpm instead."
6. **New matters with no clear home**: the steward picks a suitable machine and agent, or asks the user back.
7. **Scheduled tasks and patrols**: "Every workday at 9, summarize last night's progress across the machines." "Keep an eye on the CI of the xx repo for me."

## 3. Design Principles

1. **The steward does no work itself; it only schedules and remembers.** In the MVP phase the steward has no execution environment of its own (browser, sandbox, phone); all execution is dispatched to agents on the user's machines.
2. **Better to ask once more than to route wrongly.** When ownership is uncertain, it must ask back.
3. **Quiet by default.** Disturb the user only on completion, when stuck, or when a decision is needed.
4. **Everything is traceable.** Every report can be drilled down into the timeline, and from there into the agent's raw process.
5. **Proactive behavior must have a source.** Every proactive action by the steward can be traced back to something the user said.
6. **Memory is visible and controllable by the user.** What gets remembered and what gets forgotten — the user can see and intervene in both.

Differentiation: products like Grok Bot and Dots put their capabilities in the cloud; Sig's capabilities live **on the user's own machines**, with access to real code, files, logged-in state, and the local environment.

## 4. Core Concepts

| Concept | Definition |
|---|---|
| **Machine** | One of the user's computers, connected to the steward by running the connector. Has an online status and a capability declaration (which agents are installed, which repos exist). |
| **Thread** | The "matter" in the user's mental model; the core unit of memory and routing. Has a goal, a summary, and the repos and machines involved. |
| **Worker session** | A concrete session of a given agent on a given machine, belonging to a Thread. A Thread can have several sessions in succession. |
| **Routine** | A proactive task the user has prescribed: a fixed trigger condition plus a fixed action. |
| **Watch (patrol)** | A proactive task where the user states a concern and the steward decides whether it needs handling. |
| **Handoff brief** | A context summary the steward provides when a new session takes over a matter. |

## 5. Threads and Sessions

### 5.1 The Unit of a Matter

The unit visible to the user is the **Thread** (the goal), with multiple sessions attached under it. Repos and machines are strong routing signals: a Thread records the repos and machines it involves; when the user mentions them, candidates are narrowed down on that basis first, then matched precisely against the goal description.

### 5.2 State Model

A Thread has only three **derived states**, inferred by the system from facts and **never set manually by the user**:

| State | Basis |
|---|---|
| **In progress** | A worker is currently running |
| **Waiting on you** | There is an unanswered question, or a failure that needs a user decision |
| **Idle** | Nothing is running and nothing is waiting |

There is also an **unread flag**: there is a report the user has not yet seen.

**There is no explicit "completed" state.** "Done" comes only from the worker's own report; it is an event, not a Thread state. The steward does not declare "this matter is over" on the user's behalf. The main view is sorted by recent activity, so old matters sink naturally. An idle Thread can receive further instructions at any time and return to in progress, and it always remains routable (with priority decaying over time). Optional manual archiving serves only as a cleanup tool.

### 5.3 Relay-Style Context

The MVP supports only the **relay style** (A finishes, B continues on top of A's results). Parallel splitting and comparison-style work are not supported yet.

Multiple sessions **do not share conversation context**; what is shared is the Thread-level handoff brief and the code itself:

1. **Resume when possible.** Follow-up requests to the same agent on the same machine resume the original session.
2. **Cases that need a new session**: switching agent, switching machine, a bloated original session context, or needing a fresh, unbiased perspective (e.g. an independent review).
3. **Provide a handoff brief when starting new**, containing: the goal; what is done and the current state; key decisions and why; pointers (branch, changed files, key commits); what this session is to do. The brief carries **pointers, not content**, letting the new agent read the code and diff itself.
4. **The brief's material comes from the worker's own wrap-up report**: every worker is required to produce a structured report when completing or pausing (what it did, what it decided, what is left, where the changes are), which the steward folds into the Thread summary rather than guessing.

Known costs: the brief is lossy; summaries revised over many rounds may drift, so the traceable raw process must be kept; the steward knows only what the worker has reported.

## 6. The Steward's Autonomy

Draw the line by "the cost of being wrong" and "whether it can be undone afterwards":

| Tier | Content |
|---|---|
| **Decides on its own, without disturbing the user** | Retries (limited count); machine or agent choice with clear grounds (the user stated a preference, or only one machine has the repo); answering purely factual questions (what the test command is, where a file is) |
| **Acts first, explains in the report** | Higher-confidence routing (the report adds a line like "I hooked it up to xx", giving the user a chance to correct it) |
| **Must ask the user first** | Low routing confidence with multiple candidates; questions involving trade-offs and direction (e.g. "JWT or session"); interrupting a running task; anything beyond the scope of the user's own words |

Key rule: the steward answers only questions for which it can find grounds in **what the user has said or the Thread records**; anything without grounds is passed to the user.

The MVP fixes a single tier (balanced) for now; the design reserves an autonomy switch — "cautious / balanced / hands-off" — plus an entry point for plugging in a decision model for approval judgments later.

Sub-agent permission policy: fully automatic (yolo) by default in the MVP, with a hook for approval requests reserved in the agent adaptation layer.

## 7. Interaction and Interface

### 7.1 Main Entry: One Continuous Conversation with the Steward

The user always faces the same steward and the same conversation. Giving instructions, hearing reports, and making corrections all happen there. Threads flow behind the conversation, and the user never switches between chat windows. Reports appear directly in this conversation — there is no separate inbox; items that need the user are surfaced through push and flags.

### 7.2 Channels

- **The first channel: Feishu.** After deployment completes, a QR code is generated and the user scans it to create a bot. The scanner is bound as the owner; only their direct messages are answered.
- Channels are abstracted as adapters; WeCom, Telegram, Slack, etc. can be added later.
- Reports can take the form of **cards with buttons**; "waiting on you" decisions become a single tap.
- No native app of our own, and no PWA first either. Important notifications are likewise carried by the IM; push reliability depends on the IM platform.

### 7.3 Companion Web Pages (Detail Pages)

Content that does not fit in chat is viewed on the web via a link. The web is not the main entry:

- Thread timelines.
- A worker's raw process (read-only).
- Memory page (view, edit, delete, pin).
- Routine and patrol list (view, pause, delete).
- Machine management (pair, revoke).

Historical design: login was handled by the IM, with one-time signed links. Browser password and
passkey sign-in now supersede this flow ([ADR-0010](adr/0010-browser-password-authentication.md)).

### 7.4 Visibility Layers

| Layer | Content | Where |
|---|---|---|
| L1 Overview | Thread list: title, status, machine and agent, recent progress, unread flag | Queried on demand in the conversation, or the web |
| L2 Timeline | Summary-level events of one Thread | Web |
| L3 Raw process | One worker's full conversation and tool calls | Web, read-only, degraded on mobile |

There are two ways to step in: **through the steward** (the default; memory stays unbroken) and **talking directly to a specific worker** (the escape hatch). Conversations during direct intervention are also recorded in the Thread timeline; the steward keeps updating the summary as a bystander but does not interfere. Direct intervention has the lowest priority on mobile.

### 7.5 Report Format

A fixed three-part format, with length strictly controlled:

1. **Outcome**: one sentence — did it work or not.
2. **What was done**: two to four bullets, covering where things changed and how they were verified.
3. **What you need to do**: omitted when there is nothing.

A "view details" entry is attached. Failure and stuck reports use the same three parts, state the outcome plainly, and suggest a next action (retry, switch agent, give up). When several tasks complete within a short window, they are merged into one report.

Example:

> Login bug fixed, tests pass.
> - The problem was in `auth/session.ts`: the token was not refreshed after expiring
> - Changed 2 files, added 1 test
> - On the `fix/login` branch on mac-studio, not pushed yet
>
> Your decision: push it and open a PR?

### 7.6 Push Policy

Push only "waiting on you" and important completions. Ordinary progress appears silently in the conversation and does not buzz the phone.

## 8. Proactive Behavior

### 8.1 Wake-Up Sources (Eyes and Ears)

| Source | Examples | Phase |
|---|---|---|
| Time | Do something every workday at 9; an alarm the steward sets for itself ("look at that task again in two hours") | MVP |
| Internal state changes | A worker completes, gets stuck, or stalls; a machine goes offline | MVP |
| External events | New GitHub issue, CI failure, email, calendar | Later, added one by one |
| Machine-side observation | The user manually starts an agent session at the computer, and the connector notices | Later, feasibility to be confirmed |

### 8.2 Two Kinds of Proactivity

- **Routine**: a fixed action the user has set, e.g. "Every morning at 9, have Claude Code run a dependency check in the xx repo and tell me if anything comes up." Predictable, easy to trust.
- **Watch (patrol)**: the user states a concern, and the steward decides whether to act on it, tiered by the autonomy rules in Section 6.

**The default conclusion upon waking is to do nothing.** Otherwise proactivity becomes noise.

### 8.3 Authorization Boundary

Every proactive action by the steward must be traceable to something the user said (a routine, a patrol, or follow-up on an already-assigned task). The steward may **suggest** new routines, but creating one requires the user's consent.

How they are created: through conversation ("Every workday at 9 in the morning, summarize last night's progress across the machines and send it to me"); the steward repeats it back for confirmation and saves it. The web provides a list for viewing, pausing, and deleting.

### 8.4 MVP Scope

Stall reminders and machine-status notifications (when related to the user's tasks) count as "staying responsible for assigned matters" and are in the MVP. Scheduled routines are a hard requirement and must be designed early. Event triggers and machine-side observation are deferred.

## 9. Machine Offline and Recovery

The core idea: **distinguish "the machine is temporarily away" from "the task failed".**

| Situation | Handling |
|---|---|
| Machine offline at dispatch time | Tell the user immediately and offer the choice: start automatically once it comes back online, or switch to another machine that has the repo. Never decide silently for the user. If the user chooses to wait, the task is queued and runs automatically on reconnect, with a notification |
| Connection drops mid-task | The worker is marked "lost contact", not failed. The steward neither retries nor declares failure; it waits, and only mentions it in a report if the loss of contact drags on |
| The machine comes back | The connector reports tasks still running and tasks already finished, and the steward reconciles. Still running: resumed. Finished: results collected late. Interrupted: **automatically try to resume the original session, and ask the user only if that fails** |

Memory keeps each machine's online habits (usually online vs. usually offline); the MVP only records them. When several machines have the repo, the MVP picks one by a deterministic rule (user-named > the Thread's last machine > online > most free slots) and asks when there is no unique winner; see [ADR-0001](adr/0001-mvp-implementation-baseline.md). Habit-based selection for long tasks comes later.

## 10. Memory

Memory is the steward's greatest value and the part most in need of iteration, so it is **a standalone module**: the rest of the steward uses it only through a narrow interface and does not care about internal storage, retrieval, or forgetting policy.

### 10.1 What to Remember

Principle: **remember only what affects scheduling decisions.** Litmus test: if the steward did not know this, would it dispatch wrongly, ask too much, or say something wrong? If yes, remember it.

| Category | Content | Written by |
|---|---|---|
| Work items | Threads, session mappings, progress summaries, user instructions | System |
| Environment | Machines, installed agents, repo paths, machine online habits | Connector reports, auto-updated |
| Project conventions | "This repo uses pnpm", "the test command is xx" | Distilled from user instructions and worker reports |
| User preferences | "Give refactoring work to Codex", "keep reports short" | Distilled from the user's words |

"Clues about people and matters" (a general-purpose personal knowledge base) is explicitly **out of scope**; hold the boundary. Pure chat creates no Thread and enters no long-term memory unless the user explicitly says "remember this".

### 10.2 Layers and Forgetting

| Layer | Content | Forgetting rules |
|---|---|---|
| Resident layer | User preferences, global conventions, about one to two thousand characters | **Hard cap**: when full, the least important entries must be evicted; visible in every conversation |
| Project layer | Conventions and notes for each repo | Loaded only when that repo is involved; a small cap per repo; entries unused for a long time are demoted automatically to the archive layer |
| Archive layer | Full Thread history, old entries | Not resident; retrieved on demand; never deleted, only sinks |

Three triggers for forgetting:

1. **Capacity pressure**: writing something new requires evicting something old. The steward chooses and tells the user, "to make room, I forgot xx".
2. **Conflict override**: when new information contradicts an old entry, the new replaces the old, and the old is kept as a historical version.
3. **Unused for a long time**: demoted to the archive layer.

The user can **pin** entries; pinned entries are exempt from automatic eviction.

### 10.3 Visible and Controllable

- When the steward distills a new memory, the report includes a line "remembered: xx"; the user can correct it on the spot if unsatisfied. Silent memory is unacceptable.
- A memory page is provided: all entries listed by category, editable, deletable, pinnable.
- Every memory carries a **source** (which conversation, who said it) and a **date**; "said by the user in person" is distinguished from "inferred from agent reports or external content" — the latter weighs less and needs user confirmation before promotion to the resident layer, to guard against memory poisoning.
- Environment memories defer to the connector's real-time reports; when conventions or preferences conflict with current facts, facts win and the memory is updated.

### 10.4 Module Boundary (Responsibilities, Not Implementation)

| Capability | Caller |
|---|---|
| Get context (resident content + project memory relevant to the current topic) | At the start of every conversation |
| Find (which Thread this utterance may belong to; returns candidates and confidence) | Routing |
| Record (content, category, source, confidence; the module decides where it is stored and whether old entries are evicted) | When the steward distills new information |
| Update or invalidate | On conflict discovery or user correction |
| Manage (list, edit, delete, pin) | Memory page |
| Report changes (what was evicted, what was demoted) | The module reports proactively; the steward relays it to the user |

Thread and worker records are part of the memory module and are managed together with background memory. For the detailed design see [design/steward.md](design/steward.md).

## 11. Concurrency and Isolation

When several matters run at the same time on the same repo, **each change-making task defaults to its own git worktree**, with the detail entirely hidden from the user:

- Parallelism becomes a safe default, suited to dispatching work casually from a phone.
- Compatible with the relay style: a later session can continue from the earlier one's branch.
- Reports naturally carry branch information.
- A repo can be configured as "serial" or "work directly in the main checkout", for projects where worktrees do not fit.
- After a task ends, the worktree is kept until the user confirms the merge or cleans it up manually.

**Read-only tasks** (research, Q&A, review) are not isolated. The steward tells the two apart at dispatch time; when unsure, it treats the task as "will make changes".

## 12. Onboarding, Security, and Cost

### 12.1 Onboarding Flow

1. Click Deploy to deploy to Cloudflare and fill in the model API key. **Users in mainland China must additionally bind a custom domain to the Worker**: `*.workers.dev` is blocked in mainland China (verified on this machine), which breaks both the user's access to the web pages and the connector's connection to the steward.
2. When deployment completes, a QR code appears; scan it with Feishu to create a bot, and the scanner becomes the owner (based on Feishu's official app-registration device flow; see [research/feishu-channel.md](research/feishu-channel.md)).
3. In the conversation, the steward gives a command; paste and run it in a terminal on the computer to connect, and the machine shows up with the steward.
4. (Nice to have) The steward probes that machine's agents and repos and walks the user through dispatching the first task.

The MVP goes up to step 3.

### 12.2 Security

The connector is effectively a remote-code-execution entry point and is fully automatic by default, so it must be designed as a security problem from the start:

- **Identity**: carried by the Feishu account system; only the owner's direct messages are answered.
- **Machine pairing**: the command embeds a one-time pairing code that expires once used; each machine has its own credentials, revocable individually on the web.
- **Web access**: historical one-time IM links are superseded by password/passkey
  authentication with rate limits and recent-auth checks for security changes
  ([ADR-0010](adr/0010-browser-password-authentication.md)).
- **Model keys**: stored encrypted in the user's own Cloudflare account, never passing through a third party.
- Content from external sources (agent reports, future external events) is never treated as a trusted instruction.

### 12.3 Cost Transparency

The steward should be dormant, costing nothing, most of the time. The documentation must clearly state the order of magnitude of Cloudflare-side costs and the drivers of model-call cost (conversation count, summary generation), so users are not startled by the bill.

## 13. The Steward's Capability Boundaries

- The steward itself answers simple questions with language ability alone (common sense, translation, explaining error messages).
- Anything that truly needs execution is always dispatched to agents on the user's machines.
- The MVP gives the steward no execution environment of its own. A cloud browser is only an optional later capability for lightweight queries on public pages that need no login; phone calls are explicitly out of near-term scope.
- A Thread is created only for matters dispatched to an agent.

## 14. MVP Scope

**Included**

- Single-tenant deployment (each deployment serves one user).
- Feishu channel (QR-code bot creation, cards, push).
- Machine pairing and the connector, supporting at least one agent. The onboarding order is **pi → Claude Code → Codex** (Codex to be confirmed on this machine before it is finalized). For the pi integration see the [research](research/pi-integration.md) and the [design](design/connector-pi.md).
- The driven agent must already be installed and logged in on that machine; Sig never touches the agent's account credentials.
- The steward manages only the sessions it started itself; sessions the user starts manually are not monitored, but external changes are detected before one is spun up again.
- Thread / session memory and routing, relay-style handoff briefs.
- Three-part reports, the "waiting on you" state, and unread flags.
- Lost-contact and recovery handling.
- Memory module (layers, forgetting, visible and controllable).
- Worktree isolation for change-making tasks.
- Scheduled routines, stall reminders, machine-status notifications.
- Companion web pages: timeline, raw process (read-only), machine management; the remaining pages come later.

**Not included for now**

- Multi-user / multi-tenant.
- Parallel splitting, comparison-style collaboration, agents reviewing each other.
- Event triggers and integration with external systems.
- Machine-side observation of sessions the user starts manually.
- The steward's own execution environment (browser, sandbox, phone).
- Native app, PWA.
- Autonomy switch, approval decision model (only the entry point is reserved).
- Cross-machine file sync, complex task orchestration, billing.

## 15. Open Questions

1. **Integration capability of the other agents.** pi has been researched (see [research/pi-integration.md](research/pi-integration.md)); the Claude Code CLI has options such as `--resume` and `stream-json` input/output, but whether interjecting mid-run takes effect and whether a structured report can be obtained are unverified; Codex is not installed on this machine and has not been researched. Agents express their differences through capability declarations, and product promises are written against the smallest common capability (see Section 3 of [design/connector-pi.md](design/connector-pi.md)).
2. **Input forms.** Voice, images, files (e.g. dispatch a bug straight from a screenshot).
3. **Cost and usage visibility, budget caps.**
4. **Privacy and data boundaries.** Whether code content passes through the cloud; whether reports may carry code snippets.
5. **The long-term shape of multi-user support.**
6. **Persona and speaking style.**

## 16. Items to Verify (Technical Assumptions)

The following are assumptions formed during discussion, not yet verified. They are **not product requirements** and are recorded here only for reference:

- pi-durable provides Cloudflare Durable Object storage (`openDurableObjectSqliteStorage`), persistable documents and tasks, idempotent commits keyed by `requestId`, and background sub-agents with a report-back pattern (see the README and Example 23 of `packages/durable` in the pi repo). Memory and dispatch are expected to be built on these primitives.
- How a task waits for an **external event** (the connector reporting back): no ready-made primitive was found in the spec; it needs prototype validation. Possible paths include waiting based on document changes, or modeling the remote worker as a proxy session.
- Most pi-side assumptions have been verified on this machine; see [research/pi-integration.md](research/pi-integration.md) and [spikes/pi-rpc](../spikes/pi-rpc): interjecting mid-run, aborting, resuming a session after the process is killed, injecting a reporting tool, forcing a catch-up report, and read-only restrictions all hold.
- Whether the long connection between the connector and the DO supports hibernation, and whether a task can be woken by an alarm after hibernating.
- The dispatch tool has external side effects; crash replay must avoid duplicate dispatches, so an idempotency key is needed.
- The actual capability and permission scope of Feishu's "scan QR code to create a bot", and whether a personal account can create one.
- Whether each coding agent can run independently of the connector, to reduce the chance of "lost contact" turning into an "interrupt".
- The resume and external-drive capabilities of Claude Code, Codex, and pi.
- Name collisions for the project name Sig on npm, GitHub, and domains have not been checked yet.

## 17. References

- Grok Bot (xAI): centered on a roster of named bots, configured through conversation, task details in a side panel; bots can route to each other by description.
- Dots (OpenAI): each dot has its own cloud computer that can be opened and inspected at any time; the entry reuses the existing chat interface; background proactive research is read-only by default.
- Hermes Agent (Nous Research): core memory has a hard capacity cap and evicts when full; resident memory is small and high-value, with older content recalled on demand through retrieval; there is a memory-poisoning risk.
- Cloudflare: Browser Run, Sandboxes / Containers, `@cloudflare/computer`, `@cloudflare/voice` (phone lines require a third party).

The competitor and product information above comes from summaries of public sources and has not been tested first-hand; verify against the official documentation before building on it.
