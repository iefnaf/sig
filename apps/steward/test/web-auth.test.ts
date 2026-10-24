// The signed-link login exchange (issue #22, spec §7.3/§12.2, steward.md §10): the /网页
// phrase hands the owner a one-time URL; opening it consumes the token (HMAC verified
// statelessly at the Worker, single-use enforced in the DO), sets the session cookie, and
// redirects. Every probe that fails the stateless checks is answered without waking the DO.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  LINK_TTL_MS,
  mintLinkToken,
  loginLinkPolicyFromEnv,
  parseSessionCookie,
  sessionCookieValue,
  verifyLinkToken,
} from "../src/web.ts";
import {
  configureAndBind,
  messageEvent,
  ownerStub,
  postEvent,
  resetLedgerState,
  waitWhileOutboundPending,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

/** Sends the owner a DM and waits for every outbound row to settle. */
async function ownerDm(text: string): Promise<void> {
  const res = await postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text }));
  expect(res.status).toBe(200);
  await waitWhileOutboundPending();
}

/** The sent texts, decoded. */
async function sentTexts(): Promise<string[]> {
  const rows = await ownerStub().outboundRows(20);
  return rows.filter((r) => r.kind === "text" && r.status === "sent").map((r) => JSON.parse(r.payload as string).text as string);
}

/** Logs in through the real path: /网页 in chat → one-time URL → 303 + session cookie. */
async function loginViaChat(): Promise<{ cookie: string; linkUrl: string }> {
  await ownerDm("/网页");
  const linkUrl = (await sentTexts()).flatMap((t) => [...t.matchAll(/https:\/\/example\.com\/link\/(\S+)/g)].map((m) => m[0])).find(Boolean);
  if (!linkUrl) throw new Error(`no link in replies: ${JSON.stringify(await sentTexts())}`);
  const open = await SELF.fetch(linkUrl, { redirect: "manual" });
  expect(open.status).toBe(303);
  expect(open.headers.get("location")).toBe("/app");
  const setCookie = open.headers.get("set-cookie")!;
  return { cookie: setCookie.split(";")[0]!, linkUrl };
}

describe("link tokens: HMAC, expiry, tampering (pure functions)", () => {
  const SECRET = "test-server-key-not-a-secret";

  it("round-trips a minted token", async () => {
    const { token } = await mintLinkToken(SECRET, "t/t_123");
    const verified = await verifyLinkToken([SECRET], token);
    expect(verified).toMatchObject({ target: "t/t_123" });
  });

  it("rejects tokens signed with a different key, tampered targets, and garbage", async () => {
    const { token } = await mintLinkToken("another-key", "home");
    expect(await verifyLinkToken([SECRET], token)).toBeNull();
    const ok = await mintLinkToken(SECRET, "home");
    const tampered = ok.token.replace("wl1.home.", "wl1.t/t_evil.");
    expect(await verifyLinkToken([SECRET], tampered)).toBeNull();
    expect(await verifyLinkToken([SECRET], "wl1.home.9999999999999.abcdef.0123")).toBeNull();
    expect(await verifyLinkToken([SECRET], null)).toBeNull();
  });

  it("rejects an expired token even though the mac is intact", async () => {
    const past = Date.now() - LINK_TTL_MS - 1;
    const { token } = await mintLinkToken(SECRET, "home", past);
    expect(await verifyLinkToken([SECRET], token)).toBeNull();
  });

  it("old-key links verify against the rotation-window key set", async () => {
    const previous = "the-previous-server-key";
    const { token } = await mintLinkToken(previous, "home");
    expect(await verifyLinkToken(["the-new-server-key"], token)).toBeNull(); // alone: dead
    expect(await verifyLinkToken(["the-new-server-key", previous], token)).toMatchObject({ target: "home" });
  });

  it("parses the preview login policy and embeds its longer expiry", async () => {
    const policy = loginLinkPolicyFromEnv("86400000", "true");
    expect(policy).toEqual({ ttlMs: 24 * 60 * 60_000, singleUse: false });
    const now = Date.now();
    const { token } = await mintLinkToken("test-server-key-not-a-secret", "home", now, policy.ttlMs);
    await expect(verifyLinkToken(["test-server-key-not-a-secret"], token)).resolves.toMatchObject({ expiresAt: now + policy.ttlMs });
  });
});

describe("the Durable Object gate: invalid links never open a session", () => {
  it("answers garbage, tampered, and expired link URLs with the shared login page", async () => {
    for (const token of ["garbage", "wl1.home.1.2.3", `${(await mintLinkToken("wrong-key", "home")).token}`]) {
      const res = await SELF.fetch(`https://example.com/link/${token}`, { redirect: "manual" });
      expect(res.status).toBe(410);
      const html = await res.text();
      expect(html).toContain("This sign-in link is invalid or expired.");
      expect(html).toContain('id="password-form"');
    }
    // Valid shape but long-expired: still rejected statelessly.
    const expired = await mintLinkToken("test-server-key-not-a-secret", "home", Date.now() - LINK_TTL_MS - 1);
    const res = await SELF.fetch(`https://example.com/link/${expired.token}`, { redirect: "manual" });
    expect(res.status).toBe(410);
  });
});

describe("/网页 → one-time link → session cookie → /app", () => {
  it("replies with a one-time URL that logs in and redirects to /app", async () => {
    const { cookie } = await loginViaChat();
    expect(cookie).toMatch(/^sig_session=ws1\.[0-9a-f]{64}\.[0-9a-f]{64}$/);

    const res = await SELF.fetch("https://example.com/app", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('name="viewport"'); // mobile
    expect(html).toContain('id="workspace"'); // the workspace shell (ADR-0004)
    expect(html).toContain("/app/assets/workspace.js");
  });

  it("marks the cookie HttpOnly, SameSite=Lax, Secure, 7-day Max-Age", async () => {
    await ownerDm("/网页");
    const linkUrl = (await sentTexts()).join(" ").match(/https:\/\/example\.com\/link\/\S+/)![0]!;
    const res = await SELF.fetch(linkUrl, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain(`Max-Age=${Math.floor(7 * 24 * 3600)}`);
  });

  it("a link opens exactly once: the second open is spent", async () => {
    const { linkUrl } = await loginViaChat();
    const again = await SELF.fetch(linkUrl, { redirect: "manual" });
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("只能打开一次");
  });

  it("/app without a session opens the shared password-or-passkey login page", async () => {
    for (const path of ["/app", "/app/"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="password-form"');
      expect(html).toContain('id="passkey-signin"');
    }
    const res2 = await SELF.fetch("https://example.com/app", { headers: { cookie: "sig_session=ws1.deadbeef.notamac" } });
    expect(res2.status).toBe(200);
    expect((await SELF.fetch("https://example.com/app/unknown")).status).toBe(404);
  });

  it("a well-formed but unknown session sid falls back to the login page", async () => {
    const fakeSid = "ab".repeat(32);
    const cookie = `sig_session=${await sessionCookieValue("test-server-key-not-a-secret", fakeSid)}`;
    expect(await parseSessionCookie(["test-server-key-not-a-secret"], cookie.split("=")[1]!)).toBe(fakeSid);
    const res = await SELF.fetch("https://example.com/app", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="password-form"');
  });

  it("the SERVER_KEY_PREVIOUS window keeps old-key links and cookies alive; dropping it kills them (issue #27)", async () => {
    const previous = "test-previous-server-key-not-a-secret";
    const { cookie, linkUrl } = await loginViaChat();
    const token = linkUrl.slice("https://example.com/link/".length);
    expect(await verifyLinkToken(["test-server-key-not-a-secret", previous], token)).not.toBeNull();
    expect(await parseSessionCookie(["test-server-key-not-a-secret", previous], cookie.split("=")[1]!)).not.toBeNull();
    expect(await verifyLinkToken([previous], token)).toBeNull();
    expect(await parseSessionCookie([previous], cookie.split("=")[1]!)).toBeNull();
  });
});
