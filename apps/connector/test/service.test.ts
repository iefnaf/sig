// Service installers (issue #26): launchd agent on macOS, systemd user unit on Linux.
// All manager commands go through an injected exec, so these tests assert the unit files'
// content and the exact launchctl/systemctl invocations without touching the real system.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServiceInstaller, SIG_LABEL, type Exec, type ExecResult, type ServiceSpec } from "../src/service.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sig-service-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: string[];
}

/** Records every invocation; `handler` decides results (default: success). */
function recordingExec(handler?: (file: string, args: string[]) => ExecResult | undefined): {
  calls: Call[];
  exec: Exec;
} {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return handler?.(file, args) ?? { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    label: SIG_LABEL,
    nodePath: "/usr/local/bin/node",
    entryPath: "/opt/pkg/bin/sig.js",
    args: ["daemon"],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    stateDir: join(home, ".sig"),
    logDir: join(home, ".sig", "logs"),
    ...overrides,
  };
}

describe("getServiceInstaller", () => {
  it("maps platforms to installers, null where unsupported", () => {
    expect(getServiceInstaller(spec(), { platform: "darwin", exec: recordingExec().exec })?.kind).toBe("launchd");
    expect(getServiceInstaller(spec(), { platform: "linux", exec: recordingExec().exec })?.kind).toBe("systemd");
    expect(getServiceInstaller(spec(), { platform: "win32", exec: recordingExec().exec })).toBeNull();
  });
});

describe("LaunchdService", () => {
  const deps = (exec: Exec, extra: Record<string, unknown> = {}) => ({
    platform: "darwin" as const,
    exec,
    homeDir: home,
    uid: 501,
    bootstrapRetryMs: 300,
    ...extra,
  });

  it("writes the plist and bootstraps it in the gui domain", async () => {
    const { calls, exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "print" ? { code: 3, stdout: "", stderr: "" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const plist = join(home, "Library", "LaunchAgents", `${SIG_LABEL}.plist`);
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, "utf8");
    expect(content).toContain(`<string>${SIG_LABEL}</string>`);
    expect(content).toContain("<string>/usr/local/bin/node</string>");
    expect(content).toContain("<string>/opt/pkg/bin/sig.js</string>");
    expect(content).toContain("<string>daemon</string>");
    expect(content).toContain("<key>KeepAlive</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<key>PATH</key>");
    expect(content).toContain(join(home, ".sig", "logs", "launchd.out.log"));

    expect(calls[0]).toEqual({ file: "launchctl", args: ["print", `gui/501/${SIG_LABEL}`] });
    expect(calls[1]).toEqual({ file: "launchctl", args: ["enable", `gui/501/${SIG_LABEL}`] });
    expect(calls[2]).toEqual({ file: "launchctl", args: ["bootstrap", "gui/501", plist] });
  });

  it("bootouts a loaded agent and bootstraps the new unit (re-pair/upgrade)", async () => {
    let bootedOut = false;
    let bootstraps = 0;
    const { calls, exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "bootout") bootedOut = true;
      if (file === "launchctl" && args[0] === "print") {
        return bootedOut ? { code: 3, stdout: "", stderr: "" } : { code: 0, stdout: "state = running", stderr: "" };
      }
      if (file === "launchctl" && args[0] === "bootstrap") {
        bootstraps += 1;
        return bootedOut ? undefined : { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const bootouts = calls.filter((c) => c.args[0] === "bootout");
    expect(bootouts).toEqual([{ file: "launchctl", args: ["bootout", `gui/501/${SIG_LABEL}`] }]);
    expect(bootstraps).toBe(1); // the retry never runs: bootout settled first
  });

  it("start retries bootstrap through launchd's teardown window (stop → start race)", async () => {
    let bootstraps = 0;
    const { exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "print") return { code: 3, stdout: "", stderr: "" };
      if (file === "launchctl" && args[0] === "bootstrap") {
        bootstraps += 1;
        // EIO while launchd is still unloading the previous bootout, then success.
        return bootstraps < 3 ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : undefined;
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.start();
    expect(bootstraps).toBe(3);
  });

  it("throws when bootstrap keeps failing", async () => {
    const { exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "bootstrap"
        ? { code: 5, stdout: "", stderr: "Bootstrap failed" }
        : args[0] === "print"
          ? { code: 3, stdout: "", stderr: "" }
          : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.install()).rejects.toThrow(/bootstrap failed \(5\)/);
  });

  it("stop disables the agent and boots it out; start re-enables and kickstarts", async () => {
    let bootedOut = false;
    const { calls, exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "bootout") bootedOut = true;
      if (file === "launchctl" && args[0] === "print") {
        return bootedOut
          ? { code: 3, stdout: "", stderr: "" }
          : { code: 0, stdout: "pid = 1\nstate = running", stderr: "" };
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.stop();
    expect(calls.map((c) => `${c.args[0]}`)).toEqual(["disable", "bootout", "print"]);

    calls.length = 0;
    await installer.start();
    // after stop the agent is unloaded, so start bootstraps again
    expect(calls.map((c) => `${c.args[0]}`)).toEqual(["enable", "print", "bootstrap"]);
    expect(calls[2]).toEqual({ file: "launchctl", args: ["bootstrap", "gui/501", installer.unitPath] });
  });

  it("restart kickstarts a loaded agent", async () => {
    const { calls, exec } = recordingExec((file, args) =>
      file === "launchctl" && args[0] === "print" ? { code: 0, stdout: "\tstate = running", stderr: "" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.restart();
    expect(calls).toEqual([
      { file: "launchctl", args: ["enable", `gui/501/${SIG_LABEL}`] },
      { file: "launchctl", args: ["print", `gui/501/${SIG_LABEL}`] },
      { file: "launchctl", args: ["kickstart", "-k", `gui/501/${SIG_LABEL}`] },
    ]);
  });

  it("uninstall removes the plist and clears the disable mark", async () => {
    const { calls, exec } = recordingExec(
      (file, args) => (file === "launchctl" && args[0] === "print" ? { code: 3, stdout: "", stderr: "" } : undefined),
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const plist = installer.unitPath;

    await installer.install();
    await installer.uninstall();

    expect(existsSync(plist)).toBe(false);
    expect(calls.some((c) => c.args[0] === "bootout")).toBe(true);
    expect(calls.some((c) => c.args[0] === "enable")).toBe(true);
  });

  it("status parses pid and state from launchctl print", async () => {
    let started = false;
    const { exec } = recordingExec((file, args) => {
      if (file === "launchctl" && args[0] === "print") {
        return started
          ? { code: 0, stdout: "domain = gui/501\n\tpid = 4242\n\tstate = running", stderr: "" }
          : { code: 3, stdout: "", stderr: "" };
      }
      if (file === "launchctl" && args[0] === "bootstrap") {
        started = true;
      }
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "launchd", installed: true, running: true, pid: 4242, detail: "running" });
  });

  it("status reports not loaded when print fails", async () => {
    const { exec } = recordingExec(() => ({ code: 3, stdout: "", stderr: "" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ installed: false, running: false, detail: "not loaded" });
  });
});

describe("SystemdService", () => {
  const deps = (exec: Exec) => ({ platform: "linux" as const, exec, homeDir: home });

  it("writes the unit, reloads, and enables it now", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();

    const unit = join(home, ".config/systemd/user", `${SIG_LABEL}.service`);
    expect(existsSync(unit)).toBe(true);
    const content = readFileSync(unit, "utf8");
    expect(content).toContain("ExecStart=/usr/local/bin/node /opt/pkg/bin/sig.js daemon");
    expect(content).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(content).toContain("Restart=on-failure");
    expect(content).toContain("WantedBy=default.target");

    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "daemon-reload"] });
    expect(calls[1]).toEqual({ file: "systemctl", args: ["--user", "enable", "--now", `${SIG_LABEL}.service`] });
    expect(calls.some((c) => c.file === "loginctl")).toBe(true); // best-effort lingering
  });

  it("records a note when enable-linger fails", async () => {
    const { exec } = recordingExec((file) =>
      file === "loginctl" ? { code: 1, stdout: "", stderr: "not allowed" } : undefined,
    );
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await installer.install();
    expect(installer.notes.length).toBe(1);
  });

  it("stop disables; start re-enables", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.stop();
    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "disable", "--now", `${SIG_LABEL}.service`] });

    calls.length = 0;
    await installer.start();
    expect(calls[0]).toEqual({ file: "systemctl", args: ["--user", "enable", "--now", `${SIG_LABEL}.service`] });
  });

  it("uninstall removes the unit and reloads the manager", async () => {
    const { calls, exec } = recordingExec();
    const installer = getServiceInstaller(spec(), deps(exec))!;

    await installer.install();
    const unit = installer.unitPath;
    await installer.uninstall();

    expect(existsSync(unit)).toBe(false);
    expect(calls.some((c) => c.file === "systemctl" && c.args.includes("daemon-reload"))).toBe(true);
  });

  it("status degrades gracefully when the user session bus is unreachable", async () => {
    const { exec } = recordingExec(() => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "systemd", running: false, detail: "user session bus unreachable" });
  });

  it("status maps is-active to running and reads MainPID", async () => {
    const { exec } = recordingExec((file, args) => {
      if (file === "systemctl" && args.includes("is-active")) return { code: 0, stdout: "active\n", stderr: "" };
      if (file === "systemctl" && args.includes("MainPID")) return { code: 0, stdout: "5150\n", stderr: "" };
      return undefined;
    });
    const installer = getServiceInstaller(spec(), deps(exec))!;
    const status = await installer.status();
    expect(status).toMatchObject({ manager: "systemd", running: true, pid: 5150, detail: "active" });
  });

  it("throws a friendly error when the user bus is unreachable", async () => {
    const { exec } = recordingExec(() => ({
      code: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    }));
    const installer = getServiceInstaller(spec(), deps(exec))!;
    await expect(installer.install()).rejects.toThrow(/logged-in session/);
  });
});
