#!/usr/bin/env node
// `npx @iefnaf/sig <command>` (ADR-0002, superseding ADR-0001 decision 10).
//
//   connect <url> <code>   redeem a pairing code, then install + start the background
//                          service (launchd agent on macOS, systemd --user unit on Linux);
//                          --foreground runs the daemon in this terminal instead
//   status                 service state, pairing, workers, installed assets
//   logs [-n N] [name]     tail ~/.shepherd/logs/<name> (default connector.log)
//   start | stop | restart control the background service (stop also disables start-at-login)
//   uninstall              stop the service and remove its unit (keeps ~/.shepherd data)
//   upgrade [--version V]  npm-install @iefnaf/sig (default @latest) and restart the
//                          service; the fresh daemon rewrites the versioned pi assets
//   add-repo <path>        register a repository so start_worker may run in it (§8.1)
//   repo-config <path> [--workspace worktree|serial|main] [--approve|--no-approve]
//                          per-repo local settings (§8.2/§13): how write tasks get a
//                          directory, and whether pi runs with --approve there. Never
//                          settable by a remote command — only here, on the machine
//   daemon                 internal: the background service's entry point
import { existsSync, readdirSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runDaemon } from "./daemon.ts";
import { installAssets } from "./install.ts";
import { tailFile } from "./logger.ts";
import { connect } from "./pairing.ts";
import { getServiceInstaller, SHEPHERD_LABEL, type ServiceInstaller, type ServiceSpec } from "./service.ts";
import { isWorkspaceMode, LocalStore, WORKSPACE_MODES } from "./store.ts";
import { defaultBranch, repoTopLevel } from "./worktree.ts";
import { runUpgrade } from "./upgrade.ts";
import { VERSION } from "./version.ts";

const exec = promisify(execFile);

const DEFAULT_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function stateDir(): string {
  // Keep the existing store by default: rebranding must not lose paired machines.
  return process.env.SIG_HOME ?? process.env.SHEPHERD_HOME ?? join(homedir(), ".shepherd");
}

/** The bin wrapper this package ships; both src/cli.ts (dev) and dist/cli.js sit one
 * directory below the package root, so ../bin/sig.js is correct in either layout. */
export function binEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "sig.js");
}

const USAGE = `sig ${VERSION} — the Sig connector

usage:
  sig connect <url> <code> [--foreground]   pair and install the background service
  sig status                                 service, pairing, workers, assets
  sig logs [-n <lines>] [name]               tail ~/.shepherd/logs (default connector.log)
  sig start | stop | restart                 control the background service
  sig uninstall                              remove the service (keeps ~/.shepherd data)
  sig upgrade [--version <version>]          replace the package and restart the service
  sig add-repo <path>                        register a repository for start_worker
  sig repo-config <path> [options]           per-repo local settings (workspace mode,
                                                  project trust); never settable remotely
  sig daemon                                 internal: run the connector daemon

environment:
  SIG_HOME         state directory (default ~/.shepherd, preserved across the rename)
  SIG_MACHINE_NAME machine name reported to the steward
  SHEPHERD_HOME / SHEPHERD_MACHINE_NAME remain supported as fallback aliases`;

function usage(code = 2): never {
  console.error(USAGE);
  process.exit(code);
}

function fail(message: string): never {
  console.error(`sig: ${message}`);
  process.exit(1);
}

/** Removes one `--flag [value]` pair from argv, returning [value, rest]. */
function takeFlag(argv: string[], flag: string): { value?: string; rest: string[] } {
  const index = argv.indexOf(flag);
  if (index === -1) return { rest: argv };
  const value = argv[index + 1];
  const rest = [...argv.slice(0, index), ...(value === undefined ? [] : argv.slice(index + 2))];
  return { value, rest };
}

function requireInstaller(): ServiceInstaller {
  const spec = serviceSpec(binEntryPath());
  const installer = getServiceInstaller(spec);
  if (!installer) {
    fail(
      `background services are not supported on ${process.platform} (ADR-0001: macOS launchd / Linux systemd only)`,
    );
  }
  return installer;
}

function serviceSpec(entryPath: string): ServiceSpec {
  const dir = stateDir();
  const env: Record<string, string> = { PATH: process.env.PATH ?? DEFAULT_PATH, SIG_HOME: dir };
  const machineName = process.env.SIG_MACHINE_NAME ?? process.env.SHEPHERD_MACHINE_NAME;
  if (machineName) env.SIG_MACHINE_NAME = machineName;
  return {
    label: SHEPHERD_LABEL,
    nodePath: process.execPath,
    entryPath,
    args: ["daemon"],
    env,
    stateDir: dir,
    logDir: join(dir, "logs"),
  };
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") usage(command ? 0 : 2);
  if (command === "-v" || command === "--version") {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "connect":
      return connectCommand(rest);
    case "status":
      return statusCommand();
    case "logs":
      return logsCommand(rest);
    case "start":
    case "stop":
    case "restart":
      return serviceCommand(command);
    case "uninstall":
      return uninstallCommand();
    case "upgrade":
      return upgradeCommand(rest);
    case "add-repo":
      return addRepo(rest[0]);
    case "repo-config":
      return repoConfig(rest);
    case "daemon":
      return daemonCommand();
    default:
      usage();
  }
}

// --- connect ---------------------------------------------------------------------------------

async function connectCommand(argv: string[]): Promise<void> {
  const foreground = argv.includes("--foreground");
  const [url, code] = argv.filter((a) => a !== "--foreground");
  if (!url || !code) usage();
  const dir = stateDir();
  const machineName = process.env.SIG_MACHINE_NAME ?? process.env.SHEPHERD_MACHINE_NAME ?? hostname();

  // 1. Pair (protocol §5.2): redeem the code once, persist credentials in the LocalStore.
  const store = new LocalStore(join(dir, "connector.sqlite"));
  let deviceId: string;
  try {
    ({ deviceId } = await connect(url, code, machineName, { store }));
  } catch (err) {
    store.close();
    fail(err instanceof Error ? err.message : String(err));
  }
  store.close();

  // 2. Write this version's pi assets so even a foreground run is ready to start workers.
  installAssets(dir);

  // 3. Install and start the background service. `--foreground` keeps the old behavior:
  //    hold the connection in this terminal (dev boxes, containers, unsupported platforms).
  if (foreground) {
    console.log(`paired as ${deviceId}; running in foreground (Ctrl-C to stop)`);
    const handle = await runDaemon({ stateDir: dir, machineName });
    const shutdown = () => {
      void handle.stop().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const installer = requireInstaller();
  try {
    await installer.install();
  } catch (err) {
    fail(
      `${err instanceof Error ? err.message : String(err)}\n` +
        `  the service could not be installed; pair again with --foreground to run attached instead`,
    );
  }
  const status = await installer.status();
  console.log(`paired as ${deviceId}`);
  console.log(
    `background service ${status.running ? "installed and running" : "installed"} ` +
      `(${installer.kind}: ${installer.unitPath})`,
  );
  for (const note of installer.notes) console.log(`note: ${note}`);
  console.log(`logs: ${join(dir, "logs", "connector.log")}`);
  console.log("next: sig status · sig add-repo <path> · sig logs");
}

// --- status / logs ---------------------------------------------------------------------------

async function statusCommand(): Promise<void> {
  const dir = stateDir();
  console.log(`sig ${VERSION} (node ${process.version}, ${process.platform})`);

  const installer = getServiceInstaller(serviceSpec(binEntryPath()));
  if (installer) {
    const status = await installer.status();
    const pid = status.pid ? ` pid ${status.pid}` : "";
    console.log(
      `service:  ${installer.kind} ${SHEPHERD_LABEL} — ${status.installed ? (status.running ? `running${pid} (${status.detail})` : `not running (${status.detail})`) : "not installed"}`,
    );
  } else {
    console.log(`service:  not supported on ${process.platform}`);
  }

  const dbPath = join(dir, "connector.sqlite");
  if (!existsSync(dbPath)) {
    console.log("paired:   not paired (run `sig connect <url> <code>`)");
    return;
  }
  const store = new LocalStore(dbPath);
  try {
    const credentials = store.getCredentials();
    if (credentials) {
      console.log(`paired:   ${credentials.deviceId} → ${credentials.serverUrl} (connEpoch ${credentials.connEpoch})`);
    } else {
      console.log("paired:   no credentials (run `sig connect <url> <code>`)");
    }
    const workers = store.listWorkers();
    const byState = new Map<string, number>();
    for (const worker of workers) byState.set(worker.state, (byState.get(worker.state) ?? 0) + 1);
    const summary =
      workers.length === 0
        ? "none"
        : [...byState.entries()].map(([state, count]) => `${count} ${state}`).join(", ");
    console.log(`workers:  ${summary}`);
    const repos = store.listRepos();
    const repoLine =
      repos.length === 0
        ? "none (sig add-repo <path>)"
        : repos.map((r) => `${r.name}[${r.workspace}${r.approved ? ", approved" : ""}]`).join(", ");
    console.log(`repos:    ${repoLine}`);
  } finally {
    store.close();
  }

  const extDir = join(dir, "ext");
  const promptDir = join(dir, "prompts");
  const exts = existsSync(extDir) ? readdirSync(extDir).sort() : [];
  const prompts = existsSync(promptDir) ? readdirSync(promptDir).sort() : [];
  console.log(`assets:   ${exts.length ? exts.join(", ") : "none installed"}`);
  if (prompts.length) console.log(`          ${prompts.join(", ")}`);
  console.log(`logs:     ${join(dir, "logs")}`);
}

async function logsCommand(argv: string[]): Promise<void> {
  const { value: count, rest } = takeFlag(argv, "-n");
  const lines = count && /^\d+$/.test(count) ? Number(count) : 50;
  const dir = stateDir();
  const logDir = join(dir, "logs");

  // Only plain file names — never a path — so `logs` cannot read outside the log directory.
  const name = rest[0] ? basename(rest[0]).replace(/[^\w.-]/g, "_") : "connector.log";
  const path = join(logDir, name);
  if (!existsSync(path)) {
    const available = existsSync(logDir) ? readdirSync(logDir).join(", ") : "none yet";
    fail(`no log file '${name}' in ${logDir} (available: ${available})`);
  }
  const tail = tailFile(path, lines);
  if (tail) console.log(tail);
}

// --- service control -------------------------------------------------------------------------

async function serviceCommand(action: "start" | "stop" | "restart"): Promise<void> {
  const installer = requireInstaller();
  try {
    await installer[action]();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const status = await installer.status();
  console.log(
    `${SHEPHERD_LABEL}: ${status.running ? `running${status.pid ? ` (pid ${status.pid})` : ""}` : `not running (${status.detail})`}`,
  );
}

async function uninstallCommand(): Promise<void> {
  const installer = requireInstaller();
  try {
    await installer.uninstall();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`removed ${installer.unitPath}`);
  console.log(`kept ${stateDir()} (credentials, workers, logs); delete it to purge everything`);
}

// --- upgrade ---------------------------------------------------------------------------------

async function upgradeCommand(argv: string[]): Promise<void> {
  const { value: version, rest } = takeFlag(argv, "--version");
  if (rest.length > 0) usage();
  try {
    await runUpgrade((line) => console.log(line), {
      version,
      currentVersion: VERSION,
      currentEntry: binEntryPath(),
      getService: (entryPath) => getServiceInstaller(serviceSpec(entryPath)),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// --- daemon ----------------------------------------------------------------------------------

async function daemonCommand(): Promise<void> {
  const dir = stateDir();
  let handle;
  try {
    handle = await runDaemon({ stateDir: dir, machineName: process.env.SIG_MACHINE_NAME ?? process.env.SHEPHERD_MACHINE_NAME ?? hostname() });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const shutdown = () => {
    handle!
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The ConnectorApp's sockets/timers hold the event loop open; nothing else to do.
  await new Promise<void>(() => {});
}

// --- add-repo --------------------------------------------------------------------------------

/** `sig add-repo <path>`: registers the repository (resolving subdirectories to the
 * repo root) in the local whitelist. Runs entirely on-machine (§8.1/§13): a remote
 * steward can never add entries, only see them. */
async function addRepo(path: string | undefined): Promise<void> {
  if (!path) usage();
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

  const store = new LocalStore(join(stateDir(), "connector.sqlite"));
  try {
    store.addRepo({ repoId: topLevel, name, path: topLevel, defaultBranch: branch, remote });
    console.log(`registered ${name} (${topLevel})${branch ? ` default branch: ${branch}` : ""}`);
    console.log("next: sig repo-config <path> to pick the workspace mode or approve the project");
  } finally {
    store.close();
  }
}

// --- repo-config -----------------------------------------------------------------------------

/** Parses repo-config argv: positional path + `--workspace worktree|serial|main` (also the
 * `--workspace=x` form) + `--approve|--no-approve`. Unknown flags fail loudly instead of
 * silently degrading into a read-only invocation (review finding 4). */
function parseRepoConfigArgv(argv: string[]): { path?: string; workspace?: string; approve?: boolean } {
  // Expand `--flag=value` into `--flag value` so both spellings share one path.
  const expanded: string[] = [];
  for (const token of argv) {
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) expanded.push(token.slice(0, eq), token.slice(eq + 1));
    else expanded.push(token);
  }
  const { value: workspace, rest } = takeFlag(expanded, "--workspace");
  if (expanded.includes("--workspace") && workspace === undefined) {
    fail("--workspace requires a value: worktree | serial | main");
  }
  if (rest.includes("--approve") && rest.includes("--no-approve")) {
    fail("--approve and --no-approve are mutually exclusive");
  }
  const approve = rest.includes("--approve") ? true : rest.includes("--no-approve") ? false : undefined;
  const positional = rest.filter((token) => !token.startsWith("--"));
  const knownBooleans = new Set(["--approve", "--no-approve"]);
  const unknown = rest.filter((token) => token.startsWith("--") && !knownBooleans.has(token));
  if (unknown.length > 0) fail(`unknown option(s): ${unknown.join(" ")} (expected --workspace, --approve, or --no-approve)`);
  return { path: positional[0], workspace, approve };
}

/** `sig repo-config <path> [--workspace worktree|serial|main] [--approve|--no-approve]`
 * (§8.2/§13, issue #16): the per-repo settings that live only in the connector's local
 * store. A command from the steward carrying them is rejected; this is the only writer.
 * With no settings flags it just prints the current configuration. */
async function repoConfig(argv: string[]): Promise<void> {
  const { path, workspace, approve } = parseRepoConfigArgv(argv);
  if (!path) usage();
  if (workspace !== undefined && !isWorkspaceMode(workspace)) {
    fail(`unknown workspace mode '${workspace}' (expected one of: ${WORKSPACE_MODES.join(" | ")})`);
  }

  const topLevel = await repoTopLevel(path);
  const store = new LocalStore(join(stateDir(), "connector.sqlite"));
  try {
    const repo = store.getRepo(topLevel);
    if (!repo) {
      fail(`${topLevel} is not registered; run 'sig add-repo ${path}' first`);
    }
    if (workspace === undefined && approve === undefined) {
      // Read-only invocation: show the current settings.
      console.log(`${repo.name} (${repo.repoId})`);
      console.log(`workspace: ${repo.workspace}`);
      console.log(`approved:  ${repo.approved ? "yes (pi runs with --approve)" : "no (pi runs with --no-approve)"}`);
      return;
    }
    store.setRepoConfig(topLevel, {
      ...(workspace !== undefined ? { workspace } : {}),
      ...(approve !== undefined ? { approved: approve } : {}),
    });
    const updated = store.getRepo(topLevel)!;
    console.log(`${updated.name}: workspace=${updated.workspace}, approved=${updated.approved ? "yes" : "no"}`);
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
