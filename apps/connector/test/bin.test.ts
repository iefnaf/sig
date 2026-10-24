// Subprocess tests against the built bin (bin/sig.js → dist/cli.js), which pretest
// builds. This is the `npx @nightboats/sig` surface: the Node gate, --version, usage, and
// the read-only subcommands on a clean SIG_HOME.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGitRepo } from "./helpers.ts";
import { VERSION } from "../src/version.ts";

const exec = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin", "sig.js");

let home: string;
let stateDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sig-bin-home-"));
  stateDir = mkdtempSync(join(tmpdir(), "sig-bin-state-"));
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

function run(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  return exec(process.execPath, [bin, ...args], {
    env: { ...process.env, HOME: home, SIG_HOME: stateDir, ...extraEnv },
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

describe("bin/sig.js (skipped when dist has not been built)", () => {
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
    expect(res.stdout).toContain(`sig ${VERSION}`);
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

  it("SIG_HOME overrides the ~/.sig default", async () => {
    const repo = await makeGitRepo(home);
    expect((await run(["add-repo", repo])).code).toBe(0);
    expect(existsSync(join(stateDir, "connector.sqlite"))).toBe(true);
    expect(existsSync(join(home, ".sig", "connector.sqlite"))).toBe(false);
  });

  it("continues using ~/.sig when no home setting is present", async () => {
    const repo = await makeGitRepo(home);
    const defaults = { SIG_HOME: undefined };
    expect((await run(["add-repo", repo], defaults)).code).toBe(0);
    expect(existsSync(join(home, ".sig", "connector.sqlite"))).toBe(true);
    expect((await run(["status"], defaults)).stdout).toContain("repo-a");
  });

  it("repo-config sets and shows the per-repo local settings (§8.2/§13, issue #16)", async () => {
    const repo = await makeGitRepo(home);

    // Not registered yet: refuse with the hint, never auto-register via a config call.
    const unregistered = await run(["repo-config", repo, "--concurrency", "serial"]);
    expect(unregistered.code).toBe(1);
    expect(unregistered.stderr).toContain("not registered");

    expect((await run(["add-repo", repo])).code).toBe(0);

    // Invalid value is rejected with the valid vocabulary.
    const bad = await run(["repo-config", repo, "--isolation", "sometimes"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("worktree | in-place");

    const set = await run(["repo-config", repo, "--concurrency", "serial", "--approve"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("concurrency=serial");
    expect(set.stdout).toContain("approved=yes");

    // No flags: print the current configuration.
    const show = await run(["repo-config", repo]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("capability:");
    expect(show.stdout).toContain("concurrency: serial");
    expect(show.stdout).toContain("--approve");

    // And status surfaces the per-repo settings.
    const status = await run(["status"]);
    expect(status.stdout).toContain("repo-a[worktree/serial, approved]");
  });

  it("repo-config parses flags in any position and both --isolation/--concurrency spellings (review finding 4)", async () => {
    const repo = await makeGitRepo(home);
    expect((await run(["add-repo", repo])).code).toBe(0);

    // Flags before the path: the path is still the path.
    const flagsFirst = await run(["repo-config", "--isolation", "in-place", repo]);
    expect(flagsFirst.code).toBe(0);
    expect(flagsFirst.stdout).toContain("isolation=in-place");

    // The --flag=value form is honored, not silently ignored.
    const eqForm = await run(["repo-config", repo, "--concurrency=serial"]);
    expect(eqForm.code).toBe(0);
    expect(eqForm.stdout).toContain("concurrency=serial");

    // A valueless --isolation and unknown flags fail loudly instead of degrading into a
    // read-only print with exit 0.
    const missingValue = await run(["repo-config", repo, "--isolation"]);
    expect(missingValue.code).toBe(1);
    expect(missingValue.stderr).toContain("requires a value");
    const unknown = await run(["repo-config", repo, "--isolationx"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown option");
  });
});
