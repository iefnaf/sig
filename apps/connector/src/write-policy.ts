/** Does a write task get a private `git worktree` copy, or edit the registered directory in
 *  place? "worktree" is a Git mechanism — it is only ever legal paired with a Git-backed repo
 *  (enforced in store.ts's `setWritePolicy`, not by this type alone). */
export type Isolation = "worktree" | "in-place";

/** Can more than one write task run against this repo at once, or must they queue one at a
 *  time? Orthogonal to isolation and to Git-ness: the write-slot queue has no Git dependency
 *  and no worktree dependency of its own. */
export type Concurrency = "parallel" | "serial";

export interface InPlacePolicy {
  readonly isolation: "in-place";
  readonly concurrency: Concurrency;
}
export interface WorktreePolicy {
  readonly isolation: "worktree";
  readonly concurrency: Concurrency;
}
export type WritePolicy = InPlacePolicy | WorktreePolicy;

export const DEFAULT_GIT_WRITE_POLICY: WritePolicy = { isolation: "worktree", concurrency: "parallel" };
/** Serial, not parallel: an in-place collision on a plain workspace has no git history to
 *  recover from (no branch, no diff, nothing to review after the fact) — strictly worse than
 *  a Git main-mode collision, which at least leaves a reviewable dirty working tree. */
export const DEFAULT_PLAIN_WRITE_POLICY: InPlacePolicy = { isolation: "in-place", concurrency: "serial" };

export function isIsolation(value: unknown): value is Isolation {
  return value === "worktree" || value === "in-place";
}
export function isConcurrency(value: unknown): value is Concurrency {
  return value === "parallel" || value === "serial";
}
