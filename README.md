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

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>`. The page opens with a reachability self-check (workers.dev vs custom domain — Feishu cannot deliver webhooks to `*.workers.dev`), then walks the QR-code flow (issue #24): scan once to create the bot — the scanner becomes the owner and the credentials are stored encrypted — scan a second time to add the `application:application:patch` scope, and the app is then switched to webhook delivery (`im.message.receive_v1` + `card.action.trigger` to `https://<your-domain>/channels/feishu/events`) with one guided manual step: republishing the version in the developer console. The page verifies the switch through real event delivery (an API-accepted config PATCH alone does not move delivery, see the [Feishu research](docs/research/feishu-channel.md) §8.2) and closes permanently once the first event lands. Manually entering App ID / App Secret / Verification Token (validated live against Feishu) remains available as the fallback at every step (ADR-0001 decisions 8–9). When rotating `SERVER_KEY`, remember a resident Durable Object isolate pins old code and secrets for minutes — evict it before verifying ([deploy guide](docs/deploy.md#secrets-and-rotation)).

Every deployment needs a custom domain before the webhook switch: Feishu's event servers sit in mainland China and cannot reach `*.workers.dev` at all (URL verification fails with 210042 — live-tested), so no event can arrive over workers.dev. For mainland users the custom domain is additionally what makes the web app and the connector reachable — workers.dev is blocked there outright ([deploy guide](docs/deploy.md#custom-domain), [Feishu research](docs/research/feishu-channel.md) §3 and §8.2).

## Talking to it (M1)

The LLM steward arrives with M2; until then the Feishu bot understands fixed command phrases only, and everything else — machine choice, branch relay, the three-part done-report card — is deterministic:

| Phrase | What it does |
|---|---|
| `/派发 <repo>[@<machine>] <要做的事>` (also `/dispatch`, `/run`) | Creates a Thread and dispatches a write task to a machine that has the repo (unique online winner; ties and offline-only machines come back as a question) |
| `/状态` (also `/status`) | Lists machines and Threads with their derived state (`running` / `waiting_you` / `idle`) |

Quote-replying to a report card continues the same Thread on its last machine — queuing until it comes back online if it dropped — and the next worker starts from the previous worker's branch. Report cards' buttons (e.g. "排队等上线" while a machine is offline) resolve the Thread from the card itself, never from data stuffed into the button.
