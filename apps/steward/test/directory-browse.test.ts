import { SELF, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { configureAndBind, ownerStub, pairFakeConnector, resetLedgerState, webLogin, type FakeConnector } from "./helpers.ts";

const BASE = "https://example.com";
const endpoint = `${BASE}/app/api/machines/directories/browse`;
const connectors: FakeConnector[] = [];

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

afterEach(() => {
  for (const connector of connectors.splice(0)) connector.close();
});

async function browser() {
  const cookie = await webLogin();
  const snapshot = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
  const { csrf } = await snapshot.json<{ csrf: string }>();
  const post = (input: Record<string, unknown>) => SELF.fetch(endpoint, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(input),
  });
  return { post, csrf, cookie };
}

async function machine(name = "mac-studio"): Promise<FakeConnector> {
  const connector = await pairFakeConnector(name, { repos: [], run: null, autorun: false });
  connector.directoryBrowse = true;
  connectors.push(connector);
  await connector.connect();
  return connector;
}

async function outboxCount(): Promise<number> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
    const row = sql`SELECT COUNT(*) AS n FROM outbox` as Array<{ n: number }>;
    return row[0]!.n;
  });
}

async function shortenBrowseTimeout(ms: number): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    (instance as unknown as { directoryBrowseTimeoutMs: number }).directoryBrowseTimeoutMs = ms;
  });
}

describe("browsing machine directories from the owner web session", () => {
  it("returns a transient listing without enqueueing a durable command", async () => {
    const connector = await machine();
    const { post } = await browser();
    const before = await outboxCount();
    const pending = post({ deviceId: connector.deviceId, path: "/srv/project", showHidden: true });
    const [request] = await connector.waitForDirectoryRequests(1);
    expect(request).toMatchObject({ t: "directory_list", path: "/srv/project", showHidden: true });
    connector.send({
      t: "directory_listing", re: request!.id, ok: true,
      listing: { path: "/srv/project", home: "/Users/owner", parent: "/srv", directories: [{ name: "src", path: "/srv/project/src" }], truncated: false },
    });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "/srv/project", home: "/Users/owner", parent: "/srv", directories: [{ name: "src", path: "/srv/project/src" }], truncated: false });
    expect(connector.cmds).toEqual([]);
    expect(await outboxCount()).toBe(before);
  });

  it("answers unsupported immediately for an old connector", async () => {
    const connector = await pairFakeConnector("legacy", { repos: [], run: null, autorun: false });
    connectors.push(connector);
    await connector.connect();
    const { post } = await browser();
    const response = await post({ deviceId: connector.deviceId, path: "~" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unsupported" });
    expect(connector.directoryRequests).toEqual([]);
  });

  it("ignores a foreign connector reply and only settles for the requested machine", async () => {
    const target = await machine("target");
    const foreign = await machine("foreign");
    const { post } = await browser();
    const pending = post({ deviceId: target.deviceId, path: "~" });
    const [request] = await target.waitForDirectoryRequests(1);
    const foreignListing = { path: "/foreign", home: "/foreign", parent: null, directories: [], truncated: false };
    foreign.send({ t: "directory_listing", re: request!.id, ok: true, listing: foreignListing });
    await new Promise((resolve) => setTimeout(resolve, 50));
    target.send({ t: "directory_listing", re: request!.id, ok: true, listing: { ...foreignListing, path: "/target" } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect((await response.json<{ path: string }>()).path).toBe("/target");
  });

  it("settles a pending read as machine_offline when the connection drops", async () => {
    const connector = await machine();
    const { post } = await browser();
    const pending = post({ deviceId: connector.deviceId, path: "~" });
    await connector.waitForDirectoryRequests(1);
    connector.close();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "machine_offline" });
  });

  it("times out a machine that never answers", async () => {
    await shortenBrowseTimeout(75);
    const connector = await machine();
    const { post } = await browser();
    const response = await post({ deviceId: connector.deviceId, path: "~" });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "browse_timeout" });
  });

  it("requires an owner session, CSRF, same origin and a valid body", async () => {
    const connector = await machine();
    const { post, cookie, csrf } = await browser();
    const input = { deviceId: connector.deviceId, path: "~" };
    expect((await SELF.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(401);
    expect((await post({ deviceId: "missing", path: "~" })).status).toBe(404);
    expect((await SELF.fetch(endpoint, {
      method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(input),
    })).status).toBe(403);
    expect((await post({ deviceId: connector.deviceId, path: "" })).status).toBe(400);
    expect((await post({ deviceId: connector.deviceId, path: "~", extra: true })).status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connector.directoryRequests).toEqual([]);
  });
});
