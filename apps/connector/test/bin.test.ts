// Subprocess tests against the built bin (bin/shepherd.js → dist/cli.js), which pretest
// builds. This is the `npx @iefnaf/shepherd` surface: the Node gate, --version, usage, and
// the read-only subcommands on a clean SHEPHERD_HOME.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGitRepo } from "./helpers.ts";
import { VERSION } from "../src/version.ts";

const exec = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin", "shepherd.js");

let home: string;
let stateDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "shepherd-bin-home-"));
  stateDir = mkdtempSync(join(tmpdir(), "shepherd-bin-state-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return exec(process.execPath, [bin, ...args], {
    env: { ...process.env, HOME: home, SHEPHERD_HOME: stateDir, ...extraEnv },
    timeout: 30_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code?: number; stdout?: string; stderr?: string }) => ({
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    }),
  );
}

describe("bin/shepherd.js (skipped when dist has not been built)", () => {
  beforeEach(() => {
    if (!existsSync(join(import.meta.dirname, "..", "dist", "cli.js"))) {
      throw new Error("dist/cli.js missing; run `npm run build` (pretest does this)");
    }
  });

  it("prints the version", async () => {
    const res = await run(["--version"]);
    expect(res.stdout.trim()).toBe(VERSION);
  });

  it("prints usage and exits 2 for unknown commands", async () => {
    const res = await run(["bogus"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage:");
    expect(res.stderr).toContain("connect");
  });

  it("status on a clean machine reports unpaired and not installed", async () => {
    const res = await run(["status"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`shepherd ${VERSION}`);
    expect(res.stdout).toContain("not installed");
    expect(res.stdout).toContain("not paired");
  });

  it("daemon without credentials exits 1 with a pairing hint", async () => {
    const res = await run(["daemon"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("connect");
  });

  it("logs without a log file exits 1 and lists what exists", async () => {
    const res = await run(["logs"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no log file");
  });

  it("treats the state dir as isolated (SHEPHERD_HOME honored)", async () => {
    await run(["status"]);
    expect(existsSync(stateDir)).toBe(true); // status created nothing...
    expect(existsSync(join(stateDir, "connector.sqlite"))).toBe(false); // ...it only reports
  });

  it("repo-config sets and shows the per-repo local settings (§8.2/§13, issue #16)", async () => {
    const repo = await makeGitRepo(home);

    // Not registered yet: refuse with the hint, never auto-register via a config call.
    const unregistered = await run(["repo-config", repo, "--workspace", "serial"]);
    expect(unregistered.code).toBe(1);
    expect(unregistered.stderr).toContain("not registered");

    expect((await run(["add-repo", repo])).code).toBe(0);

    // Invalid mode is rejected with the valid vocabulary.
    const bad = await run(["repo-config", repo, "--workspace", "sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("worktree | serial | main");

    const set = await run(["repo-config", repo, "--workspace", "serial", "--approve"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("workspace=serial");
    expect(set.stdout).toContain("approved=yes");

    // No flags: print the current configuration.
    const show = await run(["repo-config", repo]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("workspace: serial");
    expect(show.stdout).toContain("--approve");

    // And status surfaces the per-repo settings.
    const status = await run(["status"]);
    expect(status.stdout).toContain("repo-a[serial, approved]");
  });
});
