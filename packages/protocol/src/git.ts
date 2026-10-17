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
