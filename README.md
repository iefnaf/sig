# Shepherd

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Status: spec and design complete, spike phase concluded — ready for the real implementation.

- [docs/spec.md](docs/spec.md): product requirements
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

```sh
cd apps/steward
wrangler secret put SERVER_KEY    # signs device tokens; rotate by re-running and restarting
wrangler secret put SETUP_TOKEN   # one-time bootstrap secret for the setup page
wrangler deploy
```

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>` and follow the steps there. The default path is QR-code creation (issue #24): scan once to create the bot — the scanner becomes the owner and the credentials are stored encrypted — scan a second time to add the `application:application:patch` scope, and the app is then switched to webhook delivery (`im.message.receive_v1` + `card.action.trigger` to `https://<your-domain>/channels/feishu/events`) with one guided manual step: republishing the version in the developer console. The page verifies the switch through real event delivery (an API-accepted config PATCH alone does not move delivery, see the [Feishu research](docs/research/feishu-channel.md) §8.2) and closes permanently once the first event lands. Manually entering App ID / App Secret / Verification Token (validated live against Feishu) remains available as the fallback at every step (ADR-0001 decisions 8–9).

Mainland-China users must bind a custom domain to the Worker: `*.workers.dev` is unreachable there, which breaks the web app, the connector, and Feishu's webhook delivery alike (see the [Feishu research](docs/research/feishu-channel.md) §3 and §8.2).

## Talking to it (M1)

The LLM steward arrives with M2; until then the Feishu bot understands fixed command phrases only, and everything else — machine choice, branch relay, the three-part done-report card — is deterministic:

| Phrase | What it does |
|---|---|
| `/派发 <repo>[@<machine>] <要做的事>` (also `/dispatch`, `/run`) | Creates a Thread and dispatches a write task to a machine that has the repo (unique online winner; ties and offline-only machines come back as a question) |
| `/状态` (also `/status`) | Lists machines and Threads with their derived state (`running` / `waiting_you` / `idle`) |
| `/加机器` (also `/添加机器`, `/add-machine`) | Issues a one-time pairing code and replies with `npx @iefnaf/shepherd connect <url> <code>` to run on the new machine |
| `/网页` (also `/web`, `/login`) | Replies with a one-time login link (15 min, single use) to the companion web |

Quote-replying to a report card continues the same Thread on its last machine — queuing until it comes back online if it dropped — and the next worker starts from the previous worker's branch. Report cards' buttons (e.g. "排队等上线" while a machine is offline) resolve the Thread from the card itself, never from data stuffed into the button.

## The companion web

Report cards carry a **查看详情** button: a one-time signed link (15 min, single use) that logs the owner in and opens the Thread timeline (L2: instructions, dispatches, reports, questions — mobile-friendly, server-rendered, no JS). While logged in (`/网页` for a fresh link), `/app` lists all Threads and `/app/machines` lists paired machines with live online state; the 撤销 button bumps a machine's device epoch and closes its connection (4403), so a stolen token dies instantly (protocol §5.1). The chat-issued `/加机器` command is the only pairing path.
