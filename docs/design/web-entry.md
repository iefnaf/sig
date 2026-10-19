# Web entry and the session viewer

Status: implemented ([ADR-0003](../adr/0003-web-entry-local-sessions.md), auth reshaped by [ADR-0004](../adr/0004-device-first-claim.md)). This is how it is built; the decisions and their reasons are in the ADRs, the operator's steps in [deploy.md](../deploy.md).

## Doors

`apps/steward/src/index.ts` is the whole public surface. Anything not listed here is `404`:

| Path | Who | Checked by |
| --- | --- | --- |
| `/app`, `/app/*` (pages, `/app/api/*`, `/app/assets/*`) | the owner's browser | the application session cookie (HMAC at the Worker, liveness in the Durable Object); without it: the sign-in page, which has no input |
| `/app/ws` (WebSocket) | the owner's browser | a well-formed application session cookie at the Worker; session liveness in the Durable Object |
| `/pair` (POST) | the first machine (claim) | the SHA-256 of `SHEPHERD_CLAIM_SECRET`, a secret only writable through the Cloudflare API; redeem is once-only |
| `/pair` (POST) | further machines | the one-time pairing code from the workspace, brute-force guarded |
| `/login` (POST) | a paired machine | the per-machine device token; mints a one-time browser sign-in link |
| `/link/<token>` (GET) | a browser with the link | the token's HMAC at the Worker; single-use in the Durable Object |
| `/agents/steward/owner` (WebSocket) | a paired machine | the per-machine device token (`role=connector` is the only role it accepts) |
| `/`, `/setup` | anyone | redirect (`303`) to `/app` |

The Worker rewrites both sockets onto the Agents SDK route with an explicit `role` (`web` or `connector`) and never lets a client choose its own: `/agents/steward/owner?role=web` is refused, and ordinary HTTP or SDK RPC traffic cannot reach the Agent router at all.

### Claiming and the auth root (`auth-root.ts`, ADR-0004)

The Durable Object generates a random secret on first boot and keeps it in its own storage (`ensureAuthRoot`). It is the primary of the key set `serverKeys()` returns — everything the deploy-time `SERVER_KEY` used to sign (device tokens, session cookies, one-time links, the claim proof comparisons' sibling material) — with a still-set legacy `SERVER_KEY` (and `SERVER_KEY_PREVIOUS`) kept in the set so pre-upgrade credentials survive the upgrade. Nothing secret is typed at deploy time.

`shepherd connect <url>` (no pairing code) claims: Wrangler's OAuth authorizes `account:read` + `workers_scripts:write`, the CLI resolves the exact Worker behind the URL through the Cloudflare API, writes a random `SHEPHERD_CLAIM_SECRET` as that Worker's secret (only the account's managers can), and POSTs its SHA-256 to `/pair`. The Worker hashes its own `SHEPHERD_CLAIM_SECRET` and compares (length-independent, so nothing leaks byte-by-byte); `redeemClaim` then spends the claim in one transaction (the `sh_claim` row plus the device row) — a replayed proof finds the deployment already claimed.

### The application session

The application session (`sh_web_session`) carries the CSRF token and the logout. It is opened only by consuming a one-time link (`openLink`): `shepherd login` on a paired machine asks the Durable Object to mint one (bound to the machine's credential, single use, minutes of validity) and the browser that opens it gets the session cookie. Every mutation needs the CSRF header, a same-origin `Origin` (required, not merely checked when present) and a JSON body. Logout deletes the session, closes the sockets it opened, and the page returns to the sign-in page.

### The owner

`sh_owner` (one row) holds the owner's internal id and the allowed email. On a deployment that had a Feishu owner the old open id is kept as the id, so every old row (`receiveId`, inbound owner authorization, card actions) stays consistent. The id is what handlers compare against; the *authorization* is the claim (ADR-0004).

## Owner workflow without Feishu

- **Settings** (`/app/api/settings`, `/app/api/settings/model`): the owner's address and the model selection (`apiKey` is a boolean — the key is never returned). Saving re-seals the key under `SERVER_KEY`.
- **Pairing** (`/app/api/pairing`): mints a one-time code (10 minutes) keyed by the client's request id, so a retry gets the same code, and returns the full `npx @iefnaf/shepherd connect <origin> <code>` command. It is shown only in the machines panel, never in the conversation feed.
- **Revoke** (`/app/api/machines/revoke`): bumps the device epoch and closes the connection with `4403`.
- **First run**: the page asks for settings (a model key) and then a machine, one notice at a time.
- **Reports, questions and decisions** are written straight to the workspace (`enqueueOutbound` stores `channel: web` rows, no delivery pass, no Feishu adapter), in the workspace's own card shape (`{ type: "pip-card", tone, title, body, note, buttons }` — the old Feishu card JSON is still read for rows written before). They exist whether or not a browser is connected; a connected one is nudged. Rows still queued for Feishu at the upgrade are handed to the workspace on the first start. Detail links are not generated: the workspace is the page.

`webOnly` (a protected getter on the Durable Object, true in production) is the single switch. The historical transport fixture `test/legacy-worker.ts` turns it off, which is how the Feishu-era suites keep running against the Feishu code.

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
| Connector older than full reads | Such a connector ignores `format: "full"` and answers with the old summary pages, which carry no `format`; the viewer says "too old… run `shepherd upgrade`" (with Retry) instead of drawing them |

## Tests

`vitest.config.ts` runs the historical suites against `test/legacy-worker.ts`; `vitest.claim.config.ts` runs `test/claim-*.test.ts` against the real entry with the ADR-0004 doors (the bound `SHEPHERD_CLAIM_SECRET` stands in for what the connector writes through the Cloudflare API). `scripts/test-groups.mjs` runs both. The connector and protocol suites cover the reader and the schemas; `ui-session.test.ts` covers the browser model.
