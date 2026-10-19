// The deploy command (ADR-0004): `npm run deploy` runs `wrangler deploy`, then stamps the
// deployment's exact identity (SHEPHERD_IDENTITY: account id + script name) so claim grants
// can be target-checked, and prints the one step left — connecting the first computer.
// A Deploy-to-Cloudflare deployment runs this same script as its deploy command.
//
// `--name <name>` (ADR-0005) overrides the Worker name from wrangler.jsonc everywhere — the
// deploy, the identity stamp, and the printed connect step. workers.dev addresses are global
// across accounts, so the agent runbook deploys under a collision-safe unique name instead
// of the repository default. `--dry-run` stops after the deploy build: no identity stamp.
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
    console.error("shepherd: --name needs a value");
    process.exit(1);
  }
}
const dryRun = args.includes("--dry-run");
execFileSync("npx", ["-y", "wrangler", "deploy", ...(overrideName ? ["--name", overrideName] : []), ...args], { stdio: "inherit" });
if (dryRun) {
  console.log("\nshepherd: dry run — identity stamp and connect step skipped.");
  process.exit(0);
}

const whoami = JSON.parse(execFileSync("npx", ["-y", "wrangler", "whoami", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
const account = whoami.accounts?.[0] ?? whoami.account ?? whoami;
if (!account?.id) {
  console.error("\nshepherd: could not read the Cloudflare account — set SHEPHERD_IDENTITY manually if needed.");
  process.exit(1);
}
const name = overrideName ?? JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/\/\/[^\n]*/g, "")).name;
const identity = JSON.stringify({ accountId: account.id, scriptName: name });
// `wrangler vars put` does not exist in wrangler 4.x; a secret is env-readable the same way.
execFileSync("npx", ["-y", "wrangler", "secret", "put", "SHEPHERD_IDENTITY", "--name", name], { input: identity, stdio: ["pipe", "inherit", "inherit"] });

console.log(`
Pip is live at the URL wrangler printed above. One step left: connect your first computer.
On a computer you want Pip to work on, run:

  npx @iefnaf/shepherd connect <your Pip URL>

The first computer to authorize with your Cloudflare account claims this Pip.
The full walk — or an agent that runs it for you — is docs/agent-deploy.md.`);
