# Shepherd

An always-on personal agent steward. It runs on Cloudflare Durable Objects, remembers which work went to which coding agent on which of your machines, and routes what you say next to the right place.

Status: product spec and design stage.

- [docs/spec.md](docs/spec.md): product requirements
- [docs/research/pi-integration.md](docs/research/pi-integration.md): findings from driving `pi --mode rpc`
- [docs/design/connector-pi.md](docs/design/connector-pi.md): how the connector manages pi workers
- [spikes/pi-rpc](spikes/pi-rpc): throwaway scripts behind the research
