// The PR consent gate's machine half (issue #21, spike-conclusions §2): push the worker's
// branch and open a PR with `gh`, both inside the worker's own worktree. Nothing here runs
// without the steward's `pr_worker` command, and that command only exists because the user
// tapped [同意] on the done card — the connector never pushes on its own (connector-pi.md
// §7.3 rule 4). Failures classify into the stages the report card explains: gh_missing,
// auth, push, create.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Test seam: one spawned command. The default is plain execFile; tests script gh and git
 *  without touching the network or a real GitHub account. */
export type PrExec = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** The failure stages the steward's report card knows how to explain (issue #21 AC4). */
export type PrFailureStage = "gh_missing" | "auth" | "push" | "create";

export class PrError extends Error {
  constructor(
    readonly stage: PrFailureStage,
    message: string,
  ) {
    super(message);
    this.name = "PrError";
  }
}

/** gh first prompts for browser auth on a TTY; in a daemon there is none, so every call
 *  runs with stdin closed and a bounded lifetime. */
export const DEFAULT_PR_TIMEOUT_MS = 120_000;

export interface OpenPrOptions {
  worktree: string;
  branch: string;
  title: string;
  body: string;
  exec?: PrExec;
  timeoutMs?: number;
}

function clip(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return typeof e.stderr === "string" && e.stderr.trim().length > 0 ? e.stderr : (e.message ?? String(err));
}

/** An expired token can pass `gh auth status` (cached) and still fail the API call at create
 *  time — keep that "auth", not "create": the fix is the same `gh auth login`. */
function classifyCreateFailure(stderr: string): PrFailureStage {
  return /auth|login|credential|token|forbidden/i.test(stderr) ? "auth" : "create";
}

/**
 * Push `branch` to origin and open a PR with `gh pr create`, both with `worktree` as cwd.
 * Returns the new PR's URL; throws PrError with the classified stage on every failure path
 * (gh absent, gh unauthenticated, push rejected, create failed).
 */
export async function openPr(opts: OpenPrOptions): Promise<{ url: string }> {
  const run: PrExec = opts.exec ?? ((file, args, options) => exec(file, args, options));
  const timeout = opts.timeoutMs ?? DEFAULT_PR_TIMEOUT_MS;
  const cwd = opts.worktree;

  // 1. gh must exist at all — ENOENT is the "not installed" signal (AC4's "no gh").
  try {
    await run("gh", ["--version"], { cwd, timeout });
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      throw new PrError("gh_missing", "the GitHub CLI (`gh`) is not installed on this machine");
    }
    // Installed but unresponsive (e.g. a timeout) is NOT "install gh" advice — classify as a
    // generic create-stage failure whose retry contract fits a transient hiccup.
    throw new PrError("create", `gh did not respond: ${stderrOf(err)}`);
  }

  // 2. gh must be authenticated — the failure the owner fixes with `gh auth login` locally.
  try {
    await run("gh", ["auth", "status"], { cwd, timeout });
  } catch (err) {
    throw new PrError("auth", clip(stderrOf(err), 280));
  }

  // 3. Push the branch (`-u` ties it to origin so a later plain `git push` works too).
  try {
    await run("git", ["push", "-u", "origin", opts.branch], { cwd, timeout });
  } catch (err) {
    throw new PrError("push", clip(stderrOf(err), 280));
  }

  // 4. Open the PR; gh prints the new PR's URL on stdout.
  let stdout: string;
  try {
    const res = await run(
      "gh",
      ["pr", "create", "--head", opts.branch, "--title", clip(opts.title, 70), "--body", opts.body],
      { cwd, timeout },
    );
    stdout = res.stdout;
  } catch (err) {
    const stderr = stderrOf(err);
    throw new PrError(classifyCreateFailure(stderr), clip(stderr, 280));
  }
  const url = stdout.match(/https?:\/\/\S+/)?.[0];
  if (!url) {
    throw new PrError("create", `gh pr create succeeded but printed no URL: ${clip(stdout, 200)}`);
  }
  return { url };
}
