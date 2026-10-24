import { rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeManager, defaultBranch, identifyWorkspace, repoTopLevel, slugify } from "../src/worktree.ts";
import { git, makeGitRepo, tmpDir } from "./helpers.ts";

let dir: string;
let repo: string;
let manager: WorktreeManager;

beforeEach(async () => {
  dir = tmpDir("sig-worktree-test");
  repo = await makeGitRepo(dir);
  manager = new WorktreeManager({ worktreesRoot: join(dir, "worktrees") });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("WorktreeManager (connector-pi.md §8.2)", () => {
  it("creates sig/<slug>-<n> from the local default-branch HEAD by default", async () => {
    const created = await manager.create({ repoPath: repo, threadId: "Fix the LOGIN bug!" });
    expect(created.branch).toBe("sig/fix-the-login-bug-1");
    expect(created.path).toContain(join(dir, "worktrees"));
    expect(created.path).toMatch(/repo-a-[0-9a-f]{8}\/fix-the-login-bug-1$/);
    expect(created.base).toBe("main");

    // The worktree is a real checkout on its own branch.
    expect((await git(created.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(created.branch);
    // And it starts at the default branch tip.
    const head = (await git(created.path, ["rev-parse", "HEAD"])).trim();
    const mainTip = (await git(repo, ["rev-parse", "main"])).trim();
    expect(head).toBe(mainTip);
  });

  it("increments n for the same thread and respects an explicit base", async () => {
    const first = await manager.create({ repoPath: repo, threadId: "fix-the-login-bug" });
    expect(first.branch).toBe("sig/fix-the-login-bug-1");
    const second = await manager.create({ repoPath: repo, threadId: "fix-the-login-bug" });
    expect(second.branch).toBe("sig/fix-the-login-bug-2");

    // Explicit base: a feature branch tip.
    await git(repo, ["branch", "feature-x"]);
    const third = await manager.create({ repoPath: repo, threadId: "other", base: "feature-x" });
    expect(third.base).toBe("feature-x");
    const head = (await git(third.path, ["rev-parse", "HEAD"])).trim();
    const featureTip = (await git(repo, ["rev-parse", "feature-x"])).trim();
    expect(head).toBe(featureTip);
  });

  it("default base stays local when the checked-out branch is not the default", async () => {
    await git(repo, ["checkout", "-b", "some-feature"]);
    writeFileSync(join(repo, "extra.txt"), "x");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "feature commit"]);
    const created = await manager.create({ repoPath: repo, threadId: "t" });
    // Falls back to conventional `main`, not the currently checked out feature branch.
    expect(created.base).toBe("main");
  });

  it("is isolated: a write in one worktree does not touch another", async () => {
    const a = await manager.create({ repoPath: repo, threadId: "t-a" });
    const b = await manager.create({ repoPath: repo, threadId: "t-b" });
    writeFileSync(join(a.path, "only-a.txt"), "a");
    const bStatus = await git(b.path, ["status", "--porcelain"]);
    expect(bStatus.trim()).toBe("");
  });

  it("cleanup refuses dirty worktrees without force", async () => {
    const created = await manager.create({ repoPath: repo, threadId: "t-c" });
    writeFileSync(join(created.path, "dirty.txt"), "dirt");
    await expect(manager.cleanup(repo, created.path)).rejects.toThrow(/uncommitted|force/);
    await expect(manager.cleanup(repo, created.path, { force: true })).resolves.toBeUndefined();
  });
});

describe("defaultBranch (§8.2: local default branch, no network)", () => {
  it("prefers origin/HEAD when recorded, resolving to the local branch", async () => {
    // Record an origin/HEAD without any network: fake the remote ref locally.
    await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    expect(await defaultBranch(repo)).toBe("main");
  });

  it("falls back to conventional names", async () => {
    expect(await defaultBranch(repo)).toBe("main");
  });
});

describe("identifyWorkspace (issue #88: Git is a detected capability, not a requirement)", () => {
  it("resolves a Git-backed path to the same identity repoTopLevel returns, with a git capability", async () => {
    const expected = await repoTopLevel(repo);
    const identity = await identifyWorkspace(repo);
    expect(identity.repoId).toBe(expected); // byte-identical: no migration of existing identity
    expect(identity.capability.kind).toBe("git");
  });

  it("resolves a plain (non-Git) directory to its realpath, with a plain capability", async () => {
    const plain = tmpDir("sig-plain-workspace-test");
    const identity = await identifyWorkspace(plain);
    expect(identity.capability).toEqual({ kind: "plain" });
    expect(identity.repoId).toBe(await realpath(plain));
    rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
});

describe("slugify", () => {
  it("maps arbitrary thread ids to branch-safe slugs", () => {
    expect(slugify("Fix the LOGIN bug!")).toBe("fix-the-login-bug");
    expect(slugify("。。。")).toBe("thread");
    expect(slugify("a")).toBe("a");
  });
});
