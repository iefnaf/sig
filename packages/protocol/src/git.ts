// Connector-collected git metadata. No file contents, diff hunks, or commit messages.
export interface GitFacts {
  branch: string;
  base: string;
  ahead: number;
  dirty: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  pushed: boolean;
  /** Optional for compatibility with connectors predating relay briefs. */
  head?: string;
  commits?: string[];
  changedFiles?: string[];
  pointersTruncated?: boolean;
}

// Repo capability (issue #88): Git is a detected, optional capability of a registered
// directory, not a registration requirement. A Git-backed repo keeps worktree isolation,
// branch/diff reporting, and PR support; a plain workspace has none of those.
export interface GitCapability {
  readonly kind: "git";
  readonly gitRoot: string;
  readonly defaultBranch: string | null;
  readonly remote: string | null;
}
export interface PlainCapability {
  readonly kind: "plain";
}
export type RepoCapability = GitCapability | PlainCapability;
