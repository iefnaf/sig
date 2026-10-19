# Deploying Shepherd

A Shepherd deployment lives entirely in **your own Cloudflare account**: one Worker (the steward, with its Durable Object), no third-party service in the middle. You talk to it in the **Pip workspace** — a web page the Worker serves — and each of your machines runs a small connector process. This guide walks the whole path: deploy → claim it with your first computer → first run, then everything operational (model keys, costs, secret rotation, updates).

Spec: §12 (onboarding, security, cost). Decisions: [ADR-0003](adr/0003-web-entry-local-sessions.md) (the web is the only owner entry), [ADR-0004](adr/0004-device-first-claim.md) (claim and sign-in), [ADR-0005](adr/0005-agent-driven-deploy.md) (the agent deploy runbook), [ADR-0001](adr/0001-mvp-implementation-baseline.md) #10, #11. The shape of the access design is in [design/web-entry.md](design/web-entry.md).

## How access works (read this once)

- **The workspace has no password and no input on its public pages** ([ADR-0004](adr/0004-device-first-claim.md)). A browser that is not signed in sees only the sign-in page, whose one way in is a one-time link minted on a computer you already paired (`shepherd login`; single use, minutes of validity).
- **The first computer claims the deployment.** `npx @iefnaf/shepherd connect <url>` (no code) authorizes Wrangler with your Cloudflare account, writes a one-time claim secret through the Cloudflare API, and the Worker verifies it — so only someone managing your Cloudflare account can ever claim. Later claims are refused.
- **The deployment owns its keys.** The Durable Object generates its signing secret on first boot; nothing secret is typed at deploy time. A still-set legacy `SERVER_KEY` keeps verifying so pre-upgrade machines and sessions survive the upgrade.
- **Your machines** do not sign in through a browser. They pair once with a one-time code (`/pair`) and then connect to the steward's machine socket (`/agents/steward/owner`) with their own per-machine credential, which you can revoke from the workspace.

## Deploy

Three ways in, same destination. **The agent runbook is the primary path** ([ADR-0005](adr/0005-agent-driven-deploy.md)): the owner hands their own coding agent one paragraph, and the agent deploys, verifies, claims the first machine, and opens the workspace — the owner's two clicks are the Cloudflare consent and the first message. Secrets never transit the agent ([discipline](agent-deploy.md#discipline-read-first-applies-throughout)).

**With your coding agent** — give it this paragraph:

> Deploy Pip for me: read `docs/agent-deploy.md` in [github.com/iefnaf/shepherd](https://github.com/iefnaf/shepherd) and follow it exactly. Stop where it says a human is needed.

**No agent at hand?** The Deploy-to-Cloudflare button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/shepherd)

It clones the repository into your own GitHub account, provisions the Durable Object, and deploys through Workers Builds; later pushes to your copy's `main` branch redeploy automatically. The form carries nothing secret ([ADR-0004](adr/0004-device-first-claim.md)) — pick a Worker name (it becomes `<name>.<your-subdomain>.workers.dev`); `MODEL_KEY` can be set now or pasted into the workspace later. Then continue from [Claim it with your first computer](#claim-it-with-your-first-computer).

**From a terminal** (the Wrangler config sits at the repo root):

```sh
git clone https://github.com/iefnaf/shepherd && cd shepherd
pnpm install
npm run deploy -- --name <unique-name>   # wrangler deploy + the SHEPHERD_IDENTITY stamp
```

workers.dev addresses are global across accounts, so pick a collision-safe name. `--dry-run` builds without deploying.

## Custom domain (optional)

The default workers.dev address runs a complete deployment; a custom domain is needed only where workers.dev is unreachable, or because you want your own hostname. It must be a domain whose DNS is hosted on your Cloudflare account (free plan is enough):

1. Dashboard → **Workers & Pages** → your Worker → **Settings → Domains & Routes** → **Add → Custom domain**, e.g. `pip.example.com`. Cloudflare creates the DNS record and the certificate.
2. Run the claim and every later `shepherd connect` against the final hostname — machines dial the address they were given.
3. (Optional) Disable the `workers.dev` route on the same page, or set `"workers_dev": false` in `wrangler.jsonc` (otherwise a later `wrangler deploy` re-enables it).

In mainland China `*.workers.dev` is blocked outright, for people and for the connector's WebSocket alike; a Cloudflare custom domain usually works there but reachability varies by domain, region and ISP (the spike's own domain returned 200 from mainland China with no proxy, ~1.2 s, [research §8.1](research/feishu-channel.md)). If the connector reconnect-loops from a mainland machine, try another domain. The agent runbook detects this case itself: [Appendix A](agent-deploy.md#appendix-a--custom-domain).

## Claim it with your first computer

The deploy prints the one step left. On the computer you want Pip to run agents from:

```sh
npx @iefnaf/shepherd connect https://<your-domain>
```

1. Wrangler opens your browser once and asks to allow `account:read` + `workers_scripts:write` — sign in with the account that deployed.
2. The command finds the exact Worker behind the URL, writes a one-time claim secret through the Cloudflare API, and the deployment verifies it. Your computer pairs as the deployment's first machine, and the command prints a one-time link: open it in your browser and you are in the workspace.
3. Every later browser (a phone, a laptop) signs in the same way: run `shepherd login` on any paired computer and open the link it prints. The link works once and expires in minutes.

Lost every paired computer? Run `npx @iefnaf/shepherd connect <url>` again on a new one — the same Cloudflare authorization re-claims it (data stays; old machines and sessions are dropped).

## First run

1. **Model key** — if you did not set `MODEL_KEY` at deploy, the workspace shows a notice: open **Settings** (the avatar, top right) and paste your provider's API key. It is sealed in your own account and never shown again.
2. **Add a machine** — the machines panel (top bar → **Machines**) → **Add a machine** → **Create pairing command**. Run the command it shows (see [Connector install](#connector-install)) on the computer; the machine appears in the panel.
3. Tell Pip what you want done. Replies, questions and decisions arrive in the conversation and are kept until you answer — also while no page is open, so you find them when you come back.

## Model provider

The steward's own conversation model is **provider-configurable, default DeepSeek** (`deepseek-flash`, the routing-eval baseline — ADR-0001 #11). Which provider and model it talks to is deploy config: `vars.STEWARD_MODEL` in the root `wrangler.jsonc` (JSON — `{"provider": …, "modelId": …, "baseUrl": …}`), defaulting to `deepseek`/`deepseek-flash`; changing it means re-running the routing eval (ADR-0001 #14).

The key is **sealed (AES-GCM, under the Durable Object's own auth root — [ADR-0004](adr/0004-device-first-claim.md)) inside its storage** — spec §12.2's "model keys stored encrypted in the user's own Cloudflare account". It gets there one of two ways: the `MODEL_KEY` secret you set at deploy is consumed the first time the steward reads its model config (afterwards the env secret is inert and can be deleted with `wrangler secret delete MODEL_KEY`), or you paste it into **Settings** in the workspace, which also replaces a key already saved. A key sealed for one provider is never sent to another. The key is used only for outbound calls from your Worker to the provider.

Note the boundary: `MODEL_KEY` pays for the **steward's own** thinking (routing, replies, summaries). The coding agents the steward dispatches on your machines (pi, Claude Code) use **their own logins/keys on those machines** and are never billed through this deployment.

## Connector install

Each machine you want to dispatch work to runs a small daemon that holds a WebSocket to the steward and drives the local coding agents. The package is `@iefnaf/shepherd` (ADR-0001 #10); on the machine (macOS or Linux, Node ≥ 22.18), paste the command the workspace gave you:

```sh
npx @iefnaf/shepherd connect https://pip.example.com <pairing-code>
```

That pairs the machine (redeeming the one-time code — valid 10 minutes, usable once), installs a background service — launchd agent (`dev.shepherd.connector`) on macOS, systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs attached to the terminal instead (containers, dev boxes). Day-to-day:

```sh
shepherd add-repo ~/code/myproject   # allow-list a repo for start_worker (machine-local by design)
shepherd repo-config ~/code/myproject --workspace serial   # per-repo workspace: worktree (default) | serial | main
shepherd repo-config ~/code/myproject --approve            # trust the repo's local pi extensions (§13; never settable remotely)
shepherd status                       # service, pairing, workers, installed assets
shepherd logs                         # tail ~/.shepherd/logs/connector.log (no keys, no session content)
shepherd stop | start | restart       # control the service
shepherd upgrade                      # npm-install the latest package and restart
shepherd uninstall                    # remove the service (keeps ~/.shepherd data)
```

State lives under `~/.shepherd/` (`SHEPHERD_HOME` to move it). A machine is revoked from the workspace's machines panel (**Revoke**): its credential dies at once and the connection is closed. Machines paired before the move to the web keep working unchanged.

Prerequisites: the coding agent you intend to use (pi first, Claude Code next) already installed and logged in — Shepherd never touches the agent's own credentials.

### Reading a session

Each worker's **Agent sessions** view in the workspace shows its recorded session as the agent wrote it — messages, tool calls with their full arguments and results, images. The record stays **on the machine** (pi's session file; Claude Code's transcript under `~/.claude/projects/`); the Worker only relays it to your browser while the machine's connector is connected and never stores or logs it. A finished agent process does not matter — the file is still read — but a disconnected machine cannot be read, and the viewer says so instead of showing an empty session. Full reads need the connector that ships with this release: a machine still running an older one is told apart ("too old to read full sessions — run `shepherd upgrade`") rather than shown as a broken session; everything else works with it unchanged.

## Costs

Shepherd is designed to be **dormant — and cost nothing — most of the time** (spec §12.3). Orders of magnitude, so the bill never surprises you (check current prices on Cloudflare's pricing page; these drift):

**Cloudflare (the deployment itself)**

- The meters that matter: **Durable Object requests** (every browser API call and every WebSocket message to/from the connector counts as one), **DO duration** (billed in GB-seconds while the steward is *awake* — a hibernating steward with an idle WebSocket bills nothing), and **SQLite storage** (your ledger/threads; kilobytes to megabytes — session records are not stored here).
- An open workspace tab keeps a socket and refreshes now and then; an open **session view** on a running agent asks the machine for new entries every few seconds while the tab is visible. Close the tab and both stop.
- **Free tier**: a personal deployment — a connected machine, a handful of conversations a day, the daily digest — generally fits inside the Workers free plan. $0.
- **Workers Paid ($5/month)**: covers a comfortably heavy personal deployment; beyond the included allowances the overage meters are fractions of a cent per million requests and ~$0.20/GB-month of storage. Realistic total for one active user: **$0–6/month**. If you are paying tens of dollars, something (a hot loop, a chatty routine) is misbehaving — the DO's logs will show it.

**Model calls (the steward's own LLM)**

- The drivers: **number of conversations/messages** (each inbound event can wake the model), **summary and digest generation** (routines), and report composition (mostly templates — no LLM). Sending a task to a coding agent costs *one* steward wake plus the agent's own tokens on your machine.
- With the default DeepSeek-class model, a wake over a conversation's context is a few thousand tokens — **well under a cent each**; a moderately active day is **single-digit cents**; a heavy month is **a few dollars**.
- **Daily budget soft cap** (`vars.DAILY_BUDGET_USD` in the root `wrangler.jsonc`, default `$1`/UTC day, `0` = only your messages reach the model): once the day's model spend reaches the cap, worker events, routine fires, and follow-ups no longer wake the model — done reports, failure/fallback notices, digest cards, and every reply to you keep working (they never depended on the model). The workspace header shows today's spend against the cap, and your next reply carries a one-line notice the first time this happens each day. The figure is an estimate from the provider's reported usage and catalog pricing, not a bill; the counter resets at 00:00 UTC.

## Secrets and rotation

The deployment's signing key is **not a secret you set**: the Durable Object generates its auth root on first boot and keeps it in its own storage ([ADR-0004](adr/0004-device-first-claim.md)). What can exist as Worker secrets:

| Secret | Role | Notes |
| --- | --- | --- |
| `MODEL_KEY` | Your model provider key. | Sealed into DO storage on first read; the env secret is deletable afterwards ([Model provider](#model-provider)). |
| `SERVER_KEY` | Legacy: the pre-ADR-0004 deploy-time signing key. | A still-set one keeps verifying so pre-upgrade machines and sessions survive; new deployments never set it. |
| `SERVER_KEY_PREVIOUS` | Legacy rotation-window key. | Exists only during a `SERVER_KEY` rotation; set and deleted within the procedure. |

Secrets at rest: the model key is AES-GCM sealed under the DO's auth root; a raw storage dump exposes neither it nor your sessions (those are not in the dump at all). `/pair` is brute-force guarded per source IP and globally (5 failed codes lock pairing for 15 minutes).

### Rotating SERVER_KEY (and why the redeploy in the middle is not optional)

Rotation keeps every machine paired: tokens carry the signing key's id, and `SERVER_KEY_PREVIOUS` holds a verification window open while connectors pick up rekeyed tokens (details in the [protocol design](design/connector-do-protocol.md) §5.1):

```sh
wrangler secret put SERVER_KEY_PREVIOUS   # the OLD key
wrangler secret put SERVER_KEY            # the NEW key (openssl rand -hex 32)
wrangler deploy                            # evicts isolates still pinning the old secrets
# …let every machine reconnect once (each welcome hands the connector a rekeyed token)…
wrangler secret delete SERVER_KEY_PREVIOUS
wrangler deploy
```

Machines that never reconnect during the window must re-pair after it closes. Application sessions made under the old key keep verifying through the window; the sealed model key keeps opening through the window and converges onto the new key as it is next written.

> **Evict the resident isolate before verifying.** A Durable Object isolate that something keeps alive — an open connector WebSocket, a pending alarm — **pins the previous code and the previous secrets for minutes after `wrangler secret put` (or `wrangler deploy`) returns.** This was verified live in the spike phase ([spike conclusions](spike-conclusions.md) §2). The `wrangler deploy` line in the recipe above is exactly this eviction: redeploying forces resident isolates out, which is also the recovery move for any sick isolate. Without it, testing the new secret against an old isolate either proves nothing or makes a healthy rotation look broken. The quieter alternative — stopping every connector so the WebSocket drops and the DO goes idle — works too, it is just slower.

The same pinning applies after ordinary code deploys: a resident isolate runs the old code until it goes idle or is evicted. If a freshly deployed fix "doesn't seem to be live", evict first, conclude second.

## Updating your deployment

- One-click deploys: push (or sync from upstream) to your copy's `main` — Workers Builds redeploys automatically.
- Manual: `git pull` in your clone, then `wrangler deploy`. Database migrations inside the Durable Object run automatically on first use after the deploy; no manual step exists or is needed.
- After any update, remember the resident-isolate rule above when verifying new behavior.

### Coming from the Feishu-era deployment

Nothing is lost: threads, worker records, the pending decisions, and messages Pip still had queued for Feishu all appear in the workspace after the update, and machines paired before keep connecting on their old address. What changes is the front door — the web workspace, with its device-first claim and sign-in ([ADR-0004](adr/0004-device-first-claim.md)). The Feishu bot, its webhook and the one-time login links are not served any more; the old Feishu code remains in the repository only so its tests keep guarding it, and can be deleted or revived later without touching the workspace. `SETUP_TOKEN` is no longer used and can be deleted.

## Troubleshooting

- **`/pair` answers `already_claimed`** — this deployment was claimed before. If it was not you: whoever manages the Cloudflare account can claim on a new machine; nothing else can.
- **The sign-in page never changes into the workspace** — the one-time link was spent, expired, or minted for another deployment: run `shepherd login` again and open the fresh link.
- **`npm run deploy` fails on the Worker name** — workers.dev names are global across accounts; pick another (`--name <unique-name>`).
- **A just-deployed change "isn't live"** — a resident Durable Object isolate pins the previous code for minutes; redeploy once or wait, then re-verify ([secrets and rotation](#secrets-and-rotation) explains why).
- **A machine's session view says it is offline, or that no record was found** — the record lives only on that machine: it is readable while the connector is connected, and gone if the file was deleted there. Neither case is shown as an empty session.
- **Connector reconnect-loops from a mainland machine** — `workers.dev` is blocked there; point it at the custom domain.
- **Every steward request returns 1101 while plain Worker routes still answer** — a Cloudflare DO/platform incident (seen in the spike, §5): redeploying does not help; the connector's retry loop self-heals and no persisted data is lost. Wait it out.
- **A just-rotated secret "doesn't work"** — resident isolate; see [secrets and rotation](#secrets-and-rotation).
- **Pip answers "⚠️ 还没有配置模型 key…"** — the deployment has no model key yet (the workspace also shows a notice with an **Add key** button). Add it in Settings (or set `MODEL_KEY`) and send the message again.
- **Pip answers "⚠️ 模型服务拒绝了这个 API key"** — the provider rejected the key itself (401: invalid or expired). Re-paste a fresh key in Settings; the provider's exact error is in the channel log (`model_call_error`).
- **Any other failed run says "⚠️ 总管这轮没有跑成…"** — the model call failed or was interrupted; retry, and if it persists the channel log's `model_call_error` entry carries the provider's error text.
