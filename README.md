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

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>` and follow the steps there. The default path is QR-code creation (issue #24): scan once to create the bot — the scanner becomes the owner and the credentials are stored encrypted — scan a second time to add the `application:application:patch` scope, and the app is then switched to webhook delivery (`im.message.receive_v1` + `card.action.trigger` to `https://<your-domain>/channels/feishu/events`) with one guided manual step: republishing the version in the developer console. The page verifies the switch through real event delivery (an API-accepted config PATCH alone does not move delivery, see the [Feishu research](docs/research/feishu-channel.md) §8.2) and closes permanently once the first event lands. Manually entering App ID / App Secret / Verification Token (validated live against Feishu) remains available as the fallback at every step (ADR-0001 decisions 8–9).

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

## Installing the connector

On a machine you want Shepherd to run agents from (macOS or Linux, Node ≥ 22.18):

```sh
npx @iefnaf/shepherd connect <steward-url> <pairing-code>
```

This pairs the machine (redeeming the pairing code from the steward's `/pair` endpoint), installs the connector as a background service — a launchd agent (`dev.shepherd.connector`) on macOS, a systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs it attached to the terminal instead (containers, dev boxes). Then:

```sh
shepherd add-repo ~/code/my-repo   # allow start_worker in this repository (§8.1)
shepherd status                    # service, pairing, workers, installed assets
shepherd logs                      # tail ~/.shepherd/logs/connector.log
shepherd stop | start | restart    # control the service
shepherd upgrade                   # npm-install the latest package and restart the service
shepherd uninstall                 # remove the service (keeps ~/.shepherd data)
```

State lives under `~/.shepherd/` (set `SHEPHERD_HOME` to move it): credentials in `connector.sqlite` (0600), pi sessions and the versioned extension/prompt files, worker worktrees, and logs that contain no keys or session content. The service unit runs the same `shepherd daemon` the package ships, so `upgrade` is just an npm reinstall plus a service restart.

## Talking to it (M1)

The LLM steward arrives with M2; until then the Feishu bot understands fixed command phrases only, and everything else — machine choice, branch relay, the three-part done-report card — is deterministic:

| Phrase | What it does |
|---|---|
| `/派发 <repo>[@<machine>] <要做的事>` (also `/dispatch`, `/run`) | Creates a Thread and dispatches a write task to a machine that has the repo (unique online winner; ties and offline-only machines come back as a question) |
| `/状态` (also `/status`) | Lists machines and Threads with their derived state (`running` / `waiting_you` / `idle`) |

Quote-replying to a report card continues the same Thread on its last machine — queuing until it comes back online if it dropped — and the next worker starts from the previous worker's branch. Report cards' buttons (e.g. "排队等上线" while a machine is offline) resolve the Thread from the card itself, never from data stuffed into the button.
