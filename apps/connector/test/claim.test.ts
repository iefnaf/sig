// claimDeployment (ADR-0004): the connector side of claiming — wrangler's OAuth token, the
// Cloudflare API calls, and the redeem. Everything external is stubbed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { claimDeployment, resolveTarget } from "../src/claim.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shepherd-claim-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const OAUTH = "wrangler-oauth-token";

function ctx(over: Partial<Parameters<typeof claimDeployment>[0]> = {}) {
  const calls: string[] = [];
  const api: Array<{ path: string; body?: unknown }> = [];
  return {
    calls,
    api,
    value: {
      serverUrl: "https://pip.example.workers.dev",
      machineName: "mac-studio",
      log: () => {},
      run: (args: string[]) => {
        calls.push(args.join(" "));
        if (args[0] === "wrangler" && args[1] === "auth" && args[2] === "token") {
          return { status: 0, stdout: JSON.stringify({ type: "oauth", token: OAUTH }), stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "unexpected wrangler call" };
      },
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        api.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.hostname === "api.cloudflare.com") {
          if (url.pathname === "/client/v4/accounts") {
            return Response.json({ success: true, result: [{ id: "acc1", name: "Personal" }] });
          }
          if (url.pathname === "/client/v4/accounts/acc1/workers/domains") {
            return Response.json({ success: true, result: [] }); // a workers.dev route is not a custom domain
          }
          if (url.pathname === "/client/v4/accounts/acc1/workers/services") {
            return Response.json({ success: true, result: [{ id: "pip" }, { id: "other" }] });
          }
          if (url.pathname === "/client/v4/accounts/acc1/workers/scripts/pip/secrets" && init?.method === "PUT") {
            // The Worker's own /pair logic: hash exactly what was written here.
            return Response.json({ success: true, result: {} });
          }
        }
        if (url.origin === "https://pip.example.workers.dev" && url.pathname === "/pair") {
          const body = JSON.parse(String(init?.body)) as { claimProof: string; name: string };
          const written = (api.find((a) => a.path.endsWith("/secrets"))?.body as { text?: string } | undefined)?.text;
          const expected = createHash("sha256").update(written ?? "").digest("hex");
          if (body.claimProof === expected) {
            return Response.json({ deviceId: "dev_new", token: "st1.tok", wsUrl: "wss://pip.example.workers.dev/agents/steward/owner", loginUrl: "https://pip.example.workers.dev/link/wl1.x" });
          }
          return Response.json({ error: "invalid_claim" }, { status: 401 });
        }
        return Response.json({ success: false, errors: [{ message: "unmocked " + url.pathname }] }, { status: 404 });
      }) as typeof fetch,
      ...over,
    } as Parameters<typeof claimDeployment>[0],
  };
}

describe("resolveTarget", () => {
  it("finds the script behind a custom-domain hostname", async () => {
    const c = ctx();
    c.value.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/client/v4/accounts/acc1/workers/domains") {
        return Response.json({ success: true, result: [{ hostname: "pip.example.com", service: "pip" }] });
      }
      if (url.pathname === "/client/v4/accounts") return Response.json({ success: true, result: [{ id: "acc1" }] });
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
    const target = await resolveTarget({ ...c.value, serverUrl: "https://pip.example.com" }, OAUTH);
    expect(target).toEqual({ accountId: "acc1", scriptName: "pip" });
  });

  it("returns null when this account owns no such hostname", async () => {
    const c = ctx();
    const target = await resolveTarget({ ...c.value, serverUrl: "https://other.example.com" }, OAUTH);
    expect(target).toBeNull();
  });
});

describe("resolveTarget (workers.dev)", () => {
  it("resolves <script>.<subdomain>.workers.dev through the account's script list", async () => {
    const c = ctx();
    const target = await resolveTarget(c.value, OAUTH);
    expect(target).toEqual({ accountId: "acc1", scriptName: "pip" });
  });

  it("does not resolve when the account has no script by that name", async () => {
    const c = ctx();
    const target = await resolveTarget({ ...c.value, serverUrl: "https://other-name.gfanfei-94c.workers.dev" }, OAUTH);
    expect(target).toBeNull();
  });
});

describe("claimDeployment", () => {
  it("writes the one-time secret through the API and redeems it", async () => {
    const c = ctx();
    const result = await claimDeployment(c.value);
    expect(result.deviceId).toBe("dev_new");
    expect(result.loginUrl).toMatch(/^https:\/\/pip\.example\.workers\.dev\/link\//);
    // The flow: read token → list accounts → find the domain → write the secret → redeem.
    expect(c.api.map((a) => a.path)).toEqual([
      "/client/v4/accounts",
      "/client/v4/accounts/acc1/workers/domains",
      "/client/v4/accounts/acc1/workers/services",
      "/client/v4/accounts/acc1/workers/scripts/pip/secrets",
      "/pair",
    ]);
    const write = c.api.find((a) => a.path.endsWith("/secrets"))!.body as { name: string; type: string };
    expect(write).toEqual({ name: "SHEPHERD_CLAIM_SECRET", type: "secret_text", text: expect.any(String) });
  });

  it("refuses to continue when wrangler is not logged in with OAuth", async () => {
    const c = ctx();
    c.value.run = () => ({ status: 0, stdout: JSON.stringify({ type: "api_token", token: "x" }), stderr: "" });
    await expect(claimDeployment(c.value)).rejects.toThrow(/wrangler login/);
  });

  it("explains when the URL is not this account's Worker", async () => {
    const c = ctx({ serverUrl: "https://strange.example.com" });
    await expect(claimDeployment(c.value)).rejects.toThrow(/not a Worker in your Cloudflare account/);
  });

  it("surfaces an already-claimed deployment", async () => {
    const c = ctx();
    c.value.fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === "https://pip.example.workers.dev") return Response.json({ error: "already_claimed" }, { status: 403 });
      if (url.pathname === "/client/v4/accounts") return Response.json({ success: true, result: [{ id: "acc1" }] });
      if (url.pathname.includes("/workers/domains")) return Response.json({ success: true, result: [{ hostname: "pip.example.workers.dev", service: "pip" }] });
      if (url.pathname.endsWith("/secrets")) return Response.json({ success: true, result: {} });
      return Response.json({}, { status: 404 });
    }) as typeof fetch;
    await expect(claimDeployment(c.value)).rejects.toThrow(/already claimed/);
  });
});
