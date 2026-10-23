// Routes audit (issue #27 + ADR-0010): public entry points are the login page, its script,
// the brand assets, POST /pair, and the password/passkey authentication endpoints. The owner
// API answers only to an explicit SERVER_KEY; every other route must stay walled. This sweep
// makes a new accidental public route fail before it ships.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { connect, ownerStub, pairDevice, resetChannelState } from "./helpers.ts";

const BASE = "https://example.com";
const API_KEY = "test-server-key-not-a-secret";
const AUTH = { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" } as Record<string, string>;

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init);
}

/** Every path the Worker or the agents SDK could possibly serve, probed without credentials. */
const PROBE_PATHS = [
  "/",
  "/admin",
  "/agents",
  "/agents/steward",
  "/agents/steward/owner",
  "/agents/steward/owner/",
  "/agents/steward/owner/ws",
  "/agents/steward/owner/pair",
  "/agents/steward/owner/setup",
  "/agents/steward/owner/api/messages",
  "/agents/steward/owner/agents/steward/owner",
  "/agents/other/owner",
  "/favicon.ico",
  "/pair", // GET/PUT/... — only POST is the entry point
  "/api", // not a route
  "/api/", // not a route
  "/api/bogus", // unknown api route
  "/api/messages/sub", // subpaths are not api routes
  "/api/messages", // probed for auth in the dedicated assertions below
  "/api/actions",
  "/api/pairing",
  "/api/login-link",
  "/app/unknown", // unknown app pages are not a login-gated route index
  "/setup", // removed with the Feishu channel (ADR-0003) — stays a 404 forever
  "/channels/feishu/events", // removed with the Feishu channel (ADR-0003) — stays a 404 forever
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] as const;

describe("routes audit: no unauthenticated surface beyond the documented entry points (issue #27, ADR-0003)", () => {
  beforeEach(async () => {
    await resetChannelState();
  });

  it("every probed route/method without credentials is walled (no 2xx, no redirects)", async () => {
    for (const path of PROBE_PATHS) {
      for (const method of METHODS) {
        if (path === "/") {
          if (method === "GET" || method === "HEAD") {
            const page = await request(path, { method });
            expect(page.status).toBe(200);
            if (method === "GET") expect(await page.text()).toContain('id="password-form"');
          } else {
            expect((await request(path, { method })).status).toBe(404);
          }
          continue;
        }
        // POST /pair is the documented entry point — probed for reachability below.
        if (path === "/pair" && method === "POST") continue;
        // The four /api/* routes are served WITH the key (the dedicated auth test covers
        // both faces); every other /api/* path must 404/401 even keyed.
        if (path === "/api/messages" && (method === "GET" || method === "POST")) continue;
        if (path === "/api/actions" && method === "POST") continue;
        if (path === "/api/pairing" && method === "POST") continue;
        if (path === "/api/login-link" && method === "POST") continue;
        // /api/messages GET+POST are served WITH the key below; without it they must 401.
        const res = await request(path, { method, headers: AUTH, body: method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : "{}" });
        const unauthorized = await request(path, {
          method,
          body: method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : "{}",
        });
        for (const probe of [res, unauthorized]) {
          const reachable = probe.ok || (probe.status >= 300 && probe.status < 400);
          expect(reachable, `${method} ${path} [keyed: ${res === probe}] -> ${probe.status}`).toBe(false);
        }
      }
    }
  });

  it("the owner API answers only to the SERVER_KEY bearer (ADR-0003)", async () => {
    // Wrong key, no key: 401, and the Durable Object is never asked (no inbound row).
    for (const headers of [undefined, { Authorization: "Bearer wrong-key", "content-type": "application/json" }]) {
      expect((await request("/api/messages", { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).status).toBe(401);
      expect((await request("/api/messages", { method: "GET", headers })).status).toBe(401);
      expect((await request("/api/actions", { method: "POST", headers, body: "{}" })).status).toBe(401);
      expect((await request("/api/pairing", { method: "POST", headers })).status).toBe(401);
      expect((await request("/api/login-link", { method: "POST", headers })).status).toBe(401);
    }
    // The old SETUP_TOKEN-style query param is not a thing anymore: the key rides the header.
    expect((await request(`/api/messages?key=${API_KEY}`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(401);

    // With the key: served. A malformed body is a 400 from the DO (it was woken), not a 401.
    expect((await request("/api/messages", { method: "POST", headers: AUTH, body: JSON.stringify({ text: "hi" }) })).status).toBe(200);
    expect((await request("/api/messages", { method: "POST", headers: AUTH, body: "not json" })).status).toBe(400);
    const listed = await request("/api/messages", { method: "GET", headers: AUTH });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { messages: unknown[] }).messages).toBeDefined();
    // SERVER_KEY_PREVIOUS also gates the API through a rotation window (issue #27).
    const prev = { Authorization: "Bearer test-previous-server-key-not-a-secret", "content-type": "application/json" };
    expect((await request("/api/login-link", { method: "POST", headers: prev })).status).toBe(200);
  });

  it("the WebSocket agent route requires a valid device token at the Worker pre-check", async () => {
    expect((await connect(null)).status).toBe(401);
    expect((await connect("st1.deadbeef.dev_nope.1.1." + "0".repeat(64))).status).toBe(401);
    // …and a real token upgrades: the wall is the auth, not a missing route.
    const { token } = await pairDevice("audit-probe");
    expect((await connect(token)).status).toBe(101);
  });

  it("WebSocket upgrades on agent subpaths cannot bypass the pre-check", async () => {
    for (const path of ["/agents/steward/owner/", "/agents/steward/owner/ws", "/agents/steward/owner/pair", "/agents/steward/owner/api/messages"]) {
      const res = await request(path, { headers: { Upgrade: "websocket" } });
      expect(res.status, path).toBe(404);
    }
  });

  it("POST /pair is reachable unauthenticated (the documented pairing entry point)", async () => {
    const res = await request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "BADCODE1", name: "x" }),
    });
    expect(res.status).toBe(400); // served: invalid code — not 401/404
    expect(((await res.json()) as { error: string }).error).toBe("invalid code");
  });

  it("serves the public logo and avatar without a session, with no channel side effects", async () => {
    const logo = await request("/brand/sig.svg");
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/svg+xml");
    expect(await logo.text()).toContain("<svg");
    const avatar = await request("/brand/sig-avatar.png");
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await avatar.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const path of ["/brand/sig.svg", "/brand/sig-avatar.png"]) {
      const head = await request(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }
    expect((await ownerStub().channelLogEntries(1)).length).toBe(0);
  });
});
