import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  mockCalls,
  mockQueue,
  mockReset,
  ownerStub,
  resetChannelState,
  sendCalls,
  tokenCalls,
} from "./helpers.ts";

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

// The outbox tests' trick of running raw SQL inside the DO; migrations are already applied by
// the time a test reaches here (configureAndBind ran RPCs first).
async function execSql(fn: (sql: Sql) => void): Promise<void> {
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: Sql }).sql.bind(instance);
    fn(sql);
  });
}

// Delivery passes serialize on a chain inside the DO, so awaiting an explicit deliverOutbound
// call also waits out the void-fired pass an enqueue just started.
async function settleDelivery(): Promise<void> {
  await ownerStub().deliverOutbound();
}

describe("outbound queue: delivery (steward.md §6.1)", () => {
  // Every enqueue here is explicitly `push` (issue #11): these suites exercise delivery
  // MECHANICS (claims, pacing, backoff) where each row must be its own wire send. The quiet
  // merge window — holding, grouping, merged sends — lives in report-merge.test.ts.
  beforeEach(async () => {
    await resetChannelState();
    await mockReset();
    await configureAndBind("ou_owner");
    await mockCalls(); // drain the binding confirmation
  });

  it("sends through the adapter, records providerMsgId, and passes the stable id as uuid", async () => {
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "report done" });
    await settleDelivery();

    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("sent");
    expect(row?.providerMsgId).toMatch(/^om_mock_/);
    expect(row?.attempts).toBe(1);

    const body = JSON.parse(sendCalls(await mockCalls())[0]!.body!);
    expect(body).toMatchObject({ receive_id: "ou_owner", msg_type: "text" });
    expect(JSON.parse(body.content)).toEqual({ text: "report done" });
    expect(body.uuid).toBe(id); // provider-side idempotency on retries
  });

  it("caches tenant_access_token across sends and refetches once expired", async () => {
    await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "one" });
    await settleDelivery();
    await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "two" });
    await settleDelivery();
    // The setup page's live validation already cached a token; sends must not refetch.
    expect(tokenCalls(await mockCalls())).toHaveLength(0);

    await execSql((sql) => sql`UPDATE sh_channel_token SET expiresAt = 1 WHERE channel = 'feishu'`);
    await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "three" });
    await settleDelivery();
    const calls = await mockCalls();
    expect(tokenCalls(calls)).toHaveLength(1); // stale cache → one refetch
    expect(sendCalls(calls)).toHaveLength(1);
  });

  it("pacing: consecutive sends to the same receiver are spaced ≥ 200ms (5 QPS cap)", async () => {
    await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "a" });
    await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "b" });
    await settleDelivery();
    const sends = sendCalls(await mockCalls());
    expect(sends).toHaveLength(2);
    expect(sends[1]!.at - sends[0]!.at).toBeGreaterThanOrEqual(200);
  });
});

describe("outbound queue: retries and failures (spike bugs 1 and 3)", () => {
  beforeEach(async () => {
    await resetChannelState();
    await mockReset();
    await configureAndBind("ou_owner");
    await mockCalls();
  });

  it("a 5xx send failure stays queued with attempts counted and a future backoff", async () => {
    await mockQueue({ status: 500 });
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "will fail" });
    await settleDelivery();

    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("queued"); // retriable
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now() + 1000);
    expect(row?.providerMsgId).toBeNull();

    // Once the backoff elapses (backdated), the alarm-driven retry delivers it.
    await execSql((sql) => sql`UPDATE sh_outbound SET nextAttemptAt = 1 WHERE id = ${id}`);
    await ownerStub().deliverOutbound();
    expect((await ownerStub().outboundRow(id))?.status).toBe("sent");
  });

  it("a 4xx failure is permanent: failed immediately, no retry", async () => {
    await mockQueue({ status: 400, body: { code: 99991663, msg: "bad token" } });
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "nope" });
    await settleDelivery();
    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("400");

    await ownerStub().deliverOutbound(); // a sweep must not resurrect it
    expect((await ownerStub().outboundRow(id))?.status).toBe("failed");
    expect(sendCalls(await mockCalls())).toHaveLength(1);
  });

  it("a serialized payload over 30 KB fails permanently without hitting the API (card limit)", async () => {
    const { id } = await ownerStub().enqueueOutbound({ kind: "card", to: "ou_owner", urgency: "push", card: { elements: [{ text: "x".repeat(31_000) }] } });
    await settleDelivery();
    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("30");
    expect(sendCalls(await mockCalls())).toHaveLength(0);
  });

  it("gives up after the attempt budget is exhausted", async () => {
    await mockQueue({ status: 500 });
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "flaky" });
    await settleDelivery();
    expect((await ownerStub().outboundRow(id))?.attempts).toBe(1);

    // Pretend earlier attempts already happened: one more failure crosses the 8-attempt line.
    await mockQueue({ status: 500 });
    await execSql((sql) => sql`UPDATE sh_outbound SET attempts = 7, nextAttemptAt = 1 WHERE id = ${id}`);
    await ownerStub().deliverOutbound();
    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(8);
  });

  it("the claim token prevents double-sending when two delivery passes race (bug 1)", async () => {
    // A slow reply keeps the first pass inside its await window; the enqueue's own void-fired
    // delivery plus two explicit passes all contend, but only one may reach the wire.
    await mockQueue({ delayMs: 400, body: { code: 0, data: { message_id: "om_mock_slow" } } });
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "once only" });
    await Promise.all([ownerStub().deliverOutbound(), ownerStub().deliverOutbound()]);

    expect(sendCalls(await mockCalls())).toHaveLength(1);
    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("sent");
    expect(row?.providerMsgId).toBe("om_mock_slow");
  });

  it("a claim abandoned by a dead pass is reclaimed after its timeout and delivered", async () => {
    await mockQueue({ status: 500 }); // the original pass fails…
    const { id } = await ownerStub().enqueueOutbound({ kind: "text", to: "ou_owner", urgency: "push", text: "crashed mid-send" });
    await settleDelivery();
    expect((await ownerStub().outboundRow(id))?.status).toBe("queued");

    // Simulate a pass that died mid-send: row stuck in sending with an expired claim.
    await execSql(
      (sql) => sql`UPDATE sh_outbound SET status = 'sending', claimToken = 'dead-pass', claimExpiresAt = 1, nextAttemptAt = 1 WHERE id = ${id}`,
    );
    await ownerStub().deliverOutbound();
    const row = await ownerStub().outboundRow(id);
    expect(row?.status).toBe("sent"); // reclaimed and delivered by the sweep
    expect(row?.providerMsgId).toMatch(/^om_mock_/);
  });
});
