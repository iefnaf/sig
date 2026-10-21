# Sig branding with stable deployment and session identities

Status: the keep-stable compatibility list below was superseded by [ADR-0009](0009-drop-shepherd-compatibility.md) once it became clear there would be no pre-rename users; the branding decisions (name, mark, `sig` command) stand.

The product is **Sig**, derived from Sigma (∑). The public connector command is `sig`, superseding ADR-0001 decision 10; its npm scope is recorded in [ADR-0008](0008-nightboats-npm-scope.md). The original `bin/shepherd.js` entry remains a forwarding wrapper for service definitions pointing into a checkout. `SIG_HOME` and `SIG_MACHINE_NAME` take precedence over their `SHEPHERD_*` aliases. The default state directory stays `~/.shepherd`, so existing pairing credentials, workers and logs remain available without moving files.

Keep the Cloudflare Worker name and Durable Object binding, database names, signing/derivation strings, session cookie, service label (`dev.shepherd.connector`), worker branch prefixes, private workspace package names, and agent extension/MCP identifiers stable. These identify existing resources, credentials and resumable sessions; changing them along with the brand would create new deployments or break continuation. GitHub links continue to target `iefnaf/shepherd` until the repository itself is renamed. Historical research, accepted baseline decisions and recorded eval output retain their original names.

The ∑ logo is a font-independent SVG in `public/brand/sig.svg`, with a 512 × 512 PNG export alongside it. Only these two public assets are served without authentication; they never enter the Durable Object. (The Feishu avatar preset that once consumed the PNG was removed with the chat channel — see ADR-0003.)
