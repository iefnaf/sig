# Sig

A personal agent steward that remembers ongoing work and coordinates coding agents across the owner’s machines. The owner talks to it through one continuous conversation: the web workspace on top, the owner API underneath.

## Language

**Sig**:
The product name, derived from Sigma and the summation symbol ∑. Previously called Shepherd.
_Avoid_: Shepherd or Pip as the current product name.

**Steward**:
Sig’s coordinating role: the agent that owns the conversation, memory and Threads, and directs worker sessions. The interface calls it Sig.
_Avoid_: 总管 in interface copy.

**Owner**:
The single user of a deployment. Browser access uses the deployment login password or a registered passkey. Existing deployments can also use their explicit SERVER_KEY for the owner API. See ADR-0010 for initialization, recovery, and key ownership.
_Avoid_: "bound owner", open_id.

**Owner API**:
The optional SERVER_KEY-gated HTTP surface for programmatic access: messages in, sent messages and button actions back, pairing, login links. Fresh deployments use the browser without requiring this API credential.
_Avoid_: calling it "the bot" or "the webhook".

**Message**:
One rendered item the owner reads (text plus optional opaque-action buttons) — an outbound row settled locally; a quiet-merged group shares one id and reads as one message.
_Avoid_: "card" for anything chat-provider-specific.

**Thread (事项)**:
An ongoing matter with a goal and history, potentially carried by several worker sessions. It remains available for follow-up when idle.
_Avoid_: A separate chat, completed task.

**Worker session**:
One coding agent’s execution session started by Sig on a machine, attached to a Thread.
_Avoid_: Another steward.

**Session record**:
The agent’s own file on a machine in which a worker session is written down. Sig reads it on demand and never keeps a copy.
_Avoid_: Transcript, raw process, log.

**Machine (机器)**:
One of the owner’s computers, with available agents, repositories, and execution capacity.

**Needs you (待处理)**:
A decision awaiting the owner, such as a question, PR approval, offline arrangement, routine offer, or memory suggestion. Several decisions may belong to one Thread; some belong to no Thread.
_Avoid_: A separate inbox.

**Workspace (工作台)**:
The web view of Sig’s conversation, Threads, worker sessions, decisions, and machines — the owner’s everyday entry. It is a view of the same conversation the owner API serves, not a second one.

**Channel**:
Where the owner and Sig talk. Everything is the one local channel for now; the workspace and the owner API are two faces of it.
_Avoid_: A separate conversation per channel or per surface.
