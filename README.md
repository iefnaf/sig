<img src="apps/steward/ui/brand/sig.svg" alt="Sig logo — summation symbol" width="72" height="72">

# Sig

**One conversation. Many agents.** Named after Sigma (∑): bringing your agents' work together.

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Formerly Shepherd. The CLI is now `sig`; existing deployment and session identities stay compatible ([rename decision](docs/adr/0002-sig-brand-and-compatibility.md)).

Status: the chat-channel integration (Feishu) is removed for now; the owner drives the deployment through a SERVER_KEY-gated HTTP API ([ADR-0003](docs/adr/0003-owner-api-replaces-chat-channel.md)) and, day to day, through the **web workspace** — one continuous conversation with Threads, "Needs you" decisions, and your agents' session records viewed live from their machines ([ADR-0004](docs/adr/0004-web-workspace.md), [ADR-0005](docs/adr/0005-web-entry-and-local-sessions.md)).

- [docs/spec.md](docs/spec.md): product requirements
- [docs/agent-deploy.md](docs/agent-deploy.md): the deploy runbook your coding agent executes (the primary path, [ADR-0007](docs/adr/0007-agent-driven-deploy.md))
- [docs/deploy.md](docs/deploy.md): deployment guide — agent/button/terminal deploy, the mainland-China custom domain, connector setup, expected costs, secret rotation
- [docs/design/web-entry.md](docs/design/web-entry.md): how owner access and the session viewer are built
- [docs/design/web-workspace/](docs/design/web-workspace/): the workspace prototype the implementation settled its shape on (historical)
- [docs/spike-conclusions.md](docs/spike-conclusions.md): what the spike phase validated, the integration pitfalls it uncovered, and the handover gaps
- [docs/research/pi-integration.md](docs/research/pi-integration.md): findings from driving `pi --mode rpc`
- [docs/research/cloudflare-do-websocket.md](docs/research/cloudflare-do-websocket.md): Durable Object WebSocket facts and limits
- [docs/research/do-protocol-spike.md](docs/research/do-protocol-spike.md): measured results of the protocol prototype on real Cloudflare
- [docs/design/connector-pi.md](docs/design/connector-pi.md): how the connector manages pi workers
- [docs/design/connector-do-protocol.md](docs/design/connector-do-protocol.md): wire protocol between connector and the steward Durable Object
- [docs/design/steward.md](docs/design/steward.md): the steward inside the Durable Object (memory module, routing, event pipeline, notifications, proactive behavior)

The spike code (protocol prototype, steward M1/M2, full e2e loop, pi-rpc scripts) was removed after the phase concluded; it is sealed under git tag `spike-final` for reference.

## Deploying the steward

**Fastest path: your own coding agent.** Give it this paragraph —

> Deploy Sig for me: read `docs/agent-deploy.md` in [github.com/iefnaf/shepherd](https://github.com/iefnaf/shepherd) and follow it exactly. Stop where it says a human is needed.

— and it deploys into your own Cloudflare account, sets and verifies the secrets, pairs your first machine, and opens the workspace; the owner's part is one paragraph and the first message, and no secret ever transits the agent ([ADR-0007](docs/adr/0007-agent-driven-deploy.md)).

No agent at hand? The button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

One click clones the repo into your own account and deploys the Worker; the deploy form generates the secrets with you — `SERVER_KEY` (an `openssl rand -hex 32` you paste) plus optionally your model provider key. The full walk — the custom domain mainland users should bind, connector install, cost expectations, and rotation — lives in **[docs/deploy.md](docs/deploy.md)**.

From a terminal instead (the Wrangler config sits at the repo root):

```sh
pnpm install
wrangler deploy                  # uses ./wrangler.jsonc at the repo root; npm run deploy -- --name <unique> for a workers.dev-safe name
wrangler secret put SERVER_KEY   # openssl rand -hex 32; signs device tokens, gates the owner API
wrangler secret put MODEL_KEY    # optional; the workspace's Settings page works too
```

The steward's model selection is deploy config (ADR-0001 decision 11): unset `vars.STEWARD_MODEL` (root `wrangler.jsonc`) defaults to `deepseek`/`deepseek-flash` — the eval baseline; set it to pick another catalog provider or a proxy base URL. The API key never rides in vars: it is the sealed `sh_model` row inside the Durable Object (seeded once from the `MODEL_KEY` you set at deploy, or pasted into the workspace's **Settings** — which also replaces a rejected key), and inside the Worker the provider is always built with an inline `auth.apiKey.resolve` closure over that sealed key. A missing key or an unknown provider/model fails visibly (`sh_run` settles `unanswered`) rather than silently using a different model; a key the provider rejects is diagnosed in place — the workspace says to fix the key, and the provider's error text lands in the channel log as `model_call_error`.

Model spend carries a daily budget soft cap (issue #28, ADR-0001 decision 15): unset `vars.DAILY_BUDGET_USD` defaults to $1 per UTC day. Past it, worker events, routine fires, and follow-ups no longer wake the model, while everything deterministic keeps working — done reports, failure/fallback pushes, digest cards, and every reply to the owner. The first reply each capped day carries a one-line notice, and `/花费` (or asking "今天花了多少钱？" verbatim) reports the day's spend straight from the counter with no model call.

Mainland users should bind a custom domain before daily use: `*.workers.dev` is blocked there outright, and the API, the web app, and the connector's WebSocket all need to reach the deployment ([deploy guide](docs/deploy.md#custom-domain)).

Secrets at rest: the model provider API key is AES-GCM sealed under `SERVER_KEY` inside the Durable Object's storage; a raw storage dump alone does not expose it. `/pair` is brute-force guarded per source IP and globally (5 failed codes lock pairing for 15 minutes).

### Rotating SERVER_KEY

`SERVER_KEY` is rotatable without re-pairing every machine — tokens carry the signing key's id, and `SERVER_KEY_PREVIOUS` keeps a verification window open (details in the [protocol design](docs/design/connector-do-protocol.md) §5.1). The owner API accepts the previous key through the window too, so your scripts keep working while you swap them over:

```sh
wrangler secret put SERVER_KEY_PREVIOUS   # the OLD key
wrangler secret put SERVER_KEY            # the NEW key (openssl rand -hex 32)
wrangler deploy                           # evicts isolates still pinning the old secrets
# …let every machine reconnect once (each welcome hands the connector a rekeyed token)…
wrangler secret delete SERVER_KEY_PREVIOUS
wrangler deploy
```

Machines that never reconnect during the window must re-pair after it closes. Why the `wrangler deploy` in between matters — a resident Durable Object isolate pins old code and old secrets for minutes after a secret change, so evict it before verifying — is explained in the [deploy guide](docs/deploy.md#secrets-and-rotation).

## Talking to it: the owner API

There is no chat channel for now ([ADR-0003](docs/adr/0003-owner-api-replaces-chat-channel.md)); whoever holds `SERVER_KEY` is the owner. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report stay deterministic) and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

```sh
KEY="Authorization: Bearer $SERVER_KEY"

# Say something (the reply lands in the message list below):
curl -X POST https://sig.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "把 repo-a 里的登录 bug 修了"}'

# Read what came back — replies, done reports, questions, digests (poll with ?after=<cursor>):
curl "https://sig.example.com/api/messages?limit=20" -H "$KEY"

# Quote a message to continue that Thread / answer its question:
curl -X POST https://sig.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "改用 pnpm", "replyTo": "<message id from the list>"}'

# Press a button a message carries (ask options, PR consent [同意/先不要], offline asks):
curl -X POST https://sig.example.com/api/actions -H "$KEY" -H 'content-type: application/json' \
  -d '{"cardMsgId": "<message id>", "action": "pr_approve"}'

# Add a machine / open the web workspace:
curl -X POST https://sig.example.com/api/pairing     -H "$KEY"   # → run this on the new machine
curl -X POST https://sig.example.com/api/login-link  -H "$KEY"   # → one-time web login URL
```

Follow-up work continues relay-style (spec §5.3): the same agent on the same machine **resumes the previous session**, while a machine/agent switch, a bloated context (≥ 80%), or your explicit ask for a fresh perspective starts a **new session on the previous worker's branch**, prefixed with a deterministic handoff brief. You can also reach a worker mid-run — 「改用 pnpm」 goes out as a steer, 「停下那个」 aborts, and stopping only ever follows your explicit instruction.

Two exact phrases stay deterministic and never reach the model — they mint credentials, so they must work without one: `/加机器` (also `/添加机器`, `/add-machine`) answers with the connect command, and `/网页` (also `/web`, `/login`) answers with a one-time login link. The same things exist as the `/api/pairing` and `/api/login-link` routes above.

## Installing the connector

On a machine you want Sig to run agents from (macOS or Linux, Node ≥ 22.18):

```sh
npx @iefnaf/sig connect <steward-url> <pairing-code>    # code from POST /api/pairing
```

This pairs the machine, installs the connector as a background service — a launchd agent (`dev.shepherd.connector`) on macOS, a systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs it attached to the terminal instead (containers, dev boxes). Then:

```sh
sig add-repo ~/code/my-repo      # allow start_worker in this repository (§8.1)
sig repo-config ~/code/my-repo --workspace serial   # worktree (default) | serial | main checkout
sig repo-config ~/code/my-repo --approve            # trust the repo's local pi extensions (machine-local only)
sig status                        # service, pairing, workers, installed assets
sig logs                          # tail ~/.shepherd/logs/connector.log
sig stop | start | restart        # control the service
sig upgrade                       # npm-install the latest package and restart the service
sig uninstall                     # remove the service (keeps ~/.shepherd data)
```

State lives under `~/.shepherd/` (set `SIG_HOME` to move it; `SHEPHERD_HOME` remains a fallback alias): credentials in `connector.sqlite` (0600), pi sessions and the versioned extension/prompt files, worker worktrees, and logs that contain no keys or session content. Set `SIG_MACHINE_NAME` to choose the advertised machine name (`SHEPHERD_MACHINE_NAME` remains supported). Once the Sig package is published, existing Shepherd installs can switch with `npx @iefnaf/sig upgrade`; their state directory and service label stay the same.

### Which agents it drives

**pi** is the default worker agent. When the `claude` CLI (Claude Code) is on the machine, the connector picks it up automatically and advertises it in `hello.agents` — ask the steward 「用 Claude Code 跑这个」 and it dispatches to a Claude Code worker: headless `claude -p` with stream-json output, a Sig `report` MCP tool, and the same outcome adjudication and branch relay as pi. The differences are declared honestly and degrade instead of pretending: Claude Code cannot be steered mid-run and cannot run read-only tasks, so those stay on pi.

## The routing eval gate

Routing quality has a measurable bar: a fixed 106-case set (ported from the spike) run against the real steward extension. Any change to the steward prompt, the tool definitions, `findCandidates`, or the model must re-run it and meet the thresholds before merge — `pnpm --filter @shepherd/steward eval:routing` exits non-zero when they are missed. See [docs/routing-eval.md](docs/routing-eval.md) for the metrics, the recorded baselines, and the no-model selftest.

## The web workspace

`/app` is the owner's everyday entry ([ADR-0004](docs/adr/0004-web-workspace.md)): one continuous conversation — the same local channel the owner API serves — with the Threads behind it, a "Needs you" view over open decisions (questions, PR consent, offline asks, routine and memory suggestions), machines and pairing, and the day's model spend against the budget cap. The page is plain HTML/CJS/ES modules with no frontend build and a CSP that forbids inline script and every other origin; it stays current over a browser WebSocket nudge and can show a reply as it is being written. The interface is English by default with an in-page EN/中文 switch.

The door is a one-time login link minted by `POST /api/login-link` (or a report card's 查看详情 button); opening it exchanges the token for a 7-day session cookie.

Each Thread exposes its workers' **session records** ([ADR-0005](docs/adr/0005-web-entry-and-local-sessions.md)): the full recorded session — messages, tool calls and results, images, compaction notes — streamed from the machine through the Durable Object over the browser socket and never stored or logged server-side (protocol doc §6.6). The connector serves it from the live agent process or, once the process is gone, from the session file on disk, resumable with a cursor and bounded per page; an offline machine shows why the record is unavailable instead of an empty page. Machines are listed and revoked in the workspace too (撤销 bumps the device epoch and closes the connection with 4403, so a stolen token dies instantly).
