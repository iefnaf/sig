// Issue #27: the connector passes none of its credentials to agents. The connector's
// credentials (serverUrl / deviceId / device token) live in `~/.sig/connector.sqlite`
// (0600) and in SIG_* environment variables — the child env must carry neither.
import { readFileSync, rmSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childEnv, PiAdapter } from "../src/pi-adapter.ts";
import { fakePiCommand, makeGitRepo, tmpDir, waitFor } from "./helpers.ts";

const POISON: Record<string, string> = {
  SIG_HOME: "/home/attacker-guess/sig-state",
  SIG_MACHINE_NAME: "sig-machine",
  SIG_DEVICE_TOKEN: "st1.abcdef12.dev_secret.1.123." + "f".repeat(64),
};

describe("childEnv (connector-pi.md §4.2, issue #27)", () => {
  it("strips every SIG_* variable but keeps the user's environment", () => {
    const env = childEnv({ ...POISON, PATH: "/usr/bin", HOME: "/home/user", LANG: "en_US.UTF-8" });
    expect(Object.keys(env).filter((k) => k.startsWith("SIG_"))).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("merges the extra env (tests, fake-pi) after stripping", () => {
    const env = childEnv({ ...POISON, PATH: "/usr/bin" }, { FAKE_PI_SCRIPT: "/tmp/s.json" });
    expect(env.FAKE_PI_SCRIPT).toBe("/tmp/s.json");
    expect(Object.keys(env).filter((k) => k.startsWith("SIG_"))).toEqual([]);
  });
});

describe("spawned agent env carries no connector credentials", () => {
  let dir: string;
  let stateDir: string;
  let envLog: string;

  beforeEach(() => {
    dir = tmpDir("sig-child-env-test");
    stateDir = join(dir, "state");
    envLog = join(dir, "child-env.jsonl");
    for (const [key, value] of Object.entries(POISON)) process.env[key] = value;
  });

  afterEach(async () => {
    for (const key of Object.keys(POISON)) delete process.env[key];
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });

  it("fake-pi sees no SIG_* vars and no credential values", async () => {
    const repo = await makeGitRepo(dir);
    const scenario = join(dir, "scenario.json");
    writeFileSync(scenario, JSON.stringify({ runs: [[]] }));
    const adapter = new PiAdapter({
      stateDir,
      command: fakePiCommand(),
      env: { FAKE_PI_SCRIPT: scenario, FAKE_PI_ENV_LOG: envLog },
    });
    const events: { workerId: string; type: string }[] = [];
    adapter.on("worker-event", (e) => events.push(e as { workerId: string; type: string }));

    try {
      await adapter.start({
        workerId: "w-env-check-1",
        threadId: "env-check",
        cwd: repo,
        mode: "readonly",
        prompt: "check env",
        commandId: "cmd-env-check",
      });
      await waitFor(() => existsSync(envLog), 10_000, "fake-pi env snapshot");
      const childEnvSeen = JSON.parse(readFileSync(envLog, "utf8")) as Record<string, string>;

      expect(Object.keys(childEnvSeen).filter((k) => k.startsWith("SIG_"))).toEqual([]);
      for (const value of Object.values(POISON)) {
        expect(JSON.stringify(childEnvSeen)).not.toContain(value);
      }
      // the extras the connector does intend to pass still arrive
      expect(childEnvSeen.FAKE_PI_SCRIPT).toBe(scenario);
    } finally {
      await adapter.stopProcess("w-env-check-1").catch(() => undefined);
    }
  });
});
