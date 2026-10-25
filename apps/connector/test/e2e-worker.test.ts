// End-to-end: a `start_worker` command arriving over the real transport (mock steward)
// drives the WorkerManager + fake-pi, and the started → progress → report(+git) → settled
// events come back on the same socket — issue #3's acceptance path over #30's transport.
import { rmSync, writeFileSync } from "node:fs";
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
  dir = tmpDir("sig-e2e-worker");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
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
      data: { sessionId: "w-e2e-1", branch: "sig/fix-the-login-bug-1" },
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
    expect(report.git).toMatchObject({ branch: "sig/fix-the-login-bug-1", ahead: 1, dirty: 0 });
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

  // Issue #13 end to end over the real transport: the stalled worker is detected, respawned
  // once (resumed{reason:stall} on the wire), and the second stall settles error:stall —
  // every event persisted through the EventLog before it hits the socket, seqs contiguous.
  it("drives a stalled worker to one respawn and then error:stall (issue #13)", async () => {
    const runsFile = join(dir, "runs-shared.txt");
    writeFileSync(runsFile, "0");
    const scenario = writeScenario(dir, "scenario", [[{ delayMs: 20_000 }], [{ delayMs: 20_000 }]]);
    app = new ConnectorApp({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_RUNS_FILE: runsFile }),
      watchdog: {
        stallMs: 400,
        tickMs: 80,
        cpuSampleGapMs: 10,
        // A permanently cold, stable tree: identical members, zero accumulated CPU.
        sampleTreeCpu: () => Promise.resolve({ totalCpuMs: 0, members: ["w-e2e-stall@t0"] }),
      },
    });
    await app.start();
    await mock.waitConnected();

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-e2e-stall",
      threadId: "t-stall",
      repoId: repo,
      mode: "write",
      prompt: "Do the thing",
    });
    await waitFor(() => mock.resultsFor(cmdId), 15_000, "cmd_result");

    await waitFor(
      () => mock.events().find((e) => e.type === "settled"),
      20_000,
      "settled error:stall on the wire",
    );
    const events = mock.events().filter((e) => e.workerId === "w-e2e-stall") as Array<Record<string, unknown>>;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // seqs contiguous from 1
    const stalls = events.filter((e) => e.type === "progress" && e.tool === "stall-watchdog");
    expect(stalls).toHaveLength(2);
    expect(events.find((e) => e.type === "resumed")).toMatchObject({ reason: "stall", count: 1 });
    expect(events.find((e) => e.type === "settled")).toMatchObject({ outcome: "error", errorClass: "stall" });
  }, 60_000);

  // PR #46 review finding 2: a caller-supplied watchdog.onError is composed with the daemon
  // log, not discarded by it — with no `log` wired it is the ONLY sink, and it must fire.
  it("routes watchdog detection errors to a caller-supplied onError even without a daemon log", async () => {
    const runsFile = join(dir, "runs-shared.txt");
    writeFileSync(runsFile, "0");
    const scenario = writeScenario(dir, "scenario", [[{ delayMs: 20_000 }]]);
    const seen: unknown[] = [];
    app = new ConnectorApp({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_RUNS_FILE: runsFile }),
      // Deliberately no `log`: the caller's onError is the only error sink.
      watchdog: {
        stallMs: 300,
        tickMs: 50,
        cpuSampleGapMs: 10,
        sampleTreeCpu: () => Promise.reject(new Error("sampler exploded")),
        onError: (err) => seen.push(err),
      },
    });
    await app.start();
    await mock.waitConnected();

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-e2e-onerr",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "go quiet",
    });
    await waitFor(() => mock.resultsFor(cmdId), 15_000, "cmd_result");

    // The silent worker becomes a candidate; the sampler rejects; the error must reach the
    // caller's hook — and must not crash the connector, which still answers commands.
    await waitFor(() => (seen.length > 0 ? seen[0] : undefined), 10_000, "onError called");
    expect(String(seen[0])).toContain("sampler exploded");
    const stopId = mock.sendCmd("stop_process", { workerId: "w-e2e-onerr" });
    const stopResult = await waitFor(() => mock.resultsFor(stopId), 10_000, "stop_process result");
    expect(stopResult).toMatchObject({ ok: true });
  }, 60_000);
});
