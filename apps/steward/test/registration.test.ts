// Unit tests for the device-flow client (issue #24): addons encoding parity with the official
// SDK's `encodeAddons` (the golden vector below was produced by the SDK pipeline itself —
// node:zlib is unavailable inside workerd, so parity is pinned instead of recomputed), the
// begin-parameter shape, and poll-outcome classification.
import { describe, expect, it } from "vitest";
import { APP_CONFIG_PATCH_SCOPE, beginDeviceFlow, encodeAddons, pollDeviceFlow } from "../src/channel/registration.ts";

const ADDONS_SCOPE_VECTOR =
  "H4sIAAAAAAAAE6tWKk7OL0gtVrKqVipJzUvMK1GyilZKLCjIyUxOLMnMz7NCZhckliRnKMXW1gIAR9dnbTcAAAA";

/** base64url (unpadded) → bytes. */
function b64urlToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parity with the SDK's `encodeAddons`: the deflate payload (bytes after the 10-byte gzip
 * header) must match byte-for-byte; the header's OS byte is runtime-dependent (node zlib
 * writes 3, workerd's CompressionStream writes 255) and any conforming gzip stream decodes
 * identically on Feishu's side, so it is deliberately not compared.
 */
async function expectAddonsParity(encoded: string): Promise<void> {
  const ours = b64urlToBytes(encoded);
  const vector = b64urlToBytes(ADDONS_SCOPE_VECTOR);
  expect(Array.from(ours.slice(10))).toEqual(Array.from(vector.slice(10)));
  const json = await new Response(new Blob([ours as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  expect(JSON.parse(json)).toEqual({ scopes: { tenant: ["application:application:patch"] } });
}

function formHandler(reply: (params: URLSearchParams) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const req = new Request(input);
    const params = new URLSearchParams(await req.text());
    return Response.json(reply(params) as Record<string, unknown>);
  }) as typeof fetch;
}

describe("encodeAddons (SDK pipeline parity)", () => {
  it("produces the SDK's gzip+base64url encoding for the scope top-up", async () => {
    await expectAddonsParity(await encodeAddons({ scopes: { tenant: [APP_CONFIG_PATCH_SCOPE] } }));
  });

  it("round-trips only through the whitelisted public fields and rejects the rest", async () => {
    // Sensitive manifest fields must fail loudly, not silently drop (SDK parity).
    await expect(encodeAddons({ preset: true, scopes: undefined } as never)).rejects.toThrow(/at least one/);
    await expect(encodeAddons({ events: { request_url: "https://x" } } as never)).rejects.toThrow(/not allowed/);
    await expect(encodeAddons({ scopes: { tenant: [""] } })).rejects.toThrow(/non-empty/);
  });
});

describe("beginDeviceFlow", () => {
  it("posts the RFC-fixed parameters and decorates the QR URL with prefills", async () => {
    const fetcher = formHandler(() => ({
      device_code: "dc_1",
      verification_uri_complete: "https://feishu.invalid/qr?dc=dc_1",
      user_code: "ABCD",
      interval: 7,
      expires_in: 600,
    }));
    const res = await beginDeviceFlow({
      fetcher,
      preset: { name: "label·Shepherd", desc: "d" },
      createOnly: true,
      now: () => 1_000_000,
    });
    expect(res.deviceCode).toBe("dc_1");
    expect(res.intervalS).toBe(7);
    expect(res.expiresAt).toBe(1_000_000 + 600_000);
    const qr = new URL(res.qrUrl);
    expect(qr.searchParams.get("name")).toBe("label·Shepherd");
    expect(qr.searchParams.get("createOnly")).toBe("true");
    // The literal "true" only: absent means the default page flow.
    const noCreate = await beginDeviceFlow({ fetcher, createOnly: false, now: () => 0 });
    expect(new URL(noCreate.qrUrl).searchParams.get("createOnly")).toBeNull();
  });

  it("targets an existing app via clientID for the update flow", async () => {
    const fetcher = formHandler(() => ({
      device_code: "dc_2",
      verification_uri_complete: "https://feishu.invalid/qr?dc=dc_2",
      user_code: "ABCD",
      interval: 5,
      expires_in: 600,
    }));
    const res = await beginDeviceFlow({ fetcher, clientId: "cli_x", addons: { scopes: { tenant: [APP_CONFIG_PATCH_SCOPE] } }, now: () => 0 });
    const qr = new URL(res.qrUrl);
    expect(qr.searchParams.get("clientID")).toBe("cli_x");
    await expectAddonsParity(qr.searchParams.get("addons")!);
  });
});

describe("pollDeviceFlow outcome classification", () => {
  const poll = (body: unknown) =>
    pollDeviceFlow({ fetcher: formHandler(() => body), deviceCode: "dc", brand: "feishu" });

  it("maps pending, slow_down, denied, expired, and unknown errors", async () => {
    expect(await poll({ error: "authorization_pending" })).toEqual({ status: "pending", brand: undefined, openId: undefined });
    expect(await poll({ error: "slow_down" })).toEqual({ status: "slow_down", brand: undefined });
    expect(await poll({ error: "access_denied" })).toEqual({ status: "denied", brand: undefined });
    expect(await poll({ error: "expired_token" })).toEqual({ status: "expired", brand: undefined });
    expect(await poll({ error: "server_is_sad", error_description: "very" })).toEqual({
      status: "failed",
      message: "server_is_sad: very",
      brand: undefined,
    });
  });

  it("carries the scanner identity and tenant brand on success", async () => {
    expect(
      await poll({ client_id: "cli_x", client_secret: "s", user_info: { open_id: "ou_1", tenant_brand: "lark" } }),
    ).toEqual({ status: "success", appId: "cli_x", appSecret: "s", openId: "ou_1", brand: "lark" });
    // The update flow may confirm without rotating the secret.
    expect(await poll({ client_id: "cli_x", user_info: { open_id: "ou_1", tenant_brand: "feishu" } })).toEqual({
      status: "success",
      appId: "cli_x",
      openId: "ou_1",
      brand: "feishu",
    });
    // A lark brand can surface before completion — that is the domain-switch signal.
    expect(await poll({ error: "authorization_pending", user_info: { tenant_brand: "lark" } })).toMatchObject({
      status: "pending",
      brand: "lark",
    });
  });
});
