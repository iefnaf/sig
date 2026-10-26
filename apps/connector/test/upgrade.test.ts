// `sig upgrade` (issue #26): npm-installs the package globally, repoints the service
// unit at the new install, and restarts — while preserving a deliberately stopped service.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACKAGE_NAME, runUpgrade } from "../src/upgrade.ts";
import type { Exec, ExecResult, ServiceInstaller, ServiceStatus } from "../src/service.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sig-upgrade-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** Creates the layout `npm install -g` would produce: <npmRoot>/@alexlikevibe/sig/bin+package.json. */
function fakeGlobalInstall(npmRoot: string, version: string): void {
  const pkgRoot = join(npmRoot, PACKAGE_NAME);
  mkdirSync(join(pkgRoot, "bin"), { recursive: true });
  mkdirSync(join(pkgRoot, "dist"), { recursive: true });
  writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version }));
  writeFileSync(join(pkgRoot, "bin", "sig.js"), "#!/usr/bin/env node\n");
}

function fakeInstaller(state: { installed: boolean; running: boolean; actions: string[] }): ServiceInstaller {
  const status = (): Promise<ServiceStatus> =>
    Promise.resolve({
      manager: "launchd",
      installed: state.installed,
      running: state.running,
      detail: state.running ? "running" : "stopped",
    });
  const record = (action: string) => async () => {
    state.actions.push(action);
  };
  return {
    kind: "launchd" as const,
    unitPath: "/tmp/fake.plist",
    notes: [],
    install: record("install"),
    start: record("start"),
    stop: record("stop"),
    restart: record("restart"),
    uninstall: record("uninstall"),
    status,
  };
}

function upgradeExec(npmRoot: string): { calls: string[][]; exec: Exec } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push(args);
    if (file === "npm" && args[0] === "root") return { code: 0, stdout: `${npmRoot}\n`, stderr: "" };
    if (file === "npm" && args[0] === "install") {
      fakeGlobalInstall(npmRoot, "9.9.9");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("runUpgrade", () => {
  it("installs @latest globally, reinstalls the service, and reports versions", async () => {
    const npmRoot = join(dir, "lib", "node_modules");
    const { calls, exec } = upgradeExec(npmRoot);
    const state = { installed: true, running: true, actions: [] as string[] };
    const lines: string[] = [];

    const result = await runUpgrade((line) => lines.push(line), {
      currentVersion: "0.1.0",
      currentEntry: "/somewhere/else/bin/sig.js",
      exec,
      getService: () => fakeInstaller(state),
    });

    expect(calls[0]).toEqual(["root", "-g"]);
    expect(calls[1]).toEqual(["install", "-g", `${PACKAGE_NAME}@latest`]);
    expect(result).toMatchObject({ from: "0.1.0", to: "9.9.9", serviceRestarted: true });
    expect(result.entryPath).toBe(join(npmRoot, PACKAGE_NAME, "bin", "sig.js"));
    expect(state.actions).toEqual(["install"]); // install() reloads + restarts
    expect(lines.some((l) => l.includes("restarted"))).toBe(true);
  });

  it("honors --version and targets the pinned version", async () => {
    const npmRoot = join(dir, "lib", "node_modules");
    const { calls, exec } = upgradeExec(npmRoot);

    await runUpgrade(() => {}, {
      version: "1.2.3",
      currentVersion: "0.1.0",
      currentEntry: "/x/bin/sig.js",
      exec,
      getService: () => null,
    });
    expect(calls[1]).toEqual(["install", "-g", `${PACKAGE_NAME}@1.2.3`]);
  });

  it("keeps a stopped service stopped", async () => {
    const npmRoot = join(dir, "lib", "node_modules");
    const { exec } = upgradeExec(npmRoot);
    const state = { installed: true, running: false, actions: [] as string[] };
    const lines: string[] = [];

    const result = await runUpgrade((line) => lines.push(line), {
      currentVersion: "0.1.0",
      currentEntry: "/x/bin/sig.js",
      exec,
      getService: () => fakeInstaller(state),
    });

    expect(result.serviceRestarted).toBe(false);
    expect(state.actions).toEqual(["install", "stop"]);
    expect(lines.some((l) => l.includes("still stopped"))).toBe(true);
  });

  it("fails loudly when npm fails", async () => {
    const exec: Exec = async (file, args) =>
      args[0] === "root"
        ? { code: 0, stdout: `${join(dir, "lib", "node_modules")}\n`, stderr: "" }
        : ({ code: 1, stdout: "", stderr: "EACCES: permission denied" } as ExecResult);

    await expect(
      runUpgrade(() => {}, { currentVersion: "0.1.0", currentEntry: "/x", exec, getService: () => null }),
    ).rejects.toThrow(/EACCES/);
  });

  it("fails when the installed layout is unexpected", async () => {
    const npmRoot = join(dir, "lib", "node_modules"); // install "succeeds" but writes nothing
    const exec: Exec = async (file, args) =>
      args[0] === "root" ? { code: 0, stdout: `${npmRoot}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" };

    await expect(
      runUpgrade(() => {}, { currentVersion: "0.1.0", currentEntry: "/x", exec, getService: () => null }),
    ).rejects.toThrow(/layout unexpected/);
  });
});
