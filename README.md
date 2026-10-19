# Shepherd

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Status: the **Pip web workspace is the owner's only entry** — you claim it with your first computer, sign browsers in with machine-minted one-time links, talk to Pip, decide, and read your agents' sessions there ([ADR-0003](docs/adr/0003-web-entry-local-sessions.md), [ADR-0004](docs/adr/0004-device-first-claim.md)). The Feishu channel is out of the active product; its code stays in the repository, unreachable, so its tests keep guarding it.

- [docs/spec.md](docs/spec.md): product requirements
- [docs/agent-deploy.md](docs/agent-deploy.md): the deploy runbook for your coding agent (the primary path, ADR-0005)
- [docs/deploy.md](docs/deploy.md): deployment guide — agent/button/terminal deploy, claiming with the first computer, sign-in, connector setup, expected costs, secret rotation
- [docs/design/web-entry.md](docs/design/web-entry.md): how owner access and the session viewer are built
- [docs/spike-conclusions.md](docs/spike-conclusions.md): what the spike phase validated, the integration pitfalls it uncovered, and the handover gaps
- [docs/research/pi-integration.md](docs/research/pi-integration.md): findings from driving `pi --mode rpc`
- [docs/research/cloudflare-do-websocket.md](docs/research/cloudflare-do-websocket.md): Durable Object WebSocket facts and limits
- [docs/research/do-protocol-spike.md](docs/research/do-protocol-spike.md): measured results of the protocol prototype on real Cloudflare
- [docs/research/feishu-channel.md](docs/research/feishu-channel.md): Feishu bot creation, event transport, messaging APIs (historical: the channel is shelved)
- [docs/design/connector-pi.md](docs/design/connector-pi.md): how the connector manages pi workers
- [docs/design/connector-do-protocol.md](docs/design/connector-do-protocol.md): wire protocol between connector and the steward Durable Object
- [docs/design/steward.md](docs/design/steward.md): the steward inside the Durable Object (memory module, routing, event pipeline, notifications, proactive behavior)

The spike code (protocol prototype, steward M1/M2, full e2e loop, pi-rpc scripts) was removed after the phase concluded; it is sealed under git tag `spike-final` for reference.

## Deploying the steward

**Fastest path: your own coding agent.** Give it this paragraph —

> Deploy Pip for me: read `docs/agent-deploy.md` in [github.com/iefnaf/shepherd](https://github.com/iefnaf/shepherd) and follow it exactly. Stop where it says a human is needed.

— and it deploys into your own Cloudflare account, verifies the gates, claims your first machine, and opens the workspace; your two clicks are the Cloudflare consent and the first message, and no secret ever transits the agent ([ADR-0005](docs/adr/0005-agent-driven-deploy.md)).

No agent at hand? The button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

Or from a terminal (the Wrangler config sits at the repo root):

```sh
pnpm install
npm run deploy -- --name <unique-name>   # wrangler deploy + the SHEPHERD_IDENTITY stamp
npx @iefnaf/shepherd connect <url>       # on your machine: claims + pairs (Cloudflare authorization)
```

`npx @iefnaf/shepherd connect <url>` claims the deployment through your Cloudflare account and pairs that machine ([ADR-0004](docs/adr/0004-device-first-claim.md)). The full walk — custom domain, sign-in, connector install, cost expectations, rotation — lives in **[docs/deploy.md](docs/deploy.md)**.

No password exists and no input sits on the public pages: a browser signs in with a one-time link minted by a paired machine (`shepherd login`), and only someone managing your Cloudflare account can claim the deployment. Machines connect to the machine socket (`/agents/steward/owner`) with their own revocable credential, exactly as before.

The steward's model selection is deploy config (ADR-0001 decision 11): unset `vars.STEWARD_MODEL` (root `wrangler.jsonc`) defaults to `deepseek`/`deepseek-flash` — the eval baseline; set it to pick another catalog provider or a proxy base URL, e.g. `{"provider": "deepseek", "modelId": "deepseek-v4-pro", "baseUrl": "https://…"}`. The API key never rides in vars: it is the sealed `sh_model` row inside the Durable Object (seeded once from the `MODEL_KEY` you set at deploy, or pasted into the workspace's Settings — see the [deploy guide's model provider section](docs/deploy.md#model-provider)), and inside the Worker the provider is always built with an inline `auth.apiKey.resolve` closure over that sealed key — never ambient environment-variable auth (spike bug 7). A missing key or an unknown provider/model fails visibly (`sh_run` settles `unanswered`) rather than silently using a different model.

Model spend carries a daily budget soft cap (issue #28, ADR-0001 decision 15): unset `vars.DAILY_BUDGET_USD` defaults to $1 per UTC day. Once the day's spend reaches it, worker events, routine fires, and follow-ups no longer wake the model, while everything deterministic keeps working — done reports, failure notices, digest cards, and every reply to the owner. The workspace header shows the day's spend against the cap, and the first reply each capped day carries a one-line notice ([deploy guide](docs/deploy.md#costs)).

Secrets at rest: the model provider API key is AES-GCM sealed inside the Durable Object's storage (under its own auth root, ADR-0004); a raw storage dump alone does not expose it. `/pair` is brute-force guarded per source IP and globally (5 failed codes lock pairing for 15 minutes). When rotating `SERVER_KEY`, remember a resident Durable Object isolate pins old code and secrets for minutes — evict it before verifying ([deploy guide](docs/deploy.md#secrets-and-rotation)).

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

On a machine you want Shepherd to run agents from (macOS or Linux, Node ≥ 22.18), open the workspace's **Machines** panel → **Add a machine** → **Create pairing command**, and run what it shows:

```sh
npx @iefnaf/shepherd connect <steward-url> <pairing-code>
```

This pairs the machine (redeeming the one-time pairing code — 10 minutes, usable once — at the steward's `/pair` endpoint), installs the connector as a background service — a launchd agent (`dev.shepherd.connector`) on macOS, a systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs it attached to the terminal instead (containers, dev boxes). Then:

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

**pi** is the default worker agent. When the `claude` CLI (Claude Code) is on the machine, the connector picks it up automatically and advertises it in `hello.agents` — ask Pip 「用 Claude Code 跑这个」 and it dispatches to a Claude Code worker: headless `claude -p` with stream-json output, a Shepherd `report` MCP tool, and the same outcome adjudication and branch relay as pi. The differences are declared honestly and degrade instead of pretending: Claude Code cannot be steered mid-run (a follow-up that lands while it works is delivered as its next prompt once the run ends) and cannot run read-only tasks, so those stay on pi.

## Talking to it (M2)

Pip is the steward LLM: a pi conversation hosted in the Durable Object, talking to the model configured above. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report card stay deterministic), keeps Thread summaries current when workers report back, and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

Follow-up work continues relay-style (spec §5.3): the same agent on the same machine **resumes the previous session** (the task goes in as its next input), while a machine/agent switch, a bloated context (≥ 80%), or your explicit ask for a fresh perspective starts a **new session on the previous worker's branch**, prefixed with a deterministic handoff brief — goal, current state, deduped decisions, leftovers, and git pointers, never file contents. The new worker reads the code and the diff itself.

You can also reach a worker mid-run: 「改用 pnpm」 goes out as a steer (applied after the current tool batch, never interrupting it), 「做完后顺便补测试」 queues as a follow-up, and 「停下那个」 aborts the run — stopping only ever follows your explicit instruction. Anything the worker hadn't received when it stopped is reported back and kept on the Thread.

Answering a report card from its **Answer** button (or picking a Thread and writing to it) attaches your message to that Thread — resolved from the card, never through the model's judgment — and the next worker starts from the previous worker's branch. A card's buttons (e.g. "wait for it" while a machine is offline) resolve the Thread the same way; an `ask_user` card's candidate buttons settle routing with one tap.

### The routing eval gate

Routing quality has a measurable bar: a fixed 106-case set (ported from the spike) run against the real steward extension. Any change to the steward prompt, the tool definitions, `findCandidates`, or the model must re-run it and meet the thresholds before merge — `pnpm --filter @shepherd/steward eval:routing` exits non-zero when they are missed. See [docs/routing-eval.md](docs/routing-eval.md) for the metrics, the recorded baselines, and the no-model selftest.

## The Pip workspace

The web is the place to talk to Pip ([ADR-0002](docs/adr/0002-pip-web-workspace.md), [ADR-0003](docs/adr/0003-web-entry-local-sessions.md), spec §7.3). Open `https://<your-domain>/app` (sign in with a `shepherd login` link from a paired machine), and you are in one continuous conversation with the Threads beside it and the decisions waiting for you ("Needs you") on the right. Pick a Thread and the conversation, the details and your next message all follow it; Pip's replies, its questions and its cards arrive live, and a card's buttons (approve a PR, wait for an offline machine, accept a routine, archive a memory) act at once. Everything Pip says is kept until you read it — also while no page is open — so a decision that arrived overnight is waiting in "Needs you".

The first run is guided from the page: a notice asks for the model key (**Settings**, top right), then for a first machine (**Machines → Add a machine** generates the pairing command). Machines are revoked from the same panel — a **Revoke** bumps the machine's device epoch and closes its connection (4403), so a stolen token dies instantly (protocol §5.1).

English is the default; the **EN / 中文** switch remembers your choice and changes only the interface — what you and Pip wrote is shown as written. (Text the system itself generates — report cards, timeline lines — is still written in Chinese.) The page is plain HTML, CSS and JavaScript in [`apps/steward/ui`](apps/steward/ui), served by the Worker as static assets behind the same Access check; there is no frontend build. Nothing the conversation or a session contains is ever parsed as HTML, and the page's content-security policy forbids inline script and any other origin.

### Agent sessions

A Thread's **Agent sessions** tab (or **View session** on a worker card) shows what a worker actually did, as the agent recorded it: every message, tool call with its full arguments and result, bash command, image and compaction note — nothing summarized or cut. Long entries are clipped on screen with a **Show all**; the oldest are one click away; a running agent is followed live; the Thread's earlier sessions are one pick away. pi's branches are honoured (what the agent left behind is shown dimmed, marked "other branch"), and Claude Code's sub-agent work is marked as such.

The record is **read from the machine, on demand, and never stored by the steward**: the connector reads pi's session file or Claude Code's transcript and streams it through the Durable Object to your browser in bounded, resumable pieces — each entry sent as fragments of its own JSON, so a 4 MB tool result is simply a long entry, not a lost one. It works while the machine's connector is connected, whether or not the agent process is still running; a disconnected machine, a missing file or an unreadable entry is said plainly, never shown as an empty session. Only sessions Pip started are shown (the worker's own file — the browser can name a worker, never a path).
