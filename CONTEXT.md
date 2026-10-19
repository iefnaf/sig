# Pip

Pip is a personal agent that remembers ongoing work and coordinates coding agents on the owner’s machines. The owner interacts with one continuous conversation in the web workspace.

## Language

**Owner**:
The person a Pip deployment serves, who directs its work and controls its connected machines. Established by the claim: the first computer authorized through the deployment's Cloudflare account.

**Claim (认领)**:
The one-time act that binds a fresh deployment to its Owner. The first computer proves, through the Cloudflare account that deployed it, that it may connect; from then on the deployment refuses every other claim.
_Avoid_: Registration, first-login

**Pip (steward)**:
The personal agent the owner talks to. “Steward” is its coordinating role; the interface calls it Pip.
_Avoid_: 总管 in interface copy

**Thread (事项)**:
An ongoing matter with a goal and history, potentially carried by several worker sessions. It remains available for follow-up when idle.
_Avoid_: A separate chat, completed task

**Worker session**:
One coding agent’s execution session started by Pip on a machine, attached to a Thread.
_Avoid_: Another steward

**Session record**:
The agent’s own file on a machine in which a worker session is written down. Pip reads it on demand and never keeps a copy.
_Avoid_: Transcript, raw process, log

**Machine (机器)**:
One of the owner’s computers, with available agents, repositories, and execution capacity.

**Needs you (待处理)**:
A decision awaiting the owner, such as a question, PR approval, offline arrangement, routine offer, or memory suggestion. Several decisions may belong to one Thread; some belong to no Thread.
_Avoid_: A separate inbox

**Workspace (工作台)**:
The web view of Pip’s conversation, Threads, worker sessions, decisions, and machines.

**Channel**:
Where the owner and Pip talk. The web workspace carries their continuous conversation.
_Avoid_: A separate conversation for each channel

**Card**:
A structured message from Pip — a report, a question, a decision — that may carry buttons. A decision card is open until the owner handles it.
