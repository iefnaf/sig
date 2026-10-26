// GitFacts, docs/design/connector-pi.md §2 and §7.2: the connector runs git itself after
// outcome adjudication and merges the result into the `report` event, so the model can
// neither fabricate nor omit branch/commits/change-stats/push status. Commits and changed
// files are pointers (issue #8): bare shas/paths, never content.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitFacts } from "@alexlikevibe/protocol";

export type { GitFacts } from "@alexlikevibe/protocol";

const exec = promisify(execFile);

/** Pointer caps: a report stays small while still naming the work (issue #8). */
const MAX_COMMITS = 20;
const MAX_FILES = 100;

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
  const [branch, aheadOut, status, numstat, remoteRefs, baseSha, head, commitsOut, filesOut, untrackedOut] = await Promise.all([
    git(worktreeDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(worktreeDir, ["rev-list", "--count", `${base}..HEAD`]),
    git(worktreeDir, ["status", "--porcelain"]),
    git(worktreeDir, ["diff", "--numstat", base]),
    git(worktreeDir, ["branch", "--all", "--contains", "HEAD"]),
    git(worktreeDir, ["rev-parse", base]),
    git(worktreeDir, ["rev-parse", "HEAD"]),
    git(worktreeDir, ["rev-list", `--max-count=${MAX_COMMITS + 1}`, `${base}..HEAD`]),
    git(worktreeDir, ["diff", "--name-only", "-z", base]),
    git(worktreeDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
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

  // Pointers: commit shas (newest first) and file paths, capped; truncated says the cap hit.
  const commits = (commitsOut ?? "").trim().split("\n").filter(Boolean);
  const changedFiles = [...new Set([...(filesOut ?? "").split("\0"), ...(untrackedOut ?? "").split("\0")].filter(Boolean))].sort();
  return {
    ...(head?.trim() ? { head: head.trim() } : {}),
    commits: commits.slice(0, MAX_COMMITS),
    changedFiles: changedFiles.slice(0, MAX_FILES),
    pointersTruncated: commits.length > MAX_COMMITS || changedFiles.length > MAX_FILES,
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
