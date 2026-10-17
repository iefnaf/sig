# Shepherd

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Status: spec and design complete, spike phase concluded — ready for the real implementation.

- [docs/spec.md](docs/spec.md): product requirements
- [docs/deploy.md](docs/deploy.md): deployment guide — one-click deploy, the mainland-China custom domain, Feishu and connector setup, expected costs, secret rotation
- [docs/spike-conclusions.md](docs/spike-conclusions.md): what the spike phase validated, the integration pitfalls it uncovered, and the handover gaps
- [docs/research/pi-integration.md](docs/research/pi-integration.md): findings from driving `pi --mode rpc`
- [docs/research/cloudflare-do-websocket.md](docs/research/cloudflare-do-websocket.md): Durable Object WebSocket facts and limits
- [docs/research/do-protocol-spike.md](docs/research/do-protocol-spike.md): measured results of the protocol prototype on real Cloudflare
- [docs/research/feishu-channel.md](docs/research/feishu-channel.md): Feishu bot creation, event transport, messaging APIs, and open questions
- [docs/design/connector-pi.md](docs/design/connector-pi.md): how the connector manages pi workers
- [docs/design/connector-do-protocol.md](docs/design/connector-do-protocol.md): wire protocol between connector and the steward Durable Object
- [docs/design/steward.md](docs/design/steward.md): the steward inside the Durable Object (memory module, routing, event pipeline, notifications, proactive behavior)

The spike code (protocol prototype, steward M1/M2, full e2e loop, pi-rpc scripts) was removed after the phase concluded; it is sealed under git tag `spike-final` for reference.

## Deploying the steward

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

One click clones the repo into your own account and deploys the Worker; the deploy form itself generates the secrets with you — `SERVER_KEY` and `SETUP_TOKEN` (each an `openssl rand -hex 32` you paste) plus your model provider key. The full walk — the setup page, the custom domain mainland users must bind, connector install, cost expectations, and rotation — lives in **[docs/deploy.md](docs/deploy.md)**.

From a terminal instead (the Wrangler config sits at the repo root):

```sh
pnpm install
wrangler deploy                  # uses ./wrangler.jsonc at the repo root
wrangler secret put SERVER_KEY   # openssl rand -hex 32; signs device tokens, seals Feishu credentials
wrangler secret put SETUP_TOKEN  # a second, different random string; one-time gate for the setup page
```

The steward's model selection is deploy config (ADR-0001 decision 11): unset `vars.STEWARD_MODEL` (root `wrangler.jsonc`) defaults to `deepseek`/`deepseek-flash` — the eval baseline; set it to pick another catalog provider or a proxy base URL, e.g. `{"provider": "deepseek", "modelId": "deepseek-v4-pro", "baseUrl": "https://…"}`. The API key never rides in vars: it is the sealed `sh_model` row inside the Durable Object (seeded once from the `MODEL_KEY` you set at deploy — see the [deploy guide's model provider section](docs/deploy.md#model-provider)), and inside the Worker the provider is always built with an inline `auth.apiKey.resolve` closure over that sealed key — never ambient environment-variable auth (spike bug 7). A missing key or an unknown provider/model fails visibly (`sh_run` settles `unanswered`) rather than silently using a different model.

Model spend carries a daily budget soft cap (issue #28, ADR-0001 decision 15): unset `vars.DAILY_BUDGET_USD` defaults to $1 per UTC day. Once the day's spend reaches it, worker events, routine fires, and follow-ups no longer wake the model, while everything deterministic keeps working — done reports, failure/fallback pushes, digest cards, and every reply to the owner. The first reply each capped day carries a one-line notice, and `/花费` (or asking "今天花了多少钱？" verbatim) reports the day's spend straight from the counter with no model call ([deploy guide](docs/deploy.md#costs)).

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>`. The page opens with a reachability self-check (workers.dev vs custom domain — Feishu cannot deliver webhooks to `*.workers.dev`), then walks the QR-code flow (issue #24): scan once to create the bot — the scanner becomes the owner and the credentials are stored encrypted — scan a second time to add the `application:application:patch` scope, and the app is then switched to webhook delivery (`im.message.receive_v1` + `card.action.trigger` to `https://<your-domain>/channels/feishu/events`) with one guided manual step: republishing the version in the developer console. The page verifies the switch through real event delivery (an API-accepted config PATCH alone does not move delivery, see the [Feishu research](docs/research/feishu-channel.md) §8.2) and closes permanently once the first event lands. Manually entering App ID / App Secret / Verification Token (validated live against Feishu) remains available as the fallback at every step (ADR-0001 decisions 8–9). When rotating `SERVER_KEY`, remember a resident Durable Object isolate pins old code and secrets for minutes — evict it before verifying ([deploy guide](docs/deploy.md#secrets-and-rotation)).

Every deployment needs a custom domain before the webhook switch: Feishu's event servers sit in mainland China and cannot reach `*.workers.dev` at all (URL verification fails with 210042 — live-tested), so no event can arrive over workers.dev. For mainland users the custom domain is additionally what makes the web app and the connector reachable — workers.dev is blocked there outright ([deploy guide](docs/deploy.md#custom-domain), [Feishu research](docs/research/feishu-channel.md) §3 and §8.2).

Secrets at rest: the Feishu credentials and the model provider API key are AES-GCM sealed under `SERVER_KEY` inside the Durable Object's storage; a raw storage dump alone exposes neither. `/pair` is brute-force guarded per source IP and globally (5 failed codes lock pairing for 15 minutes), and the Feishu webhook rejects events whose verification token or app id mismatch and whose timestamp skews more than an hour.

### Rotating SERVER_KEY

`SERVER_KEY` is rotatable without re-pairing every machine — tokens carry the signing key's id, and `SERVER_KEY_PREVIOUS` keeps a verification window open (details in the [protocol design](docs/design/connector-do-protocol.md) §5.1):

```sh
wrangler secret put SERVER_KEY_PREVIOUS   # the OLD key
wrangler secret put SERVER_KEY            # the NEW key (openssl rand -hex 32)
wrangler deploy                            # evicts isolates still pinning the old secrets
# …let every machine reconnect once (each welcome hands the connector a rekeyed token)…
wrangler secret delete SERVER_KEY_PREVIOUS
wrangler deploy
```

Machines that never reconnect during the window must re-pair after it closes. Why the `wrangler deploy` in between matters — a resident Durable Object isolate pins old code and old secrets for minutes after a secret change, so evict it before verifying — is explained in the [deploy guide](docs/deploy.md#secrets-and-rotation).

## Installing the connector

On a machine you want Shepherd to run agents from (macOS or Linux, Node ≥ 22.18):

```sh
npx @iefnaf/shepherd connect <steward-url> <pairing-code>
```

This pairs the machine (redeeming the pairing code from the steward's `/pair` endpoint), installs the connector as a background service — a launchd agent (`dev.shepherd.connector`) on macOS, a systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs it attached to the terminal instead (containers, dev boxes). Then:

```sh
shepherd add-repo ~/code/my-repo   # allow start_worker in this repository (§8.1)
shepherd repo-config ~/code/my-repo --workspace serial   # worktree (default) | serial | main checkout
shepherd repo-config ~/code/my-repo --approve            # trust the repo's local pi extensions (machine-local only)
shepherd status                    # service, pairing, workers, installed assets
shepherd logs                      # tail ~/.shepherd/logs/connector.log
shepherd stop | start | restart    # control the service
shepherd upgrade                   # npm-install the latest package and restart the service
shepherd uninstall                 # remove the service (keeps ~/.shepherd data)
```

State lives under `~/.shepherd/` (set `SHEPHERD_HOME` to move it): credentials in `connector.sqlite` (0600), pi sessions and the versioned extension/prompt files, worker worktrees, and logs that contain no keys or session content. The service unit runs the same `shepherd daemon` the package ships, so `upgrade` is just an npm reinstall plus a service restart.

### Which agents it drives

**pi** is the default worker agent. When the `claude` CLI (Claude Code) is on the machine, the connector picks it up automatically and advertises it in `hello.agents` — ask the steward 「用 Claude Code 跑这个」 and it dispatches to a Claude Code worker: headless `claude -p` with stream-json output, a Shepherd `report` MCP tool, and the same outcome adjudication and branch relay as pi. The differences are declared honestly and degrade instead of pretending: Claude Code cannot be steered mid-run (a follow-up that lands while it works is delivered as its next prompt once the run ends) and cannot run read-only tasks, so those stay on pi.

## Talking to it (M2)

The Feishu bot is the steward LLM: a pi conversation hosted in the Durable Object, talking to the model configured above. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report card stay deterministic), keeps Thread summaries current when workers report back, and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

Follow-up work continues relay-style (spec §5.3): the same agent on the same machine **resumes the previous session** (the task goes in as its next input), while a machine/agent switch, a bloated context (≥ 80%), or your explicit ask for a fresh perspective starts a **new session on the previous worker's branch**, prefixed with a deterministic handoff brief — goal, current state, deduped decisions, leftovers, and git pointers, never file contents. The new worker reads the code and the diff itself.

You can also reach a worker mid-run: 「改用 pnpm」 goes out as a steer (applied after the current tool batch, never interrupting it), 「做完后顺便补测试」 queues as a follow-up, and 「停下那个」 aborts the run — stopping only ever follows your explicit instruction. Anything the worker hadn't received when it stopped is reported back and kept on the Thread.

Two exact phrases stay deterministic and never reach the model — they mint credentials, so they must work without one:

| Phrase | What it does |
|---|---|
| `/加机器` (also `/添加机器`, `/add-machine`) | Issues a one-time pairing code and replies with `npx @iefnaf/shepherd connect <url> <code>` to run on the new machine |
| `/网页` (also `/web`, `/login`) | Replies with a one-time login link (15 min, single use) to the Pip workspace |

Quote-replying to a report card attaches your message to that Thread (resolved from the card's message id, never through the model's judgment) and the next worker starts from the previous worker's branch. Report cards' buttons (e.g. "排队等上线" while a machine is offline) resolve the Thread the same way; an `ask_user` card's candidate buttons settle routing with one tap, and the choice routes back as a reply to that Thread.

### The routing eval gate

Routing quality has a measurable bar: a fixed 106-case set (ported from the spike) run against the real steward extension. Any change to the steward prompt, the tool definitions, `findCandidates`, or the model must re-run it and meet the thresholds before merge — `pnpm --filter @shepherd/steward eval:routing` exits non-zero when they are missed. See [docs/routing-eval.md](docs/routing-eval.md) for the metrics, the recorded baselines, and the no-model selftest.

## The Pip workspace

The web is the everyday place to talk to Pip ([ADR-0002](docs/adr/0002-pip-web-workspace.md), spec §7.3). A one-time signed link — `/网页` in Feishu, or the **查看详情** button on a report card (15 min, single use) — logs the owner in and opens `/app`: the same continuous conversation as in Feishu, with the Threads beside it and the decisions waiting for you ("Needs you") on the right. Pick a Thread and the conversation, the details and your next message all follow it; Pip's replies, its questions and its cards arrive live, and a card's buttons (approve a PR, wait for an offline machine, accept a routine, archive a memory) are the same handlers a Feishu tap reaches — answered on the web. Acknowledgements and replies to what you did on the web stay on the web; alerts that arrive on their own still push to Feishu.

English is the default; the **EN / 中文** switch remembers your choice and changes only the interface — what you and Pip wrote is shown as written. (Text the system itself generates — report cards, timeline lines — is still written in Chinese.) The page is plain HTML, CSS and JavaScript in [`apps/steward/ui`](apps/steward/ui), served by the Worker as static assets behind the same session check; there is no frontend build. Nothing the conversation contains is ever parsed as HTML, and the page's content-security policy forbids inline script and any other origin.

`/app/machines` lists paired machines with live online state; its 撤销 button bumps a machine's device epoch and closes its connection (4403), so a stolen token dies instantly (protocol §5.1). The chat-issued `/加机器` command is the only pairing path.

Each worker on a timeline links to its **原始过程** (L3 raw process, spec §7.4): the full conversation and tool calls, streamed from the machine through the Durable Object over a browser WebSocket — never stored or logged server-side (protocol doc §6.6). The connector serves it from the live pi process (`get_entries`) or, once the process is gone, by parsing the session JSONL along the current branch; entries are normalized and truncated with a 2 MB per-stream cap and a cursor for paging. Offline machines answer `machine_offline` with an explanation instead of a stream: the transcript lives on that machine only.
