import { beforeEach, describe, expect, it } from "vitest";
import {
  FEISHU_API_BASE,
  FeishuAdapter,
  MAX_SERIALIZED_BYTES,
  type FeishuCredentials,
  type TokenStore,
} from "../src/channel/feishu.ts";
import { MessageTooLargeError, RetriableChannelError, type OutboundMessage } from "../src/channel/types.ts";
import { TEST_APP_ID, TEST_APP_SECRET, TEST_VERIFY_TOKEN, messageEvent } from "./helpers.ts";

const CREDS: FeishuCredentials = { appId: TEST_APP_ID, appSecret: TEST_APP_SECRET, verificationToken: TEST_VERIFY_TOKEN };

class MemoryTokenStore implements TokenStore {
  token: string | null = null;
  expiresAt = 0;
  getCachedToken() {
    return this.token === null ? null : { token: this.token, expiresAt: this.expiresAt };
  }
  saveToken(token: string, expiresAt: number): void {
    this.token = token;
    this.expiresAt = expiresAt;
  }
}

function adapter(store: TokenStore, fetcher: typeof fetch, now: () => number = Date.now) {
  return new FeishuAdapter({ credentials: CREDS, tokenStore: store, fetcher, now });
}

function eventRequest(body: unknown): Request {
  return new Request("https://example.com/channels/feishu/events", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("FeishuAdapter.verifyAndParse", () => {
  it("echoes the url_verification challenge for the matching token", async () => {
    const res = await adapter(new MemoryTokenStore(), fetch).verifyAndParse(
      eventRequest({ type: "url_verification", challenge: "abc", token: TEST_VERIFY_TOKEN }),
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
    expect(await (res as Response).json()).toEqual({ challenge: "abc" });
  });

  it("401s the handshake and events on token mismatch", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const handshake = await a.verifyAndParse(eventRequest({ type: "url_verification", challenge: "x", token: "nope" }));
    expect((handshake as Response).status).toBe(401);
    const event = await a.verifyAndParse(eventRequest(messageEvent({ token: "nope" })));
    expect((event as Response).status).toBe(401);
  });

  it("403s events for another app and events with excessive timestamp skew", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    expect(((await a.verifyAndParse(eventRequest(messageEvent({ appId: "cli_other" })))) as Response).status).toBe(403);
    expect(((await a.verifyAndParse(eventRequest(messageEvent({ createTime: Date.now() - 2 * 3_600_000 })))) as Response).status).toBe(403);
  });

  it("tolerates second-precision create_time and rejects unparseable ones", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const seconds = Math.floor(Date.now() / 1000);
    const ok = await a.verifyAndParse(eventRequest(messageEvent({ createTime: seconds })));
    expect(ok).not.toBeInstanceOf(Response);
    expect(((await a.verifyAndParse(eventRequest(messageEvent({ createTime: -5 })))) as Response).status).toBe(400);
  });

  it("parses a p2p text message with its quote parent", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const parsed = await a.verifyAndParse(eventRequest(messageEvent({ msgId: "om_9", senderId: "ou_a", text: "fix it", parentId: "om_8" })));
    expect(parsed).not.toBeInstanceOf(Response);
    expect(parsed).toMatchObject({
      kind: "message",
      msgId: "om_9",
      senderId: "ou_a",
      chatType: "p2p",
      messageType: "text",
      text: "fix it",
      parentId: "om_8",
      eventType: "im.message.receive_v1",
    });
  });

  it("treats an empty parent_id as no quote", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const parsed = await a.verifyAndParse(eventRequest(messageEvent({ msgId: "om_10" })));
    expect((parsed as { parentId?: string }).parentId).toBeUndefined();
  });

  it("groups and non-text message types come through with their labels", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    expect(await a.verifyAndParse(eventRequest(messageEvent({ chatType: "group" })))).toMatchObject({ chatType: "group" });
    expect(await a.verifyAndParse(eventRequest(messageEvent({ messageType: "image", msgId: "om_img" })))).toMatchObject({
      messageType: "image",
      text: undefined,
    });
  });

  it("non-message events become kind=other deduped on event id", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const parsed = await a.verifyAndParse(
      eventRequest({
        schema: "2.0",
        header: { event_id: "evt_other_2", event_type: "contact.user.updated_v3", create_time: String(Date.now()), token: TEST_VERIFY_TOKEN, app_id: TEST_APP_ID },
        event: {},
      }),
    );
    expect(parsed).toMatchObject({ kind: "other", msgId: "evt_other_2", eventType: "contact.user.updated_v3" });
  });

  it("card.action.trigger becomes kind=card_action with operator, action value, and card message id", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const parsed = await a.verifyAndParse(
      eventRequest({
        schema: "2.0",
        header: { event_id: "evt_card_ok", event_type: "card.action.trigger", create_time: String(Date.now()), token: TEST_VERIFY_TOKEN, app_id: TEST_APP_ID },
        event: {
          operator: { open_id: "ou_owner" },
          action: { value: { action: "wait_online" } },
          context: { open_message_id: "om_card_1" },
        },
      }),
    );
    expect(parsed).toMatchObject({
      kind: "card_action",
      msgId: "evt_card_ok",
      operatorId: "ou_owner",
      action: "wait_online",
      cardMsgId: "om_card_1",
    });
  });

  it("a card.action.trigger without operator or card context is a 400", async () => {
    const a = adapter(new MemoryTokenStore(), fetch);
    const parsed = await a.verifyAndParse(
      eventRequest({
        schema: "2.0",
        header: { event_id: "evt_card_bad2", event_type: "card.action.trigger", create_time: String(Date.now()), token: TEST_VERIFY_TOKEN, app_id: TEST_APP_ID },
        event: { operator: { open_id: "ou_owner" } },
      }),
    );
    expect(parsed).toBeInstanceOf(Response);
    expect((parsed as Response).status).toBe(400);
  });
});

describe("FeishuAdapter.send and token cache", () => {
  const store = new MemoryTokenStore();
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.includes("/auth/v3/tenant_access_token")) {
      return Response.json({ code: 0, tenant_access_token: "t_unit", expire: 7200 });
    }
    if (url.includes("/resources/")) {
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    return Response.json({ code: 0, data: { message_id: "om_unit_1" } });
  };

  beforeEach(() => {
    seen.length = 0;
    store.token = null;
    store.expiresAt = 0;
  });

  const msg: OutboundMessage = { id: "out_1", to: "ou_owner", kind: "text", text: "hi" };

  it("fetches and caches the tenant token, then sends with bearer auth and uuid", async () => {
    const a = adapter(store, fetcher);
    const r1 = await a.send(msg);
    expect(r1).toEqual({ providerMsgId: "om_unit_1" });
    await a.send({ ...msg, id: "out_2" }); // token now cached
    expect(seen).toHaveLength(3); // one token fetch + two sends
    const tokenCall = seen[0]!;
    expect(tokenCall.url).toBe(`${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`);
    expect(JSON.parse(String(tokenCall.init.body))).toEqual({ app_id: TEST_APP_ID, app_secret: TEST_APP_SECRET });
    const send = seen[1]!;
    expect(send.url).toBe(`${FEISHU_API_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`);
    expect((send.init.headers as Record<string, string>).Authorization).toBe("Bearer t_unit");
    expect(JSON.parse(String(send.init.body))).toMatchObject({ receive_id: "ou_owner", msg_type: "text", uuid: "out_1" });
  });

  it("refetches the token when the cache is inside the refresh margin", async () => {
    const a = adapter(store, fetcher);
    store.token = "t_old";
    store.expiresAt = Date.now() + 60_000; // under the 120s margin
    await a.send(msg);
    expect(seen.filter((s) => s.url.includes("/auth/v3/"))).toHaveLength(1);
  });

  it("classifies 5xx/429/network as retriable and 4xx/api errors as permanent", async () => {
    const mk = (status: number) =>
      adapter(
        { getCachedToken: () => ({ token: "t", expiresAt: Date.now() + 3_600_000 }), saveToken: () => {} },
        (async () => Response.json({ code: 0, data: {} }, { status })) as unknown as typeof fetch,
      );
    await expect(mk(500).send(msg)).rejects.toBeInstanceOf(RetriableChannelError);
    await expect(mk(429).send(msg)).rejects.toBeInstanceOf(RetriableChannelError);
    await expect(mk(400).send(msg)).rejects.not.toBeInstanceOf(RetriableChannelError);
  });

  it("rejects serialized payloads over 30 KB without any request", async () => {
    const boom: typeof fetch = async () => {
      throw new Error("must not be called");
    };
    const a = adapter(
      { getCachedToken: () => ({ token: "t", expiresAt: Date.now() + 3_600_000 }), saveToken: () => {} },
      boom,
    );
    await expect(a.send({ id: "out_big", to: "ou_owner", kind: "text", text: "x".repeat(MAX_SERIALIZED_BYTES) })).rejects.toBeInstanceOf(
      MessageTooLargeError,
    );
  });

  it("fetchAttachment targets the message-resource API with the token", async () => {
    const a = adapter(store, fetcher);
    const bytes = await a.fetchAttachment({ messageId: "om_1", fileKey: "img_v2_key" });
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(seen[1]!.url).toBe(`${FEISHU_API_BASE}/open-apis/im/v1/messages/om_1/resources/img_v2_key?type=image`);
    expect((seen[1]!.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });
});
