// Routes audit (issue #27): the ONLY unauthenticated entry points are POST /pair, the Feishu
// webhook, and the setup page before owner binding (ADR-0001 decisions 7-8). Everything else
// must be walled — 401/404 at the Worker, or an SDK error for unknown bindings — for any
// request that arrives without a valid device token. This test sweeps a route/method matrix
// so a newly added route fails here before it ships.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  connect,
  configureAndBind,
  ownerStub,
  pairDevice,
  resetChannelState,
  SETUP_URL,
  submitSetupCredentials,
  urlVerification,
} from "./helpers.ts";

const BASE = "https://example.com";
const SETUP_TOKEN = "test-setup-token-not-a-secret";

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
  "/agents/steward/owner/channels/feishu/events",
  "/agents/steward/owner/agents/steward/owner",
  "/agents/other/owner",
  "/favicon.ico",
  "/pair", // GET/PUT/... — only POST is the entry point
  "/setup", // without the token below
  "/channels/feishu/events", // GET — only POST is the entry point
];

const METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;

describe("routes audit: no unauthenticated surface beyond the documented entry points (issue #27)", () => {
  beforeEach(async () => {
    await resetChannelState();
  });

  it("every probed route/method without credentials is walled (no 2xx, no redirects)", async () => {
    for (const path of PROBE_PATHS) {
      for (const method of METHODS) {
        // POST /pair and POST /channels/feishu/events are the documented entry points —
        // probed for reachability in the dedicated assertions below.
        if (path === "/pair" && method === "POST") continue;
        if (path === "/channels/feishu/events" && method === "POST") continue;
        const res = await request(path, { method, body: method === "GET" || method === "OPTIONS" ? undefined : "{}" });
        const reachable = res.ok || (res.status >= 300 && res.status < 400);
        expect(reachable, `${method} ${path} -> ${res.status}`).toBe(false);
      }
    }
  });

  it("the WebSocket agent route requires a valid device token at the Worker pre-check", async () => {
    expect((await connect(null)).status).toBe(401);
    expect((await connect("st1.deadbeef.dev_nope.1.1." + "0".repeat(64))).status).toBe(401);
    // …and a real token upgrades: the wall is the auth, not a missing route.
    const { token } = await pairDevice("audit-probe");
    expect((await connect(token)).status).toBe(101);
  });

  it("WebSocket upgrades on agent subpaths cannot bypass the pre-check", async () => {
    for (const path of ["/agents/steward/owner/", "/agents/steward/owner/ws", "/agents/steward/owner/pair", "/agents/steward/owner/channels/feishu/events"]) {
      const res = await request(path, { headers: { Upgrade: "websocket" } });
      expect(res.status, path).toBe(401);
    }
  });

  it("POST /pair is reachable unauthenticated (the documented pairing entry point)", async () => {
    const res = await request("/pair", { method: "POST", body: JSON.stringify({ code: "BADCODE1", name: "x" }) });
    expect(res.status).toBe(400); // served: invalid code — not 401/404
    expect(((await res.json()) as { error: string }).error).toBe("invalid code");
  });

  it("the Feishu webhook is reachable unauthenticated but enforces Feishu's own token", async () => {
    await submitSetupCredentials();
    expect((await urlVerification()).status).toBe(200); // entry point served…
    expect((await urlVerification("wrong-token")).status).toBe(401); // …with its own verification
  });

  it("the setup page opens only with SETUP_TOKEN, only before owner binding", async () => {
    expect((await request("/setup")).status).toBe(404);
    expect((await request(`/setup?token=wrong-${SETUP_TOKEN}`)).status).toBe(404);
    expect((await request(`/setup?token=${SETUP_TOKEN}`)).status).toBe(200); // pre-binding: open
    expect((await request(`/setup?token=${SETUP_TOKEN}`, { method: "POST", body: new URLSearchParams({ appId: "a", appSecret: "b", verificationToken: "c" }) })).status).toBe(200);

    // Once the owner is bound the page closes permanently — token or not (ADR-0001 decision 8).
    await configureAndBind("ou_audit_owner");
    expect((await request(`/setup?token=${SETUP_TOKEN}`)).status).toBe(404);
    expect((await ownerStub().setupState()).state).toBe("bound");
  });
});
