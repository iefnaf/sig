// The deploy command (ADR-0007): `npm run deploy` wraps `wrangler deploy` and prints the
// steps that make the deployment usable — setting SERVER_KEY (the owner API's auth, ADR-0003)
// and connecting the first machine. A Deploy-to-Cloudflare deployment runs this same script
// as its deploy command.
//
// `--name <name>` overrides the Worker name from wrangler.jsonc — the deploy and the printed
// steps. workers.dev addresses are global across accounts, so the agent runbook deploys under
// a collision-safe unique name instead of the repository default. `--dry-run` stops after the
// deploy build. Secrets are NOT handled here on purpose: SERVER_KEY and MODEL_KEY go through
// the deploy form or `wrangler secret put` (docs/deploy.md); an agent orchestrates them but
// never observes them (ADR-0007's secret discipline).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const nameFlag = args.findIndex((a) => a === "--name" || a.startsWith("--name="));
let overrideName;
if (nameFlag !== -1) {
  if (args[nameFlag] === "--name") {
    overrideName = args[nameFlag + 1];
    args.splice(nameFlag, 2);
  } else {
    overrideName = args[nameFlag].slice("--name=".length);
    args.splice(nameFlag, 1);
  }
  if (!overrideName) {
    console.error("sig: --name needs a value");
    process.exit(1);
  }
}
const dryRun = args.includes("--dry-run");
execFileSync("npx", ["-y", "wrangler", "deploy", ...(overrideName ? ["--name", overrideName] : []), ...args], { stdio: "inherit" });
if (dryRun) {
  console.log("\nsig: dry run — next-step hints skipped.");
  process.exit(0);
}

const name = overrideName ?? JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/\/\/[^\n]*/g, "")).name;
console.log(`
Sig is deployed as "${name}" at the URL wrangler printed above. Steps that make it yours:

1. Set SERVER_KEY if the deploy form did not (the owner API's Bearer secret):
     npx wrangler secret put SERVER_KEY --name ${name}
   Generate one with: openssl rand -hex 32   (keep a copy — see docs/deploy.md)
2. On the computer you want Sig to work on, pair it:
     POST /api/pairing   (with the SERVER_KEY Bearer)  →  prints the exact connect command
3. Open the workspace: POST /api/login-link gives a one-time sign-in URL.

The full walk — or an agent that runs it for you — is docs/agent-deploy.md.`);
