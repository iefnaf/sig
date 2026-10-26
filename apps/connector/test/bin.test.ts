// Subprocess tests against the built bin (bin/sig.js → dist/cli.js), which pretest
// builds. This is the `npx @alexlikevibe/sig` surface: the Node gate, --version, usage, and
// the read-only subcommands on a clean SIG_HOME.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGitRepo } from "./helpers.ts";
import { VERSION } from "../src/version.ts";
import { LocalStore } from "../src/store.ts";

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

function seedRegisteredRepo(repo: string, directory = stateDir): void {
  const path = realpathSync(repo);
  const store = new LocalStore(join(directory, "connector.sqlite"));
  try {
    store.addRepo({ repoId: path, name: basename(path), path, capability: { kind: "git", gitRoot: path, defaultBranch: "main", remote: null } });
  } finally {
    store.close();
  }
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

  it("directs registration to the web workspace in help", async () => {
    const res = await run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("Machines > Add directory");
    expect(res.stderr).not.toContain("add-repo");
  });

  it("rejects add-repo without creating local state", async () => {
    const repo = await makeGitRepo(home);
    const res = await run(["add-repo", repo]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Machines > Add directory");
    expect(existsSync(join(stateDir, "connector.sqlite"))).toBe(false);
    expect(existsSync(join(home, ".sig", "connector.sqlite"))).toBe(false);
  });

  it("rejects add-repo without changing existing registrations or local settings", async () => {
    const repo = await makeGitRepo(home);
    seedRegisteredRepo(repo);
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    try {
      store.setWritePolicy(realpathSync(repo), { concurrency: "serial" });
      store.setApproved(realpathSync(repo), true);
      const before = store.listRepos();
      const newRepo = await makeGitRepo(home, "repo-b");
      expect((await run(["add-repo", newRepo])).code).toBe(2);
      expect((await run(["add-repo", repo])).code).toBe(2);
      expect(store.listRepos()).toEqual(before);
    } finally {
      store.close();
    }
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
    const defaultRepo = await makeGitRepo(home, "default-repo");
    seedRegisteredRepo(repo);
    seedRegisteredRepo(defaultRepo, join(home, ".sig"));
    const res = await run(["status"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("repo-a");
    expect(res.stdout).not.toContain("default-repo");
  });

  it("continues using ~/.sig when no home setting is present", async () => {
    const repo = await makeGitRepo(home);
    const customRepo = await makeGitRepo(home, "custom-repo");
    seedRegisteredRepo(repo, join(home, ".sig"));
    seedRegisteredRepo(customRepo);
    const res = await run(["status"], { SIG_HOME: undefined });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("repo-a");
    expect(res.stdout).not.toContain("custom-repo");
  });

  it("repo-config sets and shows the per-repo local settings (§8.2/§13, issue #16)", async () => {
    const repo = await makeGitRepo(home);

    // Not registered yet: refuse with the hint, never auto-register via a config call.
    const unregistered = await run(["repo-config", repo, "--concurrency", "serial"]);
    expect(unregistered.code).toBe(1);
    expect(unregistered.stderr).toContain("not registered");
    expect(unregistered.stderr).toContain("Machines > Add directory");
    const store = new LocalStore(join(stateDir, "connector.sqlite"));
    try {
      expect(store.listRepos()).toEqual([]);
    } finally {
      store.close();
    }

    seedRegisteredRepo(repo);

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
    seedRegisteredRepo(repo);

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
