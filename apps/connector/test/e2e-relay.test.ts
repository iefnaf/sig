// End-to-end relay (issue #8, spec §5.3): leg 1 commits a plan file on its sig branch;
// leg 2 starts with base = that branch and SEES the plan file in its own worktree — the
// acceptance test that the plan document is actually on disk for the next leg, not just a
// branch name in a message. Real git, real worktrees, fake-pi playing the model.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import { fakePiAdapter, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";
import { startMockSteward } from "./mock-steward.ts";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let mock: ReturnType<typeof startMockSteward>;
let app: ConnectorApp;

beforeEach(async () => {
  dir = tmpDir("sig-e2e-relay");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  app?.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function startApp(scenarioPath: string): Promise<ConnectorApp> {
  app = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, scenarioPath) });
  return app.start().then(() => app);
}

/** Finds the worktree directory of a worker's branch under the connector's worktrees root. */
function worktreeOf(branchSlug: string): string {
  const roots = readdirSync(join(stateDir, "worktrees"));
  for (const root of roots) {
    const candidate = join(stateDir, "worktrees", root, branchSlug);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no worktree for ${branchSlug}`);
}

describe("a relay across two write legs (issue #8, spec §5.3)", () => {
  it(
    "leg 2 starts from leg 1's branch and sees its plan file on disk",
    async () => {
      const THREAD = "e2e-relay";
      const PLAN = "# plan from leg 1\nuse sqlite for the session store\n";
      // One scripted run serves both legs (fake-pi indexes runs per process, so a second
      // worker replays runs[0]): it branches on the plan file's presence — leg 1 (no PLAN.md
      // yet) writes and COMMITS the plan; leg 2 (inherits it via base) reads it and records
      // the proof files for the assertions.
      const planShell =
        `if [ -f PLAN.md ]; then cp PLAN.md .plan-read.txt && git rev-parse --abbrev-ref HEAD > .branch.txt ` +
        `&& git log --oneline main..HEAD > .log.txt; ` +
        `else printf '${PLAN.trim()}\n' > PLAN.md && git add PLAN.md && git commit -m "leg 1: plan"; fi`;
      const scenario = writeScenario(dir, "scenario", [
        reportRun({ status: "done", summary: "leg finished", changes: ["worktree"] }, { shellBefore: planShell }),
      ]);
      startApp(scenario);
      await mock.waitConnected();
      await mock.waitHello();

      // --- leg 1: no base, its own branch -------------------------------------------------------
      const cmd1 = mock.sendCmd("start_worker", {
        workerId: "w-relay-1",
        threadId: THREAD,
        repoId: repo,
        mode: "write",
        prompt: "Produce the implementation plan and commit it",
      });
      const res1 = await waitFor(() => mock.resultsFor(cmd1), 15_000, "leg 1 cmd_result");
      expect(res1).toMatchObject({ ok: true, data: { branch: "sig/e2e-relay-1" } });
      await waitFor(() => mock.events().some((e) => e.type === "report" && e.workerId === "w-relay-1"), 20_000, "leg 1 report");

      const leg1Report = mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-1") as {
        git: { branch: string; ahead: number };
      };
      expect(leg1Report.git.branch).toBe("sig/e2e-relay-1");
      expect(leg1Report.git.ahead).toBe(1);
      const leg1Dir = worktreeOf("e2e-relay-1");
      expect(readFileSync(join(leg1Dir, "PLAN.md"), "utf8")).toBe(PLAN);
      expect(existsSync(join(repo, "PLAN.md"))).toBe(false); // the owner's checkout is untouched

      // --- leg 2: base = leg 1's branch — what the steward sends on a relay (spec §5.3) -------
      const cmd2 = mock.sendCmd("start_worker", {
        workerId: "w-relay-2",
        threadId: THREAD,
        repoId: repo,
        mode: "write",
        base: leg1Report.git.branch,
        prompt: "Implement per the plan committed by the previous leg",
      });
      const res2 = await waitFor(() => mock.resultsFor(cmd2), 15_000, "leg 2 cmd_result");
      expect(res2).toMatchObject({ ok: true, data: { branch: "sig/e2e-relay-2" } });
      await waitFor(() => mock.events().some((e) => e.type === "settled" && e.workerId === "w-relay-2"), 20_000, "leg 2 settled");

      // The acceptance: leg 2's worktree is cut from leg 1's branch — the plan file is ON
      // DISK in leg 2's working directory, and its run could read it.
      const leg2Dir = worktreeOf("e2e-relay-2");
      expect(readFileSync(join(leg2Dir, "PLAN.md"), "utf8")).toBe(PLAN); // inherited from leg 1
      expect(readFileSync(join(leg2Dir, ".plan-read.txt"), "utf8")).toBe(PLAN); // leg 2 actually read it
      expect(readFileSync(join(leg2Dir, ".branch.txt"), "utf8").trim()).toBe("sig/e2e-relay-2");
      // The lineage: leg 2's log contains leg 1's plan commit (inherited via base).
      expect(readFileSync(join(leg2Dir, ".log.txt"), "utf8")).toContain("leg 1: plan");

      const leg2Report = mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-2") as {
        git: { branch: string; ahead: number };
      };
      expect(leg2Report.git.branch).toBe("sig/e2e-relay-2");
      expect(leg2Report.git.ahead).toBe(0); // leg 2 committed nothing itself — the inherited plan rides on leg 1's commit
    },
    60_000,
  );

  it(
    "a base that does not exist locally fails loudly instead of silently starting from the default branch",
    async () => {
      const scenario = writeScenario(dir, "scenario", []);
      startApp(scenario);
      await mock.waitConnected();
      const cmd = mock.sendCmd("start_worker", {
        workerId: "w-relay-x",
        threadId: "e2e-relay",
        repoId: repo,
        mode: "write",
        base: "sig/never-pushed",
        prompt: "continue",
      });
      const res = await waitFor(() => mock.resultsFor(cmd), 15_000, "cmd_result");
      expect(res).toMatchObject({ ok: false, error: { code: "worktree_failed" } });
    },
    30_000,
  );
});
