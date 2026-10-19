# Using Sig

[English README](../README.md) · [中文 README](../README.zh-CN.md)

## The owner API

There is no chat channel for now ([ADR-0003](adr/0003-owner-api-replaces-chat-channel.md)); whoever holds `SERVER_KEY` is the owner. Natural language in, natural language out — the model dispatches through its `start_worker` tool (machine choice, branch relay, and the three-part done-report stay deterministic) and only ever disturbs you on its own initiative through `notify_user`/`ask_user`. In event-triggered runs its plain text output is discarded by structure — quiet by default is guaranteed by the code, not the prompt.

```sh
KEY="Authorization: Bearer $SERVER_KEY"

# Say something (the reply lands in the message list below):
curl -X POST https://sig.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "把 repo-a 里的登录 bug 修了"}'

# Read what came back — replies, done reports, questions, digests (poll with ?after=<cursor>):
curl "https://sig.example.com/api/messages?limit=20" -H "$KEY"

# Quote a message to continue that Thread / answer its question:
curl -X POST https://sig.example.com/api/messages -H "$KEY" -H 'content-type: application/json' \
  -d '{"text": "改用 pnpm", "replyTo": "<message id from the list>"}'

# Press a button a message carries (ask options, PR consent [同意/先不要], offline asks):
curl -X POST https://sig.example.com/api/actions -H "$KEY" -H 'content-type: application/json' \
  -d '{"cardMsgId": "<message id>", "action": "pr_approve"}'

# Add a machine / open the web workspace:
curl -X POST https://sig.example.com/api/pairing     -H "$KEY"   # → run this on the new machine
curl -X POST https://sig.example.com/api/login-link  -H "$KEY"   # → one-time web login URL
```

Follow-up work continues relay-style (spec §5.3): the same agent on the same machine **resumes the previous session**, while a machine/agent switch, a bloated context (≥ 80%), or your explicit ask for a fresh perspective starts a **new session on the previous worker's branch**, prefixed with a deterministic handoff brief. You can also reach a worker mid-run — 「改用 pnpm」 goes out as a steer, 「停下那个」 aborts, and stopping only ever follows your explicit instruction.

Two exact phrases stay deterministic and never reach the model — they mint credentials, so they must work without one: `/加机器` (also `/添加机器`, `/add-machine`) answers with the connect command, and `/网页` (also `/web`, `/login`) answers with a one-time login link. The same things exist as the `/api/pairing` and `/api/login-link` routes above.

## Local coding agents

**pi** is the default worker agent. When the `claude` CLI (Claude Code) is on the machine, the connector picks it up automatically and advertises it in `hello.agents` — ask the steward 「用 Claude Code 跑这个」 and it dispatches to a Claude Code worker: headless `claude -p` with stream-json output, a Sig `report` MCP tool, and the same outcome adjudication and branch relay as pi. The differences are declared honestly and degrade instead of pretending: Claude Code cannot be steered mid-run and cannot run read-only tasks, so those stay on pi.

## The web workspace

`/app` is the owner's everyday entry ([ADR-0004](adr/0004-web-workspace.md)): one continuous conversation — the same local channel the owner API serves — with the Threads behind it, a "Needs you" view over open decisions (questions, PR consent, offline asks, routine and memory suggestions), machines and pairing, and the day's model spend against the budget cap. The page is plain HTML/CJS/ES modules with no frontend build and a CSP that forbids inline script and every other origin; it stays current over a browser WebSocket nudge and can show a reply as it is being written. The interface is English by default with an in-page EN/中文 switch.

The door is a one-time login link minted by `POST /api/login-link` (or a report card's 查看详情 button); opening it exchanges the token for a 7-day session cookie.

Each Thread exposes its workers' **session records** ([ADR-0005](adr/0005-web-entry-and-local-sessions.md)): the full recorded session — messages, tool calls and results, images, compaction notes — streamed from the machine through the Durable Object over the browser socket and never stored or logged server-side (protocol doc §6.6). The connector serves it from the live agent process or, once the process is gone, from the session file on disk, resumable with a cursor and bounded per page; an offline machine shows why the record is unavailable instead of an empty page. Machines are listed and revoked in the workspace too (撤销 bumps the device epoch and closes the connection with 4403, so a stolen token dies instantly).
