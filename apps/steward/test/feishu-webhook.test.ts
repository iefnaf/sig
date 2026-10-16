import { beforeEach, describe, expect, it } from "vitest";
import {
  TEST_APP_ID,
  TEST_VERIFY_TOKEN,
  configureAndBind,
  messageEvent,
  mockCalls,
  mockReset,
  ownerStub,
  postEvent,
  resetChannelState,
  sendCalls,
  submitSetupCredentials,
  urlVerification,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetChannelState();
  await mockReset();
});

describe("webhook: handshake and verification (steward.md §9.1)", () => {
  it("404s before any credentials are configured", async () => {
    expect((await urlVerification()).status).toBe(404);
    expect((await postEvent(messageEvent())).status).toBe(404);
  });

  it("echoes the url_verification challenge for the matching token", async () => {
    await submitSetupCredentials();
    const res = await urlVerification();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch-123" });
  });

  it("rejects url_verification with a wrong verification token", async () => {
    await submitSetupCredentials();
    const res = await urlVerification("wrong-token");
    expect(res.status).toBe(401);
  });

  it("rejects events whose verification token does not match, persisting nothing", async () => {
    await submitSetupCredentials();
    const res = await postEvent(messageEvent({ token: "wrong-token" }));
    expect(res.status).toBe(401);
    expect(await ownerStub().inboundSeen("om_default")).toBe(false);
  });

  it("rejects events addressed to a different app_id", async () => {
    await submitSetupCredentials();
    const res = await postEvent(messageEvent({ appId: "cli_someone_else" }));
    expect(res.status).toBe(403);
    expect(await ownerStub().inboundSeen("om_default")).toBe(false);
  });

  it("rejects events with a timestamp more than an hour skewed (replay guard)", async () => {
    await submitSetupCredentials();
    const res = await postEvent(messageEvent({ createTime: Date.now() - 2 * 60 * 60_000 }));
    expect(res.status).toBe(403);
    expect(await ownerStub().inboundSeen("om_default")).toBe(false);
    // Within the window is fine (Feishu clocks are not ours).
    const ok = await postEvent(messageEvent({ msgId: "om_fresh", createTime: Date.now() - 5 * 60_000 }));
    expect(ok.status).toBe(200);
  });

  it("answers malformed bodies with 400", async () => {
    await submitSetupCredentials();
    expect((await postEvent({ nonsense: true })).status).toBe(400);
    expect((await postEvent("not-json")).status).toBe(400);
  });
});

describe("webhook: dedup on message id (persist before 200, §9.1/§11)", () => {
  it("acks a redelivered event without reprocessing it", async () => {
    await submitSetupCredentials();
    const first = await postEvent(messageEvent({ msgId: "om_bind", senderId: "ou_owner", text: "hi" }));
    expect(first.status).toBe(200);
    await waitWhileOutboundPending();

    const second = await postEvent(messageEvent({ msgId: "om_bind", senderId: "ou_owner", text: "hi" }));
    expect(second.status).toBe(200);

    const logs = await ownerStub().channelLogEntries(50);
    expect(logs.filter((l) => l.reason === "owner_bound")).toHaveLength(1);
    const calls = await mockCalls();
    expect(sendCalls(calls)).toHaveLength(1); // exactly one confirmation, not two
    expect((await ownerStub().outboundRows(10)).filter((r) => r.status === "sent")).toHaveLength(1);
  });
});

describe("webhook: owner binding and DM filtering (issue #4)", () => {
  it("the first p2p DM binds the sender as owner and replies before the 200 settles", async () => {
    await submitSetupCredentials();
    const res = await postEvent(messageEvent({ msgId: "om_first", senderId: "ou_alice", text: "你好" }));
    expect(res.status).toBe(200);

    const state = await ownerStub().setupState();
    expect(state.state).toBe("bound");
    expect(state.ownerOpenId).toBe("ou_alice");
    // Persisted before the response went out.
    expect(await ownerStub().inboundSeen("om_first")).toBe(true);
    expect((await ownerStub().channelLogEntries(10)).some((l) => l.reason === "owner_bound" && l.detail === "ou_alice")).toBe(true);

    await waitWhileOutboundPending();
    const [row] = await ownerStub().outboundRows(1);
    expect(row?.status).toBe("sent");
    expect(row?.providerMsgId).toMatch(/^om_mock_/);
    expect(row?.receiveId).toBe("ou_alice");

    const calls = await mockCalls();
    const body = JSON.parse(sendCalls(calls)[0]!.body!);
    expect(body.receive_id).toBe("ou_alice");
    expect(body.msg_type).toBe("text");
    expect(JSON.parse(body.content).text).toContain("已绑定");
  });

  it("a DM from someone else after binding is ignored and logged, never answered", async () => {
    await configureAndBind("ou_owner");
    await mockCalls(); // drain the binding confirmation so only new sends count
    const res = await postEvent(messageEvent({ msgId: "om_stranger", senderId: "ou_stranger", text: "let me in" }));
    expect(res.status).toBe(200);
    expect(await ownerStub().inboundSeen("om_stranger")).toBe(true); // still persisted
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "ignored_not_owner" && l.detail?.includes("ou_stranger"))).toBe(true);
    expect(sendCalls(await mockCalls())).toHaveLength(0);
    expect((await ownerStub().setupState()).ownerOpenId).toBe("ou_owner"); // binding unchanged
  });

  it("group messages are ignored and logged even from the owner", async () => {
    await configureAndBind("ou_owner");
    await mockCalls(); // drain the binding confirmation
    const res = await postEvent(messageEvent({ msgId: "om_group", senderId: "ou_owner", chatType: "group", text: "hi all" }));
    expect(res.status).toBe(200);
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "ignored_group" && l.detail?.includes("om_group"))).toBe(true);
    expect(sendCalls(await mockCalls())).toHaveLength(0);
  });

  it("records the owner's text DMs durably (routing to the steward is a later ticket)", async () => {
    await configureAndBind("ou_owner");
    const res = await postEvent(
      messageEvent({ msgId: "om_task", senderId: "ou_owner", text: "fix the login bug", parentId: "om_mock_1" }),
    );
    expect(res.status).toBe(200);
    expect(await ownerStub().inboundSeen("om_task")).toBe(true);
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "owner_message" && l.detail?.includes("fix the login bug") && l.detail?.includes("om_mock_1"))).toBe(
      true,
    );
  });

  it("acknowledges and logs non-message event types", async () => {
    await configureAndBind("ou_owner");
    const res = await postEvent({
      schema: "2.0",
      header: {
        event_id: "evt_other_1",
        event_type: "contact.user.updated_v3",
        create_time: String(Date.now()),
        token: TEST_VERIFY_TOKEN,
        app_id: TEST_APP_ID,
      },
      event: { obj: {} },
    });
    expect(res.status).toBe(200);
    expect(await ownerStub().inboundSeen("evt_other_1")).toBe(true); // deduped on event id
    expect((await ownerStub().channelLogEntries(10)).some((l) => l.reason === "event_ignored_other")).toBe(true);
  });

  it("rejects a malformed card.action.trigger (no card context) instead of acking it", async () => {
    await configureAndBind("ou_owner");
    const res = await postEvent({
      schema: "2.0",
      header: {
        event_id: "evt_card_bad",
        event_type: "card.action.trigger",
        create_time: String(Date.now()),
        token: TEST_VERIFY_TOKEN,
        app_id: TEST_APP_ID,
      },
      event: { operator: { open_id: "ou_owner" } }, // missing action/context
    });
    expect(res.status).toBe(400);
    expect(await ownerStub().inboundSeen("evt_card_bad")).toBe(false);
  });
});
