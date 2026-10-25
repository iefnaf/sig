// Issue #12 fault injection over the real transport (connector-pi.md §14): the connector is
// killed mid-run, mid-`sending`, and mid-reconciliation. A "kill" is an in-process crash
// simulation — children SIGKILLed without the graceful stop, locks left naming a dead
// process, this instance's timers cleared — and the next ConnectorApp boot over the same
// LocalStore plays the restart: §9.1 reconciliation first, then the hello whose workers
// snapshot + fresh bootId let the DO reconcile (asserted on the wire here; the DO side is
// covered by apps/steward/test/reconcile.test.ts).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { CommandLog } from "../src/commands.ts";
import { inspectSessionTail } from "../src/session-tail.ts";
import { LocalStore } from "../src/store.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  reportToolCall,
  sessionAssistantMessage,
  sessionUserMessage,
  tmpDir,
  waitFor,
  writeScenario,
  writeSessionFile,
} from "./helpers.ts";

let dir: string;
let stateDir: string;
let sessionsDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
const apps: ConnectorApp[] = [];

beforeEach(async () => {
  dir = tmpDir("sig-e2e-restart");
  stateDir = join(dir, "state");
  sessionsDir = join(dir, "sessions");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  const last = apps.at(-1);
  if (last) {
    for (const worker of store.listWorkers()) await last.manager.stopProcess(worker.workerId).catch(() => undefined);
  }
  for (const app of apps) app.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function bootApp(scenarioPath: string | null, recovery: ConstructorParameters<typeof ConnectorApp>[0]["recovery"] = {}): Promise<ConnectorApp> {
  const app = new ConnectorApp({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenarioPath ?? writeScenario(dir, `empty-${apps.length}`, []), {
      FAKE_PI_SESSIONS_DIR: sessionsDir,
    }),
    recovery,
  });
  apps.push(app);
  return app.start().then(() => app);
}

function interruptedSessionFile(workerId: string): string {
  return writeSessionFile(sessionsDir, workerId, [
    sessionUserMessage("Fix the login bug"),
    sessionAssistantMessage([reportToolCall("c1", { status: "done", summary: "halfway" })], { stopReason: "toolUse" }),
  ]);
}

describe("connector restart fault injection (issue #12, connector-pi.md §9/§14)", () => {
  it("killed mid-run: restart reconciles lost → auto-resumes → completes, seqs continue", async () => {
    // Boot A: the run is in flight (a tool call issued, no result) when the connector dies.
    const scenarioA = writeScenario(dir, "scenario-a", [
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        { session: sessionUserMessage("Fix the login bug") },
        { session: sessionAssistantMessage([reportToolCall("c1", { status: "done", summary: "halfway" })], { stopReason: "toolUse" }) },
        { delayMs: 60_000 }, // "mid-run": the crash lands here
      ],
    ]);
    const appA = await bootApp(scenarioA);
    await mock.waitConnected();

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-restart-1",
      threadId: "fix-the-login-bug",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => mock.resultsFor(cmdId), 15_000, "cmd_result");
    await waitFor(() => mock.events().some((e) => e.type === "started"), 15_000, "started on the wire");

    appA.simulateCrash(); // SIGKILL the children, leave dead-holder locks, stop the socket

    // Boot B over the same store: reconcile BEFORE hello, then the resume completes the task.
    const scenarioB = writeScenario(dir, "scenario-b", [reportRun({ status: "done", summary: "resumed and finished" })]);
    const appB = await bootApp(scenarioB, { autoResumeBackoffMs: 500 });
    await mock.waitConnected();

    // bootId changed and the hello snapshot already reflects the reconciliation (§6.1).
    await waitFor(() => mock.hellos().length >= 2, 10_000, "second hello");
    const [helloA, helloB] = mock.hellos() as Array<{ bootId: string; workers: Array<Record<string, unknown>> }>;
    expect(helloA).toBeDefined();
    expect(helloB!.bootId).not.toBe(helloA!.bootId);
    expect(helloB!.workers).toContainEqual(expect.objectContaining({ workerId: "w-restart-1", state: "lost" }));

    await waitFor(() => mock.events().some((e) => e.type === "settled"), 20_000, "settled after auto-resume");

    const events = mock.events().filter((e) => e.workerId === "w-restart-1");
    const types = events.map((e) => e.type);
    // The restart path on the wire: lost → resumed → … → report → settled (§9.1/§9.2), with
    // per-worker seqs CONTINUING across the restart (ADR-0001: restart-at-1 gets deduped away).
    for (const [i, type] of ["started", "lost", "resumed", "report", "settled"].entries()) {
      expect(types).toContain(type);
      expect(types.indexOf(type)).toBeGreaterThan(i - 1);
    }
    expect(events.find((e) => e.type === "lost")).toMatchObject({ reason: "connector_restart" });
    expect(events.find((e) => e.type === "resumed")).toMatchObject({ reason: "connector_restart", count: 1 });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // contiguous, no renumbering
    expect(store.getWorker("w-restart-1")).toMatchObject({ state: "idle", lastOutcome: "reported" });
  }, 60_000);

  it("killed mid-`sending`: the stuck command is reported ambiguous at hello, never re-run (§6.3)", async () => {
    // A command whose handler was in flight when the connector died is undecidable.
    const stuck = new CommandLog(store.database);
    stuck.begin("cmd-sending-crash", { kind: "diag" });
    stuck.markSending("cmd-sending-crash");

    await bootApp(null);
    await mock.waitConnected();
    await mock.waitHello(); // the frame can trail the OPEN on slow runners (CI flake)

    const hello = mock.hellos().at(-1) as { pendingAcks: Array<{ cmdId: string; state: string; recovered?: boolean }> };
    expect(hello.pendingAcks).toContainEqual(expect.objectContaining({ cmdId: "cmd-sending-crash", state: "ambiguous" }));

    mock.sendCmd("start_worker", {}, "cmd-sending-crash"); // DO redelivery
    await waitFor(
      () => (mock.acksFor("cmd-sending-crash") as { status?: string } | undefined)?.status === "ambiguous",
      10_000,
      "ambiguous ack",
    );
    // The connector never re-ran it: no start_worker side effects appeared.
    expect(store.listWorkers()).toHaveLength(0);
  }, 30_000);

  it("killed mid-reconciliation: the next boot finishes it without runaway resumes", async () => {
    // Two workers were running at the crash; boot B dies again while reconciling them
    // (the second worker's session tail is unreadable).
    for (const workerId of ["w-mid-1", "w-mid-2"]) {
      const sessionFile = interruptedSessionFile(workerId);
      store.upsertWorker({
        workerId,
        threadId: "fix-the-login-bug",
        repoId: repo,
        mode: "write",
        state: "running",
        sessionId: workerId,
        sessionFile,
      });
    }
    const appB = await bootApp(null, {
      autoResumeBackoffMs: 10_000, // the pending resume must not fire before this boot dies
      inspectTail: (sessionFile) => {
        if (sessionFile?.includes("w-mid-2")) throw new Error("simulated unreadable session");
        return inspectSessionTail(sessionFile);
      },
    });
    await mock.waitConnected();
    // w-mid-1 reconciled (lost, resume pending); w-mid-2 untouched; then this boot crashes.
    expect(store.getWorker("w-mid-1")).toMatchObject({ state: "lost" });
    expect(store.getWorker("w-mid-2")).toMatchObject({ state: "running" });
    appB.simulateCrash();

    // Boot C finishes the reconciliation; the persisted budget keeps resumes bounded (§9.2).
    const scenarioC = writeScenario(dir, "scenario-c", [reportRun({ status: "done", summary: "recovered on boot C" })]);
    const appC = await bootApp(scenarioC, { autoResumeBackoffMs: 40 });
    await mock.waitConnected();
    await waitFor(
      () =>
        ["w-mid-1", "w-mid-2"].every((id) => store.getWorker(id)?.state === "idle") &&
        ["w-mid-1", "w-mid-2"].every((id) => mock.events().some((e) => e.workerId === id && e.type === "settled")),
      20_000,
      "both workers recovered (store and wire)",
    );

    for (const workerId of ["w-mid-1", "w-mid-2"]) {
      // Exactly one resume each across both boots — the crashed boot's pending timer never fired.
      expect(store.countResumes(workerId)).toBe(1);
      const events = mock.events().filter((e) => e.workerId === workerId);
      expect(events.filter((e) => e.type === "lost")).toHaveLength(1);
      expect(events.filter((e) => e.type === "resumed")).toHaveLength(1);
      expect(events.some((e) => e.type === "settled" && e.outcome === "reported")).toBe(true);
    }
    // The lost event boot B emitted BEFORE it ever connected still reached the DO: it was
    // persisted with its seq and replayed after boot C's welcome (§11.3).
    expect(mock.events().some((e) => e.workerId === "w-mid-1" && e.type === "lost" && e.reason === "connector_restart")).toBe(true);
  }, 60_000);

  it("the reconcile command answers with a fresh workers snapshot (protocol §6.2)", async () => {
    store.upsertWorker({
      workerId: "w-snap-1",
      threadId: "t",
      repoId: repo,
      mode: "write",
      state: "idle",
      sessionId: "w-snap-1",
    });
    await bootApp(null);
    await mock.waitConnected();

    const cmdId = mock.sendCmd("reconcile", {});
    const result = await waitFor(() => mock.resultsFor(cmdId), 10_000, "reconcile result");
    expect(result).toMatchObject({
      ok: true,
      data: { workers: [expect.objectContaining({ workerId: "w-snap-1", state: "idle", lastSeq: 0 })] },
    });
  }, 30_000);
});
