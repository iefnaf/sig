import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorClient } from "../src/client.ts";
import { EventLog } from "../src/events.ts";
import { LocalStore } from "../src/store.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let dbPath: string;
let store: LocalStore;
let mock: MockSteward;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sig-connector-events-"));
  dbPath = join(dir, "connector.sqlite");
  store = new LocalStore(dbPath);
  mock = startMockSteward();
  port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await mock.close();
});

function connectClient() {
  const client = new ConnectorClient({ store, pingIntervalMs: 60_000, batchMs: 50 });
  client.start();
  return client;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("EventLog (durable log, persisted seqs)", () => {
  it("assigns monotonically increasing per-worker seqs, independently per worker", () => {
    const log = new EventLog(store.database);
    expect(log.append("w1", { type: "progress" }).seq).toBe(1);
    expect(log.append("w1", { type: "progress" }).seq).toBe(2);
    expect(log.append("w2", { type: "report" }).seq).toBe(1);
    expect(log.append("w1", { type: "settled" }).seq).toBe(3);
  });

  it("continues seqs after a connector restart (regression: restart-at-1 gets every event silently dropped)", () => {
    const first = new EventLog(store.database);
    first.append("w1", { type: "progress" });
    first.append("w1", { type: "progress" });

    // "Restart": a fresh process over the same on-disk database.
    store.close();
    store = new LocalStore(dbPath);
    const second = new EventLog(store.database);
    expect(second.append("w1", { type: "report" }).seq).toBe(3);
    expect(second.nextSeq("w1")).toBe(4);
  });

  it("truncate removes acked rows; pending returns only unacked ones", () => {
    const log = new EventLog(store.database);
    log.append("w1", { type: "progress" });
    log.append("w1", { type: "progress" });
    log.append("w1", { type: "report" });
    expect(log.pending("w1")).toHaveLength(3);

    log.truncate("w1", 2);
    expect(log.pending("w1").map((e) => e.seq)).toEqual([3]);
    expect(log.ackedUpTo("w1")).toBe(2);
  });

  it("rangeAvailable flags evicted history as a gap instead of pretending to replay it", () => {
    const log = new EventLog(store.database);
    for (let i = 1; i <= 3; i++) log.append("w1", { type: "progress" });
    log.truncate("w1", 1); // seq 1 gone

    const { replay, gapFrom, gapTo } = log.rangeAvailable(1, "w1");
    expect(gapFrom).toBe(1);
    expect(gapTo).toBe(1);
    expect(replay.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe("event delivery over the client", () => {
  it("batches emitted events, truncates on events_ack, and replays only unacked after a dropped connection", async () => {
    const client = connectClient();
    await mock.waitConnected();

    client.emit("w1", { type: "progress", phase: "tool" });
    client.emit("w1", { type: "report", status: "done" });
    await wait(300);
    expect(mock.events().map((e) => e.seq)).toEqual([1, 2]); // delivered, acked, truncated

    mock.setSwallowAcks(true); // the connection dies before the ack for the next batch
    client.emit("w1", { type: "progress" });
    client.emit("w1", { type: "settled", outcome: "reported" });
    await wait(300);
    const delivered = mock.events().length;
    expect(delivered).toBe(4);

    mock.dropConn();
    mock.setSwallowAcks(false);
    await mock.waitConnected(); // reconnect: hello -> welcome -> replay from the durable log
    await wait(300);
    const seqs = mock.events().map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 3, 4]); // first two were acked (not replayed); 3-4 replayed once
    client.stop();
  });

  it("welcome.acks acts as a cumulative ack: local truncation plus replay from after it", async () => {
    // Pre-populate the durable log as if a previous session emitted 5 events, 3 already acked.
    const log = new EventLog(store.database);
    for (let i = 1; i <= 5; i++) log.append("w1", { type: "progress", n: i });
    log.truncate("w1", 3);

    mock.setWelcomeAcks({ w1: 3 });
    const client = connectClient();
    await mock.waitConnected();
    await wait(300);
    expect(mock.events().map((e) => e.seq)).toEqual([4, 5]); // replay starts after welcome.acks

    // New emissions continue the persisted seq, not a fresh counter.
    client.emit("w1", { type: "settled" });
    await wait(300);
    expect(mock.events().map((e) => e.seq)).toEqual([4, 5, 6]);
    client.stop();
  });

  it("keeps emitting with continuing seqs across a connector restart (regression)", async () => {
    const client = connectClient();
    await mock.waitConnected();
    client.emit("w1", { type: "progress" });
    client.emit("w1", { type: "progress" });
    await wait(300);
    client.stop();
    await wait(100);

    mock.setWelcomeAcks({ w1: 2 }); // the DO has both durably
    const restarted = connectClient();
    await mock.waitConnected();
    restarted.emit("w1", { type: "report" });
    await wait(300);
    const seqs = mock.events().map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]); // continues at 3, and the acked 1-2 are not replayed
    restarted.stop();
  });
});
