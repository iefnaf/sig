# Design: the steward (Durable Object internals)

> **Status note (ADR-0003/0010):** the Feishu channel this design describes — QR onboarding,
> the webhook inbound, cards — is removed for now. The owner uses the password/passkey web
> workspace; the optional `/api/*` surface remains SERVER_KEY-gated. Outbound rows render
> locally as text + buttons. The rest of this document (ledger, routing, routines, questions)
> still describes the system.


Status: draft v0.1. Based on: the [product spec](../spec.md), the [connector–DO protocol](connector-do-protocol.md), and [protocol spike field tests](../research/do-protocol-spike.md).

This document designs the half that lives inside the Durable Object: **the memory module, routing, Thread management, event processing, notification policy, proactive behavior, and how the steward (the LLM) uses them**. The connector side is in [connector-pi.md](connector-pi.md); the transport protocol is in [connector-do-protocol.md](connector-do-protocol.md).

## 0. Conclusions up front

1. **The conversation is just a working buffer; the ledger is the memory.** The steward's pi-durable conversation gets compacted and grows long, so the facts of every "matter" (Threads, workers, reports, notes) live in our own SQLite tables, managed by a separate memory module. Each turn, the steward reads the latest state from the ledger instead of paging through conversation history.
2. **Anything deterministic is not handed to the LLM.** Deriving state after events arrive (running / waiting for you / idle, unread, open questions) is a deterministic reducer; `done`-class reports are sent to the user by the core straight from a template, **with no dependence on the LLM being up or on budget**. The LLM handles judgment: routing, answering workers' factual questions, updating summaries, taking notes.
3. **"Quiet by default" is guaranteed by structure, not by prompting.** In event-triggered runs, the steward's ordinary text output is always discarded; only explicit calls to `notify_user` / `ask_user` ever disturb the user.
4. **"Proactive behavior must have provenance" is enforced by tool parameters.** Every tool that can start work must carry a `provenance` (the ID of a user message, routine, follow-up, or watch); without one it is rejected.
5. **The memory module has a narrow interface and is replaceable as a whole.** The steward, the web app, and the Feishu adapter read and write only through it; how layering, capacity, retrieval, and forgetting are implemented is invisible from outside.

## 1. Position inside the DO

```
 Feishu / web / connectors              (remaining layers: see the protocol and connector designs)
        │
 ┌──────▼───────────────────────────────────────────────────────────────────────────────┐
 │ Sig DO (singleton "owner", an Agents SDK Agent)                                        │
 │                                                                                        │
 │  Channel adapters        Protocol gateway             Web read model                   │
 │  (dedup in, send out)    (connector/browser, outbox)  (timeline, memory page)          │
 │       │                       │                             ▲                          │
 │       ▼                       ▼                             │                          │
 │  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
 │  │ Core (deterministic)                                                             │  │
 │  │  event reducer ─ notification policy ─ outbound queue ─ alarm scheduler          │  │
 │  └───────┬───────────────────────────────────────────┬──────────────────────────────┘  │
 │          │ narrow interface                          │ wake / tools                    │
 │  ┌───────▼──────────────────────────────┐       ┌────▼───────────────────────────────┐ │
 │  │ Memory module                        │◀──────│ Steward (PiHarness conversation)   │ │
 │  │   Ledger                             │ tools │  tools, system prompt, policy hooks│ │
 │  │   Notes                              │       └────────────────────────────────────┘ │
 │  │   retrieval / forgetting / summaries │                                              │
 │  └──────────────────────────────────────┘                                              │
 │          one shared SQLite (Sig's tables + pi-durable's own tables)                    │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **The core** is deterministic code with no LLM, unit-testable.
- **The steward** is the root session of a `PiHarness`, holding a set of tools; it never writes SQL directly — it reaches the memory module and the protocol gateway only through tool calls.
- The two share one SQLite database. The core uses `ctx.storage.transactionSync` for atomic updates; there is **no cross-transaction** between these and pi-durable's commits — consistency rests on idempotency keys (§11).

## 2. The memory module

### 2.1 Responsibilities and boundaries

The memory module = ledger (facts) + notes (knowledge) + retrieval + lifecycle (forgetting, summarization). It answers three kinds of questions:

- **Which matter does this utterance belong to?** (routing)
- **What is the situation everywhere right now?** (situation brief)
- **What context should I know?** (preferences, project conventions)

It exposes only the interface below, and **callers must not read or write the tables around it**:

```ts
interface Memory {
  // ---- ledger ----
  threads: {
    create(input: NewThread): Thread;
    get(id: ThreadId): ThreadView;                        // includes summary, workers, open questions, related project notes
    list(filter: { state?: ThreadState[]; repoId?: RepoId; limit: number }): ThreadSummary[];
    findCandidates(q: RouteQuery): RouteCandidates;        // §3
    update(id: ThreadId, patch: { title?: string; goal?: string; summary?: string }): void;
    archive(id: ThreadId): void;
  };
  workers: { register(w: NewWorker): Worker; get(id: WorkerId): Worker; listByThread(id: ThreadId): Worker[] };
  machines: { upsertFromHello(h: Hello): void; setOnline(deviceId: DeviceId, online: boolean): void; list(): MachineView[] };
  events: { apply(batch: WorkerEvent[]): ReduceResult };   // §5: persist to the ledger + reducer, one transaction
  handoff: { build(threadId: ThreadId, fromWorker?: WorkerId): HandoffBrief };   // §2.6

  // ---- notes ----
  notes: {
    context(scope: { repoIds: RepoId[] }): NotesContext;   // resident layer + related project layers, with a character budget
    propose(n: NoteDraft): ProposeResult;                  // returns similar/conflicting candidates; does not write directly
    commit(n: NoteDraft, opts: { replaces?: NoteId[] }): { note: Note; changes: ChangeReport[] };
    pin(id: NoteId, pinned: boolean): void;
    remove(id: NoteId): void;
    search(q: string, opts?: { scope?: NoteScope[] }): Note[];
  };

  // ---- lifecycle ----
  maintenance(now: number): ChangeReport[];                // decay, demotion, capacity checks; called by the alarm

  // ---- views ----
  views: { situation(): SituationBrief; timeline(id: ThreadId, since?: Cursor): TimelinePage; memoryPage(): MemoryPage };
}
```

A `ChangeReport` is a change the memory module **proactively reports** (noted, evicted, demoted, superseded, pinned by the user). The steward must relay these to the user (§9) — this is where "forgetting is visible to the user" gets implemented.

> **Reliability, as implemented (issue #14).** `sh_machine.reliability` is a record-only JSON
> tally (`observedSince / since / onlineMs / offlineMs / transitions`) written in the same
> transaction as every real connection-status change; nothing selects on it yet.

### 2.2 The ledger's data model

Table names all carry the `sh_` prefix. Only semantics are listed below, not every column.

| Table | Key fields | Notes |
|---|---|---|
| `sh_machine` | `deviceId, name, online, lastSeen, capabilities, reliability` | Machines. `reliability` tracks online habits; in the MVP it is record-only |
| `sh_repo` | `repoId, deviceId, path, name, defaultBranch, remote` | Repositories reported by connectors |
| `sh_thread` | `threadId, title, goal, summary, summaryAt, state, unread, lastActivityAt, archived, createdFromMsg` | `state` is a **derived** value (§5), never set directly by the LLM or the user |
| `sh_thread_repo` | `threadId, repoId` | Which repos a matter involves; a strong routing clue |
| `sh_worker` | `workerId, threadId, deviceId, repoId, agent, mode, state, sessionId, branch, parentWorker, lastOutcome, lastEventAt` | One row per worker. `parentWorker` records the relay relationship |
| `sh_report` | `workerId, seq, status, summary, changes, decisions, leftovers, tests, question, next, git` | A worker's structured closing report (the `report` event in the protocol); raw material for handoff briefs |
| `sh_timeline` | `id, threadId, ts, kind, text, refs` | A summary-level timeline for L2 viewing: user instructions, dispatches, reports, questions, system notes. Contains no raw transcripts |
| `sh_question` | `qid, threadId, workerId, text, options, status, askedAt, answeredAt` | Open questions; the basis of the "waiting for you" state |
| `sh_event` / `sh_worker_ack` | Protocol-layer event inbox and watermark | See the protocol doc; we add `processedUpTo` |
| `sh_inbound` | `channel, msgId, receivedAt` | Inbound message dedup |
| `sh_outbound` | `id, channel, kind, threadId, payload, urgency, status, attempts, providerMsgId` | The outbound message queue; doubles as the "reply to this message → which Thread" mapping |
| `sh_routine` / `sh_watch` / `sh_followup` | See §8 | Proactive behavior |
| `sh_command` | Protocol-layer `outbox` | Adds a `provenance` column for auditing |

Full-text index for threads: `sh_thread_fts` (FTS5, covering `title + goal + summary + the latest report.summary`), kept in sync by triggers. FTS5 is supported in the DO's SQLite (official docs; verified by #7 — trigram tokenizer included, see §13).

### 2.3 Notes: data model and layering

```
sh_note(noteId, layer, scope_repoId?, kind, text, bytes,
        source, evidence, confirmed, pinned,
        createdAt, lastUsedAt, useCount, status, supersededBy)
sh_note_fts(text)                     -- FTS5
sh_note_log(id, ts, op, noteId, text, reason, delivery, decision, reportedAt)
                                       -- all changes (text = snapshot for the relay);
                                       -- reportedAt marks "already relayed with a reply" (issue #18);
                                       -- delivery = 'reply' | 'maintenance' and decision settle the
                                       --   90-day ask cards (issue #19)
sh_note_pressure(layer, scope_repoId, text, chars, kind, evidence)
                                       -- the latest user request for room per placement that a
                                       --   refused commit left behind (issue #19); PRIMARY KEY
                                       --   (layer, scope_repoId) — the daily pass resolves it
```

| Layer | `layer` | Contents | Capacity | How it loads |
|---|---|---|---|---|
| Resident layer | `resident` | User preferences, global conventions | Hard cap of **2,400 characters** | Rendered into a system-prompt section on every conversation turn |
| Project layer | `project` | A repo's conventions, machine-specific caveats | **1,500 characters** per repo | Injected alongside tool results whenever a Thread involving that repo is fetched |
| Archive layer | `archive` | Demoted old entries, evicted historical versions | Unlimited, never deleted | Fetched on demand via `notes.search` only |

`kind`: `preference` (a preference), `convention` (a project convention), `environment` (an environment fact), `fact` (any other fact that affects scheduling). Pure chat never becomes a note (spec §10.1).

`source` and trust level (spec §10.3, anti memory-poisoning):

| `source` | Meaning | Trust | Allowed into the resident layer? |
|---|---|---|---|
| `user_said` | Said by the user directly; `evidence` is a message ID | High | Yes |
| `connector` | Environment facts reported by a connector (repo paths, installed agents) | High | No — project layer only; live reports are the source of truth, notes are not relied on |
| `worker_reported` | From a worker's `report.decisions` and the like | Low | **No** — promoted only after the user confirms |
| `inferred` | Inferred by the steward | Low | **No** — promoted only after the user confirms |

Low-trust entries with `confirmed=false` live only in the project layer (marked "pending confirmation") and never appear in the resident layer; only after the user says "yes" — or the steward asks for confirmation and receives an affirmative answer — is `confirmed` set to true and promotion allowed.

### 2.4 Noting, conflicts, and supersession: the two-phase write

The module is deterministic and **semantic judgment is left to the steward**, so writes happen in two steps:

1. `notes.propose(draft)`: the module normalizes and dedupes (an exact match only bumps `useCount`) and uses FTS to find the closest few existing entries, returning `ProposeResult { duplicate?: NoteId, similar: Note[], needsEviction?: Note[] }`.
2. The steward reviews the candidates and decides on `commit(draft, { replaces })`: same-meaning entries supersede the old one (the old entry moves to the archive, preserving the historical version); different ones coexist.

Capacity handling: if a write would push the resident layer past 2,400 characters, `propose` returns `needsEviction` (sorted by the §2.5 score, lowest first, **pinned entries excluded**); the steward picks which to evict and carries them in `commit.replaces`. The module enforces the cap and rejects anything over it. **Pinned entries are never spendable as room**: a `replaces` target that is pinned is refused outright — the pin leaves only by the owner's unpin (spec §10.2's exemption covers every eviction shape, however it is dressed up).

If the steward does not handle it (issue #19): a **user_said** refusal records the request in `sh_note_pressure` — one row per **distinct request** (latest-wins must never erase an earlier promise without a report), carrying the draft's `kind`/`evidence` and its `replaces` intent; low-trust sources are never worth the room and stay plain refusals. The refusal message says so. The next daily `maintenance` honours each parked request deterministically: supersede its named `replaces` targets first (a parked correction must not score-evict *around* its predecessor; a target pinned in the meantime is skipped — the pin wins), then evict the lowest-scored unpinned entries by the same score, then write what was asked for, reporting both halves (「为腾空间我忘了 xx；记住了 yy」) through the daily delivery. If even that cannot free enough, the request is reported as unmet (`room_refused`) instead of rotting silently. A parked row is cleared only when a same-claim write lands (an *unrelated* successful write never clears it — a write consumes room, it does not make any).

### 2.5 Forgetting

Three triggers (spec §10.2):

1. **Capacity pressure**: eviction at write time (above). Eviction = demotion to `archive`, not deletion.
2. **Conflict supersession**: `replaces`. The old entry's `supersededBy` points to the new entry.
3. **Long unused**: `maintenance` runs once a day via a 02:00 UTC cron (idempotent by expression — restarts dedup onto the same schedule row instead of postponing it), with these rules:
   - A project-layer entry whose `lastUsedAt` is over 60 days old and not pinned → demoted to the archive.
   - A resident-layer entry unused for over 90 days and not pinned → **proposed to the owner, never demoted automatically** (resident-layer entries have broad impact): the daily pass sends an archive-or-keep card (「已经 90 天没有被用过…要归档吗？」); 归档 sinks the note (still searchable), 保留 renews `lastUsedAt` — a renewal, not a pin; the pin exemption stays the owner's explicit call. An unanswered ask re-fires at most every 30 days.

Retention score (used to pick eviction victims; the lower, the earlier evicted):

```
score = recency(lastUsedAt) × (1 + log(1 + useCount)) × sourceWeight × (confirmed ? 1 : 0.5)
sourceWeight: user_said 1.0 | connector 0.9 | worker_reported 0.4 | inferred 0.3
pinned entries do not participate
```

`lastUsedAt` is updated when an entry is assembled into the steward's context (`notes.context`, and `get_thread`'s project-note fetch via `forRepos`); this approximates "being used", which is good enough for the MVP. The always-rendered resident **section** deliberately does not count as use (PR #44 review finding 2) — every resident entry would then be "used" every turn and the 90-day rule would be dead code.

Every change is written to `sh_note_log`, and `ChangeReport`s are generated from it. The user's edits, deletions, and pins on the web memory page go through the same interface and are logged the same way.

**Delivery of the changes (issue #19)** — nothing sinks or is forgotten silently (spec §10.3): conversation-time changes ride the owner's next reply (「记账」 relay). The daily pass's own changes (demotions, evictions, the notes it saved from parked pressure, unmet pressure, 90-day suggestions) get their **own durable delivery** right after the pass: one quiet coalesced 「记账」 message for the bookkeeping and one push card per open suggestion, both through `sh_outbound` with stable ids (`notechg:<logId>`, `noteask:<noteId>:<logId>` — the card's tap resolves through its `providerMsgId`, §3.1's rule, and `decision`/`reportedAt` settle the ask). Three guards keep the classes honest: rows are marked reported only in their own delivery class (a pending `reply` row still rides the next reply); an **undecided suggestion never rides a reply** — plain text would report it while its card has never existed, and the 30-day quiet window would then block the re-ask; and one pass delivers at most **one bounded batch** (the rest stays pending for the next pass — same-vintage notes go stale together, and an unbounded flush would burst). Suggestions are logged **last** in the pass and re-validated at delivery time, so a note sunk by the pass itself (or between passes) never gets a card — its ask settles as gone. Without a bound owner, the rows simply wait for the first reply.

### 2.6 Summaries and handoff briefs

**Thread summaries** are the main raw material for routing and the situation brief, so distortion must be prevented:

- While handling wakes such as `report` / `settled` / `external_activity`, the steward calls `threads.update(summary)`. Summaries are capped at 600 characters.
- The module keeps the last 5 summary versions. Every 10 cumulative updates, the steward is prompted to **rewrite from scratch** rather than edit the old summary (rebuilt from the timeline and reports), to suppress drift.
- Original sources stay traceable: `sh_timeline`, `sh_report`, and the raw session on the connector.

The **handoff brief** is assembled deterministically by `handoff.build`; the steward then adds the current task:

```
Goal             ← thread.goal
Current state    ← thread.summary
Key decisions    ← all sh_report.decisions under the Thread, deduplicated, with the source worker
Leftovers        ← the latest sh_report.leftovers
Pointers         ← branch, commits, changed files (git facts from the connector, not the model's own account)
Task at hand     ← written by the steward
```

Briefs carry **pointers, not content** (connector-pi.md §5.3 / spec §5.3).

> **Implemented (issue #8).** Summary versions live in `sh_thread_summary` (`(threadId, version)`
> PK); the version number doubles as the cumulative update count, and blank or unchanged
> re-saves move nothing. A thread that predates the table enters history with its then-current
> summary as version 1, so the counter never reads zero on a thread with a past. The
> from-scratch prompt fires where it is actionable: the ⟦event⟧ wake text and the
> `update_thread` tool result both flag it when the NEXT update lands on the every-10th
> boundary (the 10th, 20th, … update is the rewrite); `get_thread` always exposes
> `summaryUpdates` / `summaryRewriteDue`. `handoff.build` (ledger.ts) gathers rows — goal,
> summary, all the thread's reports oldest-first, the from-worker (default: the thread's
> latest), and the thread's latest reported git facts — and `handoff.ts` assembles/renders
> deterministically: decisions dedupe by normalized wording with the FIRST reporter credited,
> leftovers come from the newest report that named any, pointers carry the connector-collected
> branch/commits(≤20)/changed-files(≤100) plus an uncommitted-changes warning, and every item
> renders as a single-line bullet so worker-reported text can never forge a brief section. The
> resume-vs-new-session rule (spec §5.3) is deterministic in the dispatcher (`decideContinuation`):
> the same agent on the same machine (healthy session, same repo, same mode, context usage
> < 80%) resumes by sending the task into the existing session — the connector's idle-cold
> relaunch is the resume mechanism; anything else (agent/machine/repo/mode switch, context
> ≥ 80%, an explicit fresh-review request, a broken session) starts a new session on the
> thread's latest worker branch with the brief prefixed and `parentWorker` recorded. The 80%
> threshold stands in until real-world data exists (connector-pi.md §15.5).

## 3. Routing

Goal (spec §0 and principles): better to ask one extra time than to route wrong.

### 3.1 Signals, strongest to weakest

1. **Explicit reference**: the user **replied to / quoted** a specific report or question in Feishu (Feishu messages carry a parent message ID); the Thread is resolved directly via `sh_outbound.providerMsgId → threadId`. Card buttons work the same way — the button's callback data carries `threadId`. These signals **never pass through LLM judgment** and carry the highest confidence.
2. **Explicit mention**: the message contains a Thread's title, short ID, or a registered repo or machine name.
3. **Semantic match**: the user's description matches a candidate Thread's title, goal, or summary.
4. **Recency and state**: recently active Threads, and Threads in the "waiting for you" state, rank first.

### 3.2 The candidate set

`threads.findCandidates({ text, hints })`:

1. Apply signal classes 1 and 2 from §3.1 first; on a hit, return only that Thread with `confidence: "explicit"`.
2. Otherwise assemble candidates: all "running" and "waiting for you" Threads (usually few) + the top 8 remaining Threads recalled by FTS over `text` + the 5 most recently active; deduplicated, capped at **12**. If `hints` contain a repo or machine, filter on that first.
3. Each candidate returns `threadId, title, one-line summary, repos, state, last activity time, match reason`.

At personal scale the whole candidate list is a few dozen lines of text, so the steward (LLM) simply picks from it in context — **no vector retrieval needed**. If Thread counts grow later, add vector recall inside `findCandidates`; the interface stays unchanged.

### 3.3 Decision rules

The steward calls `find_threads` to get candidates, then chooses `attach` (join a Thread), `create` (start a new one), or `ask`. A **deterministic policy hook** gates the choice afterwards (§7.2):

- An `explicit` signal among the candidates → direct `attach` is allowed.
- Otherwise the steward must also give `confidence ∈ {high, medium, low}` and a reason.
  - `high` with a unique candidate → allowed; the report includes a line "I attached it to xx".
  - Anything else → the hook blocks execution and demands `ask_user` instead (listing up to 3 candidates + "start a new matter").
- **When to create a Thread**: only for matters that dispatch an agent; never for pure chat (spec §13).

When attaching to an old Thread that has gone idle, the report must say so (spec §5.2): "I attached it to the earlier xx".

### 3.4 Routing evaluation

Routing is the core of the product's value and needs a measurable bar. Build a fixed evaluation set: 20–30 simulated Threads (including similar titles, multiple events in the same repo, idle for many days) and 100 utterances, each labeled with the true target or "should ask back". Metrics:

| Metric | Target |
|---|---|
| Mis-routing rate (auto-attached to the wrong Thread) | < 2% |
| Should have asked back but did not | < 3% |
| Unnecessary ask-back rate | < 15% |

Re-run this evaluation set whenever the model, prompts, or candidate-assembly rules change.

> **Implemented (issue #7).** The 106-case set was ported verbatim from `spike-final`
> (ADR-0001 decision 1) into `apps/steward/eval/` with a runner over the real extension
> (fresh in-memory world per case, node:sqlite + the trigram FTS index, the confidence gate
> live). `pnpm --filter @alexlikevibe/steward eval:routing` enforces the thresholds as the exit
> code — the required merge check for routing changes per ADR-0001 decision 14. Recorded
> runs, the key handling, and the OpenAI-compatible `--endpoint` override: [routing-eval.md](../routing-eval.md).

## 4. The steward (LLM)

### 4.1 Form

- The **root session** of a `PiHarness`; it never ends, and pi-durable compacts the context automatically.
- A pi-durable extension (`sig-steward`) supplies the system-prompt sections, tools, and hooks.
- What each turn sees:

| Content | Where | Why |
|---|---|---|
| Role, rules, autonomy, report format | System prompt (static sections) | Rarely changes; prompt-cache friendly |
| Resident-layer notes | One section of the system prompt | Changes rarely; when it changes, only the delta is appended |
| **Situation brief** (per-Thread state, machine online status, open questions) | Injected by the `beforeRequest` hook into the **single request**, not written into the conversation | Freshest every turn without bloating the conversation (**verified**: see the note at the end of this section) |
| Project-layer notes for the repos involved | Return values of tools like `get_thread` | Appears only when relevant |
| This turn's input | A user message or a system event | |

The `beforeRequest` hook can replace a single request's message list (pi-durable README, Generation hooks); whether it satisfies "append just one brief block, persist nothing" needs prototype validation. Fallback: put the situation brief into an input-text prefix.

> **Verified (issue #6, 2026-10-16).** The `beforeRequest` hook of pi-durable 1.3.0 replaces only the outgoing request's messages: pi commits the transcript *view*, not the hook's copy, so the injected `sig-situation` section never lands in any stored entry. Verified by test (`llm-reply.test.ts`, "the situation brief"): the outgoing request carries the fresh brief every turn, no stored `pi.system`/`pi.user` entry contains the section or its body, and two turns see different briefs after a state change. The input-prefix fallback stays unused. One implementation note: the hook rewrites the **leading system message's `sections` record** (adding `sig-situation` by name) rather than appending a mid-conversation system message — deepseek-flash's catalog entry does not declare `supportsMidConvoSystemMessages`, so the leading message is the safe place.

### 4.2 The two input sources

PiHarness's `submit` takes content only and does not support custom entry types (`pi-durable@1.1.0`'s `input` does not allow an `entry`; the repo README for newer versions says it does — needs verification). The MVP distinguishes them with **content markers**:

```
User message:   <raw text>                                  operationId = user:<channel message id>
System event:   ⟦event⟧ thread=<id> ... (compact text)      operationId = evt:<batch id>
Routine fire:   ⟦routine R⟧ <instruction>                   operationId = routine:<id>:<fireTime>
Follow-up due:  ⟦followup F⟧ <reason>                       operationId = followup:<id>
```

The core knows the input type at submit time and records it in `sh_run(operationId, kind, replyTo)` for outbound decisions (§6). The system prompt explains what the markers mean: anything starting with `⟦` is not something the user said.

### 4.3 Tools

Five groups. Every tool returns compact text plus a few structured fields. The "Replay" column is pi-durable's `replay` attribute: `safe` means it can re-run after a crash; `unsafe` means it cannot re-run, and the model sees "interrupted".

**Memory and lookup**

| Tool | Purpose | Replay |
|---|---|---|
| `situation()` | Returns the current situation brief (a fallback; usually already injected by the hook) | safe |
| `find_threads(text, hints?)` | Candidates from §3 | safe |
| `get_thread(threadId)` | Summary, workers, open questions, project-layer notes, recent timeline | safe |
| `update_thread(threadId, {title?, goal?, summary?})` | Updates the summary | safe (idempotent overwrite) |
| `notes_propose(draft)` / `notes_commit(draft, replaces?, confirmEvidence?)` / `notes_confirm(id, evidenceRef)` / `notes_pin(id, pinned)` / `notes_remove(id)` / `notes_list` | Two-phase writes from §2.4; confirm/list complete the conversation surface (issue #18). Resident writes require `evidence=user:<msgId>` (auto-attached from the triggering message in user runs); low-trust promotions require a confirmed predecessor or the run's own confirmation message | propose: safe; commit: safe (an exact-text duplicate absorbs the replay) |
| `notes_search(q)` | Search the archive layer | safe |

**Dispatch and control (via the protocol gateway)**

| Tool | Purpose | Replay |
|---|---|---|
| `start_worker(threadId, repoId, mode, prompt, base?, provenance, basis)` | Creates a worker command (connector-pi `start_worker`) | **unsafe** |
| `send_to_worker(workerId, text, intent, provenance, basis)` | Appends instructions | unsafe |
| `interrupt_worker(workerId, then?, basis)` | Interrupts, optionally resuming afterwards | unsafe |
| `resume_worker(workerId, reason)` | Manual resume | unsafe |
| `worker_status(workerId?)` / `machine_status()` | Read-only status | safe |

For `unsafe` tools the command ID is taken from the tool task ID: `cmdId = "tool:" + api.taskId`, so even a replay of the same call after a crash produces only the same command (protocol doc §7.1).

**Communicating with the user**

| Tool | Purpose |
|---|---|
| `notify_user({ threadId?, conclusion, did[], needsYou?, urgency })` | Sends in the fixed three-part format; `urgency: push \| quiet`; links are appended by the system |
| `ask_user({ threadId?, question, options?[≤3] })` | Creates an `sh_question`, flips the state to "waiting for you", pushes; **terminates the turn** (`control.terminate`) |
| `no_action(reason)` | Explicitly records "woke up, nothing to do" and terminates the turn |

**Proactive behavior** (§8): `create_routine`, `create_watch`, `set_followup`, `list_schedules`, `cancel_schedule`. Creating routines and watches requires `basis = user_explicit`.

**Answering workers' questions**

| Tool | Purpose |
|---|---|
| `answer_worker(workerId, text, evidence)` | The steward answers a worker's factual question itself. `evidence` must be a note ID or user message ID; without one the hook rejects it and only `ask_user` remains |

### 4.4 System prompt essentials

(The actual text is written at implementation time; these are the rules it must contain.)

1. You are Sig's steward: you never write code yourself; you only dispatch and remember.
2. Input starting with `⟦` is not something the user said — it is a system event. In event-triggered runs, **do not emit user-facing text**: call `notify_user` when the user must be notified, `no_action` when there is nothing to do.
3. Read the situation brief before every action; when routing is uncertain you must `ask_user` — never guess.
4. Reports have exactly three parts, in a fixed format, kept short.
5. The three autonomy levels (spec §6), and which matters must be put to the user.
6. The bar for taking a note: "if the steward did not know this, would it dispatch wrongly, over-ask, or misspeak?" Only then is it noted; once noted, the user is told in the report; `worker_reported` and `inferred` sources must never enter the resident layer.
7. Never conclude "this matter is finished" on the user's behalf.

## 5. The event-processing pipeline

### 5.1 Pipeline

```
events batch (protocol layer)
   │ 1. dedup and persist to the ledger, advance the watermark, reply events_ack   —— verified at the protocol layer
   ▼
reducer (deterministic, one transactionSync)
   │ 2. update worker / thread / question / timeline / report
   │ 3. recompute thread derived state, unread
   │ 4. write notification_intent and wake_request (durable queue)
   ▼
scheduler (alarm, 3-second merge window)
   ├─▶ notification intents → outbound (deterministic templates, §6)
   └─▶ wake_request → harness.submit(...) (operationId idempotent)
```

Step 4 writes "what to do" into a queue, and the alarm later picks it up and executes it. If the process crashes at any step, the queued rows are still there after restart, and execution is idempotent.

### 5.2 Thread derived state

A pure function, **recomputed after every state change, never set by the LLM or the user** (spec §5.2):

```
if any worker.state ∈ {starting, running, recovering}       → running
elif an sh_question with status=open exists                 → waiting_you
else                                                        → idle
unread = there is a report / question / error the user has not yet viewed
```

Workers in the `lost` / `broken` states do not count as running; `broken` produces a question ("how to handle it"), which flips the Thread to `waiting_you`.

### 5.3 Event rules table

| Event | Reducer action | Notification intent | Wake the steward? |
|---|---|---|---|
| `started` | worker→running | none | no |
| `progress` | Update `lastEventAt` and latest progress | none | no |
| `report` done | Record `sh_report`, timeline | **`done` report (deterministic)**, 3-second merge window | yes (normal priority; bookkeeping: summary, notes) |
| `report` blocked / needs_decision | Record the report, create an `sh_question` | Held at first — enters the **90-second window** for the steward to handle | **yes (high priority)** |
| `settled` error:auth | Create a question | Push immediately (the user must fix credentials on the machine) | yes |
| `settled` error:transient | timeline | none (the connector resumes automatically) | no |
| `settled` error:context | Create a question suggesting a fresh session | push | yes |
| `settled` error:stall | Create a question (the connector already auto-restarted once) | push | yes |
| `settled` unreported | Create a question | none | yes (the steward reads the last utterance and classifies it) |
| `lost` / `resumed` | timeline | none | no |
| `broken` | Create a question | push | yes |
| `external_activity` | timeline | none | yes (low priority; update the summary; 10-minute merge window) |
| Command `ambiguous` (§4.2/#15) | timeline note | none | yes (high priority; `ask_user` whether to re-issue; never re-send) |
| `cmd_result` failed `session_in_use` / `not_delivered` (#15) | timeline note | none | yes (high priority; tell the user; re-issue only on their confirmation) |
| Machine offline / online | Mark that machine's workers `unreachable` | Only when in-flight tasks are affected; 2-minute debounce | no |
| Stall (§8.4) | timeline | Reports once: "X has shown no activity for N minutes" | no |

> **Machine status, as implemented (issue #14).** A real disconnect marks the machine's
> in-flight workers `unreachable` — a flag alongside the execution state, so nothing
> invents a `failed`/`lost` task or discards a `running` state the connector may still honor;
> the next `hello.workers` snapshot (plus any replayed events) re-states the truth. The
> notice is a `sh_notify` intent whose `dueAt` carries the 2-minute debounce: it renders
> only if the worker is *still* unreachable when the window closes (a healed blip produces
> no notice at all, recovery included), and "X is back" follows later only when an offline
> notice was actually delivered. No wake: these are core templates, never the LLM.

**The 90-second window**: `needs_decision` / `blocked` reports go to the steward first, letting it try to answer factual questions itself per the first autonomy tier (`answer_worker`, evidence required). If the steward calls `ask_user`, `answer_worker`, or `notify_user` within the window, the report counts as handled; if the window expires with no action (LLM unavailable, budget spent, model error), the core **falls back to a deterministic push** and forwards the worker's question to the user verbatim. A pending user decision can therefore never get lost because of the LLM.

> **Implemented (issue #10).** The window is a durable deadline on the `sh_question` row
> (`fallbackDueAt`, alarm-driven `sweepQuestionFallback` — cancel-then-schedule so a new,
> earlier deadline always pulls the alarm in; the pass may run late after a DO reset, never
> early, and replays converge on one `sh_notify` intent, which the sweep drains
> unconditionally so a crash between queueing and delivery cannot strand it). Handling is
> booked as `handledAt`: `answer_worker` (relay settled) or `ask_user`/`notify_user` carrying
> the wake's `questionId` — the forwarding ask BINDS the worker's question (no second row;
> its buttons and quote-route resolve to the worker); notify_user is terminal for
> `resolution: done` / explained failures (it closes the question — an unreported run the
> steward classified as done unwedges the Thread) but keeps it open for `resolution:
> question` (prose asks), and a stale `questionId` fails the call visibly. The fallback card
> forwards the question VERBATIM (uncapped, line breaks preserved) and carries the binding,
> so the owner's quote-reply or option click relays the answer to the worker
> deterministically (`send`, after_current_tools semantics) — no LLM run at all for the
> answer; a failed relay keeps the question open and tells the owner. The deterministic relay
> applies ONLY to the quoted card's own bound question and only when the WORKER asked it
> (kind `report`): a reply to a failure/unreported card — or to a card whose question is
> already answered — is the steward's to handle (the routed-reply close still applies),
> never a relay into a broken worker or an overflowing session. `answer_worker`'s evidence
> gate lives in the `beforeTool` hook (§7.2): `note:<id>` must exist in the ledger,
> `user:<msgId>` must be a message the bound owner actually sent (card clicks count as owner
> actions); without evidence only `ask_user` remains. Failure-class questions
> (error/unreported/broken) are refused to `answer_worker` — they are the user's, not the
> worker's. One deliberate deviation from the M1 text: failure pushes and the
> broken/start-failed paths now also open an `sh_question` (the rules table's "Create a
> question"), so those Threads read `waiting_you`, not `idle`, and the hello/reap reconcile
> paths drain their pushes right at the reconnect; `unreported` still never pushes on its
> own (classification is the steward's job), and its question carries no fallback deadline —
> the push would assert a failure the last utterance may contradict.

### 5.4 Wake-up text

Multiple events within 3 seconds merge into a single wake-up. The text looks like this (kept in Chinese — it is real input data; English gloss below):

```
⟦event⟧ thread=t_8f2 「登录 bug」
- worker w_a1 (pi@mac-studio, 写任务) 报告 done：修复 token 过期后未刷新的问题
  改动：auth/session.ts 等 2 个文件；测试已通过；分支 sig/login-1，未推送
  决定：沿用 session 方案，因为……
  遗留：无
已发送给用户的通知：是（done 汇报，模板）
请做记账：更新摘要；如有值得记住的约定，走 notes_propose。无需再通知用户，除非有新的信息要补充。
```

This text is generated by the core, not by the LLM; its content comes from `sh_report` and git facts. (Gloss of the example: on thread t_8f2 「登录 bug」 ("login bug"), worker w_a1 (pi@mac-studio, write task) reports done — fixed the token-expiry-without-refresh issue; changes: 2 files including auth/session.ts, tests pass, branch sig/login-1, not pushed; decision: keep the session approach because…; leftovers: none. The user was already notified via the done-report template; the steward is asked to update the summary and to propose notes for any convention worth keeping, and not to notify the user again unless there is new information.)

## 6. Notification and outbound

### 6.1 The outbound queue

Everything sent to the user goes through `sh_outbound`; a delivery task (alarm-driven, exponential-backoff retries) calls the channel adapter. Each outbound message has a stable ID, so retries never double-send; on success the `providerMsgId` is recorded for "reply to this message → Thread" routing (§3.1).

### 6.2 Who can produce outbound messages

Only three sources:

1. **Core templates**: `done` reports, fallback pushes, stall reminders, machine status, and the notes maintenance reports (issue #19 — forgetting is reported even with no LLM and no pending conversation). Content comes from data, generated deterministically, with no dependence on the LLM.
2. **`notify_user` / `ask_user`**: explicit calls by the steward.
3. **Replies to user messages**: in runs triggered by a user message, the final text reply is sent automatically (`sh_run.kind = user`).

In runs triggered by events, routines, or follow-ups, **the steward's ordinary text output is discarded** (kept in the conversation, not sent to the user). That is the structural guarantee of "quiet by default".

### 6.3 Getting the reply

Replying to a user message requires the run's final text. `harness.wait(operationId)` returns `PiOperationResult { status, reason, text }`. The approach: when submitting a user message, write `sh_run(operationId, kind=user, replyTo=<channel message ID>, status=open)`; an alarm-driven task checks every 2 seconds while unsettled `sh_run` rows exist, and on settlement writes `sh_outbound` and marks it done. This relies on the already-verified `submit` and on `PiHarness`'s alarm heartbeat; `wait` itself has only been seen in type declarations and needs prototype validation.

> **Verified (issue #6).** Both `pending()` (lists unsettled operations) and `wait()` (resolves immediately for a settled one; `not_found` for a never-submitted one — which is exactly the crash-recovery resubmit path) behave as declared. The 2-second poll runs as the `pollRuns` alarm; user runs reply with the final text, every other kind discards it.

### 6.4 Report format and merging

`notify_user`'s parameter structure is itself the three parts (spec §7.5), plus a `tone` (success / attention / failure): **the tone is decided by the nature of the message, independent of whether needsYou is attached** — a completion that comes with minor caveats still gets the success tone, so one glance at the color tells the user whether anything went wrong (corrected after live testing in the M1 prototype).

```
conclusion   ≤ 80 chars, one sentence: succeeded or not
did[]        ≤ 4 items, each ≤ 100 chars
needsYou?    ≤ 120 chars
```

Over-length input is rejected by the tool with a demand to rewrite. The link (the Thread timeline) is appended by the system and points to a one-time-signed web URL.

Merging rules: within one channel, multiple `urgency: quiet` notifications merge into one over a 60-second window; `urgency: push` sends immediately; anything related to `waiting_you` is always `push`.

**The PR consent gate (issue #21, spike-conclusions §2):** a done report for a *write* task whose git facts say `ahead > 0 && !pushed` renders with two extra buttons — [同意] (approve) / [先不要] (not yet). Nothing is pushed without that tap (connector-pi.md §7.3 rule 4). [同意] sends the `pr_worker` command to the worker's machine; the PR URL (or the classified failure: no gh / auth / push rejected) lands back in the chat asynchronously as a deterministic card, and a failure re-arms the same button as a retry. [先不要] records the decision on `sh_pr_consent` and does nothing else. The tap resolves through the card's providerMsgId → outbound row id (`notify:report:<workerId>:<seq>`) — never data stuffed into the button (§3.1).

### 6.5 User views and unread

Opening a Thread on the web, or replying to its report, clears `unread`. A card button click counts as both read and one reply.

## 7. Making autonomy concrete

### 7.1 Basis in tool parameters

Every side-effecting tool carries a `basis` describing what authorizes the steward's action:

| `basis` | Meaning |
|---|---|
| `user_explicit` | The user explicitly asked for this |
| `user_reply_to` | The user replied to / clicked a specific message or button |
| `memory` | Based on a preference or convention in the notes (`evidence` is a note ID) |
| `routine` / `followup` / `watch` | From a proactive task the user created earlier (`provenance` is its ID) |
| `inferred` | Inferred by the steward itself |

### 7.2 Policy hooks

The `beforeTool` hook (pi-durable's `hook(ToolTask, { beforeTool })`) consults the table below before a tool runs; returning `{ block: "reason" }` lets the model see the rejection reason:

| Action | Allowed `basis` | Extra conditions |
|---|---|---|
| `start_worker` | all | `provenance` required; `inferred` not allowed when the repo or machine is ambiguous (multiple candidates) |
| `send_to_worker` | all | Not allowed when routing confidence is low |
| `interrupt_worker` | `user_explicit`, `user_reply_to` | spec §6: an interrupt must first ask the user or follow an explicit instruction |
| `answer_worker` | `memory`, `user_explicit` | `evidence` required |
| `create_routine` / `create_watch` | `user_explicit` | Must reference the user message that created it |
| `resume_worker` | all | Auto-resume of the same worker ≤ 2 times per hour (consistent with the connector) |
| Scope expansion (dispatching beyond what the user literally said) | none | Always diverted to `ask_user` |

The `provenance` rule (spec §8.3): in event-triggered runs, calling `start_worker`/`send_to_worker` requires a `provenance` that is an existing routine, follow-up, or watch ID, or a user message ID; an empty value is always rejected. This makes it impossible for the steward to decide to act "out of thin air".

> **Implemented boundary (issue #9):** `send_to_worker` and `interrupt_worker` share the `start_worker` provenance rule: event-triggered runs need a verified `user:<msgId>` ref (PR #45 review round 1: `basis` labels are model-claimed, and an abort is at least as destructive as a steer — stopping follows an explicit instruction or a verifiable reference to one; routine/follow-up refs landed with #20, below.) The `beforeTool` hook additionally gates `interrupt_worker` to `basis ∈ {user_explicit, user_reply_to}` — anything else (e.g. `memory`) is blocked with a reason the model sees. The tools' replies state the delivery computed from the ledger at enqueue time; the connector's `cmd_result` — which the tools do not await, keeping delivery latency off the model's critical path — settles the outbox row, and failures land on the timeline deterministically. A `broken` worker is refused before the enqueue so the model cannot claim a delivery the connector is guaranteed to reject; the residual gap (a cmd_result that fails after an honest enqueue-time reply) is accepted: the failure is recorded, and re-issuing is the user's call.

> **Implemented boundary (issue #6, PR #40 review #4; extended by #20):** in event/routine/follow-up-triggered runs the `start_worker` tool requires an explicit `provenanceRef`; `user:<msgId>` values are verified against `sh_inbound` (a message this deployment actually received), `routine:<id>` / `followup:<id>` against their ledger rows **and their liveness** (active; a done once-routine or freshly fired follow-up authorizes only while its fire is fresh — paused/cancelled are the owner's revocation), anything else — including the wake's own `evt:` id — is refused at the tool.

The autonomy switch (cautious / balanced / hands-off) = three settings of this policy table; the MVP implements only "balanced", and the table structure leaves room for swapping in the others.

## 8. Proactive behavior

### 8.1 Data

```
sh_routine(routineId, createdFromMsg NOT NULL, schedule(cron|once), instruction,
           repoId?, threadId?, enabled, lastRunAt, lastResult)
sh_watch(watchId, createdFromMsg NOT NULL, kind, spec, actionPolicy, enabled)   -- MVP: definition only; event sources wired up later
sh_followup(followupId, threadId, dueAt, reason, createdBy: user|steward, sourceRef, status)
```

A non-null `createdFromMsg` is the data-layer guarantee of the spec's rule that "every proactive behavior must have provenance".

### 8.2 Routines

- Creation: the user says 「每个工作日早上 9 点……」 ("every workday at 9 a.m., …"); the steward repeats it back, confirms, then calls `create_routine`.
- Triggering: via the Agents SDK's `this.schedule(cron, "fireRoutine", { routineId })` (cron scheduling is idempotent). On fire, the core submits `⟦routine R⟧ <instruction>` with `operationId = routine:<id>:<fireTime>`, so duplicate fires are never processed twice.

> **Implemented (issue #20).** `fireTime` is the fire's scheduled second (the SDK hands the callback the due time, not the next occurrence), and `sh_routine.lastFireKey` gates the whole fire — an SDK re-dispatch after a handler error is a no-op for both digests and instruction wakes. Digest routines never reach the LLM at all (spike-conclusions §2 wins over the design's blanket "submit ⟦routine⟧"): the core renders running/waiting/unread into one card, stays silent when there is nothing to say, and only `instruction` routines queue a wake. Suggestions send a button card whose tap creates the routine deterministically (`sh_routine_offer`, resolved via the card's providerMsgId); `create_routine` refuses to run outside a user message. Every fire leaves `lastResult` and a timeline entry (thread-less when the routine has no Thread — `sh_timeline.threadId` is nullable since #20).
- The steward executes per the instruction with `provenance = routine:<id>`; if there is nothing to do, `no_action`.

### 8.3 Follow-ups (setting an alarm for yourself)

`set_followup(threadId, after, reason)`: writes `sh_followup` and calls `schedule`. When due, it submits `⟦followup F⟧`. The steward can use it to "take another look at that task in two hours". When the creator is the steward, `sourceRef` must point to the user message or routine that triggered it.

### 8.4 Stall detection

Every running worker gets an alarm at `lastEventAt + 20 minutes` (configurable). Every arriving event rewrites that time. If the alarm fires and the worker still has no events → the core emits one stall notification (template) and writes a timeline entry; a given stall notifies only once, and the timer resets once the worker emits again. `progress` events are already throttled on the connector side, so 20 straight minutes of total silence means the agent is stuck in a very long tool call or the process is dead — worth a nudge.

### 8.5 Suggesting new routines

When the steward notices a repeating pattern (e.g. being asked to check something every week), it may **suggest** creating a routine: it only sends the suggestion with a button; `create_routine` is called only after the user confirms (`user_reply_to`).

### 8.6 Default to doing nothing

The default conclusion after a wake-up is `no_action`. Every proactive wake-up should leave an auditable result: `sh_routine.lastResult`, a timeline entry.

## 9. Channels: Feishu

### 9.0 Onboarding and event transport (based on the [Feishu research](../research/feishu-channel.md); corrected against live tests on 2026-10-14)

- **Creation**: after deployment, the DO calls Feishu's app-registration device flow (`POST accounts.feishu.cn/oauth/v1/app/registration`, `action=begin`, `archetype=PersonalAgent`) and shows the returned QR-code link on the settings page; the DO uses the alarm to poll `action=poll` at the `interval`, and on success obtains the `client_id`, `client_secret`, and the `open_id` of the user who scanned (switching to the international domain to continue when `tenant_brand=lark`). Credentials are stored encrypted, and the `open_id` serves directly as the owner. In live testing the link is valid for 1 hour and is one-time. Manually filling in the App ID and App Secret is the fallback.
- **Inbound transport has two implementations**, selected by the adapter's configuration:
  1. `Webhook` (**MVP default**, verified working): Feishu POSTs events to `https://<custom domain>/channels/feishu/events`; the DO sleeps entirely and is woken only when events arrive; the implementation is just an HTTP endpoint plus signature verification. Switching requires: granting the `application:application:patch` scope via a scan → config PATCH (Feishu automatically performs URL verification) → **republishing the version in the console** (live testing shows the API `publish` cannot replace this step). Mainland-China users must use a custom domain (`*.workers.dev` is unreachable even from Feishu's servers, verified in testing).
  2. `LongConnection` (alternative): the DO connects as a client to Feishu's long connection (protobuf frames, shard reassembly, ping, ack frames); it needs no console operations and no public address, but an outbound WebSocket cannot sleep (the DO stays permanently awake), and the implementation effort is large.
- On mainland networks `*.workers.dev` is unavailable; both the user reaching the web app and connectors reaching the steward need a custom domain (or a proxy); see spec §12.

### 9.1 Inbound

- Path: `POST /channels/feishu/events` (handled by the Agent's `onRequest`). Verify that the event's `token` field matches the stored verification token (in webhook mode the event body carries a `token`; card callbacks have a separate `token`), handle the URL-verification handshake (`url_verification` echoes the `challenge`), and — following OpenClaw's practice — reject requests whose timestamps deviate too far. **Persist first, then return 200.**
- Dedup: `sh_inbound(msgId)` as primary key; duplicate events simply return 200. Feishu retries events, so this must be idempotent.
- Identity: only the owner's **direct messages** are processed. The owner's `open_id` is recorded at first scan binding; every other source is ignored and logged.
- Content: text, quotes (parent message ID, used for §3.1 routing), and images. The adapter downloads images via the Feishu API, scales them to within the protocol's per-message limit (protocol doc §6.2), and submits them as `images`.
- Submit: `harness.submit(text, { operationId: "user:" + msgId })`, plus a row in `sh_run`.
- Card button callbacks: converted into structured input carrying `threadId`, with `basis = user_reply_to`.

### 9.2 Outbound

- The access token (`tenant_access_token`) is cached and refreshed by an alarm.
- Sends text or cards; respects length and rate limits; failures retry via §6.1.
- `notify_user` renders as a card: the conclusion in bold, a bullet list, and buttons when a user decision is needed (options from `ask_user.options`).

### 9.3 Adapter interface

Channels are replaceable:

```ts
interface ChannelAdapter {
  verifyAndParse(req: Request): Promise<InboundEvent | Response>;   // verification, handshake, dedup key
  send(out: OutboundMessage): Promise<{ providerMsgId: string }>;
  fetchAttachment(ref: AttachmentRef): Promise<Uint8Array>;
}
```

Feishu is the first implementation. "QR-code creation", "long connection vs webhook", and "cards, callbacks, rate limits, and message length" are already covered by [research](../research/feishu-channel.md); of these, the 5 QPS per user and the 30 KB serialized-message cap are folded into §6. Still-unverified points (whether a QR-created app can switch to webhook, whether a publish review is required, the stability of a DO-hosted long connection, and Feishu-to-Worker reachability) are listed in section 6 of the research doc.

## 10. The web read model

The web app is the workspace (spec §7.3, [ADR-0004](../adr/0004-web-workspace.md)): the owner's conversation, the Threads and the decisions waiting for them, drawn from one snapshot (`workspace.ts`, assembled over the memory module's `views.workspace`) and kept current by a nudge — every ledger write tells connected workspaces to refetch, and the words of a reply being written follow over pi's event stream (`workspace-stream.ts`, the one place that touches that experimental API):

| Surface | Source |
|---|---|
| Conversation | `sh_inbound` (the owner's words) + `sh_outbound` (the steward's) on the one local channel; credentials are `private` and never listed |
| Needs you | Open cards: `questions` / `offers` / `offlineDispatches` / `notes.askOpen` / `prConsent`, decided per card kind by `cardOpen` |
| Thread details | `views.workspace`: workers (git facts, PR consent), latest 40 timeline entries |
| Machines | Protocol-layer devices + `sh_machine` (slots, agents, repos) |
| Raw transcripts | Relayed from the protocol's `history`; not stored in the DO |
| Machines dialog | `/app/api/machines/revoke` (the workspace API) |
| Memory page, routine list | Later phase |

Owner actions come in over `/app/api` (session cookie + CSRF token + same origin + JSON): a message, a card button, "read", logout. Each carries a client request id (`sh_web_request`; the run is `user:web:<id>`), so a retry is one effect. A button is validated against the card's own buttons and its decision must still be open; it then enters the same handlers an owner API action does — the workspace and `GET /api/messages` are two views of the one local channel (ADR-0003).

Password or passkey sign-in opens the browser session; explicit-key deployments can still exchange a legacy one-time link. See [ADR-0010](../adr/0010-browser-password-authentication.md) and [web-entry.md](web-entry.md). Write operations issued from the web are likewise logged to `sh_note_log` / audit, keeping "forgetting and changes visible to the user".

## 11. Consistency and idempotency

There is no cross-store transaction between the two stores (our tables and pi-durable's tables), so we rely on **idempotency keys** and a **durable queue**:

| Scenario | Idempotency key | Behavior after a crash |
|---|---|---|
| Feishu event retry | `sh_inbound.msgId`, `operationId=user:<msgId>` | Duplicate events dropped |
| Connector event retransmission | `(workerId, seq)`, `operationId=evt:<batch>` | Verified: 3 retransmissions still produce only 1 steward input |
| Steward tool replay | `cmdId = tool:<taskId>` | `unsafe` tools do not re-run; the replay yields the same command ID |
| Crash between reducer and wake | `wake_request` persisted, `operationId` idempotent | Resumes from the queue after restart |
| Outbound retry | `sh_outbound.id` | Each entry is sent only once; `providerMsgId` recorded on success |
| Workspace message / card tap retry | `sh_web_request.id` (client request id), `operationId=user:web:<id>` | Same payload = same effect; a different payload under the same id is refused (409) |
| Duplicate routine fire | `routine:<id>:<fireTime>` | Deduplicated |

Note that pi-durable's `submit` returns only after the submission succeeds. If a crash happens between "queue row written" and "`submit` called", the row is still pending and will be submitted again; the `operationId` guarantees no duplication.

## 12. Cost and degradation

| Lever | Approach |
|---|---|
| Call the LLM less | Wake only for user messages, events needing judgment, routines, and follow-ups; `progress` never wakes; 3-second merge window; `external_activity` 10-minute window |
| Use fewer tokens | The situation brief has a character budget; hard caps of 2,400 characters (resident layer) and 1,500 (project layer); 600-character Thread summaries |
| Cheap model for routine events | Later, model choice per input type (strong model for user messages, cheap model for event bookkeeping). One model in the MVP |
| Budget cap | A soft daily budget: past it, events no longer wake the steward, while `done` reports and fallback pushes continue; user messages are still processed, with the budget state noted |

> **Implemented (issue #28).** `vars.DAILY_BUDGET_USD` (root wrangler.jsonc, default $1, `0` = owner messages only) is the cap; the day is the UTC calendar date and the counter is `sh_usage_day`, fed from pi.usage deltas (`sh_usage_cursor` is the single high-water mark over the session-wide total; a never-seen cursor baselines instead of charging, so an upgrade's history is never billed to "today"). Nothing meters in the background, on purpose — a pi commit listener can only be attached from `conversationCreated`, which never fires for the root of a restarted isolate, and a listener beside the sweep double-charges — so the counter is brought current exactly where a decision reads it: the wake drain (before the gate), run settlement (before the over-budget note), and the spend readout, all through one serialized sync. The gate sits in the wake drain — the single choke point every event/routine/follow-up input passes — and skips are auditable (`sh_channel_log`, and `lastResult` + a timeline entry for routine/follow-up fires, §8.6). The "noted once" line rides exactly one owner reply per capped day (marked only after the reply row is durably enqueued, same discipline as the notes relay), and the spend question is answered deterministically from the counter (`/花费` + whole-message natural forms in budget.ts) — no tool, no prompt change, no model call, so the routing-eval-gated surfaces (§3.4, ADR-0001 decision 14) stay untouched. A wording the matcher misses falls through to the model, which cannot see the counter — `/花费` is the guaranteed path; widening the surface (a `budget_status` tool + prompt line) is deliberately deferred until the eval has a valid in-tree baseline to re-run against.
| Works without the LLM | Core templates guarantee that `done` reports, the `needs_decision` fallback, stall reminders, and machine status can always be sent |

## 13. Depended-on APIs and verification status

Legend: ✓ verified in the protocol spike; ◦ seen only in docs or type declarations; ? unverified.

| Dependency | Status |
|---|---|
| `PiHarness.submit(text, { operationId, whenBusy })` idempotent | ✓ |
| Event-triggered `submit` resumes via alarm after the DO is reset | ✓ |
| `PiHarness.pending()`, `messages()` | ✓ |
| `PiHarness.wait(operationId)` returns the final text | ✓ (issue #6: pending/wait/not_found all exercised by tests) |
| `defineTool`, `section`, `hook(ToolTask, beforeTool)` in extensions | ✓ (issue #6: the sig-steward extension is built on them) |
| `api.taskId` inside tools is stable across replays and usable as an idempotency key | ✓ (issue #6: `cmdId = "tool:" + api.taskId`; replays converge on the existing outbox row) |
| The `beforeRequest` hook replaces only the single request and persists nothing | ✓ (issue #6: verified by test — see §4.1) |
| A tool result's `control.terminate` ends the turn | ✓ (issue #6: ask_user / no_action terminate) |
| `input` with a custom `entry` (distinguishing user vs event) | ? `pi-durable@1.1.0` types disallow it, the repo README allows it; `PiHarness.submit` does not expose it. The MVP uses content markers (§4.2) |
| DO SQLite supports FTS5 and JSON functions | ✓ (issue #7): the trigram tokenizer works in workerd and node:sqlite; the sh_thread_fts triggers (insert / title-goal-summary update / delete / report insert) keep the index current — verified by probe and `test/schema.test.ts` (migration 010). ✓ (issue #18): external-content FTS5 with the `trigram` tokenizer verified by test in workerd — insert/update/delete triggers stay in sync, CJK substring `MATCH` works; the default unicode61 tokenizer would have collapsed Chinese sentences into single tokens |
| `ctx.storage.transactionSync` | ◦ (DO storage API) |
| `this.schedule(cron, ...)` idempotent | ✓ (issue #20: cron dedups by expression+payload, one-shots opt in with `idempotent: true`; verified by tests incl. lost-schedule reconciliation). ✓ (issue #19): the daily notes-maintenance cron reuses it — arming at every `onStart` dedups onto the same row (restarts never postpone or stack it), replacing #18's 24h one-shot chain |
| Feishu: QR-code creation (`registerApp` device flow) | ◦ official SDK source; no live scan performed |
| Feishu: long-connection protocol, message send / reply / card update, rate limits and lengths | ◦ official SDK source and comments; not exercised live |
| Feishu: switching a QR-created app to webhook, publish review, personal-account limits, long-connection stability inside the DO | ? unverified; see [feishu-channel.md](../research/feishu-channel.md) §6 |

## 14. MVP scope and milestones

| Milestone | Contents | How it is verified |
|---|---|---|
| M1 Ledger and core | Table schemas, reducer, derived state, outbound queue, core-template reports, Feishu send/receive (no LLM; dispatch triggered by fixed command phrases) | Unit tests + joint debugging with a mock connector against the protocol spike |
| M2 Steward and routing | `PiHarness` steward, tools, policy hooks, `find_threads`, situation-brief injection, `ask_user`, reply retrieval | The routing evaluation set (§3.4) |
| M3 Notes and forgetting | Two-phase note writes, layering, ChangeReport, maintenance | Unit tests for note capacity, conflicts, and demotion; manual review |
| M4 Proactive behavior | Routines, follow-ups, stall detection, the 90-second-window fallback | Fault injection: LLM failure, DO reset |
| M5 Web | Timeline, memory page, machine management, password/passkey login | Manual |

Not included: multi-tenancy, event sources (GitHub, CI, etc.), voice, the autonomy switch, cheap-model routing, vector retrieval.

## 15. Pending decisions

1. **Whether `beforeRequest` can append the situation brief to the single request only.** **Resolved (issue #6):** yes, verified — see §4.1. The input-prefix fallback stays unused.
2. **Distinguishing events from user messages.** Content markers work but are fragile (what if `⟦` happens to appear in a user message): escape the marker characters in user text on inbound (`⟦`→`〔`, `⟧`→`〕`, implemented in issue #6). Once pi-durable is upgraded to a version supporting `input.entry`, switch to structured entries.
3. **The length of the 90-second window**, and the share of questions the steward answers itself within it, need real usage data.
4. **Whether 2,400 characters (resident layer) and 1,500 (project layer)** are right depends on what notes actually look like.
5. **Approximating a note's "use" by "assembled into context" for `lastUsedAt`** may overcount; later, the steward could annotate which notes a reply cited.
6. **The summary rebuild frequency** (every 10 updates) is a guess.
7. **When Thread counts grow**, the recall strategy of `findCandidates` (add vectors or add tiering).
8. **Feishu integration's** unverified items (see research §6), plus WeCom. Hosting the long connection inside the DO means the DO stays permanently awake: duration billing still falls within the included allowance, but "sleeping costs almost nothing" no longer holds, and this must be stated in the cost notes.
9. **Simultaneous reports from multiple Threads**: how to merge them into one message that stays short without losing any matter's three parts needs to be tried on real cards.
10. **The user-viewed-a-Thread signal**: how to capture it reliably (web open, reply, button) for clearing unread.
11. **Budget and usage metering**: the pi-durable `pi.usage` docs, and how the steward's daily usage is aggregated. **Resolved (issue #28):** `pi.usage` is cumulative per session (failed attempts and compaction included), so the daily counter charges the growth of that total against a stored high-water cursor — brought current at the wake drain, run settlement, and the spend readout by one serialized sync.
