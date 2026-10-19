# Web entry and the session viewer

Status: implemented ([ADR-0005](../adr/0005-web-entry-and-local-sessions.md), on the owner API of [ADR-0003](../adr/0003-owner-api-replaces-chat-channel.md) — the device-first claim variant was rejected as [ADR-0006](../adr/0006-device-first-claim-rejected.md)). This is how it is built; the decisions and their reasons are in the ADRs, the operator's steps in [deploy.md](../deploy.md).

## Doors

`apps/steward/src/index.ts` is the whole public surface. Anything not listed here is `404`:

| Path | Who | Checked by |
| --- | --- | --- |
| `/app`, `/app/*` (pages, `/app/api/*`, `/app/assets/*`) | the owner's browser | the application session cookie (HMAC at the Worker, liveness in the Durable Object); without it: the sign-in page, which has no input |
| `/app/ws` (WebSocket) | the owner's browser | a well-formed application session cookie at the Worker; session liveness in the Durable Object |
| `/api/*` (POST/GET) | the owner (scripts, agents) | the `SERVER_KEY` bearer at the Worker — [ADR-0003](../adr/0003-owner-api-replaces-chat-channel.md)'s four routes only |
| `/pair` (POST) | machines | the one-time pairing code minted via `POST /api/pairing`, brute-force guarded |
| `/link/<token>` (GET) | a browser with the link | the token's HMAC at the Worker; single-use in the Durable Object |
| `/agents/steward/owner` (WebSocket) | a paired machine | the per-machine device token at the Worker pre-check (`onBeforeConnect`); a browser socket instead presents the session cookie with `role=web` |

The Worker rewrites the workspace's socket (`/app/ws`) onto the Agents SDK route with an explicit `role=web` and re-checks the cookie there; machine sockets authenticate with device tokens. The doors are pinned by `test/routes-audit.test.ts`: nothing beyond `POST /pair` and the two brand assets answers without credentials.

### Keys and the application session

Everything is signed by the deploy-time `SERVER_KEY` (`SERVER_KEY_PREVIOUS` keeps a rotation window open, issue #27): device tokens, session cookies, one-time links, the sealed model key. The application session (`sh_web_session`) carries the CSRF token and the logout. It is opened only by consuming a one-time link (`openLink`) — minted by `POST /api/login-link` (the owner's SERVER_KEY) or attached to a report card's 查看详情 button; the browser that opens it gets the session cookie. Every mutation needs the CSRF header, a non-cross-origin `Origin` and a JSON body. Logout deletes the session, closes the sockets it opened, and the page returns to the sign-in page, which names the one way in.

### The owner

The owner is whoever holds `SERVER_KEY` (ADR-0003): no owner row, no messaging identity. Legacy rows from a deployment that had a Feishu owner keep their old `receiveId` values; new outbound rows address the constant owner id.

## Owner workflow without Feishu

- **Settings** (`/app/api/settings`, `/app/api/settings/model`): the model selection (`apiKey` is a boolean — the key is never returned). Saving re-seals the key under `SERVER_KEY`.
- **Pairing** (`/app/api/pairing`): mints a one-time code (10 minutes) keyed by the client's request id, so a retry gets the same code, and returns the full `npx @iefnaf/sig connect <origin> <code>` command. It is shown only in the machines panel, never in the conversation feed (`private: true` on the outbound row).
- **Revoke** (`/app/api/machines/revoke`): bumps the device epoch and closes the connection with `4403`.
- **First run**: the page asks for settings (a model key) and then a machine, one notice at a time.
- **Reports, questions and decisions** are outbound rows on the one local channel (ADR-0003: the row settles with `providerMsgId` = row id; `GET /api/messages` reads the same rows back). The workspace derives its structured view (tone, title, body, note) from the message templates' own markers — the leading 【Thread】 prefix and tone emoji — so the API's flat text and the workspace's cards can never disagree. They exist whether or not a browser is connected; a connected one is nudged. Detail links are not generated inside the workspace: it is the page.

## Session content

### Reading (connector)

`apps/connector/src/full-session-history.ts` reads one worker's own session file — `worker.sessionFile` for pi, `claudeSessionPath` for Claude Code (Claude's `~/.claude/projects/<cwd, non-alphanumerics as "-">/<uuid>.jsonl`, falling back to a search by the worker's session UUID when the folder name differs) — as JSON lines, **without parsing them**. One line is one record; a record is sent as fragments of its text (`HistoryEntry.fragment = { data, offset, total }`, `role: "record"`, ≤ 24 K characters each, never splitting a surrogate pair), each carrying `nextCursor`. A page ends when its byte budget is spent (`done: false`, the chunk marked `truncated`), at the end of the file, or at a last line still being written (no newline yet — returned whole on the next read).

The cursor is opaque (`full.<base64url>`): byte offset of the line, how far into it, a hash of the line when resuming mid-record, and the file's inode. A cursor that no longer fits — replaced file, shorter file, a record that changed under the reader — is refused (`cursor_invalid`), never spliced. A missing file is `no_history` ("does not exist (yet)" before the first read, "is gone" after one); a file that cannot be a record store is the same. The browser names a worker, never a path; a Claude session id must be a UUID.

The transport is the existing history relay (protocol §6.6) with one new field, `format: "full"`, on `history_open` / `history_req` / `history_chunk`. Summary reads (the old raw-process page, older machines) are unchanged and carry no format. The relay still only forwards: chunks pass through memory, `history_relay` rows hold ids and byte meters.

### Showing (browser)

`ui/session-model.js` (pure) reassembles fragments (`createAssembler`: contiguous offsets or the stream is refused, and a read that resumes mid-entry continues where it stopped), reads a record into display blocks (`describeRecord`: pi's `message`/`toolResult`/`bashExecution`/system/compaction/branch-summary/model/custom entries, Claude Code's `user`/`assistant`/`tool_use`/`tool_result`/`thinking`/`system`/`summary`; anything else is a `raw` block), pairs tool calls with their results, and finds pi's current branch (`branchOf`: only when some entry has two children is anything marked "other branch").

`ui/session.js` draws it: the latest 200 entries first and earlier ones on request (scroll anchored), long text clipped with "Show all", tool details built only when opened, images only for png/jpeg/gif/webp base64, everything through `h()` text nodes. It reads in short streams over one socket (`1 MiB` pages, continued at once when a page was cut, up to 64 MB before it asks), follows a working agent every three seconds while the tab is visible, resumes after a drop from its cursor, and says which of these it is in: connecting, loading, following live, up to date, more available, machine offline, nothing recorded yet / record missing, disconnected, error.

| Situation | What the owner sees |
| --- | --- |
| Agent running, connector online | The record so far, then new entries as they are written |
| Agent finished, connector online | The retained file, up to date |
| Connector disconnects mid-read | What was loaded stays; "Connection lost. Reconnecting…"; resumes without duplicates |
| Machine offline when opened | "That machine is offline…", with Retry; Thread summaries and reports still there |
| No file yet (agent just started) | "Nothing has been recorded yet" — follows once it appears |
| File deleted | "No local record… may have been deleted" |
| File replaced under the reader | The view restarts from the beginning (at most three times) |
| Connector older than full reads | Such a connector ignores `format: "full"` and answers with the old summary pages, which carry no `format`; the viewer says "too old… run `sig upgrade`" (with Retry) instead of drawing them |

## Tests

`vitest.config.ts` runs the whole suite against the production entry with the test bindings (`SERVER_KEY` et al.). `scripts/test-groups.mjs` parallelizes the files. The connector and protocol suites cover the reader and the schemas; `ui-session.test.ts` covers the browser model, `ui-modules.test.ts` the shipped files.
