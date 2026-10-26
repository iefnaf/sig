# Design: the protocol between the connector and the steward (Durable Object)

Status: draft v0.1. Based on: [product spec](../spec.md), [connector–pi integration design](connector-pi.md), [Cloudflare DO WebSocket research](../research/cloudflare-do-websocket.md).

This document defines the **transport, authentication, pairing, reliable delivery, and message formats** between the connector (a daemon on the user's machine) and the steward (a Cloudflare Durable Object). The semantics of commands and events come from [connector-pi.md](connector-pi.md); this document specifies only how they travel over the wire. How the steward side processes events, updates memory, and notifies the user is designed in a separate document.

## 1. Goals and non-goals

Goals:

1. The connector needs only **outbound** connections — no public address, port forwarding, or tunnels.
2. Commands and events are both **delivered at least once and processed idempotently**; nothing is lost or duplicated across disconnects, sleep, or restarts.
3. The steward DO can sleep: keep-alive costs almost nothing, and the DO is not woken while a machine is quiet.
4. Pairing is simple, credentials can be revoked per machine, and a stolen credential has a bounded blast radius.
5. The protocol can evolve: version negotiation, and clear rules for handling unknown messages.
6. The same transport also carries the streaming relay for on-demand reads of raw transcripts.

Non-goals (MVP): multi-tenancy; end-to-end encryption (between connector and browser); connector-to-connector communication; binary encoding (JSON is used).

## 2. Overall shape

```
 Feishu / web ─────────────┐
                           ▼
Connector A ──wss──▶  Worker (entry, pre-check)──▶  Sig DO (singleton "owner")
Connector B ──wss──▶                                     ├─ connection management (tags: connector / web)
                                                         ├─ outbox: commands pending delivery
                                                         ├─ event_inbox: received events
                                                         └─ memory module, the steward's pi-durable tasks
```

- One connector per machine, **one WebSocket per connector**, initiated by the connector.
- The DO is a singleton (fixed instance name, e.g. `owner`); all connectors and all browser connections land on this one instance.
- A single Agent class serves both connector connections and browser connections, telling the roles apart with a **connection tag** and restricting the message types each role may send (§5.1).

## 3. Transport

### 3.1 Connection

```
wss://<worker-host>/agents/sig/owner?role=connector&proto=1
Authorization: Bearer <device token>
```

- The token goes in a request header, not the URL, so it never lands in access logs. The connector is a Node client and can set request headers.
- The role is declared with a query parameter and used only for routing and tagging; **whether the role is legitimate is decided by the token** — the parameter is not trusted.
- For connector connections, the SDK's default protocol frames are turned off (`shouldSendProtocolMessages` returns `false`); otherwise every connection would receive frames unrelated to this protocol.
- A machine may have only one active connection at a time (§3.4).

### 3.2 Keep-alive and sleep

- The connector sends a WebSocket protocol-level `ping` frame every **25 seconds**; if no `pong` arrives within 60 seconds it treats the link as dead and reconnects. The runtime auto-replies `pong` and **does not wake a sleeping DO** — near-zero cost.
- *(Superseded by [ADR-0001](../adr/0001-mvp-implementation-baseline.md): the e2e spike hit half-dead TCP, so the real implementation uses a bidirectional application-level heartbeat — uplink ping, downlink pong, inter-frame timeout forcing reconnect — and `hello` also re-delivers `failed(timeout)` commands, deduplicated by `cmdId`.)* Original text: there is no periodic application-level heartbeat. The DO judges "is the machine online" purely by whether a connection exists; for half-open connections the DO probes only when needed: after sending a command to a machine it sets an ack deadline (§4.2), and on timeout marks the machine suspect.
- The DO sleeps after roughly 10 seconds without events. **Sleeping wipes memory**, so all protocol state (unacked commands, timeouts, retries) lives in SQLite and is driven by `this.schedule` (alarms), with no reliance on in-memory Promises or timers.
- Measured ([spike results](../research/do-protocol-spike.md)): with a protocol-level ping every 5 seconds, the DO sleeps as usual, the connection stays up, and the wake count does not grow; the first message after a sleep costs only about 35–50 ms more. The connector need not do anything to "keep the DO online".

### 3.3 Reconnection

Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at 60 s; reset after a successful connection and completed handshake. The close code decides whether to reconnect (§3.5): authorization-related close codes do not reconnect.

### 3.4 Single-connection constraint

Every connection carries a `connEpoch` (a counter the connector increments and persists before establishing each connection). For each `deviceId` the DO keeps only the connection with the largest `connEpoch`: once a new connection is established, the old one is closed with `4409 superseded`. This resolves the race where the old and new connections overlap during a network switch.

### 3.5 Close codes

| Code | Meaning | Connector behavior |
|---|---|---|
| 1000 / 1001 | Normal close, service restart | Reconnect |
| 4401 | Token invalid or missing | Do not reconnect; prompt for re-pairing |
| 4403 | Device has been revoked | Do not reconnect; clear local credentials and notify the user |
| 4409 | Superseded by a new connection from the same device | Do not reconnect (the new connection already exists) |
| 4426 | Protocol version not accepted | Do not reconnect; prompt to upgrade the connector |
| 4429 | Rate limited | Reconnect after backing off per `retryAfterMs` |
| 4500 | Server internal error | Reconnect |

### 3.6 Message size and batching

- A single JSON message is capped at **256 KiB**. The server-side receive limit is 32 MiB, but a SQLite row is only 2 MB and large messages slow JSON parsing; every chunk is far below this.
- Events are sent in batches: the connector accumulates **250 ms** or **50 items** or **64 KiB**, whichever comes first. WebSocket messages are billed as requests at 20:1, so batching is mainly about waking the DO less often, not about saving money.
- Regenerable `progress` events are coalesced on the connector side (see connector-pi.md §11.2) and are not amplified by batching.

## 4. Envelope and reliability

### 4.1 Envelope

All messages are JSON objects:

```json
{ "t": "cmd", "id": "01J…", "re": null, "ts": 1791965696285, "...": "payload" }
```

| Field | Meaning |
|---|---|
| `t` | Message type, see §6 |
| `id` | Message ID (ULID). Required on any message that needs an ack or a reply |
| `re` | ID of the message this replies to; only present on reply-type messages |
| `ts` | Sender clock, milliseconds; **diagnostics only — not used for ordering or dedup** |

Unknown `t`: if the message carries `"opt": true` it is ignored; otherwise the reply is `error{code:"unsupported"}`. Unknown fields are always ignored.

### 4.2 Command flow (DO → connector): at-least-once, connector dedups

The DO's `outbox` table:

```
outbox(cmdId PK, deviceId, workerId?, cseq, kind, payload, notAfter?,
       state: queued|sent|accepted|done|failed|expired|ambiguous,
       attempts, sentAt, ackDeadline, result?)
```

- `cseq` is a monotonically increasing sequence number on the device; **commands for the same `workerId` are processed in `cseq` order**, while different workers may run in parallel.
- A command is first written to `outbox` (state `queued`), then sent (marked `sent`), with an `ackDeadline` of 15 seconds.
- On receiving one, the connector persists it first (the `command` table, connector-pi.md §6.3), then replies `cmd_ack`. `cmd_ack` means only **received and persisted**:
  - `status: "accepted"`: a new command, queued for processing.
  - `status: "duplicate"`: seen before, with the original result attached (if already completed).
  - `status: "rejected"`: rejected, with a `code` (e.g. `not_registered_repo`, `lock_held`, `capacity`); the DO marks it `failed`.
- When the command completes, the connector sends `cmd_result{ok, data | error}` and the DO marks it `done` or `failed`. `cmd_result` may equally be duplicated; the DO handles it idempotently by `cmdId`.
- **Re-send**: after a reconnect (once `welcome` is done), the DO re-sends every command that is `sent` but not `accepted`; when the `ackDeadline` expires while the connection is still up, it re-sends once more — after two failures it marks the machine suspect and notifies the steward.
- **The alarm handler must re-schedule itself.** `schedule()` has whole-second granularity, so an alarm may fire a few hundred milliseconds before the millisecond-precision `ackDeadline`; if the handler wakes, finds no due rows, and returns, there will be no further alarm and the command stays in `sent` forever. Rule: before the handler finishes, as long as any row is still `sent`, schedule one more alarm (about 1 second out). This is a defect found during spike testing.
- **Expiry**: a command may carry `notAfter`. If it is already expired when the connector receives it, it replies `rejected{code:"expired"}`. The default is `notAfter = 下发时刻 + 10 分钟` (issuance time + 10 minutes), so a machine that was offline for a day does not suddenly execute stale instructions; commands where the user explicitly chose "wait for it to come online" are set to `null` (no expiry).
- **Ambiguous state**: a command during whose `sending` phase the connector crashed is reported by the connector as `ambiguous` during reconciliation (connector-pi.md §6.3); the DO marks the `outbox` row `ambiguous` and hands it to the steward — **no automatic re-send**. *(Implemented by #15: "hands it to the steward" is a high-priority ⟦event⟧ wake instructing the LLM to `ask_user` — the row is never redelivered, the connector answers later re-deliveries `ambiguous`, and the wake lands once per `cmdId`. `hello.pendingAcks` may equally carry `done`/`failed` for commands the connector *resolved* from session-tail evidence before its first hello — the DO settles those rows from the snapshot the same way, and a `failed` entry carries the recovered error `code` (e.g. `not_delivered`) so the steward can surface it without a `cmd_result`.)*

### 4.3 Event flow (connector → DO): at-least-once, DO dedups

- Each worker's events carry a monotonically increasing `seq` (connector-pi.md §11.3).
- The connector sends `events` batches; the DO **writes them to `event_inbox` (unique on `(workerId, seq)`) before acking**. `events_ack{workerId, upTo}` is a cumulative ack meaning all events `≤ upTo` are persisted. The DO coalesces acks over 500 ms.
- Only after receiving an ack may the connector truncate its local log. **`welcome.acks` is equivalent to `events_ack`**: after a reconnect it decides where replay starts, and the acknowledged portion is truncated at the same time — otherwise the log only ever grows.
- **Gap detection**: when the DO receives a `seq` greater than `已收最大值 + 1` (max received + 1), it sends `resync{workerId, from}`; the connector replays from `from`. If the local log has already been dropped due to the size cap, it replies `events_gap{workerId, from, to}`, and the DO marks the gap on the timeline and triggers `reconcile`.
- **Processing decoupled from persistence**: `event_inbox` records "received"; the steward processes events (updating threads, notifying the user) bounded by `processed_upto(workerId)`. If the DO is evicted mid-processing, it resumes from `processed_upto` next time, and the processing itself is idempotent per `(workerId, seq)`.

### 4.4 Why not exactly-once

Both ends can crash at any moment; exactly-once is unattainable. The trade-off: **commands are delivered at least once, deduplicated by the connector on `cmdId`, and in undecidable cases the connector reports `ambiguous` rather than re-sending**; events are at-least-once, deduplicated on `(workerId, seq)`. The result is semantically equal to exactly-once, and every crash scenario has a well-defined outcome.

## 5. Authentication and pairing

### 5.1 Device token

The token is issued by the DO at pairing time, in the format:

```
st1.<keyId>.<deviceId>.<epoch>.<issuedAt>.<mac>
mac   = HMAC-SHA256(key.secret, "st1." + keyId + "." + deviceId + "." + epoch + "." + issuedAt)
keyId = first 8 hex chars of SHA-256("sig:keyid:v1:" + key.secret)
```

- Fresh deployments generate a random signing key inside the owner Durable Object; existing explicit-key deployments use the `SERVER_KEY` Worker secret and optional `SERVER_KEY_PREVIOUS` rotation window. The verifier accepts tokens signed by either configured explicit key. Tokens minted before the `keyId` segment existed (`st1.<deviceId>.<epoch>.<issuedAt>.<mac>`) are tried against every configured key.
- **Worker-layer pre-check** (explicit-key deployments only; does not wake the DO): validates the format and `mac`, returning 401 outright on failure. Generated-key deployments cannot expose their key to the Worker, so their DO performs the only token check.
- **DO-layer check** (always): validates the token against the deployment key set, then consults the `device` table and confirms the device exists, its `epoch` matches the current one, and it has not been revoked; otherwise it closes with `4401` / `4403`.
- Revocation = increment the device's `epoch` and close its connection; every previously issued token becomes invalid at once, so there is no blacklist to maintain.
- The token is a **bearer token**: whoever steals it can impersonate the device. Mitigations: transport is TLS-only; it is stored locally with `0600` permissions; revocation is cheap; it can later be upgraded to a device key pair with a signed challenge — the protocol already reserves room for that (the `hello.auth` extension field).

#### SERVER_KEY rotation procedure (no re-pairing)

The `keyId` segment plus the `SERVER_KEY_PREVIOUS` window make the key rotatable without invalidating paired machines:

1. `wrangler secret put SERVER_KEY_PREVIOUS` — paste the **old** `SERVER_KEY`.
2. `wrangler secret put SERVER_KEY` — paste the **new** key (generate e.g. with `openssl rand -hex 32`).
3. `wrangler deploy` — a resident isolate pins the secrets it started with (spike-conclusions §3), so redeploy to evict it.
4. Wait for every machine to reconnect once. Each `welcome` on a connection authenticated with the previous key carries a rekeyed `token` (§6.1) minted under the new key; the connector persists it and uses it for every future reconnect. Sealed secrets (Feishu/model credentials) are re-sealed under the new key on their next read.
5. `wrangler secret delete SERVER_KEY_PREVIOUS` + `wrangler deploy` — close the window. Machines that never reconnected during the window (or that keep a pre-`keyId` token) fail auth with `4401` and must re-pair; sealed secrets that were never re-read re-open as unconfigured and accept fresh credentials via the setup flow.

Leaving `SERVER_KEY_PREVIOUS` unset at step 1 (rotating "cold") is the same as jumping straight to step 5: every existing token and sealed secret becomes invalid.

### 5.2 Pairing flow

```
User (Feishu/web)                                  DO                                          Connector (user's machine)
   │ "添加机器" ("add machine")                    │                                           │
   │──────────────────────────────────────────────▶│ create pairing{code, 10min}               │
   │◀── command hint ──────────────────────────────│                                           │
   │  npx @alexlikevibe/sig connect <url> <code>                                                          │
   │ ………… 在目标机器终端粘贴运行 ("paste & run on the target machine") ……………………………………………………………▶│
   │                                               │◀── POST /pair {code, machine}─────────────│
   │                                               │ validate code: exists, unexpired, unused  │
   │                                               │ create device, issue token                │
   │                                               │─── {deviceId, token, wsUrl} ─────────────▶│ save credentials 0600
   │                                               │◀──────── wss connect + hello ─────────────│
   │◀ "mac-studio 已连接" ("mac-studio connected")─│                                           │
```

- Pairing code: 8 characters of Crockford Base32 (40 bits), **valid only for the 10 minutes after the user initiates "add machine", single-use**.
- `/pair` is one of the Worker's public entry points (the login page, authentication endpoints, and static sign-in assets are the others). Rate limits: both per source IP and globally there is a cap on failures (e.g. locked for 15 minutes after 5 failures); the code's entropy plus the short validity window makes brute-force enumeration infeasible.
- Pairing happens exactly once; after that the connector uses only the token. The connector stores `{serverUrl, deviceId, token}`, and once the server address has been written, **downgrading to non-TLS is not allowed** (local development excepted).
- The command hint is sent to the user by the steward in chat, and the user runs it on the computer being enrolled, because pairing must be completed by the machine's owner on that machine.

### 5.3 Roles and permissions

| Role | How it is identified | May send | May receive |
|---|---|---|---|
| `connector` | Valid token | `hello`, `cmd_ack`, `cmd_result`, `events`, `history_chunk`, `error` | `welcome`, `cmd`, `events_ack`, `resync`, `history_req`, etc. |
| `web` | A password/passkey browser session (or a legacy one-time link on an explicit-key deployment) | `subscribe`, `history_open`, `worker_cmd` (§6.8, only for a `workerId` currently subscribed), and other browser-type messages | State pushes, history chunks |

A connector connection sending browser-type messages, or a browser connection sending connector-type messages, always gets `error{code:"forbidden"}` back and the violation is counted; repeated violations may get the connection closed. `worker_cmd` for a `workerId` the connection has not subscribed to is likewise `forbidden` — see §6.8.

### 5.4 Trust in commands

- The connector accepts commands only on **its own authenticated connection**.
- Worker commands still require a locally registered repository. The owner requests registration only through **Add directory** on the authenticated web machine page, which sends `register_repo{path}`. The connector persists the directory's canonical identity and detects, opportunistically, whether it is a Git repository (issue #88) — Git is a capability, not a registration requirement. The model has no registration tool.
- Web registration trusts the steward to convey owner authorization, so it replaces the former guarantee against whitelist expansion by a compromised steward. `approveProject` and write policy remain settable only on the machine (connector-pi.md §8.1, §8.2, §13).

## 6. Message catalog

### 6.1 Handshake

**`hello`** (connector → DO, first message after connecting)

```json
{
  "t": "hello", "id": "...",
  "protocol": { "min": 1, "max": 1 },
  "deviceId": "dev_…", "bootId": "…", "connEpoch": 42,
  "connector": { "version": "0.1.0", "os": "darwin", "arch": "arm64", "node": "22.13.0" },
  "machine": { "name": "mac-studio", "memTotalMB": 65536, "memFreeMB": 31000 },
  "agents": [ { "kind": "pi", "version": "1.2.0", "capabilities": { "steer": true, "followUp": true, "interrupt": true, "resume": true, "history": true, "images": true, "structuredReport": true, "readonly": true } } ],
  "repos": [ { "repoId": "…", "name": "sig", "path": "/Users/x/code/sig", "defaultBranch": "main", "remote": "git@github.com:…", "capability": { "kind": "git", "gitRoot": "/Users/x/code/sig", "defaultBranch": "main", "remote": "git@github.com:…" } } ],
  "limits": { "maxWorkers": 4, "running": 1 },
  "workers": [ { "workerId": "w…", "agent": "pi", "state": "idle", "lastSeq": 128, "sessionId": "…", "lastOutcome": "reported:done" } ],
  "pendingAcks": [ { "cmdId": "…", "state": "done" } ]
}
```

- `bootId`: randomly generated at each start of the connector process. The DO uses it to tell "reconnect after a network blip" (same `bootId`) from "connector restart" (new `bootId`; all pi processes exited in between).
- `workers` is a full snapshot from the connector's point of view, used for reconciliation.
- `repos[].capability` (issue #88): `{kind:"git", gitRoot, defaultBranch, remote}` or `{kind:"plain"}`. Optional on the wire — absent on a connector build that predates it, in which case the repo is a Git repository (no earlier connector could register anything else) and `defaultBranch`/`remote` carry the same facts the deprecated flat fields always have.

**`welcome`** (DO → connector)

```json
{
  "t": "welcome", "re": "<hello.id>",
  "protocol": 1, "serverTime": 1791965696285, "sessionId": "…",
  "acks": { "w…": 126 },
  "limits": { "maxMessageBytes": 262144, "batchMs": 250, "batchEvents": 50 },
  "token": "st1.<keyId>.<deviceId>.<epoch>.<issuedAt>.<mac>"
}
```

- `acks`: the highest `seq` per worker already persisted by the DO. The connector replays from after it.
- `token`: present only during a `SERVER_KEY` rotation window (§5.1), when the connection authenticated with a non-primary key. The connector persists it and uses it for future reconnects; absent on normal welcomes.
- Failed negotiation: `4426`, with the supported version range given in the close reason.

The DO then re-sends the unacknowledged commands in `outbox` (§4.2).

### 6.2 Commands (DO → connector)

Common envelope:

```json
{ "t": "cmd", "id": "<cmdId>", "cseq": 118, "kind": "start_worker",
  "workerId": "w…", "notAfter": 1791966296285, "args": { … } }
```

| `kind` | `args` | Notes |
|---|---|---|
| `register_repo` | `path` | Authenticated owner web action. Registers any existing directory and returns its canonical identity plus detected Git capability. No project approval or write-policy changes. |
| `start_worker` | `threadId, repoId, mode, base?, prompt, images?, model?` | Maps to connector-pi.md §6.1; `repoId` must be in the connector's whitelist |
| `send` | `text, images?, intent` | `intent: now \| after \| auto` |
| `interrupt` | `then?: { text }` | Abort, optionally followed by one new instruction |
| `resume` | `reason` | |
| `stop_process` | none | |
| `cleanup_worktree` | `force?` | |
| `reconcile` | none | Ask for a fresh `hello.workers` snapshot |
| `pr_worker` | `workerId, title?, body?` | The PR consent gate (issue #21): push the branch + `gh pr create` in the worktree; result arrives as `pr_created`/`pr_failed` events |
| `diag` | none | Ask for diagnostic information |

Images ride base64-encoded in `images` and must fit, together with the whole command, within 256 KiB (about 190 KB of image bytes). Anything larger is compressed on the steward side before dispatch (downscaled or converted to JPEG); if it still does not fit, the command is rejected and the user is told. Ways to pass larger images: open question 3 in §8; not implemented in the MVP.

### 6.3 Command ack and result (connector → DO)

```json
{ "t": "cmd_ack", "re": "<cmdId>", "status": "accepted" }
{ "t": "cmd_ack", "re": "<cmdId>", "status": "duplicate", "result": { "ok": true, "data": { } } }
{ "t": "cmd_ack", "re": "<cmdId>", "status": "rejected", "code": "not_registered_repo" }
{ "t": "cmd_result", "re": "<cmdId>", "ok": true, "data": { "sessionId": "…", "branch": "sig/login-1", "effect": "after_current_tools" } }
{ "t": "cmd_result", "re": "<cmdId>", "ok": false, "error": { "code": "lock_held", "message": "…", "retriable": false } }
```

The `cmd_result` for `start_worker` is sent once the worker enters `running` (it does not wait for the task to finish); task progress and completion travel on the event stream.

A successful `register_repo` returns `{ repo: { repoId, name, path, defaultBranch, remote } }` after local persistence. The DO accepts the result only from the target machine and records that one repository before reporting success to the web. Duplicate terminal results do not re-add a directory that a newer `hello` removed. A full `hello` remains the reconciliation path for all machine repositories.

The web submits `{ id, deviceId, path }` to `POST /app/api/machines/directories`. Repeating the same request reads its durable state. Reusing an id with a different machine or path returns a conflict. New requests require an online machine and expire after two minutes. An elapsed deadline with no confirmed result is an unknown outcome, so the owner can check the directory list or repeat registration safely. Old connectors return `unsupported_command`, which the web presents as an update instruction.

### 6.4 Events (connector → DO)

```json
{ "t": "events", "id": "…", "batch": [
  { "workerId": "w…", "seq": 129, "ts": 1791965700000, "type": "progress", "phase": "tool", "tool": "edit", "target": "auth/session.ts", "turn": 3 },
  { "workerId": "w…", "seq": 130, "ts": 1791965712000, "type": "report", "status": "done", "summary": "…", "changes": ["…"], "git": { "branch": "sig/login-1", "ahead": 2, "dirty": 0, "pushed": false } },
  { "workerId": "w…", "seq": 131, "ts": 1791965712500, "type": "settled", "outcome": "reported", "usage": { "tokens": { "input": 2317, "output": 101 }, "cost": 0.004 } }
] }
```

Event types and payloads are in connector-pi.md §11.1 and are not repeated here. `events_ack{workerId, upTo}` is the ack in the opposite direction. `resync` and `events_gap` are covered in §4.3.

### 6.5 Machine status

`hello` supplies the full machine and repository snapshot on each connection. During a connection, repository registration comes only from the owner's web **Add directory** action. A successful `register_repo` result updates the DO's repository inventory before the web reports success (§6.3), without a reconnect.

`hello` remains the full reconciliation path, including repository removals. There is no separate live machine-status update message. Live resource telemetry is outside the current protocol.

### 6.6 History (raw transcript) relay

When the web wants to view a worker's raw transcript, the DO acts as a **relay** and stores no content.

1. The browser connection sends `history_open{workerId, since?, maxBytes}`.
2. The DO writes `relay(reqId, webConnId, workerId, expiresAt)` and sends `history_req` to the connector (same envelope as `cmd`, `kind:"history"`, but it does not enter `outbox` and is not re-sent).
3. The connector returns a number of `history_chunk` messages:

```json
{ "t": "history_chunk", "re": "<reqId>", "n": 0, "entries": [ { "role": "assistant", "text": "…", "tools": [ ] } ], "cursor": "e91…", "done": false }
```

4. The DO looks up `relay` to find the corresponding browser connection and forwards; only after the browser's ack (`history_ack{reqId, n}`) does it tell the connector to send the next chunk (simple window control, window size 2).
5. Termination: `done: true`, the browser closing the connection, timeout (60 seconds), or the cumulative total exceeding `maxBytes` (default 2 MB).

Constraints:

- Each chunk ≤ 256 KiB.
- `relay` lives in SQLite, because the DO may sleep between chunks.
- Content **passes through DO memory but is never written to disk**. Logs record no content.
- If the machine is offline, the DO returns `machine_offline` to the browser directly.

### 6.7 Errors

```json
{ "t": "error", "re": "<msgId>", "code": "forbidden", "message": "…", "retriable": false }
```

Values for `code`: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `busy`, `expired`, `unsupported`, `too_large`, `rate_limited`, `internal`.

### 6.8 Direct worker commands (web → DO → connector, no steward step)

[ADR-0011](../adr/0011-direct-worker-chat-from-session-view.md): a browser that already has a worker session's view open can act on it directly, without routing through Sig's conversation. v1 scope is `send` and `interrupt` — the two kinds that already have a deterministic, LLM-free dispatch path (`Dispatcher.sendToWorker`/`interruptWorker`). `resume` and `stop_process` are not reachable this way yet; see ADR-0011 decision 1.

**`subscribe`** (web → DO): declares which worker's session view is open. Required before `worker_cmd`; tracked on the connection itself (lost on disconnect or hibernation, never inferred from any other state).

```json
{ "t": "subscribe", "workerId": "w…" }
```

**`unsubscribe`** (web → DO): ends it (closing the session view, or switching to another worker before re-subscribing).

```json
{ "t": "unsubscribe" }
```

**`worker_cmd`** (web → DO → connector):

```json
{ "t": "worker_cmd", "id": "<sh_web_request>", "workerId": "w…", "kind": "send", "args": { "text": "也把 lint 跑一下" } }
```

- `kind ∈ {send, interrupt}`. `args` has the same shape as the corresponding `cmd.args` (§6.2). Anything requiring project/account-level trust (`start_worker`, `register_repo`, `pr_worker`, …) is not reachable this way — those stay steward- or owner-web-page-only.
- **Subscription-gated, not client-asserted.** The DO accepts `worker_cmd` only when the connection's own `subscribe` state names that exact `workerId`. No subscription, a mismatched one, or one since dropped (tab closed, unsubscribed, DO restarted and not yet re-subscribed): `error{code:"forbidden"}`. This is what makes "the UI already picked the target" an enforced property rather than a convention.
- **Dispatch**: the DO calls `Dispatcher.sendToWorker`/`interruptWorker` with `provenance: "web_direct"` and `cmdId: id` — the same methods and the same `outbox` write (§4.2) a steward tool call would produce, so the resulting `cmd` the connector receives is indistinguishable from a steward-issued one.
- **Idempotency**: `id` is the caller's `sh_web_request` (ADR-0004 decision 3), reused directly as `cmdId`; a retry under the same id is one effect, matching every other owner-web mutation. This is the one path where `cmdId` does not originate from a steward tool-call id (§7.1).
- **Recording, not waking**: `sendToWorker`/`interruptWorker` already add a Thread timeline entry as part of normal dispatch; the `web_direct` provenance is what lets Sig tell, next time it reasons about that Thread, that this one did not come from its own tool call. Sig is not woken synchronously. Sig learns the outcome the ordinary way — the worker's resulting `progress`/`report`/`settled` events flow back through §4.3 and wake Sig under the existing rules, regardless of who issued the command.
- A `refused` outcome from the `Dispatcher` (unknown/broken worker, empty text) never reaches `outbox`, so the DO answers with `error` directly instead of waiting for a `cmd_ack` that will never come.
- Otherwise, `cmd_ack`/`cmd_result` follow §6.3 exactly and are relayed verbatim to the subscribed browser connection once the connector answers — the DO does not fabricate an optimistic ack.

## 7. Key flows

### 7.1 Dispatching a task

```
Steward task (pi-durable)      DO outbox/protocol layer        Connector                     pi
   │ dispatch(start)           │                               │                             │
   │──────────────────────────▶│ write outbox(queued)          │                             │
   │                           │ cmd{start_worker}────────────▶│ persist to command table    │
   │                           │◀──── cmd_ack(accepted) ───────│ create worktree, start pi ─▶│
   │                           │◀──── cmd_result(ok) ──────────│ send prompt                 │
   │◀─ wake steward (result) ──│ mark outbox done              │                             │
   │                           │◀── events(progress…) ─────────│◀──── event stream ──────────│
   │                           │ write event_inbox, events_ack │                             │
   │                           │◀── events(report, settled)                                  │
   │◀─ wake steward (report) ──│                               │                             │
```

Idempotency key: the steward's tool invocation takes `cmdId` from the tool-call ID (or `requestId`); replaying the same invocation after a crash yields the same `cmdId`, and `outbox`'s primary key guarantees no second command is created (in concert with pi-durable's `requestId` idempotency mechanism). A `worker_cmd` sent directly from an open session view (§6.8) takes `cmdId` from the browser's `sh_web_request` instead — same guarantee, different source.

### 7.2 Disconnect, reconnect, and replay

```
connection drops ─▶ connector reconnects with backoff ─▶ wss + token ─▶ hello(workers, each lastSeq, pendingAcks)
                                                                        │
                    DO: validate, supersede old connection ◀────────────┘
                    DO ─▶ welcome(acks) ─▶ connector replays events after acks
                    DO ─▶ re-send outbox commands that are sent but not accepted
                    Connector: reply cmd_ack(duplicate) for already-processed commands
```

### 7.3 Dispatching commands while a machine is offline

> **As implemented (issue #14, PR #51).** The offline ask parks the whole dispatch: the
> worker row (a plain `starting` — #13's sweepWorkers owns its closure), the outbox command
> (`held` — deliver refuses it, and its enqueue arms the lapse alarm), and the card
> (`offline:<cmdId>` outbound id, so a tap resolves to exactly that command, never the
> Thread's latest worker). [wait] clears the hold (`notAfter = null`, delivered at the next
> hello with a deterministic "started" notice); [switch] expires the held command and
> re-dispatches over the same deterministic rule — to the unique alternative, or a machine
> picker when several; with no alternative the original stays held. An unanswered ask lapses
> with its `notAfter` (default 10 minutes): sweepIdle marks the command `failed/not_after`
> (the user-withdrawal state `expired` stays reserved for cancel/switch, per #13) and
> sweepWorkers closes the worker with a failure push — nothing wedges. A waited command
> keeps the queue's 30-minute idle bound, closed the same way with a「排队超时」push. A
> continuation to the Thread's remembered machine now asks the same way instead of silently
> queueing (spec §9 "never decide silently" supersedes the spike's bug-4 behavior).

- The DO finds the machine has no active connection: the command is written to `outbox` (`queued`) and "machine offline" is returned to the steward immediately; the steward asks the user "wait for it to come online, or switch to another machine" (spec §9).
- User picks "wait": the command's `notAfter` is set to `null`; it is delivered automatically after `welcome` once the machine comes online.
- User picks "switch": the command is marked `expired` and a new command is created for another machine.

### 7.4 Interruption

The `interrupt` command travels through `outbox` like any other command, with no priority lane. `abort` itself is a millisecond-scale operation; the network round trip is the dominant latency. If the connector has several queued commands, `interrupt` still executes in `cseq` order within its worker's queue, but **on receiving `interrupt` the connector should immediately run `abort` for that worker**, treating `send` commands queued ahead of it whose delivery has not started as superseded (returning `result{ok:false, code:"superseded"}`).

## 8. Open questions

1. ~~**Mechanism for waking the steward.**~~ **Resolved (verified in the spike).** After events are committed to storage, call `harness.submit(text, { operationId: "evt:<workerId>:<seq>", whenBusy: "followUp" })` for each event that needs the steward. The `operationId` makes replay and retransmission idempotent (send the same event batch 3 times and the steward still gets only 1 input); `PiHarness` maintains an alarm heartbeat job per session, so after the DO is force-reset no request is needed — the alarm restarts itself and carries on. The same applies to `cmd_result`. The only remaining question is "which events are worth waking for" (item 2). Note: `submit` must be called after the events are committed and acked; if a crash happens in between, `processed_upto` triggers reprocessing, and `operationId` guarantees no duplication.
2. **Throttling event processing.** Waking the steward for every `events` batch keeps the DO constantly awake. Leaning toward: `progress` is only committed, no wake; only `report/settled/lost/error/external_activity` wake processing.
3. **Passing large images**: connector-pi.md allows a single image up to 4 MB base64, beyond this protocol's 256 KiB per-message cap. Options: compress on the steward side to fit within the cap (the MVP approach); stage in R2 first with the command carrying only a reference, the connector downloading over a signed URL (inside Cloudflare, can ship with the one-click deploy); or the connector uploading separately over HTTP in chunks. Leaning toward R2 staging later.
4. **Interest-driven progress levels.** Silent by default (`coarse`); when the user opens a worker in the web UI, raise the frequency via `set_progress{workerId, level:"live"}` and restore it when they leave. This reduces wake-ups while nobody is watching. This command needs to be added to the command set.
5. **Device key pairs** (Ed25519 signing challenge): when to replace bearer tokens; `hello.auth` already reserves the room.
6. ~~**The `web` role's session.**~~ **Resolved:** password/passkey login creates the same database-backed session as the legacy one-time link path; see [ADR-0010](../adr/0010-browser-password-authentication.md).
7. **Load isolation between browser and connector connections inside one DO**: as message types multiply, whether to split into two Agent classes sharing one SQLite (not feasible — different DOs do not share storage); hence the lean toward keeping one class and dispatching by role.
8. **Clocks**: `ts` is diagnostics only. `notAfter` depends on the offset between the connector clock and the DO clock; `welcome.serverTime` can let the connector compute the offset and correct locally.

## 9. Points requiring spike validation

Verified ([spike results](../research/do-protocol-spike.md)):

- Protocol-level `ping` neither wakes the DO nor prevents sleep; the first message after a wake costs only about 35–50 ms more.
- Alarm-driven re-send during sleep is reliable (including re-scheduling when the alarm fires before the deadline).
- The HMAC pre-check with the Worker secret in `onBeforeConnect`: bad tokens do not wake the DO.
- Custom close codes 4403 and 4409 arrive unchanged at Node's `ws` client.
- Command re-send plus connector dedup: executed exactly once.
- Event replay: 120 events after a disconnect, each stored once; `welcome.acks` triggers truncation.
- Offline-queued commands are delivered after `hello`.
- Events wake the steward idempotently via `harness.submit`; after the DO is force-reset the alarm carries on by itself.

Not yet verified:

1. How quickly half-open connections are noticed after laptop sleep or a network switch (this machine sits behind a proxy and cannot stand in for a real link).
2. End-to-end behavior when the connector is killed during the `sending` phase (the spike's mock connector did not implement that phase).
3. The real wake-up frequency and duration cost of event batching; bills need checking in the console.
4. History relay behavior across DO sleep gaps (driven by the `relay` table); not implemented in the spike.
5. Stability with messages close to 256 KiB, several connectors in parallel, and multi-hour long-lived connections.
6. The impact of in-flight I/O on how long the DO stays resident while real model calls are in progress.
7. Recovery behavior under real evictions other than `ctx.abort()` (platform migration, memory reclamation).
