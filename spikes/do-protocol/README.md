# DO protocol spike

Throwaway prototype of the connector to Durable Object protocol. Results: [docs/research/do-protocol-spike.md](../../docs/research/do-protocol-spike.md). Not production code.

- `src/index.ts`: Worker entry (HMAC pre-check, `/pair`, `/admin/*`) and the `Steward` Durable Object (device auth, outbox with alarm resend, event inbox with cumulative acks, `PiHarness` wake-up).
- `sim.mjs`: simulated connector with fault injection (dropped replies, socket killed mid-batch).
- `tests.mjs`: scenarios T1 to T8.

## Run locally

```sh
npm install --ignore-scripts
printf 'SERVER_KEY=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .dev.vars
npx wrangler dev --port 8787 &
BASE_URL=http://localhost:8787 node tests.mjs t2 t3 t4 t5
```

T1, T6, T7 and the crash step of T8 depend on real hibernation and alarms, so run them against a deployed Worker (`wrangler deploy`, then set the two secrets with `wrangler secret put`). Delete it afterwards with `wrangler delete --name shepherd-spike`.

If `*.workers.dev` is blocked on your network, set `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY`, `HTTP_PROXY` and `WS_PROXY` to a local proxy before running `tests.mjs`.
