## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `iefnaf/sig` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

#### Toolchain pin

`package.json`'s `packageManager` field is the authoritative pnpm version (Corepack writes it on any `pnpm` run when missing — commit it, never revert it; CI installs exactly this version). If your local pnpm differs, `corepack enable` once and it self-switches.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Local steward

Start the workspace from the repo root:

```sh
pnpm --dir apps/steward exec wrangler dev --config ../../wrangler.jsonc --ip 0.0.0.0 --port 8787
```

Copy `.dev.vars.example` to gitignored `.dev.vars` and set `LOGIN_PASSWORD` to a unique password of at least 15 characters. Sign-in screens it through `api.pwnedpasswords.com`. Set `STEWARD_MODEL={"provider":"faux","modelId":"faux-1"}` to answer in the workspace without a model API key; an unscripted reply is `(faux: 未脚本化的回复)`. Cloud Agent boot writes that `.dev.vars` when the file is missing and runs the command above on port 8787.

CI checks: `pnpm -r typecheck`, then `pnpm -r test`.
