// Issue #15, the real-flow half (connector-pi.md §6.3): a connector crash during a
// command's `sending` window is adjudicated from the session tail at the next boot —
// through the REAL delivery paths (start_worker's spawn→get_state→prompt sequence, a steer
// into a running worker, a send parked while the worker is starting), not seeded rows.
// The crash is an in-process simulation: the handler's promise is parked forever (exactly
// what dying mid-`sending` leaves behind — the row is `sending`, no result, no cleanup),
// the children are SIGKILLed, and a fresh ConnectorApp boots over the same store.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { PiAdapter, type PiAdapterOptions } from "../src/pi-adapter.ts";
import type { StartSpec } from "../src/agent.ts";
import { LocalStore } from "../src/store.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
} from "./helpers.ts";

/** Wraps PiAdapter so a flagged call never settles from the caller's side — on resolution
 *  OR rejection: the child did (or began) its work, but no further connector code runs and
 *  the command row stays `sending` forever, which is exactly what dying mid-`sending`
 *  leaves on disk (in a real crash the process is simply gone; the zombie continuation a
 *  test park emulates must stay parked, or it would "settle" a crashed command). Flag the
 *  adapter BEFORE issuing the command under test. */
class CrashWindowAdapter extends PiAdapter {
  hung = false;
  constructor(options: PiAdapterOptions) {
    super(options);
  }
  override async start(spec: StartSpec) {
    try {
      const handle = await super.start(spec);
      if (this.hung) await new Promise<never>(() => {});
      return handle;
    } catch (err) {
      if (this.hung) await new Promise<never>(() => {});
      throw err;
    }
  }
  override async send(...args: Parameters<PiAdapter["send"]>) {
    try {
      const result = await super.send(...args);
      if (this.hung) await new Promise<never>(() => {});
      return result;
    } catch (err) {
      if (this.hung) await new Promise<never>(() => {});
      throw err;
    }
  }
  override async interrupt(...args: Parameters<PiAdapter["interrupt"]>) {
    try {
      const result = await super.interrupt(...args);
      if (this.hung) await new Promise<never>(() => {});
      return result;
    } catch (err) {
      if (this.hung) await new Promise<never>(() => {});
      throw err;
    }
  }
}

let dir: string;
let stateDir: string;
let sessionsDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
const apps: ConnectorApp[] = [];

beforeEach(async () => {
  dir = tmpDir("sig-crash-recovery");
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
  for (const app of apps) app.stop();
  apps.length = 0;
  await mock.close();
  store.close();
  await removeTree(dir);
});

/** rmSync that tolerates a lingering git child: simulateCrash deliberately leaves a
 *  `git worktree add` mid-flight (nothing kills or awaits it), and on a loaded CI runner
 *  it can still be writing .git for seconds. Node's built-in maxRetries gives up after
 *  ~200ms — retry with a real budget instead of failing the next test's teardown. */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "ENOTEMPTY" && code !== "EBUSY") || attempt >= 20) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function bootApp(adapter: CrashWindowAdapter): ConnectorApp {
  const app = new ConnectorApp({ store, stateDir, adapter });
  apps.push(app);
  return app;
}

function crashAdapter(scenario: string, extra: Record<string, string> = {}): CrashWindowAdapter {
  return new CrashWindowAdapter({
    stateDir,
    command: [process.execPath, join(import.meta.dirname, "fake-pi.mjs")],
    env: { FAKE_PI_SCRIPT: scenario, FAKE_PI_SESSIONS_DIR: sessionsDir, ...extra },
  });
}

function hellos(): Array<Record<string, unknown>> {
  return mock.hellos();
}

const pendingAck = (cmdId: string) => {
  const hello = hellos().at(-1) as { pendingAcks?: Array<{ cmdId: string; state: string; code?: string }> } | undefined;
  return hello?.pendingAcks?.find((p) => p.cmdId === cmdId);
};

describe("crash during `sending`, recovered from the session tail (§6.3)", () => {
  it("start_worker crashed AFTER the prompt landed → recovered delivered (done), never re-run", async () => {
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]);
    const adapter = crashAdapter(scenario, { FAKE_PI_LOG: join(dir, "pi.log") });
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();
    adapter.hung = true; // die as soon as the prompt is out (start never returns)

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-crash-after-prompt",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    // Wait until fake-pi has persisted the marker + prompt (the delivery happened)…
    await waitFor(
      () => {
        const file = join(sessionsDir, "w-crash-after-prompt.jsonl");
        return existsSync(file) && readFileSync(file, "utf8").includes("sig.command") ? true : undefined;
      },
      15_000,
      "marker + prompt on disk",
    );
    // …then die mid-`sending`: the handler never settles, children are killed, socket drops.
    app.simulateCrash();

    const boot2 = bootApp(crashAdapter(scenario));
    await boot2.start();
    await mock.waitHello(2);
    expect(pendingAck(cmdId)).toMatchObject({ state: "done" });

    // A DO redelivery is answered `duplicate` with the recovered result — never re-executed.
    mock.sendCmd("start_worker", { workerId: "w-crash-after-prompt", threadId: "t", repoId: repo, mode: "write", prompt: "x" }, cmdId);
    await waitFor(
      () => (mock.acksFor(cmdId) as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "redelivery ack",
    );
    expect(mock.resultsFor(cmdId)).toBeUndefined(); // no fresh cmd_result: not re-run
  }, 60_000);

  it("start_worker crashed BEFORE any pi write → recovered not_delivered, with the code riding pendingAcks", async () => {
    // get_state is held back (the `starting` window): the crash lands before the prompt RPC.
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "never ran" })], { delayMs: 60_000 });
    const adapter = crashAdapter(scenario);
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();
    adapter.hung = true; // die inside the held get_state window, before any pi write

    const cmdId = mock.sendCmd("start_worker", {
      workerId: "w-crash-before-prompt",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => store.getWorker("w-crash-before-prompt")?.state === "starting", 10_000, "launch in flight");
    app.simulateCrash();

    const boot2 = bootApp(crashAdapter(scenario));
    await boot2.start();
    await mock.waitHello(2);
    expect(pendingAck(cmdId)).toMatchObject({ state: "failed", code: "not_delivered" });

    mock.sendCmd("start_worker", { workerId: "w-crash-before-prompt", threadId: "t", repoId: repo, mode: "write", prompt: "x" }, cmdId);
    await waitFor(
      () => (mock.acksFor(cmdId) as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "redelivery ack",
    );
    expect(mock.acksFor(cmdId)).toMatchObject({
      status: "duplicate",
      result: { ok: false, error: { code: "not_delivered", retriable: true } },
    });
  }, 60_000);

  it("a steer crashed after pi queued it → recovered delivered via the marker entry", async () => {
    const scenario = writeScenario(dir, "scenario", [
      [
        { emit: { type: "agent_start" } },
        { emit: { type: "turn_start" } },
        ...Array.from({ length: 30 }, () => ({ delayMs: 200 }) as ScenarioStep),
      ],
    ]);
    const adapter = crashAdapter(scenario, { FAKE_PI_LOG: join(dir, "pi.log") });
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();

    const startCmd = mock.sendCmd("start_worker", {
      workerId: "w-crash-steer",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => mock.resultsFor(startCmd), 15_000, "start result");
    await waitFor(() => store.getWorker("w-crash-steer")?.state === "running", 10_000, "running");

    adapter.hung = true; // die with the steer queued and the command still `sending`
    const sendCmd = mock.sendCmd("send", { workerId: "w-crash-steer", text: "改用 pnpm", intent: "now" });
    // The steer reached pi's queue: fake-pi wrote ITS marker entry (preamble stripped) —
    // waiting for the start's marker would race, the crash could land before the steer.
    await waitFor(
      () => readFileSync(join(sessionsDir, "w-crash-steer.jsonl"), "utf8").includes(`"commandId":"${sendCmd}"`),
      15_000,
      "steer marker on disk",
    );
    app.simulateCrash();

    const boot2 = bootApp(crashAdapter(scenario));
    await boot2.start();
    await mock.waitHello(2);
    expect(pendingAck(sendCmd)).toMatchObject({ state: "done" });
    mock.sendCmd("send", { workerId: "w-crash-steer", text: "again", intent: "now" }, sendCmd);
    await waitFor(
      () => (mock.acksFor(sendCmd) as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "redelivery ack",
    );
    expect(mock.acksFor(sendCmd)).toMatchObject({ status: "duplicate", result: { ok: true } });
  }, 60_000);

  it("a send still parked (worker starting) at the crash → recovered not_delivered", async () => {
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })], { delayMs: 60_000 });
    const adapter = crashAdapter(scenario);
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();
    adapter.hung = true;

    const startCmd = mock.sendCmd("start_worker", {
      workerId: "w-crash-parked",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => store.getWorker("w-crash-parked")?.state === "starting", 10_000, "launch in flight");
    const sendCmd = mock.sendCmd("send", { workerId: "w-crash-parked", text: "顺便补测试", intent: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 150)); // parked on the starting row
    app.simulateCrash();

    const boot2 = bootApp(crashAdapter(scenario));
    await boot2.start();
    await mock.waitHello(2);
    expect(pendingAck(sendCmd)).toMatchObject({ state: "failed", code: "not_delivered" });
    expect(pendingAck(startCmd)).toBeDefined(); // both crashed commands are reported, neither re-run
  }, 60_000);

  it("an interrupted interrupt (no `then`) stays honestly ambiguous", async () => {
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]);
    const adapter = crashAdapter(scenario);
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();

    const startCmd = mock.sendCmd("start_worker", {
      workerId: "w-crash-interrupt",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => mock.resultsFor(startCmd), 15_000, "start result");
    adapter.hung = true; // die inside the interrupt's abort sequence
    const interruptCmd = mock.sendCmd("interrupt", { workerId: "w-crash-interrupt" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    app.simulateCrash();

    const boot2 = bootApp(crashAdapter(scenario));
    await boot2.start();
    await mock.waitHello(2);
    // The abort has no session footprint: whether pi got it cannot be known.
    expect(pendingAck(interruptCmd)).toMatchObject({ state: "ambiguous" });
  }, 60_000);
});

describe("session_in_use leaves the worker relaunchable (§10)", () => {
  it("an idle-cold send refused under a foreign holder stays idle, releases the lock, and succeeds after it exits", async () => {
    const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]);
    // A first run creates the session; then the process is stopped (idle-cold).
    const adapter = crashAdapter(scenario);
    const app = bootApp(adapter);
    await app.start();
    await mock.waitConnected();
    const startCmd = mock.sendCmd("start_worker", {
      workerId: "w-inuse-cold",
      threadId: "t",
      repoId: repo,
      mode: "write",
      prompt: "Fix the login bug",
    });
    await waitFor(() => mock.resultsFor(startCmd), 15_000, "start result");
    await waitFor(() => mock.events().some((e) => e.workerId === "w-inuse-cold" && e.type === "settled"), 20_000, "settled");
    await app.manager.stopProcess("w-inuse-cold");
    await waitFor(() => store.getWorker("w-inuse-cold")?.state === "idle", 10_000, "idle");

    // A foreign process holds the session by argument → the cold send is refused…
    const holder = (await import("node:child_process")).spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)", "--", "--session-id", "w-inuse-cold"],
      { stdio: "ignore" },
    );
    try {
      const sendCmd = mock.sendCmd("send", { workerId: "w-inuse-cold", text: "again", intent: "auto" });
      const result = await waitFor(() => mock.resultsFor(sendCmd), 20_000, "refused result");
      expect(result).toMatchObject({ ok: false, error: { code: "session_in_use" } });
      // …and the worker must be exactly as it was: idle, lock free, nothing stuck.
      expect(store.getWorker("w-inuse-cold")?.state).toBe("idle");
      expect(existsSync(join(stateDir, "locks", "w-inuse-cold.lock"))).toBe(false);
    } finally {
      holder.kill("SIGKILL");
    }

    // Once the holder is gone, the same send cold-relaunches and completes.
    const sendCmd2 = mock.sendCmd("send", { workerId: "w-inuse-cold", text: "冷启动补发", intent: "auto" });
    const result2 = await waitFor(() => mock.resultsFor(sendCmd2), 20_000, "second send result");
    expect(result2).toMatchObject({ ok: true, data: { delivery: "prompt", relaunched: true } });
  }, 90_000);
});
