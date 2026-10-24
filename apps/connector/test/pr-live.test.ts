// LIVE verification of the consent gate's machine half (issue #21 AC5) — run explicitly:
//
//   SIG_PR_LIVE=1 npx vitest run test/pr-live.test.ts
//
// It creates a PRIVATE scratch repo under the authenticated gh account, commits a change on
// a sig/* branch in a local clone, runs the REAL pr_worker path (real `git push`, real
// `gh pr create`, no exec seam), and asserts the pr_created event carries a working PR URL.
// The scratch repo is deleted again in the cleanup hook. Skipped without the env var, so CI
// never touches the network or the account.
//
// The click half ([同意] on the done card → pr_worker command) cannot be verified by an
// agent by design — spike-conclusions §2: "the happy path requires the user's own click";
// it is covered by test/pr-consent.test.ts against the real webhook path instead.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakePiAdapter, git, writeScenario } from "./helpers.ts";

const exec = promisify(execFile);
const LIVE = process.env.SIG_PR_LIVE === "1";

describe.skipIf(!LIVE)("pr_worker against a real repo (issue #21 AC5)", () => {
  const dir = join(tmpdir(), `sig-pr-live-${process.pid}-${Date.now()}`);
  const stateDir = join(dir, "state");
  const repoName = `sig-pr-gate-verify-${Date.now()}`;
  let store: LocalStore;
  let manager: WorkerManager;
  const events: Array<Record<string, unknown>> = [];

  afterAll(async () => {
    manager?.stop();
    store?.close();
    // Best-effort cleanup: the clone never outlives the run; the scratch repo needs the
    // delete_repo scope, which the verifying token may lack — then say so loudly instead of
    // leaving an invisible leftover.
    await exec("gh", ["repo", "delete", repoName, "--yes"]).catch((err) => {
      console.warn(`[pr-live] could not delete ${repoName} (${err instanceof Error ? err.message : err}); delete it manually`);
    });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("pushes the branch and opens a real PR; pr_created carries the URL", { timeout: 120_000 }, async () => {
    // 1. A private scratch repo on the account, cloned empty into `dir/clone`.
    const who = (await exec("gh", ["api", "user", "--jq", ".login"])).stdout.trim();
    await exec("gh", ["repo", "create", repoName, "--private"]);
    mkdirSync(stateDir, { recursive: true });
    const clone = join(dir, "clone");
    await exec("git", ["clone", `https://github.com/${who}/${repoName}.git`, clone]);
    await git(clone, ["config", "user.email", "verify@sig.local"]);
    await git(clone, ["config", "user.name", "Sig Verify"]);

    // 2. Seed main, then the worker branch with one commit — the state a settled write task leaves.
    writeFileSync(join(clone, "README.md"), `# ${repoName}\n`);
    await exec("git", ["add", "."], { cwd: clone });
    await exec("git", ["commit", "-m", "init"], { cwd: clone });
    await exec("git", ["branch", "-M", "main"], { cwd: clone });
    await exec("git", ["push", "-u", "origin", "main"], { cwd: clone });
    const branch = "sig/live-verify-1";
    await exec("git", ["checkout", "-b", branch], { cwd: clone });
    writeFileSync(join(clone, "VERIFY.md"), `# consent gate live verification\n\n${new Date().toISOString()}\n`);
    await exec("git", ["add", "."], { cwd: clone });
    await exec("git", ["commit", "-m", "verify: consent gate live run"], { cwd: clone });

    // 3. A worker row shaped exactly like a settled write task, then the REAL command:
    //    real git push + real gh pr create, no exec seam anywhere.
    store = new LocalStore(join(stateDir, "connector.sqlite"));
    store.addRepo({ repoId: clone, name: repoName, path: clone, capability: { kind: "git", gitRoot: clone, defaultBranch: "main", remote: `https://github.com/${who}/${repoName}.git` } });
    manager = new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, writeScenario(dir, "noop", [])),
      emit: (workerId, fields) => events.push({ workerId, ...fields }),
    });
    store.upsertWorker({
      workerId: "w-live-verify",
      threadId: "consent-gate-live-verify",
      repoId: clone,
      mode: "write",
      state: "idle",
      branch,
      worktree: clone,
      base: "main",
    });
    const result = (await manager.handleCommand(
      "cmd-live-1",
      "pr_worker",
      { workerId: "w-live-verify", title: "consent gate live verification", body: "Opened by sig's pr_worker live test (issue #21)." },
      "w-live-verify",
    )) as { url: string };

    // 4. The event the chat would see, and the PR actually existing on GitHub.
    expect(result.url).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
    expect(events).toEqual([
      { workerId: "w-live-verify", type: "pr_created", cmdId: "cmd-live-1", url: result.url, branch },
    ]);
    const view = JSON.parse(
      (await exec("gh", ["pr", "view", branch, "--json", "url,state", "--repo", `${who}/${repoName}`])).stdout,
    ) as { url: string; state: string };
    expect(view.url).toBe(result.url);
    expect(view.state).toBe("OPEN");
    console.log(`[pr-live] opened and verified: ${view.url}`);
  });
});
