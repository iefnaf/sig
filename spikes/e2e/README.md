# End-to-end spike

The full product loop in one Worker: Feishu webhook inbound -> steward M2 (a real LLM via pi-durable) or fixed-command dispatch (/派发, /状态) -> connector protocol (pairing, outbox, event inbox) -> M1 core (reducer, templates, outbound queue) -> replies and report cards back to Feishu. Deployed as `shepherd-hook` behind the custom domain `shepherd-spike.iefnaf.cc`.

- `src/index.ts`: Worker entry (Feishu webhook, /pair, /admin/*) and the Steward Durable Object combining the connector protocol from the do-protocol spike, the M1 core from ../steward-m1, and the M2 steward extension from ../steward-m2.
- `sim-connector.mjs <BASE> <pairingCode> [name]`: simulated connector; answers start_worker with a scripted event sequence. Pairing codes are single-use — a supervisor loop that fetches a fresh code per attempt is the practical way to keep one alive (deploys and network stalls kill the process).

Verified live with deepseek-flash (2026-10-14): user message -> steward reply creating and dispatching a new thread; a repeated message recognized as already-dispatched (no duplicate worker); report card with buttons after the simulated worker settles; ask_user card when a second dispatch is requested while a worker is still running; pending questions surfaced in the next reply.

Bugs found and fixed while wiring this up (all worth remembering for the real implementation):

1. **Double-send race**: DO `onMessage` handlers interleave; two concurrent `flush()` calls can both deliver the same outbound row. Fixed with claim tokens (conditional UPDATE + ownership check).
2. **Missing schema migration**: `CREATE TABLE IF NOT EXISTS` does not add columns to existing DO tables; deploys against live storage need idempotent `ALTER TABLE` migrations.
3. **No fetch timeout + no retry driver**: a hung Feishu send blocked the events handler forever (acks stopped, nothing retried). Fixed with 10 s timeouts and an alarm-driven `retryOutbound`.
4. **Dispatch picked a dead device** (first row in the device table) whenever the online lookup came up empty — an isolate swap can silently drop the connector socket with no close frame, so `getWebSockets` correctly returns nothing and the old code fell through to a random dead device. Fixed: a thread keeps the machine its last worker ran on (queued, resumed on reconnect); a new thread with nothing online refuses with a note.
5. **Queued commands never retried**: `deliver()` only ran at dispatch and at hello; if the device was offline at dispatch the row sat queued forever. `resendUnacked` now sweeps queued rows, delivers when the device returns, and fails them after ~30 idle minutes.
6. **Secret rotation needs a new isolate**: a resident Durable Object keeps the env it was constructed with, so a rotated DEEPSEEK_API_KEY kept producing `model_error` until eviction/redeploy. Same for code: a resident DO (kept alive by an open WebSocket or alarms) serves the previous version for minutes after `wrangler deploy` returns — close the sockets and let it idle out before judging a deploy.
7. **pi-ai provider construction in Workers**: env-var auth reads the wrong context; build the provider with `createProvider` and an inline `auth.apiKey.resolve`. `PiModel` is `{provider, id}` (not `modelId`); the lazy OpenAI-completions API import comes from `api/openai-completions.lazy`.

Setup: secrets SERVER_KEY, ADMIN_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID, DEEPSEEK_API_KEY; custom domain attached in the dashboard; Feishu app webhook pointed at https://<domain>/feishu (see docs/research/feishu-channel.md §8.2 for the console-republish requirement). Diagnostics: `/agents/steward/owner/__diag` (plain HTTP, bypasses the RPC envelope) shows constructor state, live connections, devices, and recent outbox rows; `/admin/stats` summarizes runs/threads/commands.
