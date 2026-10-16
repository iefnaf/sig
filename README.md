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
wrangler secret put SERVER_KEY    # signs device tokens and seals stored secrets
wrangler secret put SETUP_TOKEN   # one-time bootstrap secret for the setup page
wrangler deploy
```

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>` and follow the steps there: create a Feishu custom app, enter its App ID / App Secret / Verification Token (validated live against Feishu), point the app's event subscription at `https://<your-domain>/channels/feishu/events` with the `im.message.receive_v1` event, republish the app, then DM the bot once — the sender becomes the owner and the setup page closes permanently (ADR-0001 decisions 8–9).

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

Machines that never reconnect during the window must re-pair after it closes.

Mainland-China users must bind a custom domain to the Worker: `*.workers.dev` is unreachable there, which breaks the web app, the connector, and Feishu's webhook delivery alike (see the [Feishu research](docs/research/feishu-channel.md) §3 and §8.2).
