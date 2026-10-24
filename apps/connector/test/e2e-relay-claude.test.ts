// End-to-end relay across agent types (issue #17 AC, spec §5.3): leg 1 is a pi worker that
// commits a plan on its sig branch; leg 2 is a CLAUDE CODE worker started with
// base = that branch — the acceptance is that the Claude Code leg's worktree is cut from
// the pi leg's branch, the plan file is on disk for it, and its report carries git facts
// from the same shared adjudication path. Real git, real worktrees, fake-pi AND
// fake-claude playing the two models; the connector advertises both agents in hello.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import {
  claudeReportRun,
  fakeClaudeAdapter,
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeClaudeScenario,
  writeScenario,
} from "./helpers.ts";
import { startMockSteward } from "./mock-steward.ts";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let mock: ReturnType<typeof startMockSteward>;
let app: ConnectorApp;

beforeEach(async () => {
  dir = tmpDir("sig-e2e-relay-claude");
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

function worktreeOf(branchSlug: string): string {
  const roots = readdirSync(join(stateDir, "worktrees"));
  for (const root of roots) {
    const candidate = join(stateDir, "worktrees", root, branchSlug);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no worktree for ${branchSlug}`);
}

describe("a relay hands a branch from a pi worker to a Claude Code worker (issue #17)", () => {
  it(
    "leg 2 (claude-code, base = leg 1's pi branch) sees the plan file and reports through the shared path",
    async () => {
      const THREAD = "cross-agent-relay";
      const PLAN = "# plan from the pi leg\nuse the shared adjudication path\n";
      // Leg 1 (pi): no PLAN.md yet → write and COMMIT the plan (exactly e2e-relay's leg 1).
      const piShell =
        `if [ -f PLAN.md ]; then echo unexpected > .wrong.txt; ` +
        `else printf '${PLAN.trim()}\n' > PLAN.md && git add PLAN.md && git commit -m "pi leg: plan"; fi`;
      const piScenario = writeScenario(dir, "pi", [reportRun({ status: "done", summary: "pi leg finished" }, { shellBefore: piShell })]);
      // Leg 2 (claude-code): PLAN.md inherited via base → read it and record the proof files.
      const claudeShell =
        `if [ -f PLAN.md ]; then cp PLAN.md .plan-read.txt && git rev-parse --abbrev-ref HEAD > .branch.txt ` +
        `&& git log --oneline main..HEAD > .log.txt; else echo missing > .no-plan.txt; fi`;
      const claudeScenario = writeClaudeScenario(dir, "claude", [
        claudeReportRun(
          { status: "done", summary: "claude leg finished", changes: ["PLAN.md read"] },
          { shellBefore: claudeShell },
        ),
      ]);

      app = new ConnectorApp({
        store,
        stateDir,
        adapters: [fakePiAdapter(stateDir, piScenario), fakeClaudeAdapter(stateDir, claudeScenario)],
      });
      await app.start();
      await mock.waitConnected();
      await mock.waitHello();

      // hello.agents advertises BOTH agents (issue #17 AC) — the steward can target either.
      const hello = mock.hellos()[0]! as { agents: Array<{ kind: string; version: string; capabilities: Record<string, boolean> }> };
      expect(hello.agents.map((a) => a.kind)).toEqual(["pi", "claude-code"]);
      const claudeEntry = hello.agents.find((a) => a.kind === "claude-code")!;
      expect(claudeEntry.version).toBeTruthy();
      expect(claudeEntry.capabilities.steer).toBe(false); // honest declaration on the wire

      // --- leg 1: pi, no base ------------------------------------------------------------------
      const cmd1 = mock.sendCmd("start_worker", {
        workerId: "w-relay-pi-1",
        threadId: THREAD,
        repoId: repo,
        mode: "write",
        prompt: "Produce the implementation plan and commit it",
      });
      const res1 = await waitFor(() => mock.resultsFor(cmd1), 15_000, "leg 1 cmd_result");
      expect(res1).toMatchObject({ ok: true, data: { branch: "sig/cross-agent-relay-1" } });
      await waitFor(
        () => mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-pi-1"),
        20_000,
        "leg 1 report",
      );
      const leg1Report = mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-pi-1") as {
        git: { branch: string; ahead: number };
      };
      expect(leg1Report.git.branch).toBe("sig/cross-agent-relay-1");
      expect(leg1Report.git.ahead).toBe(1);
      expect(readFileSync(join(worktreeOf("cross-agent-relay-1"), "PLAN.md"), "utf8")).toBe(PLAN);

      // --- leg 2: claude-code, base = leg 1's branch (what the steward sends on a relay) ------
      const cmd2 = mock.sendCmd("start_worker", {
        workerId: "w-relay-claude-2",
        threadId: THREAD,
        repoId: repo,
        mode: "write",
        agent: "claude-code",
        base: leg1Report.git.branch,
        prompt: "Implement per the plan committed by the previous leg",
      });
      const res2 = await waitFor(() => mock.resultsFor(cmd2), 15_000, "leg 2 cmd_result");
      expect(res2).toMatchObject({ ok: true, data: { branch: "sig/cross-agent-relay-2" } });

      // The report rides the SAME event path (report merged with git facts, then settled).
      await waitFor(
        () => mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-claude-2"),
        30_000,
        "leg 2 report",
      );
      const leg2Report = mock.events().find((e) => e.type === "report" && e.workerId === "w-relay-claude-2") as {
        summary: string;
        git: { branch: string; ahead: number };
      };
      expect(leg2Report.summary).toBe("claude leg finished");
      expect(leg2Report.git.branch).toBe("sig/cross-agent-relay-2");
      expect(leg2Report.git.ahead).toBe(0); // the inherited plan rides on the pi leg's commit
      await waitFor(
        () => mock.events().some((e) => e.type === "settled" && e.workerId === "w-relay-claude-2" && e.outcome === "reported"),
        20_000,
        "leg 2 settled",
      );

      // The acceptance proofs, inside leg 2's own worktree:
      const leg2Dir = worktreeOf("cross-agent-relay-2");
      expect(readFileSync(join(leg2Dir, "PLAN.md"), "utf8")).toBe(PLAN); // inherited via base
      expect(readFileSync(join(leg2Dir, ".plan-read.txt"), "utf8")).toBe(PLAN); // claude actually read it
      expect(readFileSync(join(leg2Dir, ".branch.txt"), "utf8").trim()).toBe("sig/cross-agent-relay-2");
      expect(readFileSync(join(leg2Dir, ".log.txt"), "utf8")).toContain("pi leg: plan");
      expect(existsSync(join(leg2Dir, ".no-plan.txt"))).toBe(false);
      expect(existsSync(join(repo, "PLAN.md"))).toBe(false); // the owner's checkout is untouched

      // The workers snapshot tells the DO which agent owns which worker.
      const workerAgents = Object.fromEntries(
        store.listWorkers().map((w) => [w.workerId, w.agent ?? "pi"]),
      );
      expect(workerAgents).toMatchObject({ "w-relay-pi-1": "pi", "w-relay-claude-2": "claude-code" });
    },
    90_000,
  );
});
