# Agent deploy runbook

You are a coding agent helping the owner deploy Sig to their own Cloudflare account. This runbook ends with a working personal agent and an open web workspace. Connecting computers is a separate step: use [agent-connect.md](agent-connect.md) on each target machine afterwards. Follow this runbook top to bottom, verify each numbered step before moving on, and report each step in one line as you complete it. Anything unexpected: surface it, don't improvise around it.

Decisions behind the flow: [ADR-0010](adr/0010-browser-password-authentication.md) defines browser sign-in and key ownership. [ADR-0007](adr/0007-agent-driven-deploy.md) defines agent-guided deployment.

## Discipline (read first, applies throughout)

- **Secrets never transit you.** No API key, token or password may appear in your context, your tool arguments, or output you echo. The owner enters the login password in the deployment form or Cloudflare dashboard. The model key goes into the workspace's Settings page. Preserve explicit SERVER_KEY secrets on existing deployments.
- **Destruction and spending are the owner's calls.** Never delete a Worker, secret, or DNS record without an explicit go-ahead — a Worker deletion destroys the deployment's data. The Wrangler OAuth consent is the owner's click; automate nothing around it.
- This machine runs the deployment tools; Sig itself runs on Cloudflare. Do not install a connector as part of this runbook. If an existing deployment is present, identify it before making changes; do not replace its secrets or create a second deployment by accident.

## 0 · Preconditions

- Node ≥ 22.18 (`node -v`), npm, git, and the pnpm version pinned in the repository's `package.json` (`packageManager`). Use Corepack to select it when available.
- Access to [iefnaf/sig](https://github.com/iefnaf/sig), or an existing local checkout. If GitHub denies access, ask the owner to authorize it before cloning.
- A Cloudflare account and a model-provider API key (see [costs](deploy.md#costs)). If an account is needed, the owner creates it before continuing.
- A proxy network? Export `HTTPS_PROXY`/`HTTP_PROXY` before every wrangler and curl step. If step 3's probe cannot reach the workers.dev address, do [Appendix A](#appendix-a--custom-domain) before step 4.

## 1 · Cloudflare authorization — the owner's click

```sh
npx wrangler login
```

A browser opens; the owner signs in with the account that will own the deployment and clicks **Allow**. Verify with `npx wrangler whoami`.

## 2 · Deploy under a unique name

For a new deployment, pick a distinct Worker name such as `sig-<two random words or 4 hex chars>` to avoid overwriting another Worker in the owner's account. For an update, use the existing deployment's name instead.

```sh
git clone https://github.com/iefnaf/sig && cd sig
pnpm install
npm run deploy -- --name <name>
```

Reuse a suitable checkout if one already exists. The script deploys the Worker and wrangler prints the URL — `https://<name>.<subdomain>.workers.dev`. Read it from the output; every later step uses it. The Durable Object binding and SQLite migration are in the root `wrangler.jsonc` and deploy with the Worker.

## 3 · Initialize the secrets

The owner sets `LOGIN_PASSWORD` in the deployment form or under the Worker's **Settings → Variables and Secrets** in the Cloudflare dashboard. Require at least 15 characters and recommend a password manager. The application rejects common and compromised passwords. Never ask the owner to paste the password into chat.

For terminal deployment, the owner can run this interactive command in their own terminal:

```sh
npx wrangler secret put LOGIN_PASSWORD --name <name>
npx wrangler deploy --name <name>
```

Deploy the version containing the new Secret before continuing. New deployments generate internal keys automatically. For an existing deployment, preserve `SERVER_KEY` and `SERVER_KEY_PREVIOUS`; adding a browser password does not rotate those keys.

`MODEL_KEY` no longer rides in the deployment form or the secrets. The model key has exactly one channel now: the owner pastes it into the workspace's Settings at step 5.

Verify the unauthenticated gates against the printed URL:

```sh
curl -o /dev/null -sW '%{http_code}\n' https://<url>/app                                   # 200 — sign-in page
curl -o /dev/null -sW '%{http_code}\n' https://<url>/api/messages                          # 401 — no bearer
```

Inspect the login page for usable password and passkey controls. The owner's browser sign-in in the next step verifies the configured password. Do not send a message before the owner configures a model.

Anything else (timeouts from this machine) → [Appendix A](#appendix-a--custom-domain) for a custom domain, then re-run this step against the new hostname before continuing.

## 4 · Open the workspace

Open the deployment's root URL in the owner's browser. The owner enters their password directly on the login page. After sign-in, the model setup wizard appears, followed by optional passkey registration. Do not collect the password through agent tools.

If the configured password is rejected or unavailable, follow [browser access recovery](deploy.md#recover-browser-access). Wait for a visible authenticated workspace before continuing.

## 5 · Model key — the owner's hands only

Ask the owner for a model provider API key (default provider DeepSeek: [platform.deepseek.com](https://platform.deepseek.com) → API Keys). **The owner pastes it into the workspace**: Settings (the avatar, top right). If the owner offers the key in the chat, decline and point back at the Settings page — a rejected key is diagnosed there with a clear notice, too.

## 6 · First message and handoff

The owner sends a message ("hi") in the workspace and Sig answers. Do not report success until a model reply is visible. No connector is needed for this check.

Hand over the deployment URL and Worker name. The owner can open that same URL on a phone or second browser and sign in with a password or passkey. Point the owner to the second prompt in the [README](../README.md#2-connect-your-computer), backed by [agent-connect.md](agent-connect.md), to connect a computer. Link to [browser access recovery](deploy.md#recover-browser-access) for password resets.

## Appendix A · Custom domain

Needed when workers.dev is unreachable (mainland China) or the owner wants their own hostname. Requires a domain whose DNS is hosted on the same Cloudflare account (free plan enough).

1. List the account's zones (`npx wrangler` auth token → `GET https://api.cloudflare.com/client/v4/zones`), agree with the owner on a hostname (`sig.example.com`).
2. Attach it — dashboard: Workers & Pages → the Worker → Settings → Domains & Routes → Add → Custom domain; or the API: `PUT /accounts/{account_id}/workers/domains` with `{hostname, zone_id, service, environment:"production"}`.
3. Re-run step 3's verification against the new hostname. Hand off **the final URL** for connector setup — machines dial the address they are given. If machines were already paired with a different hostname, reconnect them using [agent-connect.md](agent-connect.md).
4. Optional: disable the workers.dev route (Worker settings, or `"workers_dev": false`) — the deployment answers nothing owner-facing there anyway.

## Failure playbook

- **Deploy fails on the name** (already taken) — pick another name, retry step 2.
- **`/api/messages` answers 401 with the key set** — a resident Durable Object isolate pins old secrets for minutes after a `secret put`; redeploy once (`npx wrangler deploy --name <name>`), or wait a minute, then re-verify. This is expected platform behavior, not a wrong key.
- **A just-deployed fix "isn't live", or `/app` behaves like an older version** — resident isolate again; same remedy.
- **Sig answers "模型服务拒绝了这个 API key"** — the pasted key is invalid or expired; the owner re-pastes in Settings. The provider's exact error is recorded in the channel log as `model_call_error`.
- **Sig answers "还没有配置模型 key"** — step 5 hasn't happened; the workspace's notice carries an Add-key button.
- **wrangler fails to reach Cloudflare from mainland China** — set `HTTPS_PROXY`; `wrangler tail` needs it explicitly. A proxy that blocks the deployment's hostname: `curl --noproxy '*'` for verification steps.
- **The connector reconnect-loops after a redeploy** — resident isolate again; its retry loop self-heals within a minute. Minutes of looping, then check `sig status` and `sig logs`.
- **Explicit `SERVER_KEY` lost** — it cannot be re-derived. Mint a replacement, keep the old key in `SERVER_KEY_PREVIOUS` while machines reconnect (see [deploy.md](deploy.md#secrets-and-rotation)), and re-pair machines that miss the window. Fresh generated-key deployments have no `SERVER_KEY`; preserve their Durable Object storage instead.
