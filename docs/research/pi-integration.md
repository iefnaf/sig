# pi Integration Research

Date: 2026-10-14. Subject: pi's RPC mode (`pi --mode rpc`), the first agent the Shepherd connector drives.

Evidence falls into three classes:

- **Measured**: run locally with pi 1.2.0 and the default model `zhipu/glm-5.3`; scripts at `spike-final:spikes/pi-rpc`. Small samples — most things ran once.
- **Source/docs**: read from the `earendil-works/pi` repo (`packages/coding-agent`); not measured.
- **Unverified**: see the last section.

## 1. Integration options

| Option | Shape | Verdict |
|---|---|---|
| `pi --print` / `--mode json` | one-shot process | wrong for a flow that needs interruption and continuation |
| **`pi --mode rpc`** | resident child process; JSONL commands on stdin, responses and events on stdout | **adopted** |
| SDK (`createAgentSession`) | in-process | no process isolation; sessions share the process and the default file-based settings and credentials; the docs recommend RPC for isolated setups. Not adopted |

RPC demands strict LF framing (not a reader split on Unicode line separators), protocol records only on stdout (logs go to stderr), and the client must keep draining stdout or it stalls on backpressure.

## 2. Measured results

| # | Finding | Experiment |
|---|---|---|
| 1 | `--extension <path>` injects an extension per process; the agent can call the injected `report` tool and structured parameters round-trip intact | A |
| 2 | `steer` does not interrupt a running tool — it takes effect only after the current tool batch finishes (a steer sent during `sleep 8` changed behavior only after the sleep); `follow_up` is processed after everything ends | B |
| 3 | `abort` responds in ~3 ms, kills bash subprocesses, emits `agent_settled{aborted:true}`, and the process accepts new commands afterwards | E |
| 4 | After SIGKILL on pi the session is already on disk; starting a new process with `--session` reads the conversation back; a dangling tool call at the end (call without result) does not impede continuation | C |
| 5 | After SIGKILL on the connector, pi and its `sleep` subprocesses all exit within 2 seconds — no orphans | H |
| 6 | 5 concurrent pi processes: ready in ~350 ms; ~135 MB RSS idle, ~153 MB after a small task; sharing one session directory causes no conflicts (one file each) | G |
| 7 | `new_session`, `switch_session`, `fork` work; `new_session` produces a new sessionId and file | F |
| 8 | `get_entries` on a tiny session (9 entries) is already ~15 KB (system prompt included); the `limit` parameter is ignored | F |
| 9 | Image input: a base64 PNG is accepted and stored verbatim; a 256x256 solid-red image is answered "Red". A 16x16 image gets an off-topic answer — a model-side issue | J |
| 10 | Without a UI, project-local `.pi/` extensions do **not** run by default — no confirmation prompt, no `extension_ui_request`; add `--approve` to run them; `--no-approve` matches the default. **`AGENTS.md` loads regardless of trust** | L |
| 11 | `report` call rate: tool description alone gets 5/6 (another round 3/4); adding an `agent_before_settle` hook that forces one final attempt gets 6/6, with 1 rescued by the hook and no duplicate calls | I, spike3 |
| 12 | With no extension injected and the model asking a question in plain text, the protocol carries only `agent_settled` and the final text — no "asking" signal | I |
| 13 | A model call failure (403) produces **no error event** — only `stopReason:"error"` and `errorMessage` on the last assistant message | A |
| 14 | A very small task: ~55–76 KB of stdout, 49–90 `message_update` records | I |
| 15 | **After SIGKILL on pi itself, tool subprocesses it started (`sleep 33`) stay alive** (still there 6 seconds later) as orphans. Contrast with #5: when the connector is killed, pi exits gracefully on stdin close and cleans up its children; kill pi directly and it can't | K |
| 16 | `--tools read,grep,find,ls,report` restricts the agent to read-only: asked to create a file, it has no tool for that, says so honestly, and calls `report` to flag the blockage; the file is not created; injected extension tools can appear in the `--tools` whitelist too | M |

## 3. Source and docs findings (not measured)

**RpcClient** (`src/modes/rpc/rpc-client.ts`): exported from the main entry, but it hardcodes the command as `spawn("node", [cliPath, ...])` with `cliPath` defaulting to `dist/cli.js` — it cannot launch an installed `pi` binary directly; stderr accumulates without bound; no auto-restart after a crash (you must `stop()` then `start()`); `stop()` clears pending requests without rejecting them. Whether `@earendil-works/pi-coding-agent` is published to npm is unclear from the repo.

**Command set** (`rpc-types.ts`): `prompt{message, images?, streamingBehavior?}`, `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`, `get_entries{since?}`, `get_tree`, `get_fork_messages`, `get_last_assistant_text`, `get_session_stats`, `switch_session`, `fork`, `clone`, `set_model`, `set_thinking_level`, `compact`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `set_session_name`, `get_commands`, and more.

**Sessions**:
- Stored at `~/.pi/agent/sessions/--<cwd path escaped>--/<timestamp>_<sessionId>.jsonl`; the first JSONL line is a header, the rest are tree entries with `id/parentId` (`message`, `model_change`, `compaction`, `custom`, `custom_message`, …).
- `--session <path|id>`: treated as a path if it contains `/` or ends with `.jsonl`; otherwise matched by ID or ID prefix in the current project, then globally.
- `--session-id <id>`: opens or creates with an exact ID in the current project; allowed characters are letters, digits, `.`, `_`, `-`, with letters/digits at both ends.
- **No file locking**; writes are plain appends; two processes opening the same session file is undefined behavior.
- Sessions are readable without starting an agent: `SessionManager.list/open` static methods, or parse the JSONL directly.
- `get_entries`'s `since` (everything after a given entry) is the only incremental read; the other read commands have no pagination or filtering.

**Events**: after `agent_end` there may still be retries, compaction, or queued messages — **the true end is `agent_settled`**. Retry events are `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}` and `auto_retry_end{success,attempt,finalError?}` with a default of at most 3 retries. There is no dedicated "run failed" flag.

**Extension hooks**: `agent_before_settle` is "the last operable boundary" — it can return `{entries:[custom_message...], continue:true}` to append entries and force one more model request; the docs warn you must guard against loops. `agent_settled` is notification-only. Extensions run in-process with full OS permissions and can write files.

**System prompt**: `--system-prompt` replaces, `--append-system-prompt` appends (repeatable); extensions may modify it in `before_agent_start`.

**Shutdown**: stdin close → dispose → `abortBash()`, `agent.abort()` → `killProcessTree`. `SIGTERM/SIGHUP` additionally clean up detached subprocesses. bash subprocesses start with `detached: true`, so **a SIGKILL on pi itself leaves them unreaped** (not measured).

**Trust** (`src/core/project-trust.ts`): without a UI `hasUI=false` and nothing blocks. Order: `--approve/--no-approve` → trusted if no protected resources → `project_trust` event from user-level extensions → the most recent record in `~/.pi/agent/trust.json` → the `defaultProjectTrust` setting → otherwise untrusted. Protected resources are `.pi/`'s `settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`, plus `.agents/skills`. `AGENTS.md` and `CLAUDE.md` are not protected.

**Usage**: `get_session_stats` returns `tokens{input,output,cacheRead,cacheWrite,total}`, `cost`, call counts, and `contextUsage`; every assistant message carries `usage`.

**Images**: `images` on `prompt/steer/follow_up` is `{type:"image", data(base64), mimeType}`; no size limit found at the RPC layer; the `read` tool scales to 2000x2000 px / 4.5 MB base64 by default — whether prompt images get the same scaling is unconfirmed; RPC does not support `@file`.

**Existing integrations in the repo**: no ready-made remote orchestration or web UI. `packages/env` (remote tool execution over SSH) and `packages/chord` (multi-process observable state) are relevant building blocks.

## 4. Constraints on the design

1. The connector writes its own thin RPC client; don't use `RpcClient`.
2. "Done / blocked / needs a decision" comes from the `report` tool plus an `agent_before_settle` hook forcing one final attempt; keep the plain-text fallback classification for questions.
3. Failure detection must check the last assistant message's `stopReason` and `auto_retry_end` — watching only `agent_end` or `agent_settled` reads failures as completions.
4. One session file, one pi process at a time — the connector guarantees it. `--session-id <workerId>` works.
5. Default to `--no-approve`; use `--approve` only for repos the user has explicitly trusted. `AGENTS.md` is always loaded — it's a prompt-injection surface.
6. Cap concurrent workers per machine (~150 MB each). A pi crash leaves orphaned tool processes — the connector needs process-group tracking and startup cleanup. Read-only tasks use the `--tools` whitelist.
7. Compress raw events in the connector before reporting up; pull the L3 raw transcript on demand via `get_entries since` or by reading the JSONL.
8. "Stop now" goes through `abort` plus continuation; "change direction" goes through `steer` — but it waits for the current tool to finish.

## 5. Unverified

- `report` call rates and hook behavior on other models (Claude, GPT, …).
- Memory growth over hours-long runs; the effect of mid-run compaction on the event stream.
- Real-world behavior of `get_entries since`, `--session-id`, and `auto_retry` events.
- pi process and connector connection behavior across machine sleep/wake.
- Conflicts between instructions in `AGENTS.md` and the `report` convention when an extension is injected.
