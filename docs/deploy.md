# Deploying Sig

A Sig deployment lives entirely in **your own Cloudflare account**: one Worker (the steward, with its Durable Object), no third-party service in the middle. Around it you connect machines, each running a small connector process. This guide walks the whole path: deploy → custom domain → model key → connector, then everything operational (costs, secret rotation, updates).

Open the deployment URL to use the web workspace. Sign in with your deployment password or a registered passkey. Existing deployments can also use their `SERVER_KEY`-gated [owner API](usage.md#the-owner-api). [ADR-0010](adr/0010-browser-password-authentication.md) describes browser authentication and recovery.

## Two ways to deploy

- **One click** — the primary channel ([ADR-0012](adr/0012-deploy-button-primary.md)). The [Deploy-to-Cloudflare button in the README](../README.md#get-started) builds and deploys into your own account and asks for the login password.
- **With your coding agent** — the guided channel ([ADR-0007](adr/0007-agent-driven-deploy.md)): end-to-end verification, custom domains where workers.dev is unreachable, and agent-operated setups. Use the [prompts in the README](../README.md#get-started): [agent-deploy.md](agent-deploy.md) deploys Sig, configures the secrets, and opens the workspace; [agent-connect.md](agent-connect.md) installs and pairs each machine separately. `npm run deploy -- --name <name>` wraps the deploy step.

## One-click deploy

Generate and save a unique password of **at least 15 characters** in your password manager before opening the form.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iefnaf/sig)

The form clones the repo into your own account and asks for one secret:

| Secret | What it is |
|---|---|
| `LOGIN_PASSWORD` | Your Sig login password. Use at least 15 characters and save it in a password manager. Common and compromised passwords are rejected. |

Your model provider's API key (default provider: DeepSeek — [platform.deepseek.com](https://platform.deepseek.com)) is not part of the form. After the build, open the Worker URL and sign in; the setup wizard, or the workspace's **Settings** page, takes the key.

The form collects a Cloudflare Secret. Sig checks the password when the application starts, so a completed deployment does not mean the password passed its policy. A rejected password cannot create a browser session. Follow the recovery instructions on the login page to replace it.

From a terminal instead:

```sh
git clone https://github.com/iefnaf/sig && cd sig
pnpm install
wrangler deploy
wrangler secret put LOGIN_PASSWORD
wrangler deploy
```

Open the Worker URL to sign in. Internal keys are generated and retained in the owner Durable Object. You do not need a `SERVER_KEY` for the browser or machine pairing.

For an existing deployment with an explicit `SERVER_KEY`, keep that secret and any rotation-window key. Its owner API remains available:

```sh
curl -X POST https://<your-worker>.workers.dev/api/messages \
  -H "Authorization: Bearer $SERVER_KEY" -H 'content-type: application/json' \
  -d '{"text": "你好"}'
curl "https://<your-worker>.workers.dev/api/messages?limit=5" -H "Authorization: Bearer $SERVER_KEY"
```

## Deployment troubleshooting

### GitHub authorization expired

If Cloudflare reports `Your GitHub authorization has expired`, repair the Cloudflare GitHub connection using the [official reauthorization instructions](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#reinstall-the-cloudflare-github-app), then retry deployment. This error concerns repository access, not `LOGIN_PASSWORD`.

The Cloudflare Workers and Pages GitHub App serves both products. Reinstalling it temporarily interrupts new builds for connected repositories, while existing deployments remain hosted. Restore the repository access needed by your existing projects.

### Deployment succeeds but password sign-in fails

If Sig reports a rejected deployment password, open your Worker in Cloudflare, then **Settings > Variables and Secrets**. Replace `LOGIN_PASSWORD` with a unique password of at least 15 characters and deploy the change. Merely entering a different password on Sig's login page does not change the configured Secret.

If the login page reports that password checking is temporarily unavailable, wait a minute and retry. A checking-service outage does not mean your password failed policy. Existing passkeys remain available.

## Opening the web workspace

Open the root URL or `/app`. Sign in with the password set during deployment, or choose **Use a passkey**. An authenticated browser opens the workspace directly. A second device uses the same URL and either authentication method without requiring the first device to be online.

The browser session lasts seven days. On first use, the workspace guides you through connecting a model and offers passkey registration. You can skip the passkey step and add one later in **Settings → Security**. Authentication changes require a recent sign-in.

Existing explicit-key deployments can still generate single-use links for compatibility:

```sh
curl -X POST https://<your-worker>.workers.dev/api/login-link -H "Authorization: Bearer $SERVER_KEY"
# → { "url": "https://<your-worker>.workers.dev/link/wl1.home.…" }  — one use, 15 minutes
```

These links are not required for ordinary browser sign-in.

## Recover browser access

If neither your password nor a passkey is available, open your Worker in the Cloudflare dashboard. In **Settings → Variables and Secrets**, replace the `LOGIN_PASSWORD` secret with a new strong password and deploy the updated Worker version. Open the Sig URL and sign in with the new password.

A password reset revokes existing browser sessions and outstanding login links. Existing passkeys remain registered. Machine credentials and encrypted model settings are independent of the login password and remain usable.

Keep `LOGIN_PASSWORD` configured as the dashboard-managed source of truth. The application stores a salted verifier, while Cloudflare retains the configured Secret. Removing the Secret disables password login; it does not provide a way for an anonymous visitor to claim the instance. If password screening is unavailable or the configured password fails policy, use a passkey or correct the Secret and retry.

Deploy authentication changes to the whole Worker version. Do not use gradual deployments with different password Secrets, because old and new versions must not alternate password configuration.

## Pull request previews

CI deploys a Cloudflare Worker Preview for every pull request from this repository. Add these repository secrets before opening the first preview:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A token created from Cloudflare's **Edit Cloudflare Workers** template. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID. |

After CI passes, it comments on the pull request with a `*.previews.iefnaf.cc` URL and a reusable sign-in link. The preview link expires after 24 hours. CI generates a new preview `SERVER_KEY` for every deployment, so an older sign-in link or browser session stops working after a new push.

Previews use the zero-cost `faux` model and get separate Durable Object storage. Pull requests from forks do not receive a Preview because they cannot access the repository secrets. Closing a pull request deletes its Preview and that storage.

## Custom domain

Not required for function anymore (there is no chat platform that must reach you), but **mainland users should bind one**: `*.workers.dev` is blocked there outright (DNS pollution + SNI reset, live-tested in the spike), and the API, the web app, and the connector's WebSocket all need to reach the deployment. The agent runbook keeps this as an appendix attached only when workers.dev is unreachable.

1. Dashboard → **Workers & Pages** → your Sig Worker → **Settings → Domains & Routes** → **Add → Custom domain**, e.g. `sig.example.com` (a zone hosted on Cloudflare DNS). Cloudflare creates the DNS record and the certificate.
2. Use `https://sig.example.com` everywhere: API calls, `sig connect`, web links.

Passkeys are bound to the deployment hostname by WebAuthn. If you add or change the custom domain later, sign in with the password on the new hostname and register a new passkey there; recovery and rate limits remain deployment-wide.

A Cloudflare custom domain is not guaranteed reachable from mainland China either; if your machine cannot connect, verify with a direct `curl` before debugging anything else.

## Model provider

The steward needs one LLM behind it. Default: `deepseek` / `deepseek-flash` (the [routing eval](routing-eval.md) baseline). Override per deployment in the root `wrangler.jsonc`:

```jsonc
"vars": { "STEWARD_MODEL": "{\"provider\": \"deepseek\", \"modelId\": \"deepseek-v4-pro\"}" }
```

To connect a provider at runtime, open **Settings → Model providers** and select its tile. Choose the plan and region if offered, paste the API key, and choose a model and thinking level. The dialog shows the preset endpoint and links to the provider's key page and console. **Test connection** makes a small model request using the current form values without saving them. It may use provider credits. Save the configuration when ready.

The chat input shows the active model and thinking level. Its searchable model menu groups models by configured provider; the thinking menu shows only levels that the model supports. Changes are saved and applied to the conversation without a redeploy. If a model does not support the current thinking level, Sig uses its advertised default and tells you. Wait for the current reply to finish before switching.

A runtime selection wins over `vars.STEWARD_MODEL`. Each provider's key is sealed separately in the Durable Object (`sh_provider_key`), so switching back does not require key re-entry. `MODEL_KEY` seeds the default provider's key once. Missing credentials, rejected keys, and unavailable models produce instructions for fixing the configuration. Changing the shipped default (`deepseek` / `deepseek-flash`) requires re-running the routing eval (ADR-0001 decision 14); changing your own deployment's selection does not.

The daily budget soft cap (issue #28): `vars.DAILY_BUDGET_USD` (dollars per UTC day, default $1, `0` disables automatic model wakes). Past it, events/routines/follow-ups stop waking the model while done reports, pushes, digests, and replies continue.

## Connecting a machine

For agent-guided setup, follow [agent-connect.md](agent-connect.md), including a source-install fallback if the npm package is unavailable. Install the CLI with `npm install --global @alexlikevibe/sig` (or that source fallback) before using the `sig` management commands below.

Each machine you want to dispatch work to runs a small daemon that holds a WebSocket to the steward and drives the local coding agents. Open **Machines** in the workspace and generate the connection command there.

Existing explicit-key deployments can also request a pairing code through the owner API:

```sh
curl -X POST https://sig.example.com/api/pairing -H "Authorization: Bearer $SERVER_KEY"
# → { "code": "AB12CD34", "command": "npx @alexlikevibe/sig connect https://sig.example.com AB12CD34" }
```

Run that command on the machine (macOS or Linux, Node ≥ 22.18). It pairs (redeeming the one-time code), installs a background service — launchd agent (`dev.sig.connector`) on macOS, systemd user unit on Linux — and starts it now and at login. `connect --foreground` runs attached instead (containers, dev boxes). On filtered networks append `--proxy http://127.0.0.1:7890` (issue #68): both channels, `git`, and worker children follow it, and it is stored so the service needs no inherited environment.

In the workspace's **Machines** page, choose **Add directory** on the online machine to register each existing directory. Sig detects a Git repository automatically; a plain directory registers too, with no branch, worktree isolation, or PR support. Registration updates the machine and the workspace without a restart. Project approval and write policy remain local settings managed with `sig repo-config`.

Day-to-day:

```sh
sig repo-config ~/code/myproject --isolation worktree --concurrency serial   # worktree (default) | in-place isolation; parallel (default) | serial concurrency
sig repo-config ~/code/myproject --approve            # trust the repo's local pi extensions (§13)
sig status                       # service, pairing, workers, installed assets
sig proxy [url]                  # show/set the stored proxy; --clear removes it (issue #68)
sig doctor                       # pairing, service, proxy, reachability diagnosis (issue #68)
sig logs                         # tail ~/.sig/logs/connector.log (no keys, no session content)
sig stop | start | restart       # control the service
sig upgrade                      # npm-install the latest package and restart the service
sig uninstall                    # remove the service (keeps ~/.sig data)
```

State lives under `~/.sig/` (`SIG_HOME` to move it). Prerequisites: the coding agent you intend to use (pi first, Claude Code next) already installed and logged in — Sig never touches the agent's own credentials. Revoke a machine any time from the workspace (机器 → 撤销): its token dies immediately (close code 4403).

## Costs

Sig is designed to be **dormant — and cost nothing — most of the time** (spec §12.3). Orders of magnitude, so the bill never surprises you (check current prices on Cloudflare's pricing page; these drift):

- **Cloudflare**: one Worker + one Durable Object. Workers free tier includes 100k requests/day; Durable Objects billing is per-request and per-GB-duration — a personal deployment idles far below the paid tier's minimums, and the WebSocket hibernation API means connected-but-idle connectors cost ~nothing.
- **Model**: the real cost. deepseek-flash list prices make a typical day (a handful of dispatches + bookkeeping wakes) well under the default $1/day cap; the budget counter is exact and `/花费` reads it without a model call.

## Secrets and rotation

New deployments generate internal keys in the owner Durable Object. Keep that object's storage when updating or recovering the deployment. Do not add `SERVER_KEY` or `SERVER_KEY_PREVIOUS` to a generated-key deployment; it fails closed instead of replacing the existing keys. The internal keys are not exposed as an API credential. Changing `LOGIN_PASSWORD` does not rotate them.

For existing deployments, retain `SERVER_KEY` and any `SERVER_KEY_PREVIOUS` during the upgrade. Set `LOGIN_PASSWORD` to enable password sign-in. Do not remove the old key as part of this feature's migration. Rollback to an older build is supported only for deployments retaining their explicit keys; a deployment with generated keys requires a build that understands those keys.

`SERVER_KEY` signs connector device tokens, seals secrets at rest, and gates the owner API. It is rotatable without re-pairing every machine — tokens carry the signing key's id, and `SERVER_KEY_PREVIOUS` keeps a verification window open (protocol design §5.1). The API accepts the previous key through the window, so your scripts keep working while you swap them:

```sh
wrangler secret put SERVER_KEY_PREVIOUS   # the OLD key
wrangler secret put SERVER_KEY            # the NEW key (openssl rand -hex 32)
wrangler deploy                           # evicts isolates still pinning the old secrets
# …let every machine reconnect once (each welcome hands the connector a rekeyed token)…
wrangler secret delete SERVER_KEY_PREVIOUS
wrangler deploy
```

Why the `wrangler deploy` in between matters: a resident Durable Object isolate pins old code and old secrets for minutes after a secret change — evict it before verifying a rotation. Machines that never reconnect during the window must re-pair after it closes (mint a code via `POST /api/pairing`). Open browser sessions and unopened login links survive a rotation the same way (the previous key stays in the verification set).

`MODEL_KEY` is consumed once to seed the sealed `sh_model` row; after that you can delete the env secret — the sealed row answers from then on.

## Updates

`git pull && wrangler deploy` updates the steward. On each machine, `sig upgrade` npm-installs the latest connector package and restarts the service; the fresh daemon rewrites its versioned pi assets on boot (old versions stay on disk for sessions still referencing them).
