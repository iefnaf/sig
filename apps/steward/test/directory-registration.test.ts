import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import type { MachineDirectoryInput, MachineDirectoryResult } from "../src/workspace-api.ts";
import { configureAndBind, helloPayload, ownerStub, pairFakeConnector, resetLedgerState, webLogin, type FakeConnector } from "./helpers.ts";

const BASE = "https://example.com";
const endpoint = `${BASE}/app/api/machines/directories`;
const connectors: FakeConnector[] = [];
const repository = { repoId: "/srv/new-project", name: "new-project", path: "/srv/new-project", defaultBranch: "main", remote: "" };

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.close();
});

async function browser() {
  const cookie = await webLogin();
  const snapshot = async (): Promise<{ csrf: string; machines: Array<{ id: string; repos: string[] }> }> =>
    (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json();
  const { csrf } = await snapshot();
  const post = (input: MachineDirectoryInput, headers: Record<string, string> = {}) => SELF.fetch(endpoint, {
    method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json", "x-csrf-token": csrf, ...headers }, body: JSON.stringify(input),
  });
  return { post, snapshot, cookie, csrf };
}

async function machine(name = "mac-studio") {
  const connector = await pairFakeConnector(name, { repos: [], run: null, autorun: false });
  connectors.push(connector);
  await connector.connect();
  return connector;
}

async function operation(post: Awaited<ReturnType<typeof browser>>["post"], input: MachineDirectoryInput): Promise<MachineDirectoryResult> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const response = await post(input);
    const result = await response.json<MachineDirectoryResult>();
    if (result.state !== "pending") return result;
    if (Date.now() > deadline) throw new Error("registration did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("adding a machine directory from the owner web session", () => {
  it("deduplicates submission and makes the connector-confirmed Git root immediately dispatchable", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    const input = { id: "directory-success", deviceId: connector.deviceId, path: "/srv/new-project/src" };
    expect((await post(input)).status).toBe(202);
    const [cmd] = await connector.waitForCmds(1);
    expect(cmd).toMatchObject({ kind: "register_repo", args: { path: input.path } });
    expect((await post(input)).status).toBe(202);
    expect(connector.cmds).toHaveLength(1);
    expect((await post({ ...input, path: "/srv/other" })).status).toBe(409);
    expect((await post({ ...input, deviceId: "another-device" })).status).toBe(409);
    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repo: repository } });
    expect(await operation(post, input)).toEqual({ state: "done", id: input.id, repo: repository });
    expect((await snapshot()).machines.find((entry) => entry.id === connector.deviceId)?.repos).toEqual([repository.name]);
    await ownerStub().dispatchForTest({ prompt: "Inspect the project", repoRef: repository.path, newTitle: "Inspect project" });
    expect((await connector.waitForCmds(2))[1]).toMatchObject({ kind: "start_worker", args: { repoId: repository.repoId } });
  });

  it("requires an owner session, CSRF, same origin and a valid body before it can enqueue", async () => {
    const connector = await machine();
    const { post } = await browser();
    const input = { id: "directory-auth-check", deviceId: connector.deviceId, path: repository.path };
    expect((await SELF.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(401);
    expect((await post(input, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await post(input, { origin: "https://attacker.example" })).status).toBe(403);
    const { cookie, csrf } = await browser();
    expect((await SELF.fetch(endpoint, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(input) })).status).toBe(403);
    expect((await post({ ...input, path: "" })).status).toBe(400);
    expect((await post({ ...input, path: "\0" })).status).toBe(400);
    expect(connector.cmds).toEqual([]);
  });

  it("rejects new operations for offline, unknown and revoked machines", async () => {
    const offline = await pairFakeConnector("offline", { repos: [], autorun: false });
    const { post } = await browser();
    expect((await post({ id: "directory-offline", deviceId: offline.deviceId, path: repository.path })).status).toBe(409);
    expect((await post({ id: "directory-missing", deviceId: "missing", path: repository.path })).status).toBe(404);
    const revoked = await machine("revoked");
    await ownerStub().revoke(revoked.deviceId);
    expect((await post({ id: "directory-revoked", deviceId: revoked.deviceId, path: repository.path })).status).toBe(404);
  });

  it("settles old connector and invalid-directory failures without inventing inventory", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    let count = 0;
    for (const code of ["unsupported_command", "invalid_directory"]) {
      const input = { id: `directory-${code}`, deviceId: connector.deviceId, path: repository.path };
      await post(input);
      const cmd = (await connector.waitForCmds(++count))[count - 1]!;
      connector.send(code === "unsupported_command"
        ? { t: "cmd_ack", re: cmd.id, status: "rejected", code }
        : { t: "cmd_result", re: cmd.id, ok: false, error: { code } });
      expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code });
    }
    expect((await snapshot()).machines[0]?.repos).toEqual([]);
  });

  it("ignores foreign connector results and accepts a duplicate ack from the target machine", async () => {
    const target = await machine();
    const foreign = await machine("foreign");
    const { post, snapshot } = await browser();
    const input = { id: "directory-device-fence", deviceId: target.deviceId, path: repository.path };
    await post(input);
    const [cmd] = await target.waitForCmds(1);
    foreign.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repo: repository } });
    foreign.send({ t: "cmd_ack", re: cmd!.id, status: "duplicate", result: { ok: true, data: { repo: repository } } });
    foreign.send(helloPayload(foreign.deviceId, 1, { repos: [], pendingAcks: [{ cmdId: cmd!.id, state: "ambiguous" }] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await post(input)).status).toBe(202);
    expect((await snapshot()).machines.every((entry) => entry.repos.length === 0)).toBe(true);
    target.send({ t: "cmd_ack", re: cmd!.id, status: "duplicate", result: { ok: true, data: { repo: repository } } });
    expect(await operation(post, input)).toEqual({ state: "done", id: input.id, repo: repository });
  });

  it("rejects a malformed successful result without publishing a directory", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    const input = { id: "directory-invalid-result", deviceId: connector.deviceId, path: repository.path };
    await post(input);
    const [cmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repo: { ...repository, path: "" } } });
    expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code: "registration_failed" });
    expect((await snapshot()).machines[0]?.repos).toEqual([]);
  });

  it("does not resurrect a directory from a delayed result after a later hello removed it", async () => {
    const connector = await machine();
    const { post, snapshot } = await browser();
    const input = { id: "directory-late-result", deviceId: connector.deviceId, path: repository.path };
    await post(input);
    const [cmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repo: repository } });
    await operation(post, input);
    connector.close();
    await connector.connect();
    expect((await snapshot()).machines[0]?.repos).toEqual([]);
    connector.send({ t: "cmd_result", re: cmd!.id, ok: true, data: { repo: repository } });
    connector.send({ t: "cmd_ack", re: cmd!.id, status: "duplicate", result: { ok: true, data: { repo: repository } } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await snapshot()).machines[0]?.repos).toEqual([]);
  });

  it("reports an unknown outcome for an accepted command whose deadline elapsed", async () => {
    const connector = await machine();
    const { post } = await browser();
    const input = { id: "directory-deadline", deviceId: connector.deviceId, path: repository.path };
    await post(input);
    const [cmd] = await connector.waitForCmds(1);
    connector.send({ t: "cmd_ack", re: cmd!.id, status: "accepted" });
    await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE outbox SET notAfter = ? WHERE cmdId = ?", Date.now() - 1, `web-directory:${input.id}`);
    });
    expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code: "outcome_unknown" });
    await runInDurableObject(ownerStub(), (_instance: Steward, state: DurableObjectState) => {
      state.storage.sql.exec("UPDATE outbox SET state = 'failed', failReason = 'not_after' WHERE cmdId = ?", `web-directory:${input.id}`);
    });
    expect(await operation(post, input)).toEqual({ state: "failed", id: input.id, code: "outcome_unknown" });
  });
});
