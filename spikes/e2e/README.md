# End-to-end spike

The full no-LLM product loop in one Worker: Feishu webhook inbound -> fixed-command dispatch (/派发, /状态) -> connector protocol (pairing, outbox, event inbox) -> steward M1 core (reducer, templates, outbound queue) -> report card back to Feishu. Deployed as `shepherd-hook` behind the custom domain `shepherd-spike.iefnaf.cc`.

- `src/index.ts`: Worker entry (Feishu webhook, /pair, /admin/*) and the Steward Durable Object combining the connector protocol from the do-protocol spike with the M1 core from ../steward-m1.
- `sim-connector.mjs <BASE> <pairingCode> [name]`: simulated connector; answers start_worker with a scripted event sequence.

Bugs found and fixed while wiring this up (all worth remembering for the real implementation):

1. **Double-send race**: DO `onMessage` handlers interleave; two concurrent `flush()` calls can both deliver the same outbound row. Fixed with claim tokens (conditional UPDATE + ownership check).
2. **Missing schema migration**: `CREATE TABLE IF NOT EXISTS` does not add columns to existing DO tables; deploys against live storage need idempotent `ALTER TABLE` migrations.
3. **No fetch timeout + no retry driver**: a hung Feishu send blocked the events handler forever (acks stopped, nothing retried). Fixed with 10 s timeouts and an alarm-driven `retryOutbound`.
4. **Dispatch picked a dead device** (first row in the device table). Fixed by preferring devices with a live connection and telling the user when all are offline.

Setup: secrets SERVER_KEY, ADMIN_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID; custom domain attached in the dashboard; Feishu app webhook pointed at https://<domain>/feishu (see docs/research/feishu-channel.md §8.2 for the console-republish requirement).
