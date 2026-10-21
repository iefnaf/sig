## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `iefnaf/sig` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

#### Toolchain pin

`package.json`'s `packageManager` field is the authoritative pnpm version (Corepack writes it on any `pnpm` run when missing — commit it, never revert it; CI installs exactly this version). If your local pnpm differs, `corepack enable` once and it self-switches.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
