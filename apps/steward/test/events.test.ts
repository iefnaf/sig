import { describe, expect, it } from "vitest";
import { connectAndHello, ownerStub, pairDevice } from "./helpers.ts";

// Tests in one file share the Durable Object's storage; a unique workerId per test keeps the
// (workerId, seq) inbox and worker_ack rows isolated from each other.
const uniqueWorker = () => `w-${crypto.randomUUID().slice(0, 8)}`;

function event(workerId: string, seq: number, type = "progress") {
  return { workerId, seq, ts: Date.now(), type, phase: "tool" };
}

describe("event inbox", () => {
  it("persists an events batch and replies with a cumulative events_ack", async () => {
    const w = uniqueWorker();
    const { deviceId, token } = await pairDevice("events-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    ws.send(JSON.stringify({ t: "events", id: "e1", batch: [event(w, 1), event(w, 2), event(w, 3)] }));
    const ack = await reader.nextWhere((m) => m.t === "events_ack");
    expect(ack).toMatchObject({ workerId: w, upTo: 3 });
  });

  it("dedups on (workerId, seq): a re-delivered batch is stored once and acked idempotently", async () => {
    const w = uniqueWorker();
    const { deviceId, token } = await pairDevice("dedup-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    const batch = [event(w, 1), event(w, 2)];
    ws.send(JSON.stringify({ t: "events", id: "e1", batch }));
    expect(await reader.nextWhere((m) => m.t === "events_ack")).toMatchObject({ workerId: w, upTo: 2 });

    ws.send(JSON.stringify({ t: "events", id: "e2", batch })); // re-delivery after a reconnect
    expect(await reader.nextWhere((m) => m.t === "events_ack")).toMatchObject({ workerId: w, upTo: 2 });

    expect(await ownerStub().inboxCount(w)).toBe(2);
  });

  it("acks cumulatively: upTo only advances through contiguous seqs", async () => {
    const w = uniqueWorker();
    const { deviceId, token } = await pairDevice("gap-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    ws.send(JSON.stringify({ t: "events", id: "e1", batch: [event(w, 1), event(w, 2)] }));
    expect(await reader.nextWhere((m) => m.t === "events_ack")).toMatchObject({ workerId: w, upTo: 2 });

    // 4 arrives but 3 is missing: the ack stays at 2 and a resync{from:3} goes out.
    ws.send(JSON.stringify({ t: "events", id: "e2", batch: [event(w, 4)] }));
    expect(await reader.nextWhere((m) => m.t === "events_ack")).toMatchObject({ workerId: w, upTo: 2 });
    expect(await reader.nextWhere((m) => m.t === "resync")).toMatchObject({ workerId: w, from: 3 });

    // The connector replays 3 and 5; now the ack jumps to 5.
    ws.send(JSON.stringify({ t: "events", id: "e3", batch: [event(w, 3), event(w, 5)] }));
    expect(await reader.nextWhere((m) => m.t === "events_ack")).toMatchObject({ workerId: w, upTo: 5 });
  });

  it("tracks each worker's ack independently", async () => {
    const w1 = uniqueWorker();
    const w2 = uniqueWorker();
    const { deviceId, token } = await pairDevice("multi-worker-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    ws.send(JSON.stringify({ t: "events", id: "e1", batch: [event(w1, 1), event(w2, 1), event(w2, 2)] }));
    const ack1 = await reader.nextWhere((m) => m.t === "events_ack");
    const ack2 = await reader.nextWhere((m) => m.t === "events_ack");
    expect([ack1, ack2].map((a) => [a.workerId, a.upTo])).toEqual(
      expect.arrayContaining([
        [w1, 1],
        [w2, 2],
      ]),
    );
  });

  it("welcome.acks carries the persisted acks so replay starts after them", async () => {
    const w = uniqueWorker();
    const { deviceId, token } = await pairDevice("welcome-acks-machine");
    const first = await connectAndHello(deviceId, token);
    first.ws.send(JSON.stringify({ t: "events", id: "e1", batch: [event(w, 1), event(w, 2), event(w, 3)] }));
    await first.reader.nextWhere((m) => m.t === "events_ack");

    const second = await connectAndHello(deviceId, token, 2);
    expect(second.welcome.acks).toMatchObject({ [w]: 3 });
  });

  it("accepts events_gap without an error reply", async () => {
    const w = uniqueWorker();
    const { deviceId, token } = await pairDevice("gap-report-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);
    ws.send(JSON.stringify({ t: "events_gap", workerId: w, from: 3, to: 9 }));
    // The report is accepted silently: the next exchange must be a normal reply, not `error`.
    ws.send(JSON.stringify({ t: "events", id: "e1", batch: [event(w, 10)] }));
    const next = await reader.next();
    expect(next.t).toBe("events_ack");
  });
});
