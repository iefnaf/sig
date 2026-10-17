// Write-task worktrees, docs/design/connector-pi.md §8.2:
// - location ~/.shepherd/worktrees/<repoName>-<pathHash>/<branchSlug>;
// - branch shepherd/<threadSlug>-<n>; starting point is `base` (on relay, the previous
//   worker's branch), defaulting to the local tip of the repository's default branch
//   (no network access);
// - one worktree per write task; no automatic deletion (§8.2).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(`git ${args.join(" ")} failed: ${e.message ?? err}`, typeof e.stderr === "string" ? e.stderr : undefined);
  }
}

/** Resolves a path to the top level of the git repository containing it. */
export async function repoTopLevel(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
}

/** The repository's default branch, detected purely locally (§8.2: no network access). */
export async function defaultBranch(repoPath: string): Promise<string> {
  // 1. origin/HEAD symbolic ref, when the clone recorded it.
  try {
    const ref = (await git(repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (branch && branch !== ref) {
      // Prefer the local branch of the same name when it exists.
      if (await branchExists(repoPath, branch)) return branch;
      return ref; // fall back to the remote-tracking ref (still a local tip, no network)
    }
  } catch {
    // not recorded — continue
  }
  // 2. Conventional names.
  for (const candidate of ["main", "master"]) {
    if (await branchExists(repoPath, candidate)) return candidate;
  }
  // 3. Whatever is currently checked out.
  try {
    const current = (await git(repoPath, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (current) return current;
  } catch {
    // detached HEAD — fall through to the commit itself
  }
  return "HEAD";
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function slugify(input: string, fallback = "thread"): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "");
  return slug || fallback;
}

export interface WorktreeSpec {
  repoPath: string;
  threadId: string;
  /** Starting point; defaults to the local default-branch tip. */
  base?: string;
  /** Overrides the thread slug used in the branch name (tests). */
  slug?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  /** The commit-ish the branch was created from. */
  base: string;
}

export class WorktreeManager {
  constructor(private readonly options: { worktreesRoot: string; maxBranchTries?: number }) {}

  /**
   * Creates a dedicated worktree for one write task. Branch: `shepherd/<threadSlug>-<n>`
   * with the smallest unused n; directory: `<root>/<repoName>-<pathHash>/<branchSlug>`.
   */
  async create(spec: WorktreeSpec): Promise<WorktreeResult> {
    const slug = spec.slug ?? slugify(spec.threadId);
    const base = spec.base ?? (await defaultBranch(spec.repoPath));

    // Drop worktree registrations whose directories disappeared, so branch/dir picks
    // are not confused by debris from a cleaned-up worktree.
    await git(spec.repoPath, ["worktree", "prune"]).catch(() => {});

    const maxTries = this.options.maxBranchTries ?? 999;
    let branch = "";
    let dir = "";
    for (let n = 1; n <= maxTries; n++) {
      const candidate = `shepherd/${slug}-${n}`;
      if (!(await branchExists(spec.repoPath, candidate))) {
        branch = candidate;
        dir = joinDir(this.options.worktreesRoot, spec.repoPath, `${slug}-${n}`);
        break;
      }
    }
    if (!branch) throw new GitError(`no free shepherd/${slug}-<n> branch within ${maxTries} tries`);

    await git(spec.repoPath, ["worktree", "add", "-b", branch, dir, base]);
    return { path: dir, branch, base };
  }

  /** cleanup_worktree (§6.1): refuses dirty or unpushed worktrees unless force. */
  async cleanup(repoPath: string, worktreePath: string, opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force) {
      const dirty = (await git(worktreePath, ["status", "--porcelain"])).trim().length > 0;
      // Unpushed = HEAD is contained by no remote-tracking branch.
      const remoteRefs = (await git(worktreePath, ["branch", "-r", "--contains", "HEAD"])).trim();
      if (dirty || remoteRefs.length === 0) {
        throw new GitError("worktree has uncommitted changes or unpushed commits; pass force");
      }
    }
    await git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  }
}

/** A detached, read-only checkout for readonly relay legs (issue #8): its branch starts at
 *  `base` and is never switched to (detached HEAD), so the repo's own checkout is untouched. */
export interface ReadonlyWorktreeResult {
  path: string;
  /** The commit the detached HEAD sits on. */
  head: string;
  base: string;
}

/**
 * Creates a worktree for a readonly continuation (issue #8, connector-pi.md §8.3): detached
 * HEAD at `base` — typically the previous write leg's branch — so a review/read task sees
 * that state without checking anything out in the owner's working directory. The detached
 * HEAD also means no branch is ever moved by a task that must not write.
 *
 * The directory is unique per invocation (`<slug>-ro-<n>`, smallest free n): a second
 * readonly leg on the same thread never collides with a live one's directory, and nothing
 * is ever removed here — stale registrations whose directories disappeared are pruned the
 * same way WorktreeManager.create does (PR #54 review finding 2: reusing a fixed path hit
 * git's "missing but already registered", and an unconditional rm could delete a running
 * leg's checkout). Explicit cleanup stays with cleanup_worktree.
 */
export async function createReadonlyWorktree(
  repoPath: string,
  opts: { worktreesRoot: string; base: string; threadId: string; maxTries?: number },
): Promise<ReadonlyWorktreeResult> {
  await git(repoPath, ["worktree", "prune"]).catch(() => {});
  const slugBase = `${slugify(opts.threadId)}-ro`;
  const pathHash = createHash("sha256").update(repoPath).digest("hex").slice(0, 8);
  const repoName = slugify(basename(repoPath), "repo");
  const root = join(opts.worktreesRoot, `${repoName}-${pathHash}`);
  const maxTries = opts.maxTries ?? 999;
  let dir = "";
  for (let n = 1; n <= maxTries; n++) {
    const candidate = join(root, `${slugBase}-${n}`);
    if (!existsSync(candidate)) {
      dir = candidate;
      break;
    }
  }
  if (!dir) throw new GitError(`no free ${slugBase}-<n> worktree within ${maxTries} tries`);
  await git(repoPath, ["worktree", "add", "--detach", dir, opts.base]);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { path: dir, head, base: head };
}

function joinDir(root: string, repoPath: string, branchSlug: string): string {
  const repoName = slugify(basename(repoPath), "repo");
  const pathHash = createHash("sha256").update(repoPath).digest("hex").slice(0, 8);
  return join(root, `${repoName}-${pathHash}`, branchSlug);
}
