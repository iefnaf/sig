# Deploying Sig

A Sig deployment lives entirely in **your own Cloudflare account**: one Worker (the steward, with its Durable Object), no third-party service in the middle. Around it you connect machines, each running a small connector process. This guide walks the whole path: deploy → custom domain → model key → connector, then everything operational (costs, secret rotation, updates).

There is no chat channel for now ([ADR-0003](adr/0003-owner-api-replaces-chat-channel.md)): you drive the deployment through the `SERVER_KEY`-gated HTTP API (`POST /api/messages` and friends — see the [README](../README.md#talking-to-it-the-owner-api)) and the web workspace — one continuous conversation with Threads, decisions and worker session viewing ([ADR-0004](adr/0004-web-workspace.md)).

## Two ways to deploy

- **With your coding agent** — the primary channel ([ADR-0007](adr/0007-agent-driven-deploy.md)). Hand the agent one paragraph pointing at [`docs/agent-deploy.md`](agent-deploy.md); it deploys under a collision-safe unique name, sets and verifies the secrets, pairs the first machine, and opens the workspace for you. `npm run deploy -- --name <name>` wraps the deploy step.
- **One-click / by hand** — the Deploy-to-Cloudflare button or a terminal, below.

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

The form clones the repo into your own account and asks for two secrets:

| Secret | What it is |
|---|---|
| `SERVER_KEY` | An `openssl rand -hex 32`. Signs connector device tokens, seals the model key at rest, and authenticates the owner API (`Authorization: Bearer …`). Keep a copy. |
| `MODEL_KEY` | Your model provider's API key (default provider: DeepSeek — [platform.deepseek.com](https://platform.deepseek.com)). Sealed into the Durable Object's storage on first boot; deletable afterwards. Optional — you can also paste it into the workspace's **Settings** after signing in. |

From a terminal instead:

```sh
git clone https://github.com/<you>/shepherd && cd shepherd
pnpm install
wrangler deploy
wrangler secret put SERVER_KEY
wrangler secret put MODEL_KEY   # optional; the workspace Settings page works too
```

That's the whole setup — no onboarding page, no webhook to register. Talk to it:

```sh
curl -X POST https://<your-worker>.workers.dev/api/messages \
  -H "Authorization: Bearer $SERVER_KEY" -H 'content-type: application/json' \
  -d '{"text": "你好"}'
curl "https://<your-worker>.workers.dev/api/messages?limit=5" -H "Authorization: Bearer $SERVER_KEY"
```

## Opening the web workspace

The workspace at `/app` is the everyday entry: the same conversation as the API, with Threads, "Needs you" decisions, and each worker's session viewer. The door is a one-time link:

```sh
curl -X POST https://<your-worker>.workers.dev/api/login-link -H "Authorization: Bearer $SERVER_KEY"
# → { "url": "https://<your-worker>.workers.dev/link/wl1.home.…" }  — one use, 15 minutes
```

Opening it sets the session cookie (7 days). Report cards carry the same kind of link on their 查看详情 button.

## Custom domain

Not required for function anymore (there is no chat platform that must reach you), but **mainland users should bind one**: `*.workers.dev` is blocked there outright (DNS pollution + SNI reset, live-tested in the spike), and the API, the web app, and the connector's WebSocket all need to reach the deployment. The agent runbook keeps this as an appendix attached only when workers.dev is unreachable.

1. Dashboard → **Workers & Pages** → your Sig Worker → **Settings → Domains & Routes** → **Add → Custom domain**, e.g. `sig.example.com` (a zone hosted on Cloudflare DNS). Cloudflare creates the DNS record and the certificate.
2. Use `https://sig.example.com` everywhere: API calls, `sig connect`, web links.

A Cloudflare custom domain is not guaranteed reachable from mainland China either; if your machine cannot connect, verify with a direct `curl` before debugging anything else.

## Model provider

The steward needs one LLM behind it. Default: `deepseek` / `deepseek-flash` (the [routing eval](routing-eval.md) baseline). Override per deployment in the root `wrangler.jsonc`:

```jsonc
"vars": { "STEWARD_MODEL": "{\"provider\": \"deepseek\", \"modelId\": \"deepseek-v4-pro\"}" }
```

The API key never rides in vars: it is the sealed `sh_model` row inside the Durable Object — seeded once from the `MODEL_KEY` you set at deploy, or pasted into the workspace's **Settings** (which also replaces a key already saved). A missing key or unknown provider/model fails visibly (`sh_run` settles `unanswered`), never with a silently different model; a key the provider rejects is diagnosed in place ([ADR-0004](adr/0004-web-workspace.md)'s workspace tells you to fix the key, not to retry). Changing the default model requires re-running the routing eval (ADR-0001 decision 14).

The daily budget soft cap (issue #28): `vars.DAILY_BUDGET_USD` (dollars per UTC day, default $1, `0` disables automatic model wakes). Past it, events/routines/follow-ups stop waking the model while done reports, pushes, digests, and replies continue.

## Connecting a machine

Each machine you want to dispatch work to runs a small daemon that holds a WebSocket to the steward and drives the local coding agents. Ask your deployment for a pairing code:

```sh
curl -X POST https://sig.example.com/api/pairing -H "Authorization: Bearer $SERVER_KEY"
# → { "code": "AB12CD34", "command": "npx @iefnaf/sig connect https://sig.example.com AB12CD34" }
```

Run that command on the machine (macOS or Linux, Node ≥ 22.18). It pairs (redeeming the one-time code), installs a background service — launchd agent (`dev.shepherd.connector`) on macOS, systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs attached instead (containers, dev boxes). Day-to-day:

```sh
sig add-repo ~/code/myproject   # allow-list a repo for start_worker (machine-local by design)
sig repo-config ~/code/myproject --workspace serial   # worktree (default) | serial | main
sig repo-config ~/code/myproject --approve            # trust the repo's local pi extensions (§13)
sig status                       # service, pairing, workers, installed assets
sig logs                         # tail ~/.shepherd/logs/connector.log (no keys, no session content)
sig stop | start | restart       # control the service
sig upgrade                      # npm-install the latest package and restart the service
sig uninstall                    # remove the service (keeps ~/.shepherd data)
```

State lives under `~/.shepherd/` (`SIG_HOME` to move it; `SHEPHERD_HOME` remains a fallback alias). Prerequisites: the coding agent you intend to use (pi first, Claude Code next) already installed and logged in — Sig never touches the agent's own credentials. Revoke a machine any time from the workspace (机器 → 撤销): its token dies immediately (close code 4403).

## Costs

Sig is designed to be **dormant — and cost nothing — most of the time** (spec §12.3). Orders of magnitude, so the bill never surprises you (check current prices on Cloudflare's pricing page; these drift):

- **Cloudflare**: one Worker + one Durable Object. Workers free tier includes 100k requests/day; Durable Objects billing is per-request and per-GB-duration — a personal deployment idles far below the paid tier's minimums, and the WebSocket hibernation API means connected-but-idle connectors cost ~nothing.
- **Model**: the real cost. deepseek-flash list prices make a typical day (a handful of dispatches + bookkeeping wakes) well under the default $1/day cap; the budget counter is exact and `/花费` reads it without a model call.

## Secrets and rotation

`SERVER_KEY` signs connector device tokens, seals secrets at rest, and gates the owner API. It is rotatable without re-pairing every machine — tokens carry the signing key's id, and `SERVER_KEY_PREVIOUS` keeps a verification window open (protocol design §5.1). The API accepts the previous key through the window, so your scripts keep working while you swap them:

```sh
wrangler secret put SERVER_KEY_PREVIOUS   # the OLD key
wrangler secret put SERVER_KEY            # the NEW key (openssl rand -hex 32)
wrangler deploy                           # evicts isolates still pinning the old secrets
# …let every machine reconnect once (each welcome hands the connector a rekeyed token)…
wrangler secret delete SERVER_KEY_PREVIOUS
wrangler deploy
```

Why the `wrangler deploy` in between matters: a resident Durable Object isolate pins old code and old secrets for minutes after a secret change — evict it before verifying a rotation. Machines that never reconnect during the window must re-pair after it closes (mint a code via `POST /api/pairing`). Open browser sessions and unopened login links survive a rotation the same way (the previous key stays in the verification set).

`MODEL_KEY` is consumed once to seed the sealed `sh_model` row; after that you can delete the env secret — the sealed row answers from then on.

## Updates

`git pull && wrangler deploy` updates the steward. On each machine, `sig upgrade` npm-installs the latest connector package and restarts the service; the fresh daemon rewrites its versioned pi assets on boot (old versions stay on disk for sessions still referencing them).
