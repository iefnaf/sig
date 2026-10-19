// ADR-0004's doors, end to end: a fresh deployment is a page with no input and no way in;
// the first machine claims it by proving it just wrote a secret through Cloudflare's API;
// every later browser signs in with a machine-minted one-time link. Nothing else opens.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Steward } from "../src/steward.ts";
import { resetLedgerState, pairFakeConnector, waitRunsSettled } from "./helpers.ts";
import { BASE, claim, claimProof, loginLink, signIn, waitFor, type Machine } from "./claim-helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
});

describe("the front door", () => {
  it("shows a sign-in page with no input, and no API opens, before any session exists", async () => {
    const page = await SELF.fetch(`${BASE}/app`);
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain("shepherd login");
    expect(html).not.toMatch(/<input|<form/i);
    for (const path of ["/app/api/workspace", "/app/api/settings", "/app/assets/workspace.js"]) {
      expect((await SELF.fetch(`${BASE}${path}`)).status, path).toBe(401);
    }
    expect((await SELF.fetch(`${BASE}/app/ws`, { headers: { Upgrade: "websocket" } })).status).toBe(401);
    for (const path of ["/", "/setup"]) {
      const res = await SELF.fetch(`${BASE}${path}`, { redirect: "manual" });
      expect(res.status).toBe(303);
    }
    expect((await SELF.fetch(`${BASE}/channels/feishu/events`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/link/wl1.home.1.2.3`)).status).toBe(410);
  });

  it("keeps the old doors for machines and nothing else", async () => {
    // /pair with a code (machines added from the workspace) still answers; role fencing is
    // exercised further down with a real device credential.
    expect((await SELF.fetch(`${BASE}/pair`, { method: "POST", body: JSON.stringify({ code: "nope", name: "x" }) })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/pair`)).status).toBe(404); // GET only
    expect((await SELF.fetch(`${BASE}/agents/steward/owner/anything`)).status).toBe(404);
  });
});

describe("claiming (the first machine)", () => {
  it("rejects every proof that is not the hash of the secret the connector just wrote", async () => {
    const good = await claimProof();
    for (const proof of ["not-a-proof", "", "0".repeat(63), good.slice(0, -2) + "zz"]) {
      const res = await SELF.fetch(`${BASE}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimProof: proof, name: "x" }) });
      expect(res.status, JSON.stringify(proof)).toBe(401);
    }
  });

  it("claims once: the machine pairs, gets a login link, and later claims are refused", async () => {
    const { machine, loginUrl } = await claim("mac-studio");
    expect(machine.deviceId).toMatch(/^dev_[0-9a-f]{12}$/);
    expect(loginUrl).toMatch(new RegExp(`^${BASE}/link/wl1\\.`));

    // The deployment is claimed: a second claim attempt with the same (still-bound) secret fails.
    const again = await SELF.fetch(`${BASE}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimProof: await claimProof(), name: "sneaky" }),
    });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toBe("already_claimed");
  });

  it("mints the login link only for a device credential the deployment trusts", async () => {
    const { machine } = await claim();
    expect((await SELF.fetch(`${BASE}/login`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/login`, { method: "POST", headers: { authorization: "Bearer st1.bogus" }, body: "{}" })).status).toBe(401);
    const link = await loginLink(machine);
    expect(link).toMatch(/^https:\/\/example\.com\/link\/wl1\./);
  });
});

describe("a browser session", () => {
  it("signs in through a one-time link exactly once, and the workspace opens", async () => {
    const { loginUrl } = await claim();
    const browser = await signIn(loginUrl!);
    const page = await browser.get("/app");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await page.text()).replace(/^/, "")).toContain('id="workspace"');

    const snapshot = await browser.json<{ threads: unknown[]; machines: unknown[]; csrf: string }>("/app/api/workspace");
    expect(snapshot.machines).toHaveLength(1);
    expect(snapshot.csrf).toMatch(/^[0-9a-f]{64}$/);

    // The link is spent: opening it again explains so.
    const spent = await SELF.fetch(loginUrl!, { redirect: "manual" });
    expect(spent.status).toBe(410);
  });

  it("protects every change with the session's CSRF token, a same-origin request and a JSON body", async () => {
    const { machine } = await claim();
    const browser = await signIn(await loginLink(machine));
    const message = { id: "csrf-check-001", text: "hello" };
    const send = (extra: Record<string, string>, body: string = JSON.stringify(message)) =>
      SELF.fetch(`${BASE}/app/api/messages`, { method: "POST", headers: browser.headers({ "content-type": "application/json", ...extra }), body });
    expect((await send({ origin: BASE })).status).toBe(403); // no CSRF token
    expect((await send({ origin: BASE, "x-csrf-token": "0".repeat(64) })).status).toBe(403);
    expect((await send({ "x-csrf-token": browser.csrf })).status).toBe(403); // no Origin
    expect((await send({ "x-csrf-token": browser.csrf, origin: "https://evil.example" })).status).toBe(403);
    expect((await send({ "x-csrf-token": browser.csrf, origin: BASE, "content-type": "text/plain" })).status).toBe(415);
    expect((await send({ "x-csrf-token": browser.csrf, origin: BASE }, "not json")).status).toBe(400);
  });

  it("signs out: the session ends, its sockets close, and the cookie is cleared", async () => {
    const { machine } = await claim();
    const browser = await signIn(await loginLink(machine));
    const socket = await SELF.fetch(`${BASE}/app/ws?view=workspace`, { headers: { Upgrade: "websocket", ...browser.headers(), origin: BASE } });
    expect(socket.status).toBe(101);
    const ws = socket.webSocket!;
    ws.accept();
    const closed = new Promise<number>((resolve) => ws.addEventListener("close", (e) => resolve((e as CloseEvent).code)));
    const out = await browser.post("/app/api/logout", {});
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await closed).toBe(4401);
    expect((await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie: browser.cookie } })).status).toBe(401);
    await waitRunsSettled();
  });
});

describe("machines after the claim", () => {
  it("use the workspace pairing code as before, and the socket takes the device credential", async () => {
    const first = await claim();
    // A second machine joins through a workspace-minted pairing code (the pre-existing path).
    const browser = await signIn(first.loginUrl!);
    const pairing = (await (await browser.post("/app/api/pairing", { id: "pair-request-0001" })).json()) as { code: string };
    const second = await SELF.fetch(`${BASE}/pair`, { method: "POST", body: JSON.stringify({ code: pairing.code, name: "laptop" }) });
    expect(second.status).toBe(200);
    const device = (await second.json()) as { token: string };
    const connectWith = (headers: Record<string, string>, query = "?role=connector") =>
      SELF.fetch(`${BASE}/agents/steward/owner${query}`, { headers: { Upgrade: "websocket", ...headers } });
    expect((await connectWith({})).status).toBe(401);
    expect((await connectWith({ authorization: `Bearer ${device.token}` }, "?role=web")).status).toBe(403);
    const accepted = await connectWith({ authorization: `Bearer ${device.token}` });
    expect(accepted.status).toBe(101);
    accepted.webSocket!.accept();
    accepted.webSocket!.close();
    await waitRunsSettled();
  });
});

describe("a fresh deployment's own keys", () => {
  it("works with no env SERVER_KEY at all: the DO mints under its own auth root", async () => {
    await runInDurableObject(env.Steward.get(env.Steward.idFromName("owner")), async (instance: Steward) => {
      const keys = await instance.authKeys();
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys[0]!.secret).toMatch(/^[0-9a-f]{64}$/); // the generated auth root
    });
    // And the whole suite above is the end-to-end proof: link → session → workspace with no
    // env key anywhere. (rotation.test.ts covers merging a legacy env key when one exists.)
  });
});
