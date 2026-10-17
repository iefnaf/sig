# Pip

Pip is a personal agent that remembers ongoing work and coordinates coding agents on the owner’s machines. The owner interacts with one continuous conversation across the web and messaging channels.

## Language

**Pip (steward)**:
The personal agent the owner talks to. “Steward” is its coordinating role; the interface calls it Pip.
_Avoid_: 总管 in interface copy

**Thread (事项)**:
An ongoing matter with a goal and history, potentially carried by several worker sessions. It remains available for follow-up when idle.
_Avoid_: A separate chat, completed task

**Worker session**:
One coding agent’s execution session on a machine, attached to a Thread.
_Avoid_: Another steward

**Machine (机器)**:
One of the owner’s computers, with available agents, repositories, and execution capacity.

**Needs you (待处理)**:
A decision awaiting the owner, such as a question, PR approval, offline arrangement, routine offer, or memory suggestion. Several decisions may belong to one Thread; some belong to no Thread.
_Avoid_: A separate inbox

**Workspace (工作台)**:
The web view of Pip’s conversation, Threads, decisions, and machines.

**Channel**:
Where the owner and Pip talk: the web workspace or Feishu. Replies and acknowledgements follow the channel the owner used; alerts that arrive on their own push to Feishu.
_Avoid_: Two conversations — both channels show the same one

**Card**:
A structured message from Pip — a report, a question, a decision — that may carry buttons. A decision card is open until the owner handles it, from either channel.
