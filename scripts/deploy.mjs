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
Sig is deployed as "${name}" at the URL wrangler printed above.

1. Open that URL and sign in with the password from the deployment form.
   If you deployed from a terminal, set a password interactively:
     npx wrangler secret put LOGIN_PASSWORD --name ${name}
     npx wrangler deploy --name ${name}
   Use at least 15 characters before redeploying.
2. Connect a model in the setup wizard, then add a passkey for future sign-ins.
3. To connect a computer, open Machines in the workspace and follow its pairing instructions.

Existing deployments must keep SERVER_KEY and any SERVER_KEY_PREVIOUS unchanged.
Password recovery and upgrade instructions are in docs/deploy.md.

The full walk — or an agent that runs it for you — is docs/agent-deploy.md.`);
