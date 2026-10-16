// End-to-end: a `start_worker` command arriving over the real transport (mock steward)
// drives the WorkerManager + fake-pi, and the started → progress → report(+git) → settled
// events come back on the same socket — issue #3's acceptance path over #30's transport.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import { fakePiAdapter, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
let app: ConnectorApp;

beforeEach(async () => {
  dir = tmpDir("shepherd-e2e-worker");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: null });
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  await app?.manager.stopProcess("w-e2e-1").catch(() => undefined);
  app?.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function startApp(scenarioPath: string): Promise<ConnectorApp> {
  app = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, scenarioPath) });
  return app.start().then(() => app);
}

describe("start_worker over the real transport (issue #3 + #30)", () => {
  it("drives a write task end to end: cmd → worktree → fake-pi → events on the socket", async () => {
    const scenario = writeScenario(dir, "scenario", [
      reportRun(
        { status: "done", summary: "Fixed the login bug", changes: ["src/auth.ts"] },
        { shellBefore: "echo fix > fix.txt && git add -A && git commit -m fix" },
      ),
    ]);
    startApp(scenario);
    await mock.waitConnected();
    await mock.waitHello(); // the frame can trail the OPEN on slow runners (CI flake)

    // hello carries the honest snapshot: the pi agent and the registered repo.
    const hello = mock.hellos().at(-1)!;
    expect(hello.agents).toEqual([expect.objectContaining({ kind: "pi" })]);
    expect(hello.repos).toEqual([expect.objectContaining({ repoId: repo })]);

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-e2e-1",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });

    const result = await waitFor(() => mock.resultsFor(cmdId), 15_000, "cmd_result");
    expect(result).toMatchObject({
      t: "cmd_result",
      re: cmdId,
      ok: true,
      data: { sessionId: "w-e2e-1", branch: "shepherd/fix-the-login-bug-1" },
    });

    await waitFor(() => mock.events().some((e) => e.type === "settled"), 20_000, "settled event on the wire");

    const events = mock.events().filter((e) => e.workerId === "w-e2e-1") as Array<Record<string, unknown>>;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.indexOf("report")).toBeLessThan(types.indexOf("settled"));
    // seqs contiguous from 1 (per-worker, assigned by the EventLog before the wire).
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const report = events.find((e) => e.type === "report")!;
    expect(report.status).toBe("done");
    expect(report.git).toMatchObject({ branch: "shepherd/fix-the-login-bug-1", ahead: 1, dirty: 0 });
    expect(events.find((e) => e.type === "settled")).toMatchObject({ outcome: "reported" });

    // Redelivery of the same cmdId: `duplicate`, and no second run (events do not grow).
    const countBefore = mock.events().length;
    mock.sendCmd("start_worker", { workerId: "w-e2e-1", threadId: "t", repoId: repo, prompt: "x" }, cmdId);
    await waitFor(
      () => (mock.acksFor(cmdId) as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "duplicate ack",
    );
    expect(mock.resultsFor(cmdId)).toMatchObject({ ok: true });
    expect(mock.events().length).toBe(countBefore);
  }, 60_000);

  it("rejects an unregistered repo with not_registered_repo on the wire", async () => {
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "s" })]);
    startApp(scenario);
    await mock.waitConnected();

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-e2e-2",
      threadId: "t",
      repoId: "/not/registered",
      mode: "write",
      prompt: "do something",
    });
    const result = await waitFor(() => mock.resultsFor(cmdId), 10_000, "cmd_result");
    expect(result).toMatchObject({ ok: false, error: { code: "not_registered_repo" } });
  }, 30_000);

  it("answers unimplemented kinds with unsupported_command", async () => {
    const scenario = writeScenario(dir, "scenario", []);
    startApp(scenario);
    await mock.waitConnected();

    const cmdId = mock.sendCmd("history", { workerId: "w-e2e-1", maxBytes: 1024 });
    const result = await waitFor(() => mock.resultsFor(cmdId), 10_000, "cmd_result");
    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_command" } });
  }, 30_000);
});
