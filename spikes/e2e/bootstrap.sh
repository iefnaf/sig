#!/usr/bin/env bash
# One-shot bootstrap for the e2e spike (deploy side): verify secrets, push them, deploy
# the worker, wait until the steward DO answers, then mint a pairing code and print the
# connector command for the machine that will run workers.
#
#   ./bootstrap.sh https://shepherd-spike.example.cc
#
# Secrets: .dev.vars (gitignored, 0600). SERVER_KEY / ADMIN_TOKEN are generated on first
# run; FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_OWNER_OPEN_ID and DEEPSEEK_API_KEY must be
# filled in by hand (the script says which are missing and exits).
set -euo pipefail
cd "$(dirname "$0")"

BASE_URL="${1:-${SHEPHERD_URL:-}}"
ALLOW_MISSING=0
for a in "$@"; do [ "$a" = "--allow-missing" ] && ALLOW_MISSING=1; done
DEV_VARS=.dev.vars

die() { echo "bootstrap: $*" >&2; exit 1; }
get() { grep -E "^$1=" "$DEV_VARS" 2>/dev/null | head -1 | cut -d= -f2-; }

command -v node >/dev/null || die "node is required"
command -v openssl >/dev/null || die "openssl is required"

# 1. secrets file: generate what we can, demand the rest
if [ ! -f "$DEV_VARS" ]; then
	umask 077
	{ echo "SERVER_KEY=$(openssl rand -base64 32)"; echo "ADMIN_TOKEN=$(openssl rand -hex 24)"; } > "$DEV_VARS"
	echo "generated $DEV_VARS with SERVER_KEY + ADMIN_TOKEN"
fi
[ -n "$(get SERVER_KEY)" ] || { echo "SERVER_KEY=$(openssl rand -base64 32)" >> "$DEV_VARS"; }
[ -n "$(get ADMIN_TOKEN)" ] || { echo "ADMIN_TOKEN=$(openssl rand -hex 24)" >> "$DEV_VARS"; }
missing=()
for k in FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_OWNER_OPEN_ID DEEPSEEK_API_KEY; do
	[ -n "$(get "$k")" ] || missing+=("$k")
done
if [ ${#missing[@]} -gt 0 ]; then
	# --allow-missing: a redeploy whose secrets already live in Cloudflare (secret put earlier,
	# values not kept locally). bulk only overwrites what .dev.vars actually holds.
	if [ "$ALLOW_MISSING" -eq 1 ]; then
		echo "note: not in $DEV_VARS (must already exist remotely): ${missing[*]}"
	else
		die "fill these in $DEV_VARS, then re-run: ${missing[*]}"
	fi
fi

# 2. deploy
[ -d node_modules ] || npm install --silent
npx wrangler secret bulk "$DEV_VARS" >/dev/null
npx wrangler deploy >/dev/null
[ -n "$BASE_URL" ] || die "pass the worker URL: ./bootstrap.sh https://<your-domain-or-workers.dev>"

# 3. wait for the steward to answer (deploy + secret changes land only after isolate churn)
ADMIN_TOKEN=$(get ADMIN_TOKEN)
ok=""
for _ in $(seq 1 30); do
	if curl -sf -m 8 "$BASE_URL/agents/steward/owner/__diag" -H "Authorization: Bearer $ADMIN_TOKEN" >/dev/null 2>&1; then ok=1; break; fi
	sleep 4
done
[ -n "$ok" ] || die "steward never answered at $BASE_URL/__diag (check deploy + ADMIN_TOKEN)"

# 4. fresh pairing code + the exact connector command
code=$(curl -sf -m 8 -X POST "$BASE_URL/admin/pairing" -H "Authorization: Bearer $ADMIN_TOKEN" | sed -E 's/.*"code":"([^"]+)".*/\1/')
[ -n "$code" ] || die "could not mint a pairing code"

echo "deployed: $BASE_URL"
echo
echo "on the machine that will run workers (first time only):"
echo "  node connector.mjs --url $BASE_URL --name <machine> --repo /path/to/repo --code $code"
echo
echo "pairing codes are single-use and expire in 10 minutes; mint another with:"
echo "  curl -X POST $BASE_URL/admin/pairing -H 'Authorization: Bearer <ADMIN_TOKEN>'"
echo "Feishu webhook (console, one-time): $BASE_URL/feishu"
