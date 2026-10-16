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

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>` and follow the steps there: create a Feishu custom app, enter its App ID / App Secret / Verification Token (validated live against Feishu), point the app's event subscription at `https://<your-domain>/channels/feishu/events` with the `im.message.receive_v1` event, republish the app, then DM the bot once — the sender becomes the owner and the setup page closes permanently (ADR-0001 decisions 8–9).

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
