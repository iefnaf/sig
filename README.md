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
wrangler secret put SERVER_KEY              # signs device tokens; rotate by re-running and restarting
wrangler secret put SETUP_TOKEN             # one-time bootstrap secret for the setup page
wrangler secret put STEWARD_MODEL_API_KEY   # the steward model's API key (default: DeepSeek)
wrangler deploy
```

The steward's model is deploy config (ADR-0001 decision 11): unset `vars.STEWARD_MODEL` defaults to `deepseek`/`deepseek-flash` (the eval baseline); set it in `wrangler.jsonc` to use another catalog provider or a proxy base URL, e.g. `{"provider": "deepseek", "modelId": "deepseek-v4-pro", "baseUrl": "https://…"}`. Inside the Worker the provider is always built with an inline `auth.apiKey.resolve` closure over the secret — never ambient environment-variable auth (spike bug 7). A missing key or an unknown provider/model fails visibly (`sh_run` settles `unanswered` with `no_model`/auth errors) rather than silently using a different model.

After deploy, open `https://<your-domain>/setup?token=<SETUP_TOKEN>` and follow the steps there. The default path is QR-code creation (issue #24): scan once to create the bot — the scanner becomes the owner and the credentials are stored encrypted — scan a second time to add the `application:application:patch` scope, and the app is then switched to webhook delivery (`im.message.receive_v1` + `card.action.trigger` to `https://<your-domain>/channels/feishu/events`) with one guided manual step: republishing the version in the developer console. The page verifies the switch through real event delivery (an API-accepted config PATCH alone does not move delivery, see the [Feishu research](docs/research/feishu-channel.md) §8.2) and closes permanently once the first event lands. Manually entering App ID / App Secret / Verification Token (validated live against Feishu) remains available as the fallback at every step (ADR-0001 decisions 8–9).

Mainland-China users must bind a custom domain to the Worker: `*.workers.dev` is unreachable there, which breaks the web app, the connector, and Feishu's webhook delivery alike (see the [Feishu research](docs/research/feishu-channel.md) §3 and §8.2).

## Talking to it (M2)

The Feishu bot is the steward LLM: a pi conversation hosted in the Durable Object, talking to the model configured above. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report card stay deterministic), keeps Thread summaries current when workers report back, and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

Quote-replying to a report card attaches your message to that Thread (resolved from the card's message id, never through the model's judgment) and the next worker starts from the previous worker's branch. Report cards' buttons (e.g. "排队等上线" while a machine is offline) resolve the Thread the same way.
