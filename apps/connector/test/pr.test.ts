// The PR consent gate's machine half (issue #21, spike-conclusions §2): `pr_worker` pushes
// the worker's branch and runs `gh pr create` in the worktree; the result rides the event
// stream (pr_created / pr_failed) and the command settles with the URL. gh/git are scripted
// through the exec seam — no network, no GitHub account — except one transport-level test
// that keeps git real and fakes only gh.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "../src/store.ts";
import { openPr, PrError, type PrExec } from "../src/pr.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakePiAdapter, makeGitRepo, tmpDir, writeScenario } from "./helpers.ts";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let manager: WorkerManager;
let events: Array<Record<string, unknown>>;
/** Every manager created in a test — afterEach stops them all. */
const managers: WorkerManager[] = [];

/** A scripted command runner: `script[file]` maps an args prefix to an outcome. */
function scriptedExec(script: Record<string, { stdout?: string; stderr?: string; exit?: number } | "enoent">): PrExec {
  return async (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    const hit = Object.entries(script).find(([prefix]) => key.startsWith(prefix));
    if (!hit) throw Object.assign(new Error(`unexpected command: ${key}`), { code: "ENOENT" });
    const outcome = hit[1];
    if (outcome === "enoent") {
      const err = new Error(`spawn ${file} ENOENT`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    if (outcome.exit !== undefined && outcome.exit !== 0) {
      throw Object.assign(new Error(`${file} exited ${outcome.exit}`), { stderr: outcome.stderr ?? "" });
    }
    return { stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
  };
}

const HAPPY: Record<string, { stdout?: string; stderr?: string } | "enoent"> = {
  "gh --version": { stdout: "gh version 2.60.0" },
  "gh auth status": { stdout: "Logged in to github.com" },
  "git push": { stdout: "" },
  "gh pr create": { stdout: "https://github.com/example/repo-a/pull/7\n" },
};

function newManager(exec?: PrExec): WorkerManager {
  events = [];
  const m = new WorkerManager({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, writeScenario(dir, "noop", [])),
    emit: (workerId, fields) => events.push({ workerId, ...fields }),
    ...(exec ? { pr: { exec } } : {}),
  });
  managers.push(m);
  return m;
}

/** A settled write worker with a worktree and branch — the state after a done report. */
function seedWorker(workerId: string, overrides: Record<string, unknown> = {}): void {
  store.upsertWorker({
    workerId,
    threadId: "fix-the-login-bug",
    repoId: repo,
    mode: "write",
    state: "idle",
    branch: "sig/fix-the-login-bug-1",
    worktree: join(dir, "worktree-login"),
    base: "main",
    ...overrides,
  });
}

beforeEach(async () => {
  dir = tmpDir("sig-pr");
  stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: "git@github.com:example/repo-a.git" } });
});

afterEach(async () => {
  for (const m of managers) m.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("openPr (issue #21)", () => {
  it("pushes the branch, creates the PR, and returns the URL from gh's stdout", async () => {
    const calls: string[] = [];
    const exec: PrExec = async (file, args, options) => {
      calls.push(`${file} ${args.join(" ")} @${options.cwd}`);
      return scriptedExec(HAPPY)(file, args, options);
    };
    const result = await openPr({ worktree: "/wt", branch: "sig/x-1", title: "修好登录", body: "body", exec });
    expect(result.url).toBe("https://github.com/example/repo-a/pull/7");
    expect(calls).toEqual([
      "gh --version @/wt",
      "gh auth status @/wt",
      "git push -u origin sig/x-1 @/wt",
      "gh pr create --head sig/x-1 --title 修好登录 --body body @/wt",
    ]);
  });

  it("classifies a missing gh as gh_missing", async () => {
    await expect(
      openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec: scriptedExec({ "gh --version": "enoent" }) }),
    ).rejects.toMatchObject({ stage: "gh_missing" });
  });

  it("classifies a failed auth status as auth", async () => {
    const exec = scriptedExec({
      "gh --version": { stdout: "gh 2" },
      "gh auth status": { exit: 1, stderr: "You are not logged into any GitHub hosts." },
    });
    await expect(openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec })).rejects.toMatchObject({ stage: "auth" });
  });

  it("classifies a rejected push as push", async () => {
    const exec = scriptedExec({
      ...HAPPY,
      "git push": { exit: 1, stderr: "ERROR: Permission to example/repo-a.git denied" },
    });
    await expect(openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec })).rejects.toMatchObject({ stage: "push" });
  });

  it("classifies an auth-flavored create failure as auth, not create", async () => {
    const exec = scriptedExec({
      ...HAPPY,
      "gh pr create": { exit: 1, stderr: "gh: HTTP 401: Bad credentials" },
    });
    await expect(openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec })).rejects.toMatchObject({ stage: "auth" });
  });

  it("a create failure without a URL on stdout is a create-stage error", async () => {
    const exec = scriptedExec({ ...HAPPY, "gh pr create": { stdout: "Opening github.com/example/repo-a in your browser" } });
    await expect(openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec })).rejects.toBeInstanceOf(PrError);
  });

  it("an unresponsive gh (timeout, not ENOENT) is create-stage, not install-gh advice", async () => {
    const exec = scriptedExec({ "gh --version": { exit: 1, stderr: "spawn timed out" } });
    await expect(openPr({ worktree: "/wt", branch: "b", title: "t", body: "", exec })).rejects.toMatchObject({
      stage: "create",
      message: expect.stringContaining("gh did not respond"),
    });
  });
});

describe("pr_worker command (issue #21 AC2/AC4)", () => {
  it("emits pr_created with the URL and settles the command with it", async () => {
    manager = newManager(scriptedExec(HAPPY));
    seedWorker("w-pr-1");
    const result = await manager.handleCommand("cmd-pr-1", "pr_worker", { workerId: "w-pr-1", title: "修好登录", body: "- 改了 auth" }, "w-pr-1");
    expect(result).toEqual({ url: "https://github.com/example/repo-a/pull/7", branch: "sig/fix-the-login-bug-1" });
    expect(events).toEqual([
      {
        workerId: "w-pr-1",
        type: "pr_created",
        cmdId: "cmd-pr-1",
        url: "https://github.com/example/repo-a/pull/7",
        branch: "sig/fix-the-login-bug-1",
      },
    ]);
  });

  it("no gh → pr_failed{gh_missing} and the command fails with gh_missing", async () => {
    manager = newManager(scriptedExec({ "gh --version": "enoent" }));
    seedWorker("w-pr-2");
    await expect(manager.handleCommand("cmd-pr-2", "pr_worker", { workerId: "w-pr-2" }, "w-pr-2")).rejects.toMatchObject({
      code: "gh_missing",
    });
    expect(events).toEqual([
      { workerId: "w-pr-2", type: "pr_failed", cmdId: "cmd-pr-2", stage: "gh_missing", message: expect.stringContaining("gh") },
    ]);
  });

  it("auth failure → pr_failed{auth} and the command fails with gh_auth", async () => {
    manager = newManager(
      scriptedExec({
        "gh --version": { stdout: "gh 2" },
        "gh auth status": { exit: 1, stderr: "not logged in" },
      }),
    );
    seedWorker("w-pr-3");
    await expect(manager.handleCommand("cmd-pr-3", "pr_worker", { workerId: "w-pr-3" }, "w-pr-3")).rejects.toMatchObject({
      code: "gh_auth",
    });
    expect(events.filter((e) => e.type === "pr_failed")).toEqual([
      { workerId: "w-pr-3", type: "pr_failed", cmdId: "cmd-pr-3", stage: "auth", message: expect.any(String) },
    ]);
  });

  it("push rejected → pr_failed{push} and the command fails with push_rejected", async () => {
    manager = newManager(
      scriptedExec({
        ...HAPPY,
        "git push": { exit: 1, stderr: "! [remote rejected] sig/x-1 (pre-receive hook declined)" },
      }),
    );
    seedWorker("w-pr-4");
    await expect(manager.handleCommand("cmd-pr-4", "pr_worker", { workerId: "w-pr-4" }, "w-pr-4")).rejects.toMatchObject({
      code: "push_rejected",
    });
    expect(events.filter((e) => e.type === "pr_failed")).toEqual([
      { workerId: "w-pr-4", type: "pr_failed", cmdId: "cmd-pr-4", stage: "push", message: expect.stringContaining("pre-receive") },
    ]);
  });

  it("refuses a readonly worker without a worktree branch", async () => {
    manager = newManager(scriptedExec(HAPPY));
    seedWorker("w-pr-ro", { mode: "readonly", worktree: null, branch: null });
    await expect(manager.handleCommand("cmd-pr-ro", "pr_worker", { workerId: "w-pr-ro" }, "w-pr-ro")).rejects.toMatchObject({
      code: "no_worktree",
    });
    expect(events).toEqual([]);
  });

  it("refuses while the worker is still in flight, and names the lost state for what it is", async () => {
    manager = newManager(scriptedExec(HAPPY));
    seedWorker("w-pr-run", { state: "running" });
    await expect(manager.handleCommand("cmd-pr-run", "pr_worker", { workerId: "w-pr-run" }, "w-pr-run")).rejects.toMatchObject({
      code: "worker_running",
    });
    seedWorker("w-pr-lost", { state: "lost" });
    await expect(manager.handleCommand("cmd-pr-lost", "pr_worker", { workerId: "w-pr-lost" }, "w-pr-lost")).rejects.toMatchObject({
      code: "worker_running",
      message: expect.stringContaining("automatic resume is pending"),
    });
  });

  it("review #4: a failing success-emit is NOT a PR failure — the command still settles with the URL", async () => {
    const events2: Array<Record<string, unknown>> = [];
    const manager2 = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, writeScenario(dir, "noop2", [])),
      emit: (workerId, fields) => {
        if (fields.type === "pr_created") throw new Error("store closed");
        events2.push({ workerId, ...fields });
      },
      pr: { exec: scriptedExec(HAPPY) },
    });
    managers.push(manager2);
    seedWorker("w-pr-emit");
    const result = await manager2.handleCommand("cmd-pr-emit", "pr_worker", { workerId: "w-pr-emit" }, "w-pr-emit");
    // The PR exists; the command says so. No pr_failed may be manufactured for it.
    expect(result).toMatchObject({ url: "https://github.com/example/repo-a/pull/7" });
    expect(events2).toEqual([]);
  });

  it("runs against a real repo: git push is real, only gh is scripted", async () => {
    // A bare "origin" the repo can push to, plus a worktree branch with one commit.
    const origin = join(dir, "origin.git");
    await exec("git", ["init", "--bare", "-b", "main", origin]);
    await exec("git", ["remote", "add", "origin", origin], { cwd: repo });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: repo });
    const worktree = join(dir, "wt-real");
    await exec("git", ["worktree", "add", "-b", "sig/real-1", worktree], { cwd: repo });
    await exec("git", ["commit", "--allow-empty", "-m", "work"], { cwd: worktree });

    const ghOnly: PrExec = async (file, args, options) => {
      if (file === "gh") return scriptedExec(HAPPY)(file, args, options);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return promisify(execFile)(file, args, options);
    };
    manager = newManager(ghOnly);
    store.upsertWorker({
      workerId: "w-pr-real",
      threadId: "t",
      repoId: repo,
      mode: "write",
      state: "idle",
      branch: "sig/real-1",
      worktree,
      base: "main",
    });
    const result = await manager.handleCommand("cmd-real", "pr_worker", { workerId: "w-pr-real" }, "w-pr-real");
    expect(result).toMatchObject({ url: "https://github.com/example/repo-a/pull/7" });
    // The branch genuinely landed on the remote.
    const { stdout } = await exec("git", ["ls-remote", "--heads", "origin"], { cwd: repo });
    expect(stdout).toContain("sig/real-1");
  });
});

async function exec(file: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)(file, args, options ?? {}) as Promise<{ stdout: string }>;
}
