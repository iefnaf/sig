# Shepherd

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Status: product spec and design stage.

- [docs/spec.md](docs/spec.md): product requirements
- [docs/research/pi-integration.md](docs/research/pi-integration.md): findings from driving `pi --mode rpc`
- [docs/research/cloudflare-do-websocket.md](docs/research/cloudflare-do-websocket.md): Durable Object WebSocket facts and limits
- [docs/design/connector-pi.md](docs/design/connector-pi.md): how the connector manages pi workers
- [docs/design/connector-do-protocol.md](docs/design/connector-do-protocol.md): wire protocol between connector and the steward Durable Object
- [docs/design/steward.md](docs/design/steward.md): the steward inside the Durable Object (memory module, routing, event pipeline, notifications, proactive behavior)
- [docs/research/do-protocol-spike.md](docs/research/do-protocol-spike.md): measured results of the protocol prototype on real Cloudflare
- [spikes/do-protocol](spikes/do-protocol): the prototype (Worker, Durable Object, simulated connector, tests)
- [spikes/pi-rpc](spikes/pi-rpc): throwaway scripts behind the research
