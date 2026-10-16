// QR-code onboarding (issue #24): device-flow begin/poll with interval/slow_down/lark-domain
// handling, encrypted credential storage, open_id owner binding, the addons scope scan, the
// webhook config PATCH, console-republish guidance, and delivery-verified closure. The device
// flow is alarm-driven inside the DO, so these tests wait on the persisted phase machine.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETUP_URL,
  configPatchCalls,
  messageEvent,
  mockCalls,
  mockQueue,
  mockRegistration,
  mockReset,
  ownerStub,
  postEvent,
  postSetupAction,
  readChannelConfig,
  registrationCalls,
  resetChannelState,
  sendCalls,
  submitSetupCredentials,
  waitForQrPhase,
  waitWhileOutboundPending,
} from "./helpers.ts";

// The device flow is alarm-driven (≥1s per hop, several hops per test), so this file gets a
// higher ceiling than the 5s default.
vi.setConfig({ testTimeout: 60_000 });

const QR_APP_ID = "cli_qr_app";
const QR_APP_SECRET = "sec_qr_secret";
const QR_OWNER = "ou_qr_scanner";

function beginReply(overrides: Record<string, unknown> = {}) {
  return {
    device_code: "dc_mock_create",
    verification_uri_complete: "https://feishu.invalid/qr/confirm?dc=dc_mock_create",
    user_code: "MOCK-CODE",
    interval: 1,
    expires_in: 600,
    ...overrides,
  };
}

function pollSuccess(overrides: Record<string, unknown> = {}) {
  return {
    client_id: QR_APP_ID,
    client_secret: QR_APP_SECRET,
    user_info: { open_id: QR_OWNER, tenant_brand: "feishu" },
    ...overrides,
  };
}

/** Runs the happy path up to (and including) the given phase. */
async function qrFlowTo(phase: "scan2" | "webhook_patched" | "done", timeout = 60_000): Promise<void> {
  // Both begins are scripted up front: the create scan's success chains the scope-scan
  // begin immediately. The trailing pending keeps the addons flow parked (stale alarms from
  // earlier tests can poll faster than the nominal interval, so the script — not the clock —
  // decides when each step advances).
  await mockRegistration({
    begin: [
      beginReply({ device_code: "dc_create_1" }),
      beginReply({ device_code: "dc_addons_1", verification_uri_complete: "https://feishu.invalid/qr/confirm?dc=dc_addons_1" }),
    ],
    polls: [{ error: "authorization_pending" }, pollSuccess(), { error: "authorization_pending" }],
  });
  await postSetupAction("start_qr");
  await waitForQrPhase("awaiting_scope_scan", timeout);
  if (phase === "scan2") return;
  // Advance the addons flow: its next poll succeeds, then the config PATCH runs against the
  // mock's default replies (token + config PATCH succeed).
  await mockRegistration({ polls: [pollSuccess()] });
  await waitForQrPhase("webhook_patched", timeout);
  if (phase === "done") {
    const cfg = await readChannelConfig();
    const res = await postEvent(messageEvent({ msgId: "om_qr_first", senderId: QR_OWNER, appId: QR_APP_ID, token: cfg!.verificationToken }));
    expect(res.status).toBe(200);
    await waitWhileOutboundPending();
    await waitForQrPhase("done", timeout);
  }
}

beforeEach(async () => {
  await resetChannelState();
  await mockReset();
});

describe("QR flow: begin and the scan page", () => {
  it("starts the device flow with the SDK's fixed begin parameters and prefills the deployment name", async () => {
    await postSetupAction("start_qr");
    const calls = await mockCalls();
    const begins = registrationCalls(calls).filter((c) => c.body?.includes("action=begin"));
    expect(begins).toHaveLength(1);
    expect(begins[0]!.url).toBe("https://accounts.feishu.cn/oauth/v1/app/registration");
    expect(Object.fromEntries(new URLSearchParams(begins[0]!.body!))).toEqual({
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    });

    const row = await ownerStub().qrSetupState();
    expect(row?.phase).toBe("awaiting_scan");
    expect(row?.flow).toBe("create");
    expect(row?.intervalS).toBe(1);
    // The deployment-distinguishing name rides the QR URL (host label first: names truncate).
    const name = new URL(row!.qrUrl).searchParams.get("name");
    expect(name).toBe("example·Shepherd");
    expect(new URL(row!.qrUrl).searchParams.get("createOnly")).toBe("true");
    expect(new URL(row!.qrUrl).searchParams.get("desc")).toContain("https://example.com");
  });

  it("renders the QR code and auto-refreshes while awaiting the scan", async () => {
    await postSetupAction("start_qr");
    const html = await (await SELF.fetch(SETUP_URL)).text();
    expect(html).toContain("<svg"); // the QR itself
    expect(html).toContain("http-equiv=\"refresh\"");
    expect(html).toContain("第 1 步");
    // The manual fallback stays reachable (issue #24: manual entry remains the fallback).
    expect(html).toContain("App ID");
    expect(html).toContain("App Secret");
  });

  it("warns that workers.dev is unreachable for the webhook switch", async () => {
    const res = await SELF.fetch("https://shepherd.example.workers.dev/setup?token=test-setup-token-not-a-secret");
    const html = await res.text();
    expect(html).toContain("workers.dev");
    expect(html).toContain("自定义域名");
  });
});

describe("QR flow: alarm-driven polling (interval, slow_down, lark brand)", () => {
  it("re-polls at the given interval and stores sealed credentials with the scanner as owner", async () => {
    await mockRegistration({
      begin: [beginReply({ interval: 1 })],
      polls: [{ error: "authorization_pending" }, pollSuccess(), { error: "authorization_pending" }],
    });
    await postSetupAction("start_qr");
    await waitForQrPhase("awaiting_scope_scan", 30_000);

    const cfg = await readChannelConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.appId).toBe(QR_APP_ID);
    expect(cfg!.source).toBe("qr");
    expect(cfg!.ownerOpenId).toBe(QR_OWNER); // the scanner is the owner, no DM needed
    // Stored encrypted, never plaintext (steward.md §9.0).
    const raw = await (await SELF.fetch(SETUP_URL)).text();
    expect(raw).not.toContain(QR_APP_SECRET);
    expect(cfg!.verificationToken).toMatch(/^[0-9a-f]{32}$/); // ours from the start
    expect((await ownerStub().setupState()).state).toBe("awaiting_webhook"); // setup stays open until verified
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "qr_created" && l.detail!.includes(QR_APP_ID))).toBe(true);
  });

  it("backs off +5s on slow_down and keeps polling", async () => {
    await mockRegistration({ begin: [beginReply({ interval: 1 })], polls: [{ error: "slow_down" }] });
    await postSetupAction("start_qr");
    // The interval grows in RFC 8628 slow_down increments (stale alarms can apply several).
    const deadline = Date.now() + 30_000;
    let row = await ownerStub().qrSetupState();
    while ((row?.intervalS ?? 0) <= 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      row = await ownerStub().qrSetupState();
    }
    expect((row!.intervalS - 1) % 5).toBe(0);
    expect(row!.intervalS).toBeGreaterThanOrEqual(6);
    expect(row?.phase).toBe("awaiting_scan"); // still polling, not failed
    const polls = registrationCalls(await mockCalls()).filter((c) => c.body?.includes("action=poll"));
    expect(polls.length).toBeGreaterThanOrEqual(2);
  });

  it("switches the polling domain when the scanner's tenant brand is lark", async () => {
    await mockRegistration({
      begin: [beginReply()],
      polls: [
        { error: "authorization_pending", user_info: { tenant_brand: "lark" } },
        pollSuccess({ user_info: { open_id: QR_OWNER, tenant_brand: "lark" } }),
        { error: "authorization_pending" },
      ],
    });
    await postSetupAction("start_qr");
    await waitForQrPhase("awaiting_scope_scan");

    const urls = registrationCalls(await mockCalls()).map((c) => c.url);
    expect(urls).toContain("https://accounts.larksuite.com/oauth/v1/app/registration");
    const cfg = await readChannelConfig();
    expect(cfg!.brand).toBe("lark");
    // The created app's second scan still begins on the lark accounts domain.
    const row = await ownerStub().qrSetupState();
    expect(row?.brand).toBe("lark");
  });

  it("fails terminally on access_denied and offers a restart", async () => {
    await mockRegistration({ begin: [beginReply()], polls: [{ error: "access_denied" }] });
    await postSetupAction("start_qr");
    await waitForQrPhase("failed", 30_000);
    const row = await ownerStub().qrSetupState();
    expect(row?.lastError).toContain("access_denied");
    const html = await (await SELF.fetch(SETUP_URL)).text();
    expect(html).toContain("重新生成二维码");
    expect((await ownerStub().setupState()).state).toBe("unconfigured");
  });
});

describe("QR flow: the second scan adds application:application:patch via addons", () => {
  it("targets the created app (clientID) and carries the encoded addons scope", async () => {
    await qrFlowTo("scan2");
    const row = await ownerStub().qrSetupState();
    expect(row?.flow).toBe("addons");
    const qrUrl = new URL(row!.qrUrl);
    expect(qrUrl.searchParams.get("clientID")).toBe(QR_APP_ID);
    expect(qrUrl.searchParams.get("createOnly")).toBeNull(); // would override clientID
    // The addons payload is the SDK pipeline: JSON → gzip → base64url; we only assert the
    // round-trip (content check lives in registration.test.ts).
    expect(qrUrl.searchParams.get("addons")).toMatch(/^[A-Za-z0-9_-]+$/);
    const html = await (await SELF.fetch(SETUP_URL)).text();
    expect(html).toContain("第 2 步");
    expect(html).toContain("application:application:patch");
  });
});

describe("QR flow: config PATCH switches delivery to the webhook", () => {
  it("PATCHes events and callbacks to the page origin with our verification token", async () => {
    await qrFlowTo("webhook_patched");
    const cfg = await readChannelConfig();
    expect(cfg!.webhookStatus).toBe("patched");

    const patches = configPatchCalls(await mockCalls());
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(`https://open.feishu.cn/open-apis/application/v7/applications/${QR_APP_ID}/config`);
    const body = JSON.parse(patches[0]!.body!) as Record<string, any>;
    expect(body.event).toEqual({
      subscription_type: "webhook",
      request_url: "https://example.com/channels/feishu/events",
      add_events: ["im.message.receive_v1"],
    });
    expect(body.callback).toEqual({ callback_type: "webhook", add_callbacks: ["card.action.trigger"] });
    expect(body.event_and_callback_encrypt_strategy).toEqual({ verification_token: cfg!.verificationToken });

    // The page guides the one manual step: the console republish.
    const html = await (await SELF.fetch(SETUP_URL)).text();
    expect(html).toContain("控制台");
    expect(html).toContain("发布");
    expect(html).toContain("open.feishu.cn/app/cli_qr_app");
    expect(html).toContain("私聊消息");
  });

  it("keeps the flow on scope_added with the error and a retry when the PATCH is rejected", async () => {
    await mockRegistration({
      begin: [beginReply({ device_code: "dc_create_1" })],
      polls: [{ error: "authorization_pending" }, pollSuccess(), { error: "authorization_pending" }],
    });
    await postSetupAction("start_qr");
    await waitForQrPhase("awaiting_scope_scan", 30_000);
    // The scope scan succeeds, but the PATCH fails (e.g. the addons confirm silently did
    // nothing — research §1: the gradual-rollout switch can drop the whole param).
    await mockRegistration({ polls: [pollSuccess()] });
    await mockQueue({ body: { code: 230002, msg: "no permission" } });
    await waitForQrPhase("scope_added", 30_000);
    const row = await ownerStub().qrSetupState();
    expect(row?.lastError).toContain("230002");
    const html = await (await SELF.fetch(SETUP_URL)).text();
    expect(html).toContain("切换到 webhook"); // retry offered
    expect(html).toContain("权限管理"); // manual top-up guidance
    expect((await readChannelConfig())!.webhookStatus).toBeNull();
  });

  it("answers url_verification loosely during the switch window and strictly after", async () => {
    await qrFlowTo("webhook_patched");
    const cfg = await readChannelConfig();
    // The PATCH's URL check may be signed with the app's previous console token (unknowable
    // for a QR-created app): challenges echo during the window.
    const loose = await postEvent({ type: "url_verification", challenge: "ch-1", token: "old-console-token" });
    expect(loose.status).toBe(200);
    expect(await loose.json()).toEqual({ challenge: "ch-1" });

    await postEvent(messageEvent({ msgId: "om_qr_verify", senderId: QR_OWNER, appId: QR_APP_ID, token: cfg!.verificationToken }));
    await waitWhileOutboundPending();
    await waitForQrPhase("done");
    // Once verified, the handshake is strict again.
    const strict = await postEvent({ type: "url_verification", challenge: "ch-2", token: "old-console-token" });
    expect(strict.status).toBe(401);
  });
});

describe("QR flow: verification by real delivery and setup closure", () => {
  it("the first event to reach the webhook completes setup and notifies the owner", async () => {
    await qrFlowTo("done");
    const state = await ownerStub().setupState();
    expect(state.state).toBe("bound");
    expect(state.webhookStatus).toBe("verified");
    const logs = await ownerStub().channelLogEntries(10);
    expect(logs.some((l) => l.reason === "webhook_verified")).toBe(true);

    // The owner got the completion DM.
    const calls = sendCalls(await mockCalls());
    const bodies = calls.map((c) => JSON.parse(c.body!));
    const done = bodies.find((b) => JSON.parse(b.content).text.includes("webhook"));
    expect(done?.receive_id).toBe(QR_OWNER);

    // Closed permanently: GET and POST 404 from here on.
    expect((await SELF.fetch(SETUP_URL)).status).toBe(404);
    expect((await postSetupAction("start_qr")).status).toBe(404);
  });

  it("events with a non-matching token never verify the switch", async () => {
    await qrFlowTo("webhook_patched");
    const res = await postEvent(messageEvent({ msgId: "om_forged", senderId: QR_OWNER, appId: QR_APP_ID, token: "forged-token" }));
    expect(res.status).toBe(401);
    expect((await ownerStub().setupState()).webhookStatus).toBe("patched");
  });
});

describe("QR flow: manual entry remains the fallback", () => {
  it("manual submission cancels an active QR flow and works as before", async () => {
    await mockRegistration({ begin: [beginReply()], polls: [{ error: "authorization_pending" }] });
    await postSetupAction("start_qr");
    await waitForQrPhase("awaiting_scan", 30_000);

    const res = await submitSetupCredentials();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("等待主人首次私聊");
    expect(await ownerStub().qrSetupState()).toBeNull(); // QR flow cancelled
    const cfg = await readChannelConfig();
    expect(cfg!.source).toBe("manual");

    // The owner's first DM still binds (issue #4 semantics untouched).
    const bind = await postEvent(messageEvent({ msgId: "om_bind_manual" }));
    expect(bind.status).toBe(200);
    const state = await ownerStub().setupState();
    expect(state.state).toBe("bound");
  });

  it("resets the owner binding when manual credentials name a different app", async () => {
    await qrFlowTo("webhook_patched");
    const before = await readChannelConfig();
    expect(before!.ownerOpenId).toBe(QR_OWNER);

    const res = await submitSetupCredentials("cli_other_app", "other-secret", "other-vt");
    expect(res.status).toBe(200);
    const cfg = await readChannelConfig();
    expect(cfg!.appId).toBe("cli_other_app");
    expect(cfg!.ownerOpenId).toBeNull(); // open_id is app-scoped: a different app unbinds
    expect(cfg!.webhookStatus).toBeNull();
    expect((await ownerStub().setupState()).state).toBe("awaiting_owner");
  });

  it("keeps the binding when manual credentials re-enter the same QR-created app", async () => {
    await qrFlowTo("webhook_patched");
    const before = await readChannelConfig();
    // Same app, different (console-copied) verification token — the documented recovery when
    // events keep arriving signed with the console token.
    const res = await submitSetupCredentials(QR_APP_ID, QR_APP_SECRET, "console-token");
    expect(res.status).toBe(200);
    const cfg = await readChannelConfig();
    expect(cfg!.ownerOpenId).toBe(QR_OWNER);
    expect(cfg!.verificationToken).toBe("console-token");
    // Manual source + bound owner = onboarding complete: the page closes.
    expect((await ownerStub().setupState()).state).toBe("bound");
    expect((await SELF.fetch(SETUP_URL)).status).toBe(404);
  });
});
