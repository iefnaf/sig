// Background service management (issue #26, ADR-0001 decision 10): `connect` installs the
// connector as a launchd agent on macOS or a systemd user unit on Linux so it keeps running
// and starts at login. Windows is out of scope (ADR-0001); getServiceInstaller returns null
// there and the CLI falls back to `--foreground`.
//
// The unit runs `<node> <bin>/sig.js daemon`; credentials stay in the LocalStore
// (never in the unit file), and the log directory is under the state dir.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";

const realExecFile = promisify(execFile);

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[]) => Promise<ExecResult>;

/** execFile that never throws: non-zero exits and spawn failures come back as {code, stderr}. */
export const defaultExec: Exec = async (file, args) => {
  try {
    const { stdout, stderr } = await realExecFile(file, args, { encoding: "utf8" });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 127,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: (e.stderr ? String(e.stderr) : "") || (e.message ?? `${file} failed`),
    };
  }
};

export const SIG_LABEL = "dev.sig.connector";

export interface ServiceSpec {
  /** Reverse-DNS label (launchd) and unit basename (systemd). */
  label: string;
  /** Absolute path of the node binary to run (process.execPath at install time). */
  nodePath: string;
  /** Absolute path of the sig bin wrapper the service should run. */
  entryPath: string;
  /** Extra argv after the entry (["daemon"]). */
  args?: string[];
  /** Environment for the daemon: PATH (to find `pi`/`git`) and optionally SIG_HOME. */
  env: Record<string, string>;
  /** ~/.sig (or $SIG_HOME) — where logs and the store live. */
  stateDir: string;
  logDir: string;
}

export interface ServiceStatus {
  manager: "launchd" | "systemd";
  /** Unit/plist file present on disk. */
  installed: boolean;
  /** The service manager reports the service as running right now. */
  running: boolean;
  pid?: number;
  /** Raw state for display (e.g. launchd "state = running", systemd "active"). */
  detail: string;
}

export interface ServiceInstaller {
  readonly kind: "launchd" | "systemd";
  /** Human-readable install notes (e.g. the lingering hint on systemd); filled by install(). */
  readonly notes: string[];
  /** Writes the unit, loads and enables it (starts now, and at login). Idempotent. */
  install(): Promise<void>;
  /** Starts now (after `stop`). */
  start(): Promise<void>;
  /** Stops now and disables start-at-login (until `start`/`install` again). */
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stops and removes the unit. Does not touch ~/.sig data. */
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  /** Absolute path of the unit/plist file (for `status` output). */
  readonly unitPath: string;
}

export interface ServiceDeps {
  exec?: Exec;
  /** Overrides for tests; default os.homedir()/process.getuid()/process.platform. */
  homeDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  /** Budget for launchd bootstrap retries (tests shorten it). Default 5s. */
  bootstrapRetryMs?: number;
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/** Picks the platform installer; null where background services are unsupported (win32). */
export function getServiceInstaller(spec: ServiceSpec, deps: ServiceDeps = {}): ServiceInstaller | null {
  const plat = deps.platform ?? platform();
  if (plat === "darwin") return new LaunchdService(spec, deps);
  if (plat === "linux") return new SystemdService(spec, deps);
  return null;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- launchd (macOS user agent) -------------------------------------------------------------

class LaunchdService implements ServiceInstaller {
  readonly kind = "launchd" as const;
  readonly notes: string[] = [];
  private readonly plistPath: string;
  private readonly target: string;
  private readonly exec: Exec;
  private readonly bootstrapRetryMs: number;

  constructor(
    private readonly spec: ServiceSpec,
    deps: ServiceDeps = {},
  ) {
    const home = deps.homeDir ?? homedir();
    this.exec = deps.exec ?? defaultExec;
    this.bootstrapRetryMs = deps.bootstrapRetryMs ?? 5000;
    this.plistPath = join(home, "Library", "LaunchAgents", `${spec.label}.plist`);
    this.target = `gui/${deps.uid ?? currentUid()}/${spec.label}`;
  }

  get unitPath(): string {
    return this.plistPath;
  }

  private async launchctl(args: string[]): Promise<ExecResult> {
    return this.exec("launchctl", args);
  }

  private async loaded(): Promise<boolean> {
    return (await this.launchctl(["print", this.target])).code === 0;
  }

  plistContent(): string {
    const env = Object.entries(this.spec.env)
      .map(([key, value]) => `        <key>${xmlEscape(key)}</key>\n        <string>${xmlEscape(value)}</string>`)
      .join("\n");
    const args = [this.spec.nodePath, this.spec.entryPath, ...(this.spec.args ?? ["daemon"])]
      .map((a) => `        <string>${xmlEscape(a)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(this.spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(this.spec.logDir, "launchd.out.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(this.spec.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
  }

  async install(): Promise<void> {
    mkdirSync(this.spec.logDir, { recursive: true });
    mkdirSync(dirname(this.plistPath), { recursive: true });
    writeFileSync(this.plistPath, this.plistContent(), { mode: 0o644 });

    // bootstrap starts the agent immediately (RunAtLoad) and at every login. When already
    // loaded (re-pair, upgrade), bootout first — and wait for the unload to actually settle,
    // or bootstrap races launchd's teardown and fails with EIO.
    if (await this.loaded()) {
      await this.launchctl(["bootout", this.target]);
      await this.waitUnloaded(3000);
    }
    // Enable before bootstrap: a disabled service (a previous `stop`) cannot be bootstrapped.
    await this.launchctl(["enable", this.target]);
    await this.bootstrapWithRetry();
  }

  /** Bootstrap, retrying through launchd's asynchronous-teardown window (EIO right after a
   * bootout of the same label — e.g. `stop` immediately followed by `restart`). */
  private async bootstrapWithRetry(): Promise<void> {
    const deadline = Date.now() + this.bootstrapRetryMs;
    let last: ExecResult = { code: -1, stdout: "", stderr: "" };
    while (Date.now() < deadline) {
      last = await this.launchctl(["bootstrap", this.targetDomain(), this.plistPath]);
      if (last.code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`launchctl bootstrap failed (${last.code}): ${last.stderr.trim()}`);
  }

  /** Polls until `launchctl print` stops finding the service (bootout is asynchronous). */
  private async waitUnloaded(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.loaded())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async start(): Promise<void> {
    await this.launchctl(["enable", this.target]);
    if (await this.loaded()) {
      await this.launchctl(["kickstart", this.target]);
    } else {
      await this.bootstrapWithRetry();
    }
  }

  async stop(): Promise<void> {
    // disable keeps it from starting at the next login; bootout stops it now. The unload
    // is asynchronous — wait for it so an immediately following status() reads clean.
    await this.launchctl(["disable", this.target]);
    await this.launchctl(["bootout", this.target]);
    await this.waitUnloaded(3000);
  }

  async restart(): Promise<void> {
    // enable first: bootstrap of a disabled service fails with EIO, and `stop` disables.
    await this.launchctl(["enable", this.target]);
    if (await this.loaded()) {
      await this.launchctl(["kickstart", "-k", this.target]);
    } else {
      await this.bootstrapWithRetry();
    }
  }

  async uninstall(): Promise<void> {
    await this.launchctl(["bootout", this.target]);
    // Clear any `disable` mark so a future install starts fresh.
    await this.launchctl(["enable", this.target]);
    rmSync(this.plistPath, { force: true });
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.plistPath);
    const res = await this.launchctl(["print", this.target]);
    if (res.code !== 0) {
      return { manager: "launchd", installed, running: false, detail: "not loaded" };
    }
    const pid = /^\s*pid = (\d+)\s*$/m.exec(res.stdout);
    const state = /^\s*state = (\S+)\s*$/m.exec(res.stdout);
    const running = pid !== null;
    return {
      manager: "launchd",
      installed,
      running,
      pid: pid ? Number(pid[1]) : undefined,
      detail: state ? state[1]! : running ? "running" : res.stdout.split("\n")[0]?.trim() || "loaded",
    };
  }

  private targetDomain(): string {
    return this.target.substring(0, this.target.lastIndexOf("/"));
  }
}

// --- systemd (Linux user unit) ---------------------------------------------------------------

class SystemdService implements ServiceInstaller {
  readonly kind = "systemd" as const;
  readonly notes: string[] = [];
  private readonly unitFile: string;
  private readonly unitName: string;
  private readonly exec: Exec;

  constructor(
    private readonly spec: ServiceSpec,
    deps: ServiceDeps = {},
  ) {
    const home = deps.homeDir ?? homedir();
    this.exec = deps.exec ?? defaultExec;
    this.unitName = `${spec.label}.service`;
    this.unitFile = join(home, ".config", "systemd", "user", this.unitName);
  }

  get unitPath(): string {
    return this.unitFile;
  }

  private async systemctl(args: string[]): Promise<ExecResult> {
    const res = await this.exec("systemctl", ["--user", ...args]);
    if (res.code !== 0 && /Failed to connect to bus|DBUS_SESSION/i.test(res.stderr)) {
      throw new Error(
        `systemctl --user ${args.join(" ")} could not reach the user session bus. ` +
          `Run from a logged-in session (SSH users need XDG_RUNTIME_DIR, or use --foreground).`,
      );
    }
    return res;
  }

  unitContent(): string {
    const env = Object.entries(this.spec.env)
      .map(([key, value]) => `Environment="${key}=${value.replace(/"/g, '\\"')}"`)
      .join("\n");
    const execStart = [this.spec.nodePath, this.spec.entryPath, ...(this.spec.args ?? ["daemon"])]
      .map((part) => (part.includes(" ") ? `"${part}"` : part))
      .join(" ");
    return `[Unit]
Description=Sig connector daemon
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${execStart}
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
  }

  async install(): Promise<void> {
    mkdirSync(this.spec.logDir, { recursive: true });
    mkdirSync(dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, this.unitContent(), { mode: 0o644 });
    await this.systemctl(["daemon-reload"]);
    const res = await this.systemctl(["enable", "--now", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
    // User units only run while a session exists; lingering starts them at boot.
    const linger = await this.exec("loginctl", ["enable-linger"]);
    if (linger.code !== 0) {
      this.notes.push(
        "loginctl enable-linger failed: the connector will start at first login instead of at boot.",
      );
    }
  }

  async start(): Promise<void> {
    const res = await this.systemctl(["enable", "--now", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
  }

  async stop(): Promise<void> {
    await this.systemctl(["disable", "--now", this.unitName]);
  }

  async restart(): Promise<void> {
    const res = await this.systemctl(["restart", this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl restart failed (${res.code}): ${res.stderr.trim()}`);
  }

  async uninstall(): Promise<void> {
    await this.systemctl(["disable", "--now", this.unitName]);
    rmSync(this.unitPath, { force: true });
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["reset-failed", this.unitName]);
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitFile);
    let active: ExecResult;
    try {
      active = await this.systemctl(["is-active", this.unitName]);
    } catch {
      // Headless hosts (no user session bus): status is informational and must not throw.
      return { manager: "systemd", installed, running: false, detail: "user session bus unreachable" };
    }
    const running = active.stdout.trim() === "active";
    let pid: number | undefined;
    if (running) {
      const show = await this.systemctl(["show", this.unitName, "-p", "MainPID", "--value"]);
      const parsed = Number(show.stdout.trim());
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    }
    return {
      manager: "systemd",
      installed,
      running,
      pid,
      detail: active.stdout.trim() || "unknown",
    };
  }
}
