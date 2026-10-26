import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CmdMessage } from "@alexlikevibe/protocol";
import { ConnectorClient } from "../src/client.ts";
import { LocalStore } from "../src/store.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let store: LocalStore;
let mock: MockSteward;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sig-connector-commands-"));
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

function connectClient(options: { handleCommand?: (cmd: CmdMessage) => Promise<{ ok: boolean; data?: unknown }> }) {
  const client = new ConnectorClient({ store, handleCommand: options.handleCommand, pingIntervalMs: 60_000 });
  client.start();
  return client;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("command dedup (at-least-once from the DO, exactly-once execution here)", () => {
  it("acks a new command, runs the handler once, and sends cmd_result", async () => {
    const run: string[] = [];
    const client = connectClient({
      handleCommand: async (cmd) => {
        run.push(cmd.id);
        return { ok: true, data: { echo: cmd.kind } };
      },
    });
    await mock.waitConnected();

    const cmdId = mock.sendCmd("diag", { x: 1 });
    await wait(200);
    expect(run).toEqual([cmdId]);
    expect(mock.acksFor(cmdId)).toMatchObject({ t: "cmd_ack", re: cmdId, status: "accepted" });
    expect(mock.resultsFor(cmdId)).toMatchObject({ t: "cmd_result", re: cmdId, ok: true, data: { echo: "diag" } });
    client.stop();
  });

  it("answers duplicate with the original result and does not re-run the handler", async () => {
    const run: string[] = [];
    const client = connectClient({
      handleCommand: async (cmd) => {
        run.push(cmd.id);
        return { ok: false, error: { code: "lock_held" } };
      },
    });
    await mock.waitConnected();
    const cmdId = mock.sendCmd("send", { text: "hi" });
    await wait(200);
    expect(run).toEqual([cmdId]);

    mock.sendCmd("send", { text: "hi" }, cmdId); // DO re-delivery of the same cmdId
    await wait(200);
    expect(run).toEqual([cmdId]); // executed exactly once
    expect(mock.acksFor(cmdId)).toMatchObject({ t: "cmd_ack", re: cmdId, status: "duplicate", result: { ok: false } });
    client.stop();
  });

  it("acks duplicate with the original result after a connector restart (persisted dedup)", async () => {
    const client = connectClient({
      handleCommand: async () => ({ ok: true, data: { persisted: true } }),
    });
    await mock.waitConnected();
    const cmdId = mock.sendCmd("diag", {});
    await wait(200);
    client.stop();
    await wait(100);

    // "Restart": a brand-new client over the same on-disk store must still know the command.
    const restarted = connectClient({ handleCommand: async () => ({ ok: true, data: { again: true } }) });
    await mock.waitConnected();
    mock.sendCmd("diag", {}, cmdId);
    await wait(200);
    expect(mock.acksFor(cmdId)).toMatchObject({ status: "duplicate", result: { ok: true, data: { persisted: true } } });
    expect(mock.resultsFor(cmdId)).toMatchObject({ ok: true, data: { persisted: true } }); // original result, not the new handler's
    restarted.stop();
  });

  it("recovers a launch-kind command crashed mid-`sending` before any pi write as not_delivered, never re-runs it", async () => {
    // The handler never settles: simulates the connector dying mid-`sending`. For the
    // marker-bearing kinds (§6.3) that window is now decidable: the write-ahead had not
    // armed, so nothing was ever written to pi — failed(not_delivered), not ambiguous.
    const gate = new Promise<never>(() => {});
    const client = connectClient({ handleCommand: () => gate });
    await mock.waitConnected();
    const cmdId = mock.sendCmd("start_worker", {});
    await wait(200);
    expect(mock.acksFor(cmdId)).toMatchObject({ status: "accepted" });
    client.stop();
    await wait(100);

    const restarted = connectClient({
      handleCommand: async () => {
        throw new Error("must not re-run a crashed command");
      },
    });
    await mock.waitConnected();
    await mock.waitHello(2); // the RESTART's hello is the second frame (CI flake guard)
    // The restart's hello carries the crashed command as recovered failed(not_delivered).
    const hello = mock.hellos().at(-1) as { pendingAcks: Array<{ cmdId: string; state: string; code?: string }> };
    expect(hello.pendingAcks).toContainEqual(expect.objectContaining({ cmdId, state: "failed", code: "not_delivered" }));

    mock.sendCmd("start_worker", {}, cmdId); // DO redelivery: answered duplicate, never executed
    await wait(200);
    expect(mock.acksFor(cmdId)).toMatchObject({
      status: "duplicate",
      result: { ok: false, error: { code: "not_delivered" } },
    });
    restarted.stop();
  });

  it("without a handler, rejects unsupported command kinds so the DO's outbox row settles", async () => {
    const client = connectClient({});
    await mock.waitConnected();
    const cmdId = mock.sendCmd("start_worker", {});
    await wait(200);
    expect(mock.acksFor(cmdId)).toMatchObject({ status: "rejected", code: "unsupported" });
    client.stop();
  });
});
