#!/usr/bin/env node
// `npx @iefnaf/shepherd <command>` (ADR-0001 decision 10).
//   connect <url> <code>  — redeem a pairing code, then hold the connection open
//                           (reconnecting per protocol §3.3) like a long-running daemon.
//   add-repo <path>       — register a repository so start_worker may run in it (§8.1).
import { hostname, homedir } from "node:os";
import { basename } from "node:path";
import { join } from "node:path";
import { ConnectorApp } from "./connector-app.ts";
import { connect } from "./pairing.ts";
import { LocalStore } from "./store.ts";
import { defaultBranch, repoTopLevel } from "./worktree.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const STATE_DIR = process.env.SHEPHERD_HOME ?? join(homedir(), ".shepherd");

function usage(): never {
  console.error("usage: shepherd connect <url> <code>\n       shepherd add-repo <path>");
  process.exit(2);
}

async function main(argv: string[]): Promise<void> {
  const [command, a, b] = argv;
  if (!command) usage();

  if (command === "add-repo") {
    if (!a) usage();
    await addRepo(a);
    return;
  }

  if (command === "connect") {
    if (!a || !b) usage();
    const store = new LocalStore(join(STATE_DIR, "connector.sqlite"));
    const machineName = process.env.SHEPHERD_MACHINE_NAME ?? hostname();
    const { deviceId } = await connect(a, b, machineName, { store });
    console.log(`paired as ${deviceId}; connecting...`);

    const app = new ConnectorApp({ store, stateDir: STATE_DIR, machineName });
    app.start();
    return;
  }

  usage();
}

/** `shepherd add-repo <path>`: registers the repository (resolving subdirectories to the
 * repo root) in the local whitelist. Runs entirely on-machine (§8.1/§13): a remote
 * steward can never add entries, only see them. */
async function addRepo(path: string): Promise<void> {
  const topLevel = await repoTopLevel(path);
  const name = basename(topLevel);
  let remote: string | null = null;
  try {
    const { stdout } = await exec("git", ["config", "--get", "remote.origin.url"], { cwd: topLevel });
    remote = stdout.trim() || null;
  } catch {
    // no remote — fine
  }
  const branch = await defaultBranch(topLevel).catch(() => null);

  const store = new LocalStore(join(STATE_DIR, "connector.sqlite"));
  try {
    store.addRepo({ repoId: topLevel, name, path: topLevel, defaultBranch: branch, remote });
    console.log(`registered ${name} (${topLevel})${branch ? ` default branch: ${branch}` : ""}`);
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
