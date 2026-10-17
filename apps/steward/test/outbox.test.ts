import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { type MessageReader, connectAndHello, ownerStub, pairDevice } from "./helpers.ts";

// Mirrors the row resendUnacked() would leave after two real ack-timeouts, without waiting out
// two 15s deadlines in real time; `redeliverOutbox()`'s reset-then-resend path is what's under
// test here, not the alarm's own timing (covered separately in alarm.test.ts).
async function markFailedAckTimeout(cmdId: string): Promise<void> {
  await runInDurableObject(ownerStub(), async (instance: Steward) => {
    (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
      UPDATE outbox SET state = 'failed', failReason = 'ack_timeout' WHERE cmdId = ${cmdId}
    `;
  });
}

// A single WS connection's messages are handled synchronously and in order, so a ping/pong
// round trip proves every earlier message from this test (e.g. a cmd_ack) has already been
// fully processed by the DO before the assertions that follow run.
async function sync(ws: WebSocket, reader: MessageReader): Promise<void> {
  ws.send(JSON.stringify({ t: "ping", id: "sync" }));
  await reader.nextWhere((m) => m.t === "pong");
}

describe("outbox: enqueue and delivery", () => {
  it("a command enqueued while the device is offline stays queued", async () => {
    const { deviceId } = await pairDevice("offline-machine");
    const { cmdId, state } = await ownerStub().enqueue(deviceId, "diag", {});
    expect(state).toBe("queued");
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("queued");
  });

  it("a command enqueued for a connected device is sent immediately, then moves to accepted on cmd_ack", async () => {
    const { deviceId, token } = await pairDevice("online-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);

    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", { foo: "bar" });
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("sent");

    const cmd = await reader.next();
    expect(cmd).toMatchObject({ t: "cmd", id: cmdId, cseq: 1, kind: "diag", args: { foo: "bar" } });

    ws.send(JSON.stringify({ t: "cmd_ack", re: cmdId, status: "accepted" }));
    await sync(ws, reader);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("accepted");

    ws.send(JSON.stringify({ t: "cmd_result", re: cmdId, ok: true, data: { done: true } }));
    await sync(ws, reader);
    const row = await ownerStub().outboxRow(cmdId);
    expect(row?.state).toBe("done");
    expect(JSON.parse(row!.result as string)).toEqual({ done: true });
  });

  it("cmd_ack duplicate with an attached result resolves the command directly", async () => {
    const { deviceId, token } = await pairDevice("dup-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {});
    await reader.next(); // the cmd frame

    ws.send(JSON.stringify({ t: "cmd_ack", re: cmdId, status: "duplicate", result: { ok: false, error: { code: "lock_held" } } }));
    await sync(ws, reader);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("failed");
  });

  it("cmd_ack rejected marks the command failed with failReason rejected, not redeliverable", async () => {
    const { deviceId, token } = await pairDevice("reject-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);
    const { cmdId } = await ownerStub().enqueue(deviceId, "start_worker", {});
    await reader.next();

    ws.send(JSON.stringify({ t: "cmd_ack", re: cmdId, status: "rejected", code: "not_registered_repo" }));
    await sync(ws, reader);
    const row = await ownerStub().outboxRow(cmdId);
    expect(row?.state).toBe("failed");
    expect(row?.failReason).toBe("rejected");
  });

  it("cmd_ack ambiguous marks the command ambiguous with no automatic re-send", async () => {
    const { deviceId, token } = await pairDevice("ambiguous-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);
    const { cmdId } = await ownerStub().enqueue(deviceId, "send", {});
    await reader.next();

    ws.send(JSON.stringify({ t: "cmd_ack", re: cmdId, status: "ambiguous" }));
    await sync(ws, reader);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("ambiguous");

    // A later hello for the same device (higher connEpoch supersedes this one) must not redeliver it.
    const second = await connectAndHello(deviceId, token, 2);
    second.ws.send(JSON.stringify({ t: "bogus", id: "p1" }));
    const reply = await second.reader.next();
    expect(reply.code).toBe("unsupported");
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("ambiguous");
  });

  it("notAfter already in the past at delivery time fails the command (not_after) without sending", async () => {
    const { deviceId, token } = await pairDevice("expired-machine");
    const { ws, reader } = await connectAndHello(deviceId, token);
    const { cmdId, state } = await ownerStub().enqueue(deviceId, "send", {}, { notAfter: Date.now() - 1000 });
    // Issue #13 review finding 1: a lapsed delivery window is a queue timeout, NOT the
    // user's cancellation — 'expired' belongs to the dispatcher's cancel path alone, so the
    // reap sweep pushes for this row instead of quietly recording a withdrawal.
    expect(state).toBe("failed");
    expect((await ownerStub().outboxRow(cmdId))?.failReason).toBe("not_after");

    // Nothing was sent over the wire for it.
    ws.send(JSON.stringify({ t: "bogus", id: "p1" }));
    const reply = await reader.next();
    expect(reply.code).toBe("unsupported");
  });

  it("commands for the same device are delivered in cseq order", async () => {
    const { deviceId, token } = await pairDevice("ordered-machine");
    const first = await ownerStub().enqueue(deviceId, "a", {});
    const second = await ownerStub().enqueue(deviceId, "b", {});
    const third = await ownerStub().enqueue(deviceId, "c", {});
    expect([first.cseq, second.cseq, third.cseq]).toEqual([1, 2, 3]);

    const { reader } = await connectAndHello(deviceId, token);
    const m1 = await reader.next();
    const m2 = await reader.next();
    const m3 = await reader.next();
    expect([m1.cseq, m2.cseq, m3.cseq]).toEqual([1, 2, 3]);
    expect([m1.id, m2.id, m3.id]).toEqual([first.cmdId, second.cmdId, third.cmdId]);
  });
});

describe("hello redelivery", () => {
  it("redelivers queued and sent commands, but not done/failed(rejected)/ambiguous/expired ones", async () => {
    const { deviceId, token } = await pairDevice("redeliver-machine");

    // queued while offline
    const queued = await ownerStub().enqueue(deviceId, "queued-one", {});
    expect(queued.state).toBe("queued");

    const first = await connectAndHello(deviceId, token, 1);
    const redelivered = await first.reader.next();
    expect(redelivered.id).toBe(queued.cmdId);

    // leave it "sent" (no ack) and reconnect with a higher connEpoch (supersedes the old one)
    const second = await connectAndHello(deviceId, token, 2);
    const resentOnReconnect = await second.reader.next();
    expect(resentOnReconnect.id).toBe(queued.cmdId);
  });

  it("redelivers ack-timeout-failed commands (spike bug 10) but resets them through queued first", async () => {
    const { deviceId, token } = await pairDevice("timeout-redeliver-machine");
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {});
    await markFailedAckTimeout(cmdId);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("failed");

    const { reader } = await connectAndHello(deviceId, token);
    const redelivered = await reader.next();
    expect(redelivered.id).toBe(cmdId);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("sent");
  });

  it("parks an unacked sent row back to queued when its deadline passes with no live connection", async () => {
    const { deviceId, token } = await pairDevice("park-machine");
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {}); // device offline: stays queued
    // Simulate: it was sent, the connection then dropped, and the ack deadline expired.
    await runInDurableObject(ownerStub(), async (instance: Steward) => {
      (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
        UPDATE outbox SET state = 'sent', attempts = 1, ackDeadline = 1 WHERE cmdId = ${cmdId}
      `;
    });

    await ownerStub().resendUnacked();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("queued"); // parked, not hot-looped or failed

    // And the device returning gets it delivered.
    const { reader } = await connectAndHello(deviceId, token);
    expect((await reader.next()).id).toBe(cmdId);
  });
});

describe("idle sweep (spike bug 5: queued commands for a device that never returns)", () => {
  it("fails a queued command after ~30 idle minutes, but keeps fresh ones queued", async () => {
    const { deviceId } = await pairDevice("idle-machine");
    const stale = await ownerStub().enqueue(deviceId, "diag", {}, { notAfter: null }); // "wait for it to come online"
    const fresh = await ownerStub().enqueue(deviceId, "diag", {}, { notAfter: null });
    expect(stale.state).toBe("queued");

    await backdateCreatedAt(stale.cmdId);
    await ownerStub().sweepIdle();

    const staleRow = await ownerStub().outboxRow(stale.cmdId);
    expect(staleRow?.state).toBe("failed");
    expect(staleRow?.failReason).toBe("idle");
    expect((await ownerStub().outboxRow(fresh.cmdId))?.state).toBe("queued");
  });

  it("does not redeliver idle-failed commands at hello (unlike ack-timeout failures)", async () => {
    const { deviceId, token } = await pairDevice("idle-no-redeliver");
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {}, { notAfter: null });
    await backdateCreatedAt(cmdId);
    await ownerStub().sweepIdle();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("failed");

    const { ws, reader } = await connectAndHello(deviceId, token);
    ws.send(JSON.stringify({ t: "bogus", id: "p1" })); // nothing should have been redelivered
    const reply = await reader.next();
    expect(reply.code).toBe("unsupported");
  });
});

async function backdateCreatedAt(cmdId: string): Promise<void> {
  await runInDurableObject(ownerStub(), async (instance: Steward) => {
    (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
      UPDATE outbox SET createdAt = ${Date.now() - 31 * 60_000} WHERE cmdId = ${cmdId}
    `;
  });
}
