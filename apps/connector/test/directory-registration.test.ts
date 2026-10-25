import { mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import { fakePiAdapter, makeGitRepo, reportRun, tmpDir, waitFor, writeScenario } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
let app: ConnectorApp;

beforeEach(async () => {
  dir = realpathSync(tmpDir("sig-register-directory"));
  repo = await makeGitRepo(dir);
  const stateDir = join(dir, "state");
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
  const scenario = writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "Directory is usable" })]);
  app = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, scenario) });
  await app.start();
  await mock.waitHello();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.manager.stopProcess("w-directory").catch(() => undefined);
  app?.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("owner directory registration over the connector transport", () => {
  it("registers a Git subdirectory and can immediately start a worker in its root", async () => {
    expect(mock.hellos()[0]).toMatchObject({ repos: [] });
    const subdirectory = join(repo, "src");
    mkdirSync(subdirectory);
    const cmdId = mock.sendCmd("register_repo", { path: subdirectory });
    expect(await waitFor(() => mock.resultsFor(cmdId))).toMatchObject({
      ok: true, data: { repo: { repoId: repo, name: "repo-a", path: repo, defaultBranch: "main", remote: "" } },
    });
    expect(store.getRepo(repo)).toMatchObject({
      path: repo,
      capability: { kind: "git" },
      writePolicy: { isolation: "worktree", concurrency: "parallel" },
      approved: false,
    });
    const worker = mock.sendCmd("start_worker", { workerId: "w-directory", threadId: "directory", repoId: repo, mode: "readonly", prompt: "Inspect the project" });
    expect(await waitFor(() => mock.resultsFor(worker), 15_000)).toMatchObject({ ok: true });
    await waitFor(() => mock.events().some((event) => event.type === "settled"), 15_000);
    expect(mock.upgrades()).toBe(1);
  }, 40_000);

  it("deduplicates delivery and preserves local approval and write policy on registration", async () => {
    store.addRepo({ repoId: repo, name: "old-name", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    store.setApproved(repo, true);
    store.setWritePolicy(repo, { concurrency: "serial" });
    const cmdId = mock.sendCmd("register_repo", { path: repo });
    await waitFor(() => mock.resultsFor(cmdId));
    mock.sendCmd("register_repo", { path: repo }, cmdId);
    expect(await waitFor(() => mock.acksFor(cmdId)?.status === "duplicate" && mock.acksFor(cmdId))).toMatchObject({ result: { ok: true } });
    const repeated = mock.sendCmd("register_repo", { path: repo });
    await waitFor(() => mock.resultsFor(repeated));
    expect(store.listRepos()).toEqual([
      expect.objectContaining({ repoId: repo, name: "repo-a", approved: true, writePolicy: { isolation: "worktree", concurrency: "serial" } }),
    ]);
  });

  it("rejects missing, relative and privileged arguments without registering anything", async () => {
    for (const args of [{ path: join(dir, "missing") }, { path: "repo-a" }, { path: repo, approved: true }, { path: "\0" }]) {
      const cmdId = mock.sendCmd("register_repo", args);
      expect(await waitFor(() => mock.resultsFor(cmdId))).toMatchObject({ ok: false, error: { code: "invalid_directory" } });
    }
    expect(store.listRepos()).toEqual([]);
  });

  it("registers a non-Git directory as a plain workspace (issue #88: Git is detected, not required)", async () => {
    const cmdId = mock.sendCmd("register_repo", { path: dir });
    expect(await waitFor(() => mock.resultsFor(cmdId))).toMatchObject({
      ok: true,
      data: { repo: { repoId: dir, name: expect.any(String), path: dir, capability: { kind: "plain" } } },
    });
    expect(store.getRepo(dir)).toMatchObject({
      capability: { kind: "plain" },
      writePolicy: { isolation: "in-place", concurrency: "serial" },
    });
  });

  it("expands ~/ on the connected machine without shell expansion", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    const cmdId = mock.sendCmd("register_repo", { path: "~/repo-a" });
    expect(await waitFor(() => mock.resultsFor(cmdId))).toMatchObject({ ok: true, data: { repo: { path: repo } } });
  });
});
