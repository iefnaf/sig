# Sig

A personal agent steward that remembers ongoing work and coordinates coding agents across the owner’s machines.

## Language

**Sig**:
The product name, derived from Sigma and the summation symbol ∑. Previously called Shepherd.
_Avoid_: Shepherd or Pip as the current product name.

**Owner**:
The single user of a deployment — whoever holds its SERVER_KEY. No chat-platform identity is involved while the chat channel is deferred.
_Avoid_: "bound owner", open_id.

**Owner API**:
The SERVER_KEY-gated HTTP surface the owner talks through: messages in, sent messages and button actions back, pairing, login links.
_Avoid_: calling it "the bot" or "the webhook".

**Message**:
One rendered item the owner reads (text plus optional opaque-action buttons) — an outbound row settled locally; a quiet-merged group shares one id and reads as one message.
_Avoid_: "card" for anything chat-provider-specific.
