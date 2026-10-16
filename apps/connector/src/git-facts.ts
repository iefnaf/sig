// GitFacts, docs/design/connector-pi.md §2 and §7.2: the connector runs git itself after
// outcome adjudication and merges the result into the `report` event, so the model can
// neither fabricate nor omit branch/commits/change-stats/push status.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitFacts {
  branch: string;
  base: string;
  /** Commits on the worker branch since base. */
  ahead: number;
  /** Uncommitted changes (file count). */
  dirty: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Whether HEAD is already contained by some remote-tracking branch. */
  pushed: boolean;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 30_000 });
    return stdout;
  } catch {
    return null; // degrade: report what we could collect
  }
}

/** Collects git facts for the worker's worktree. Individual failures degrade to zeroes/nulls. */
export async function collectGitFacts(worktreeDir: string, base: string): Promise<GitFacts> {
  const [branch, aheadOut, status, numstat, remoteRefs, baseSha] = await Promise.all([
    git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(worktreeDir, ["rev-list", "--count", `${base}..HEAD`]),
    git(worktreeDir, ["status", "--porcelain"]),
    git(worktreeDir, ["diff", "--numstat", base]),
    git(worktreeDir, ["branch", "--all", "--contains", "HEAD"]),
    git(worktreeDir, ["rev-parse", base]),
  ]);

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of (numstat ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t");
    filesChanged += 1;
    if (add !== undefined && /^\d+$/.test(add)) insertions += Number(add);
    if (del !== undefined && /^\d+$/.test(del)) deletions += Number(del);
  }

  return {
    branch: (branch ?? "").trim() || "unknown",
    base: (baseSha ?? "").trim() || base,
    ahead: Number((aheadOut ?? "0").trim()) || 0,
    dirty: (status ?? "").split("\n").filter((l) => l.trim().length > 0).length,
    filesChanged,
    insertions,
    deletions,
    pushed: (remoteRefs ?? "")
      .split("\n")
      .some((ref) => ref.trim().startsWith("remotes/")),
  };
}
