<img src="apps/steward/ui/brand/sig.svg" alt="Sig logo — summation symbol" width="72" height="72">

# Sig

**One conversation. Many agents.**

Named after Sigma (∑) — it brings your agents' work together.

Sig is an always-on steward for your coding agents. It lives in your own Cloudflare account, connects the machines you already work on, and remembers which task went to which agent, in which session, on which machine. So wherever you are — at the keyboard, or away with just a phone — one sentence is enough:

```text
你     把 repo-a 里的登录 bug 修了
Sig    交给 mac-studio 上的 pi 了，在 fix/login-bug 分支上。
Sig    ✅ 完成：改动 3 个文件，测试全绿。要开 PR 吗？［同意 / 先不要］
你     同意。对了，昨天那个登录 bug，再补几个边界测试
Sig    好，已恢复原来的 session 继续补。
```

Follow-ups resume the same session on the same branch. Questions wait for you instead of scrolling away. Nothing speaks unless it's done, stuck, or needs you.

## What you get

- **Memory.** Threads carry the goal, the history and the handoffs — 「昨天那个」 routes back to the exact machine, agent and session.
- **Quiet by default.** A report when it finishes, a ping when it's stuck, a question when it must. Nothing else.
- **Your machines, not a sandbox.** Agents run where your code, files and logins already are — real environments, nothing uploaded.
- **Yours entirely.** One Worker in your own Cloudflare account. Model keys sealed at rest; session records stream from the machine on demand and are never stored server-side; a daily budget cap keeps spend visible and boring.

## Get started

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

One click into your own account. Or from a terminal:

```sh
git clone https://github.com/<you>/shepherd && cd shepherd
pnpm install && wrangler deploy
wrangler secret put SERVER_KEY   # openssl rand -hex 32
wrangler secret put MODEL_KEY    # optional — paste it in Settings later instead
```

Even better, hand the whole thing to a coding agent:

> Deploy Sig for me: read `docs/agent-deploy.md` in github.com/iefnaf/shepherd and follow it exactly. Stop where it says a human is needed.

Then connect a machine (macOS or Linux, Node ≥ 22.18):

```sh
npx @iefnaf/sig connect <steward-url> <pairing-code>
sig add-repo ~/code/my-repo
```

The connector installs itself as a background service and starts at login. **pi** is the default worker agent; **Claude Code** is picked up automatically when it's installed.

Open `/app` and say the first thing.

> **Mainland China:** bind a custom domain before daily use — `*.workers.dev` is blocked ([details](docs/deploy.md#custom-domain)).

## The workspace

`/app` is where you live with Sig: one continuous conversation, the Threads behind it, a **Needs you** view over open decisions, and every worker's session record streamed live from its machine. Machines and pairing, the day's model spend against the cap. English by default, 中文 one switch away.

Underneath, the same conversation is served by a plain HTTP API (`POST /api/messages`) — so everything you can say in the workspace, you can script from anywhere.

---

[Deploy guide](docs/deploy.md) · [Product spec](docs/spec.md)

Formerly Shepherd — existing deployments and sessions keep working.
