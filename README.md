<p align="center">
  <img src="apps/steward/ui/brand/sig.svg" alt="Sig" width="88" height="88">
</p>

<h1 align="center">Sig</h1>

<p align="center"><strong>Your agents, summed.</strong></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Sig is a self-hosted **personal agent** built on **pi-durable** and **Cloudflare Durable Objects**. It lives in your Cloudflare account, remembers your conversations and ongoing work, and connects to coding agents on your own machines.

Its name comes from **Sigma (Σ)**, the summation symbol: bringing the agents across your machines together through one personal agent.

Talk to Sig in its web workspace. Ask it to work on a repository, follow up on a task, or pick up where you left off. Sig coordinates the work; a lightweight **connector** on each machine runs the local agents and brings back their progress and results.

- **One conversation across machines.** Keep track of tasks, follow-ups, and decisions in one place.
- **Your agents, on your computers.** Use pi, or Claude Code when installed, in repositories you choose to connect.
- **Context that lasts.** Conversation and task state persist in the Durable Object. Full coding-agent session records stay on the machine and can be viewed while it is online.

## Get started

Deploy Sig into your Cloudflare account first, then connect a machine where you want work to run. You will need a Cloudflare account and a model-provider API key for Sig; Node.js **22.18+** is needed only for the agent path below and for the connector. The connector supports **macOS and Linux** and needs a local coding agent with its own authentication configured.

### 1. Deploy your personal agent

**One click.** The button clones this repository into your Cloudflare account, builds, and deploys:

Before you start, generate and save a unique password of **at least 15 characters** in your password manager. Enter it as `LOGIN_PASSWORD`. Sig rejects shorter, common, or compromised passwords when it starts, even if Cloudflare accepts them in the deployment form.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/sig)

Give the Worker a name and set your login password in the form. When the build finishes, open the Worker URL and sign in; the setup wizard asks for your model provider's API key.

If deployment reports expired GitHub authorization, follow the [deployment troubleshooting guide](docs/deploy.md#deployment-troubleshooting). Changing the login password does not repair the GitHub connection.

**Or hand it to your coding agent.** Copy this into an agent that can run terminal commands on your computer:

```text
Deploy Sig, my personal agent, to my Cloudflare account.

Repository: https://github.com/iefnaf/sig
Read docs/agent-deploy.md in that repository and follow its runbook.

Check the prerequisites, deploy the Worker and Durable Object, configure
the secrets, verify access, and open the web workspace. Guide me through
Cloudflare authorization and entering my model API key directly in Settings.
Keep secrets out of chat and logs. Finish by verifying that Sig replies
to a message, then give me the deployment URL. I will connect my machines
separately using the connector setup prompt.
```

**Done when:** the web workspace opens and Sig replies to your first message. You can talk to Sig before connecting any machines.

### 2. Connect your computer

Run your coding agent **on the machine you want Sig to work on**, then paste:

```text
Install the Sig connector on this machine and connect it to my existing
personal agent on Cloudflare.

Repository: https://github.com/iefnaf/sig
Read docs/agent-connect.md in that repository and follow its runbook.

Ask me for my Sig deployment URL and which local repositories to connect.
Check Node.js and my local coding-agent setup, install the connector,
and guide me through pairing from the web workspace's Machines page.
Start the connector, register only the repositories I choose, and verify
that this machine and its repositories appear online in Sig.
Keep long-lived credentials out of chat and logs. Finish with a small
read-only task to confirm the connection works end to end.
```

**Done when:** your machine is online in Sig and a read-only task returns a result. Repeat this prompt on any additional machine.

The connector makes an outbound connection to Sig; you do not need to open an inbound port on your computer. Your machine must stay awake and connected for local agents to run.

> If your agent cannot read the repository, give it GitHub access or a local checkout. The connector runbook includes a source-install path when the npm package is unavailable. If `workers.dev` is unreachable from your network, the deployment runbook covers using a custom domain.

## Start a conversation

Once a machine is connected, try:

> “Review the login flow in my-app and tell me what you find.”
>
> “Fix that bug on my Mac using pi.”
>
> “Continue the previous task, and use pnpm this time.”

The workspace brings together messages, task threads, decisions that need you, connected machines, and session records. Its interface supports English and Chinese.

## How it fits together

**You → Sig on Cloudflare → connector on your machine → pi / Claude Code**

The cloud agent uses **`@earendil-works/pi-durable`** for its agent runtime and a **Cloudflare Durable Object** for persistent state and coordination. Each connector maintains a WebSocket connection, starts local coding-agent sessions, and reports progress back to Sig. Your code and full session files stay on the machine; local coding agents use their configured model providers as usual.

## Go further

- [Deploy runbook](docs/agent-deploy.md) · [Connector runbook](docs/agent-connect.md) — instructions for your coding agent.
- [Deployment guide](docs/deploy.md) — manual deployment, model configuration, custom domains, costs, and updates.
- [Usage and API](docs/usage.md) — owner API, local agent behavior, and session viewing.
- [Architecture](docs/design/steward.md) · [Product spec](docs/spec.md) · [Routing eval](docs/routing-eval.md) — for contributors.

## License

Sig is released under the [MIT License](LICENSE).
