import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_URL,
  mockCalls,
  mockQueue,
  mockReset,
  messageEvent,
  ownerStub,
  postEvent,
  resetChannelState,
  submitSetupCredentials,
  tokenCalls,
} from "./helpers.ts";

beforeEach(async () => {
  await resetChannelState();
  await mockReset();
});

describe("setup page: SETUP_TOKEN gate (ADR-0001 decision 8)", () => {
  it("returns 404 without a token, with a wrong token, and for other methods", async () => {
    expect((await SELF.fetch("https://example.com/setup")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/setup?token=wrong")).status).toBe(404);
    expect((await SELF.fetch("https://example.com/setup?token=", { method: "PUT" })).status).toBe(404);
  });

  it("renders the manual-credentials form with the right token", async () => {
    const res = await SELF.fetch(SETUP_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("App ID");
    expect(html).toContain("Verification Token");
    expect(html).toContain("/channels/feishu/events");
    expect((await ownerStub().setupState()).state).toBe("unconfigured");
  });
});

describe("setup page: credential submission", () => {
  it("rejects credentials Feishu will not authenticate, keeps the form open", async () => {
    await mockQueue({ body: { code: 10003, msg: "app secret is invalid" } });
    const res = await submitSetupCredentials("cli_test_app", "bad-secret");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("凭据校验失败");
    expect((await ownerStub().setupState()).state).toBe("unconfigured");
  });

  it("accepts valid credentials, caches their tenant token, and moves to awaiting-owner", async () => {
    const res = await submitSetupCredentials();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("等待主人首次私聊");
    expect((await ownerStub().setupState()).state).toBe("awaiting_owner");

    // The live validation fetched (and cached) a tenant_access_token.
    const calls = await mockCalls();
    expect(tokenCalls(calls)).toHaveLength(1);
    expect(JSON.parse(tokenCalls(calls)[0]!.body!)).toEqual({ app_id: "cli_test_app", app_secret: "sec_test_secret" });

    // Still open before binding.
    expect((await SELF.fetch(SETUP_URL)).status).toBe(200);
  });

  it("stores the secret and verification token encrypted, not in plaintext", async () => {
    await submitSetupCredentials();
    const res = await SELF.fetch(SETUP_URL);
    const html = await res.text();
    expect(html).not.toContain("sec_test_secret");
    expect(html).not.toContain("verify-token");
  });
});

describe("setup page: post-deploy reachability self-check (issue #25)", () => {
  const page = async (origin: string) =>
    (await SELF.fetch(`${origin}/setup?token=test-setup-token-not-a-secret`)).text();

  it("on a workers.dev host: warns that Feishu cannot deliver webhooks and points at the custom-domain guide", async () => {
    const html = await page("https://shepherd-steward.demo.workers.dev");
    expect(html).toContain("部署自检");
    expect(html).toContain("shepherd-steward.demo.workers.dev");
    expect(html).toContain("无法访问 <code>*.workers.dev</code>");
    expect(html).toContain("绑定自定义域名");
    expect(html).toContain("deploy.md#custom-domain");
    // The definitive Feishu-side reachability proof is the webhook switch, so say so.
    expect(html).toContain("地址校验");
  });

  it("on a custom domain: green check naming the host the webhook URL will use", async () => {
    const html = await page("https://shepherd.example.com");
    expect(html).toContain("自定义域名</b> <code>shepherd.example.com</code>");
    expect(html).toContain("deploy.md#custom-domain");
    expect(html).not.toContain("无法访问");
  });

  it("stays quiet for local dev hosts", async () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      const html = await page(origin);
      expect(html).not.toContain("部署自检");
      expect(html).not.toContain("网络自检");
    }
  });
});

describe("setup page: closing permanently on owner binding", () => {
  it("404s for GET and POST once the owner has DM'd the bot", async () => {
    await submitSetupCredentials();
    const res = await postEvent(messageEvent({ msgId: "om_bind", senderId: "ou_owner", text: "hi" }));
    expect(res.status).toBe(200);
    expect((await ownerStub().setupState()).state).toBe("bound");

    const closed = await SELF.fetch(SETUP_URL);
    expect(closed.status).toBe(404);
    // The deployer who opens the link right after a successful setup is told it is done, not
    // handed a bare "not found" that reads like a failure.
    const closedBody = await closed.text();
    expect(closedBody).toContain("设置已完成");
    expect(closedBody).toContain("/加机器");
    expect(closed.headers.get("cache-control")).toBe("no-store");
    expect((await submitSetupCredentials("cli_other", "other-secret", "other-vt")).status).toBe(404);
    // And it stays closed.
    expect((await SELF.fetch(SETUP_URL)).status).toBe(404);
    // Anyone without the token still learns nothing: the Worker answers before the DO is asked.
    const stranger = await SELF.fetch("https://example.com/setup?token=wrong");
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe("not found");
  });
});
