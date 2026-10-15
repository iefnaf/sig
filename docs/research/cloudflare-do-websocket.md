# Cloudflare: Durable Object WebSocket Research

Date: 2026-10-14. Purpose: establish the facts behind the protocol between connectors and the steward (a Durable Object).

Sources (source files from the official repos, not measurements):

- `cloudflare/cloudflare-docs`, commit `eeca142b`: `durable-objects/best-practices/websockets.mdx`, `platform/limits.mdx`, `platform/pricing.mdx`
- `cloudflare/agents`, commit `b1e3614b`: `docs/agents/http-websockets.md`, `docs/agents/routing.md`, and others

Nothing was measured on a real Worker. Hibernation, wakes, close codes, and billing behavior needed prototype verification (see the last section).

## 1. Hibernation

- A DO acting as the WebSocket **server** can hibernate; **outbound connections the DO initiates as a client cannot**.
- After a period without events (messages, alarms) the DO is evicted from memory while the client connection stays alive on Cloudflare's network; the next message re-initializes it (constructor runs again) and invokes the message handler.
- No duration (GB-s) cost accrues while hibernating.
- All in-memory state is lost on hibernation. `setTimeout`, `setInterval`, alarms, and in-flight I/O prevent it.
- The Agents SDK's WebSockets **always use the hibernation API; there is no non-hibernating mode**; the docs say hibernation kicks in after roughly 10 idle seconds.
- What survives hibernation: `this.state`, `connection.state`, SQLite data, connection metadata. What doesn't: class memory fields, timers, in-flight Promises, local caches.
- `serializeAttachment` payloads are capped at **16,384 bytes**; attachments are lost once either side closes the connection.
- The runtime automatically answers client WebSocket **ping frames with pong** — this neither wakes a hibernated DO nor invokes the message handler.

## 2. Limits

| Item | Value |
|---|---|
| WebSocket received message size | 32 MiB (receive only) |
| SQLite single row / string / BLOB | 2 MB |
| SQLite storage per DO | 10 GB |
| Single SQL statement length | 100 KB |
| Bound parameters per statement | 100 |
| CPU time per request or WebSocket message | 30 s default (reset on each new message) |
| Connection tags (Agents SDK) | at most 9, each up to 256 chars |

## 3. Billing

- WebSocket messages are billed as requests at **20:1**; each new connection counts as one request.
- Requests: 1M/month included, $0.15 / million beyond.
- Duration: 400,000 GB-s/month included, $12.50 / million GB-s beyond, metered at 128 MB.
- Paid plans have a $5/month minimum.
- Doc example: a DO that never hibernates for a whole month (messages every second) is on the order of 330k GB-s, still inside the included amount. By the same arithmetic, a single DO awake all month is ~2,592,000 s × 0.128 GB ≈ 331,776 GB-s, **below the 400,000 included**. So for single-tenant deployments duration cost is not a hard constraint — but frequent wakes should still be avoided (wasteful, and it approaches the included amount).
- In-flight I/O can keep an object in memory for at most 15 minutes, metered as duration.

## 4. Agents SDK (the `agents` package)

- Hooks: `onStart`, `onRequest`, `onConnect(connection, ctx)`, `onMessage(connection, message)`, `onClose`, `onError`. `ctx.request` is the original HTTP request — **headers are readable**, good for auth; on failure `connection.close(4001, ...)` works.
- `routeAgentRequest(request, env, { onBeforeConnect })`: runs **before the Agent is woken**; returning a `Response` rejects, returning a `Request` rewrites it. `getAgentByName` does not run this hook — callers must check themselves.
- Every new connection receives protocol frames by default (`CF_AGENT_IDENTITY`, `CF_AGENT_STATE`, `CF_AGENT_MCP_SERVERS`). `shouldSendProtocolMessages(connection, ctx)` returning `false` disables them — right for non-browser clients; the choice survives hibernation.
- `getConnectionTags(connection, ctx)` tags connections, `getConnections(tag)` fetches by tag — good for separating "connector connections" from "browser connections".
- Routing shape is `/agents/<class name kebab>/<instance name>`; single-tenant deployments use a fixed instance name (e.g. `owner`).
- The `agents` repo has `docs/agents/harnesses/pi.md` on how PiHarness combines with an Agent, plus `push-notifications.md`, `webhooks.md`, `scheduling.md`, `tasks.md`; not read this round.

## 5. Constraints on the protocol design

1. Hibernation wipes memory: **any pending-ack state, timeout, or retry must live in SQLite**, driven by `this.schedule` (alarms) — never in-memory Promises or timers.
2. Keepalive via WebSocket protocol-level ping (sent by the connector); the runtime auto-pongs without waking the DO, near-zero cost; send an application-level heartbeat only if needed. *(Spike-phase note, 2026-10-15: "only if needed" arrived sooner than expected — the e2e spike hit half-dead TCP and had to add a bidirectional application-level heartbeat; see [spike-conclusions.md](../spike-conclusions.md) §2.)*
3. Two auth layers: the Worker layer does a stateless pre-check in `onBeforeConnect` (no DO wake); the DO layer does stateful checks in `onConnect` (revocation, device records).
4. Connector connections should disable protocol frames and use tags to distinguish themselves from browser connections.
5. Messages are far below the 32 MiB cap, but a SQLite row is only 2 MB: events and history must be chunked well below that.
6. 16 KB attachment cap per connection: keep only identity and small flags on the connection; everything else goes through SQLite.

## 6. Verification status

The following were verified on real Cloudflare with the prototype, see [do-protocol-spike.md](do-protocol-spike.md): extra latency of the first message after hibernation (~35–50 ms); protocol-level pings neither waking the DO nor preventing hibernation; custom close codes 4403 and 4409 arriving verbatim at Node's `ws` client; the HMAC pre-check with the Worker secret in `onBeforeConnect` so bad tokens never wake the DO; `ws` accepting custom headers.

Still unverified:

- How long a half-open connection goes unnoticed after laptop sleep or network switch.
- The exact hibernation threshold (only confirmed: within 40 s), and the real duration-cost impact of frequent small messages.
- Billing reconciliation (request counts and GB-s in the console).
