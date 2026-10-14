# Steward M1 prototype

The deterministic core of the steward Durable Object ([design](../../docs/design/steward.md) M1, no LLM): ledger schema, event reducer, derived thread states, outbound queue with retry/merge, and the fixed notification templates. Runs on plain SQLite so the same code can later run inside the Durable Object's storage.

- `src/db.ts` / `src/node-db.ts`: minimal Db facade (node:sqlite here, DO storage later)
- `src/schema.ts`: the `sh_*` ledger tables
- `src/memory.ts`: the Memory module (ledger writes, derived state, intents, views)
- `src/reducer.ts`: WorkerEvent batch -> ledger updates + intents (steward.md §5.3)
- `src/templates.ts`: fixed three-part reports rendered from ledger data
- `src/outbound.ts`: outbound queue with exponential retry and quiet-window merging
- `src/scheduler.ts`: intents -> outbound; the 90-second decision window with deterministic fallback
- `test/core.test.ts`: 9 tests covering lifecycle, dedup, decision windows, errors, unread, retry, merge, timeline
- `smoke/feishu-card.ts`: runs a simulated scenario and sends the rendered cards to the owner's real Feishu

```sh
node --test 'test/*.test.ts'   # zero npm dependencies (node:sqlite + node:test)
node smoke/feishu-card.ts      # needs ../feishu/.credentials.json
```
