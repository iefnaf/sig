// Fresh deployments have no SERVER_KEY: the owner Durable Object generates its key, and the
// public URL is the complete sign-in surface. This file runs in its own no-SERVER_KEY workerd.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { connectWeb, nextClose, ownerStub } from "./helpers.ts";
import type { Steward } from "../src/steward.ts";

const BASE = "https://example.com";
const PASSWORD = "correct horse battery staple 47!";
const NEW_PASSWORD = "a different long deployment password 82!";

function login(password: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/auth/password`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ password }),
  });
}

async function pairMachine(name: string): Promise<{ token: string; deviceId: string }> {
  const { code } = await ownerStub().createPairing();
  const response = await SELF.fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(async () => {
  await ownerStub().configureBrowserPasswordForTests(PASSWORD);
});

describe("a fresh deployment without SERVER_KEY", () => {
  it("generates and retains a durable internal signing key", async () => {
    expect(env.SERVER_KEY).toBeUndefined();
    const row = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => unknown[] }).sql.bind(instance);
      return (sql`SELECT mode, secret FROM sh_auth_deployment WHERE id = 0` as Array<{ mode: string; secret: string }>)[0]!;
    });
    expect(row.mode).toBe("generated");
    expect(row.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("opens the login page at the deployment root", async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="password-form"');
    expect(html).toContain('id="passkey-signin"');
  });

  it("signs in from a second device with the deployment password", async () => {
    const response = await login(PASSWORD, "203.0.113.10");
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toMatch(/^sig_session=ws1\./);
    const app = await SELF.fetch(`${BASE}/app`, { headers: { cookie: cookie! } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('id="workspace"');
  });

  it("shows the sign-in form for a recent-auth challenge even with a session cookie", async () => {
    const signedIn = await login(PASSWORD, "203.0.113.18");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const normal = await SELF.fetch(`${BASE}/`, { headers: { cookie }, redirect: "manual" });
    expect(normal.status).toBe(303);
    expect(normal.headers.get("location")).toBe("/app");
    const reauth = await SELF.fetch(`${BASE}/?reauth=1&next=%2Fapp`, { headers: { cookie } });
    expect(reauth.status).toBe(200);
    expect(await reauth.text()).toContain('id="password-form"');
  });

  it("requires a fresh sign-in before passkey settings can change", async () => {
    const signedIn = await login(PASSWORD, "203.0.113.19");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const sid = cookie.split(".")[1]!;
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown[] }).sql.bind(instance);
      sql`UPDATE sh_web_session SET createdAt = ${Date.now() - 11 * 60_000} WHERE sid = ${sid}`;
    });
    const workspace = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
    const { csrf } = await workspace.json() as { csrf: string };
    const options = await SELF.fetch(`${BASE}/app/api/settings/webauthn/register/options`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: "{}",
    });
    expect(options.status).toBe(403);
    expect(await options.json()).toEqual({ error: "reauth_required" });
  });

  it("rejects a cross-site password request and an oversized body", async () => {
    const foreign = await SELF.fetch(`${BASE}/auth/password`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(foreign.status).toBe(403);
    const oversized = await SELF.fetch(`${BASE}/auth/password`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", "CF-Connecting-IP": "203.0.113.11" },
      body: JSON.stringify({ password: "x".repeat(9000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("bounds repeated wrong guesses without permanently locking another device", async () => {
    const ip = "203.0.113.12";
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await login("definitely the wrong password", ip)).status).toBe(401);
    }
    const blocked = await login(PASSWORD, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    const passkeyOptions = await SELF.fetch(`${BASE}/webauthn/login/options`, {
      method: "POST",
      headers: { origin: BASE, "CF-Connecting-IP": ip },
    });
    expect(passkeyOptions.status).toBe(200);
    expect((await login(PASSWORD, "203.0.113.13")).status).toBe(200);
    const logs = await ownerStub().channelLogEntries(100);
    expect(logs.some((entry) => entry.reason === "browser_password_failed")).toBe(true);
    expect(logs.some((entry) => entry.reason === "browser_auth_throttled" && entry.detail === "password")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("definitely the wrong password");
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("reserves concurrent password attempts so a burst cannot all reach verification", async () => {
    const ip = "203.0.113.14";
    const responses = await Promise.all(Array.from({ length: 8 }, () => login("wrong password attempt", ip)));
    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
  });

  it("enforces a deployment-wide password budget across source IPs", async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await login("distributed wrong password", `198.51.100.${attempt + 1}`);
      expect(response.status).toBe(401);
    }
    expect((await login(PASSWORD, "198.51.100.250")).status).toBe(429);
  });

  it("revokes browser sessions on password reset but keeps connector credentials and model keys", async () => {
    const signedIn = await login(PASSWORD, "203.0.113.15");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const machine = await pairMachine("reset-probe");
    await ownerStub().setModelConfig("deepseek", "sk-preserved-model-key");
    expect((await SELF.fetch(`${BASE}/app`, { headers: { cookie } })).status).toBe(200);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => unknown }).sql.bind(instance);
      sql`DELETE FROM sh_channel_log`;
    });
    await ownerStub().configureBrowserPasswordForTests(NEW_PASSWORD);

    expect((await ownerStub().channelLogEntries(100)).some((entry) => entry.reason === "browser_password_reset")).toBe(true);

    const oldSession = await SELF.fetch(`${BASE}/app`, { headers: { cookie } });
    expect(oldSession.status).toBe(200);
    expect(await oldSession.text()).toContain('id="password-form"');
    expect((await login(PASSWORD, "203.0.113.16")).status).toBe(401);
    expect((await login(NEW_PASSWORD, "203.0.113.16")).status).toBe(200);
    expect(await ownerStub().modelConfig()).toMatchObject({ provider: "deepseek", apiKey: "sk-preserved-model-key" });

    const connector = await SELF.fetch(`${BASE}/agents/steward/owner?role=connector`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${machine.token}` },
    });
    expect(connector.status).toBe(101);
    connector.webSocket?.accept();
    connector.webSocket?.close();
  });

  it("closes live browser sockets when the deployment password changes", async () => {
    const signedIn = await login(PASSWORD, "203.0.113.17");
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const { ws } = await connectWeb(cookie);
    const closedPromise = nextClose(ws);
    await ownerStub().configureBrowserPasswordForTests(NEW_PASSWORD);
    const closed = await closedPromise;
    expect(closed.code).toBe(4401);
  });

  it("keeps unknown Agent subpaths and unknown public routes closed", async () => {
    for (const path of ["/agents/steward/owner/ws", "/agents/steward/owner/api/messages", "/not-found"]) {
      expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(404);
    }
  });
});
