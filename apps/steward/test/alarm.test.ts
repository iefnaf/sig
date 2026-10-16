// protocol §4.2 / spike-conclusions: `schedule()` has whole-second granularity, so the alarm
// can fire a few hundred milliseconds before the millisecond-precision ackDeadline. The handler
// must leave another alarm armed while any row is still `sent`, or a command gets stuck forever.
//
// The Agents SDK's scheduler only *runs* schedule rows that are due (its alarm handler re-arms
// the DO alarm for future rows), so handler logic is exercised by calling `resendUnacked()`
// directly via RPC; one real-time test then proves the SDK alarm wiring end-to-end.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { connectAndHello, ownerStub, pairDevice } from "./helpers.ts";

async function getAlarmMs(): Promise<number | null> {
  return runInDurableObject(ownerStub(), async (_instance: Steward, state: DurableObjectState) => state.storage.getAlarm());
}

// Simulates the 15s ackDeadline having passed without waiting real time.
async function setAckDeadlineInPast(cmdId: string): Promise<void> {
  await runInDurableObject(ownerStub(), async (instance: Steward) => {
    (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql`
      UPDATE outbox SET ackDeadline = 1 WHERE cmdId = ${cmdId}
    `;
  });
}

describe("resendUnacked alarm handler", () => {
  it("keeps an alarm armed after an early run (sub-second deadline regression) and resends once due", async () => {
    const { deviceId, token } = await pairDevice("alarm-machine");
    const { reader } = await connectAndHello(deviceId, token);
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {});
    await reader.next(); // the initial cmd frame, state -> sent

    // The alarm handler runs before the ms-precision ackDeadline (whole-second granularity):
    // the row is not due yet, must neither fail it nor leave nothing scheduled for the future.
    await ownerStub().resendUnacked();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("sent");
    expect(await getAlarmMs()).not.toBeNull(); // re-armed: the spike bug would end here

    // Deadline passes; the follow-up run re-sends exactly once.
    await setAckDeadlineInPast(cmdId);
    await ownerStub().resendUnacked();
    const resend = await reader.next();
    expect(resend.id).toBe(cmdId);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("sent");

    // Second timeout: failed(ack_timeout), no third send.
    await setAckDeadlineInPast(cmdId);
    await ownerStub().resendUnacked();
    const row = await ownerStub().outboxRow(cmdId);
    expect(row?.state).toBe("failed");
    expect(row?.failReason).toBe("ack_timeout");
    await ownerStub().resendUnacked();
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("failed");
  });

  it("drives a resend through a real scheduled alarm without any forced run", { timeout: 10_000 }, async () => {
    const { deviceId, token } = await pairDevice("real-alarm-machine");
    const { reader } = await connectAndHello(deviceId, token);
    // 1s ack timeout: the SDK alarm fires ~1s later; if the handler failed to re-arm on an
    // early fire, the row would sit in `sent` forever and the resend never arrive.
    const { cmdId } = await ownerStub().enqueue(deviceId, "diag", {}, { ackTimeoutMs: 1000 });
    const first = await reader.next();
    expect(first.id).toBe(cmdId);

    const resend = await reader.next(); // alarm-driven resend (not due-yet early fires may precede it)
    expect(resend.id).toBe(cmdId);
    expect((await ownerStub().outboxRow(cmdId))?.state).toBe("sent");
  });
});
