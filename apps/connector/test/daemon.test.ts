// The daemon behind the service (issue #26): loads credentials, installs the versioned
// assets, connects to the (mock) steward, and logs lifecycle lines that contain no secrets.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDaemon, type DaemonHandle } from "../src/daemon.ts";
import { LocalStore } from "../src/store.ts";
import { VERSION } from "../src/version.ts";
import { fakePiAdapter, tmpDir, waitFor, writeScenario } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let stateDir: string;
let mock: MockSteward;
let store: LocalStore;
let handle: DaemonHandle | null = null;

beforeEach(async () => {
  dir = tmpDir("shepherd-daemon-test");
  stateDir = join(dir, "state");
  mock = startMockSteward();
  const port = await mock.listen();
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
  store.close(); // the daemon opens its own connection
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("runDaemon", () => {
  it("connects with saved credentials, installs assets, and logs without the token", async () => {
    const scenario = writeScenario(dir, "idle", []);
    handle = await runDaemon({
      stateDir,
      machineName: "test-machine",
      adapter: fakePiAdapter(stateDir, scenario),
    });

    await mock.waitHello();
    const hello = mock.hellos().at(-1)!;
    expect(hello.connector).toMatchObject({ version: VERSION, os: process.platform });
    expect(hello.machine).toMatchObject({ name: "test-machine" });

    // Every boot rewrites the versioned assets (upgrade path, issue #26).
    expect(existsSync(join(stateDir, "ext", `shepherd-pi-${VERSION}.ts`))).toBe(true);
    expect(existsSync(join(stateDir, "prompts", `worker-${VERSION}.md`))).toBe(true);

    const logPath = join(stateDir, "logs", "connector.log");
    expect(existsSync(logPath)).toBe(true);
    // 'welcomed' is written when the welcome frame lands — strictly after the hello we
    // waited for. Poll for the line instead of reading the log the instant hellos() has an
    // entry: on a slow runner the welcome trails, the assert fires early, and teardown's
    // store.close() then races the in-flight welcome handler (unhandled 'database is not
    // open').
    await waitFor(
      () => (existsSync(logPath) ? readFileSync(logPath, "utf8").includes("welcomed") : undefined),
      5000,
      "welcomed log line",
    );
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("daemon_start");
    expect(log).toContain("welcomed");
    expect(log).not.toContain(mock.token); // no keys in ~/.shepherd/logs
  }, 20_000);

  it("refuses to start without credentials", async () => {
    rmSync(join(stateDir, "connector.sqlite"), { force: true });
    rmSync(stateDir, { recursive: true, force: true });
    await expect(runDaemon({ stateDir })).rejects.toThrow(/not paired/);
  });

  it("logs worker events and command lifecycle coarsely (ids and types only)", async () => {
    const scenario = writeScenario(dir, "scenario", []);
    handle = await runDaemon({ stateDir, adapter: fakePiAdapter(stateDir, scenario) });
    await mock.waitConnected();

    mock.sendCmd("start_worker", { workerId: "w-daemon-1", threadId: "t", repoId: "/nope", prompt: "x" });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const log = readFileSync(join(stateDir, "logs", "connector.log"), "utf8");
    expect(log).toContain("command_received");
    expect(log).toContain("not_registered_repo");
    expect(log).not.toContain("prompt"); // session content never hits the log
  }, 20_000);
});
