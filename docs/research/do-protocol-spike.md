# Protocol Prototype, Measured: The Connector Protocol on a Durable Object

Date: 2026-10-14. Prototype code: `spike-final:spikes/do-protocol`. Corresponding design: [connector-do-protocol.md](../design/connector-do-protocol.md).

## Environment and method

- Deployed to real Cloudflare: Worker `shepherd-spike` (with one SQLite-backed Durable Object, `agents@0.28.1`, `wrangler@4.151.0`), deleted after testing.
- The test client was Node's `ws@8.22.0` plus a simulated connector, on the user's machine. **That machine's network blocks `*.workers.dev` (DNS poisoning, TLS reset by SNI), so all real-environment tests went through a local proxy (`127.0.0.1:7897`)** — the round-trip latencies below include proxy overhead and are good only for comparison, not as absolute values.
- The same tests also ran on local `wrangler dev` (workerd) with identical functional results; hibernation, alarms, and wake counts are taken from the real environment only.
- The steward's model used pi-ai's faux provider (scripted replies); no real model was called.
- Each test typically ran once — no statistical significance.

## What the prototype implemented

The Worker entry does the HMAC token pre-check and serves `/pair`, `/admin/*`; the DO (`Steward`) implements: device and pairing tables, `onConnect` auth (4401/4403), same-device connection takeover (4409), `hello/welcome`, the `outbox` (commands) with alarm-driven resend, `event_inbox` with cumulative acks and `resync`, and the `PiHarness` integration (`agents/harness/pi`) that lets `report` events drive steward runs. Protocol fields match the design doc.

## Results

| # | What was verified | Result |
|---|---|---|
| T1 | Do bad tokens wake the DO | **No.** First let the DO be evicted (`instanceId` changes), then make 10 connections with tampered tokens; the Worker layer returns HTTP 401 outright. Reading the wake counter afterwards showed +1 — that one was the read itself |
| T1 | Token validation | Missing and tampered tokens both 401; a valid token completes the handshake; a wrong pairing code is rejected |
| T2 | Custom close codes | 4409 (superseded by a new connection) and 4403 (revoked) both **arrive verbatim at Node's `ws` client**; after revocation, reconnecting with the old token passes the Worker pre-check and the DO closes with 4403 in `onConnect` |
| T3 | Command resend and dedup | The first delivery's ack and result were deliberately dropped; the DO's alarm resends after the ack deadline; the connector recognizes the duplicate by `cmdId` and returns `duplicate`; the command reaches terminal state `done` with `attempts=2`, and the connector **executed it exactly once** |
| T4 | Event replay | After emitting the first batch the connection was `terminate()`d; on reconnect `welcome.acks` indicates what the DO already has, and the connector replays from there; 120 events each stored once, cumulative ack reaches 120, the connector log drains |
| T5 | Offline queuing | Queued while the device is offline the command stays `queued`; after the device comes online, `hello` triggers delivery and completion, executed once |
| T6 | Hibernation and ping | Within 40 idle seconds the DO is evicted (`instanceId` changes) while the connection **stays open**. **Sending a WebSocket protocol ping every 5 seconds, the DO is evicted all the same**; the wake counter goes up by exactly 1 per read. Conclusion: protocol-level pings neither wake the DO nor prevent hibernation |
| T6 | Warm vs. cold latency | Warm: 173, 172, 174, 177 ms; first message after hibernation: 207, 224 ms. Wake overhead is ~35–50 ms, swamped by network and proxy latency |
| T7 | Alarm after hibernation | A command is sent, the DO hibernates; 20 seconds later an alarm wakes it and resends; the command completes, executed once |
| T8 | Event-driven steward | A `report` event goes through `harness.submit(..., {operationId})` and produces one steward input; the steward replies. **Re-transmitting the same event batch 3 times still yields exactly 1 steward input**; `accepted=false` is recognized correctly |
| T8 | Crash recovery | Mid-steward-run, `ctx.abort()` hard-resets the DO (`instanceId` changes); for 60 seconds **no request touches the DO**; on the next look the run has completed and `pending` is empty |

## Issues found and fixed in the prototype

1. **An alarm can fire before a millisecond-precision deadline.** `schedule()` works in whole seconds while my `ackDeadline` was in milliseconds. The alarm handler wakes, sees "not due yet", returns — and with no further alarm ever scheduled, the command sits in `sent` forever. Fix: when un-acked rows remain, the handler **reschedules itself**. Written into the design doc.
2. **`welcome.acks` is also a cumulative ack.** After reconnecting, the connector must use `acks` not only to decide where to replay from but also to truncate its local log — otherwise the log only grows. Written into the design doc.
3. **A simulator bug of our own** (send queue not drained on disconnect, inflating duplicate event counts): unrelated to the protocol; fixed; the DO-side dedup was correct throughout.

## Conclusions for the design

- "How events wake the steward" has a workable answer: **after persisting connector events, call `harness.submit(text, { operationId: "evt:<workerId>:<seq>", whenBusy: "followUp" })` for every event worth handling.** The `operationId` makes replays and re-transmissions naturally idempotent; `PiHarness` maintains an alarm heartbeat per session, so an evicted DO restarts and resumes via alarm.
- Keepalive needs only the connector's protocol-level ping (or nothing — the connection survives DO hibernation). No application-level heartbeat required. *(Spike-phase note, 2026-10-15: the e2e spike later found half-dead TCP where protocol pings kept flowing — an application-level heartbeat proved necessary after all; see [spike-conclusions.md](../spike-conclusions.md) §2.)*
- The Worker-layer HMAC pre-check works: scans and brute-force attempts neither wake the DO nor incur DO duration cost.

## Limitations and unverified

- `ctx.abort()` simulates a crash; it is not the platform's real eviction or host migration.
- Large messages (near 256 KiB), concurrent connectors, and multi-hour connection stability were not tested.
- How quickly a half-open connection is noticed (laptop sleep, network switch) was not tested; this machine went through a proxy and cannot represent a real path.
- The hibernation threshold is only confirmed as "within 40 seconds"; the exact value is unknown.
- Billing was not checked: wake counts and duration cost are estimates from pricing docs, not verified in the console.
- The steward used the faux model. How long real-model I/O keeps the DO in memory, and the 15-minute pending-I/O ceiling, were not tested.
- Proxy latencies cannot be used to judge real wake delays.
- `https-proxy-agent` was only for bypassing this machine's network restrictions; it is not part of the design.
