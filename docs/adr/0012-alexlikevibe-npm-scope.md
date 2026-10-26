# Alexlikevibe npm scope

Status: accepted. Supersedes [ADR-0008](0008-nightboats-npm-scope.md).

The `nightboats` npm account that owns the `@nightboats` scope was restricted from publishing, blocking releases of `@nightboats/sig` (published through 0.1.1). The scope moves wholesale to the owner's `alexlikevibe` npm identity: the public package becomes `@alexlikevibe/sig` and the workspace packages become `@alexlikevibe/protocol` / `@alexlikevibe/steward` / `@alexlikevibe/preview-machine`, while GitHub repository URLs and deployment identities remain unchanged as in ADR-0008. Published `@nightboats/sig` versions stay on the registry under the dead scope; there are no external users (per ADR-0009), so the rename needs no bridge release — the next `v*` tag publishes under the new name. Historical records (ADR-0002, ADR-0008, ADR-0009, the connector-pi design notes) keep the old scope name, per the convention ADR-0002 set.
