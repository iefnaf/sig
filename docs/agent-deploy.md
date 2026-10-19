# Agent deploy runbook

You are a coding agent on the owner's machine. This runbook turns a fresh Cloudflare account into a running Pip — deployed, claimed by this machine, and signed in — with the owner's two clicks where they must be. Follow it top to bottom, verify each numbered step before moving on, and report each step in one line as you complete it. Anything unexpected: surface it, don't improvise around it.

Decisions behind the flow: [ADR-0004](adr/0004-device-first-claim.md) (who owns a deployment and how sign-in works), [ADR-0005](adr/0005-agent-driven-deploy.md) (this channel).

## Discipline (read first, applies throughout)

- **Secrets never transit you.** No API key, token or password may appear in your context, your tool arguments, or output you echo — a key pasted into the chat is already leaked into a session transcript and a third-party model provider. Where a secret is needed, the owner supplies it through a channel you point at but do not observe: the workspace's Settings page, or a command the owner runs in their own terminal.
- **Destruction and spending are the owner's calls.** Never delete a Worker, secret, or DNS record without an explicit go-ahead — a Worker deletion destroys the deployment's data. The Wrangler OAuth consent is the owner's click; automate nothing around it.
- You deploy onto **the machine you are running on** — it becomes Pip's first machine. If that is wrong (the owner wants Pip elsewhere), stop and say so before step 2.

## 0 · Preconditions

- Node ≥ 22.18 (`node -v`), npm, git.
- A Cloudflare account (the free plan runs a personal Pip at $0 — see [costs](deploy.md#costs)). None yet? Stop; the owner creates one, then continue.
- A proxy network? Export `HTTPS_PROXY`/`HTTP_PROXY` before every wrangler and curl step. Mainland China additionally blocks `*.workers.dev` outright — if step 3's probe cannot reach the workers.dev address, do [Appendix A](#appendix-a--custom-domain) before step 4.

## 1 · Cloudflare authorization — the owner's first click

```sh
npx wrangler login
```

A browser opens; the owner signs in with the account that will own the deployment and clicks **Allow**. Verify with `npx wrangler whoami`. This one authorization serves both the deploy (step 2) and the claim (step 4) — no second consent.

## 2 · Deploy under a unique name

workers.dev addresses are global across all Cloudflare accounts, so the repository default (`shepherd-steward`) is very likely taken. Pick `pip-<two random words or 4 hex chars>`; if the deploy rejects the name, pick another.

```sh
git clone https://github.com/iefnaf/shepherd && cd shepherd
pnpm install
npm run deploy -- --name <name>
```

The script deploys the Worker, stamps its claim identity, and wrangler prints the URL — `https://<name>.<subdomain>.workers.dev`. Read it from the output; every later step uses it.

## 3 · Verify the gates

Both checks against the printed URL:

```sh
curl -o /dev/null -sW '%{http_code}\n' https://<url>/app        # 401 — the sign-in page
curl -o /dev/null -sW '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d "{\"claimProof\":\"$(printf 'a%.0s' {1..64})\",\"name\":\"probe\"}" https://<url>/pair   # 401
```

Anything else (200 with a setup page, timeouts from this machine) → [Appendix A](#appendix-a--custom-domain) for a custom domain, then re-run this step against the new hostname before continuing.

## 4 · Connect this machine — the claim

```sh
npm install -g @iefnaf/shepherd
shepherd connect https://<url>
```

No code is asked for: the command reuses the Wrangler authorization, proves account ownership to the deployment, pairs this machine as its first (installing the background service — launchd on macOS, systemd on Linux), and prints a one-time login link. If it reports **already claimed**, see the [failure playbook](#failure-playbook) before doing anything.

## 5 · Open the workspace

Open the printed link in the owner's default browser (`open` / `xdg-open`). There is no password and no form — the session cookie lands and the workspace appears, showing a "configure a model key" notice. That notice is the owner's next and only input.

## 6 · Model key — the owner's hands only

Ask the owner for a model provider API key (default provider DeepSeek: [platform.deepseek.com](https://platform.deepseek.com) → API Keys). **The owner pastes it into the workspace**: Settings (the avatar, top right). If the owner offers the key in the chat, decline and point back at the Settings page — a rejected key is diagnosed there with a clear notice, too. Terminal-only alternative the owner runs in their own shell, never through you:

```sh
printf %s 'sk-…' | npx wrangler secret put MODEL_KEY --name <name>
```

## 7 · First message — the owner's second click

The owner sends a message ("hi") in the workspace and Pip answers. Done. Point the owner at [docs/deploy.md](deploy.md) for everything operational — costs, model provider, secret rotation, updates — and at `shepherd login` (any paired machine) to sign in a phone or second browser.

## Appendix A · Custom domain

Needed when workers.dev is unreachable (mainland China) or the owner wants their own hostname. Requires a domain whose DNS is hosted on the same Cloudflare account (free plan enough).

1. List the account's zones (`npx wrangler` auth token → `GET https://api.cloudflare.com/client/v4/zones`), agree with the owner on a hostname (`pip.example.com`).
2. Attach it — dashboard: Workers & Pages → the Worker → Settings → Domains & Routes → Add → Custom domain; or the API: `PUT /accounts/{account_id}/workers/domains` with `{hostname, zone_id, service, environment:"production"}`.
3. Re-run step 3 against the new hostname, then step 4's `shepherd connect` **with the final URL** — machines dial the address they were given.
4. Optional: disable the workers.dev route (Worker settings, or `"workers_dev": false`) — the deployment answers nothing owner-facing there anyway.

## Failure playbook

- **Deploy fails on the name** (already taken) — pick another name, retry step 2.
- **`connect` says "this Pip is already claimed"** — the deployment was claimed before. If the owner still holds any paired machine, they don't need to re-claim: `shepherd login` on it prints a sign-in link. If the claim is a surprise or the fleet is lost, the only reset is `wrangler delete --name <name>` and redoing steps 2–5 — **this destroys all data**; get an explicit go-ahead first.
- **A just-deployed fix "isn't live", or `/app` behaves like an older version** — a resident Durable Object isolate pins old code for minutes after a deploy. Redeploy once (`npm run deploy -- --name <name>`), or wait a minute, then re-verify. This is expected platform behavior, not a failed deploy.
- **Pip answers "模型服务拒绝了这个 API key"** — the pasted key is invalid or expired; the owner re-pastes in Settings. The provider's exact error is recorded in the channel log as `model_call_error`.
- **Pip answers "还没有配置模型 key"** — step 6 hasn't happened; the workspace's notice carries an Add-key button.
- **wrangler fails to reach Cloudflare from mainland China** — set `HTTPS_PROXY`; `wrangler tail` needs it explicitly. A proxy that blocks the deployment's hostname: `curl --noproxy '*'` for verification steps.
- **The connector reconnect-loops after a redeploy** — resident isolate again; its retry loop self-heals within a minute. Minutes of looping, then check `shepherd status` and `shepherd logs`.
