// ADR-0001 correction to protocol §3.2: half-dead TCP raises no error on either end — the
// bytes just never arrive. The cure is the bidirectional application-level heartbeat: uplink
// pings with a pong timeout, an inter-frame timeout on the downlink, and forced teardown +
// reconnect instead of buffering into the dead link (spike bug 10).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorClient } from "../src/client.ts";
import { LocalStore } from "../src/store.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let store: LocalStore;
let mock: MockSteward;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sig-connector-heartbeat-"));
  store = new LocalStore(join(dir, "connector.sqlite"));
  mock = startMockSteward();
  port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await mock.close();
});

function connectClient(timings: { pingIntervalMs?: number; pongTimeoutMs?: number; deadAfterMs?: number; minBackoffMs?: number }) {
  const client = new ConnectorClient({ store, ...timings });
  client.start();
  return client;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bidirectional heartbeat", () => {
  it("pings on the interval and stays connected while pongs flow back", async () => {
    const client = connectClient({ pingIntervalMs: 60, pongTimeoutMs: 600, deadAfterMs: 2000 });
    await mock.waitConnected();
    await wait(300);
    expect(mock.pings()).toBeGreaterThanOrEqual(3);
    expect(mock.upgrades()).toBe(1); // never torn down
    client.stop();
  });

  it("tears down and reconnects when pongs stop arriving (uplink pong loss)", async () => {
    mock.setSwallowPongs(true);
    const client = connectClient({ pingIntervalMs: 50, pongTimeoutMs: 150, deadAfterMs: 5000, minBackoffMs: 40 });
    await mock.waitConnected();
    await wait(700);
    expect(mock.upgrades()).toBeGreaterThanOrEqual(2); // dead link detected, fresh one built
    expect(mock.hellos().length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it("tears down and reconnects when the downlink goes silent (frame swallowing)", async () => {
    mock.setSwallowAllFrames(true); // no welcome, no pong, nothing after the upgrade
    const client = connectClient({ pingIntervalMs: 50, pongTimeoutMs: 5000, deadAfterMs: 250, minBackoffMs: 40 });
    await wait(1000);
    expect(mock.upgrades()).toBeGreaterThanOrEqual(2); // inter-frame timeout forced a rebuild
    client.stop();
  });
});

describe("offline queueing", () => {
  it("delivers a command queued while the device was offline as soon as it returns", async () => {
    const seen: string[] = [];
    const client = new ConnectorClient({
      store,
      pingIntervalMs: 5000,
      minBackoffMs: 600, // the reconnect must land well after the "still offline" assertion below
      maxBackoffMs: 1200,
      handleCommand: async (cmd) => {
        seen.push(cmd.id);
        return { ok: true, data: {} };
      },
    });
    client.start();
    await mock.waitConnected();

    mock.dropConn(); // the machine drops off the network
    const cmdId = mock.sendCmd("diag", {}); // queued in the mock's outbox while offline
    await wait(150);
    expect(seen).toEqual([]);

    await mock.waitConnected(3000); // connector's reconnect loop brings it back
    await wait(300);
    expect(seen).toEqual([cmdId]); // delivered on return, exactly once
    expect(mock.acksFor(cmdId)).toMatchObject({ status: "accepted" });
    client.stop();
  });
});
