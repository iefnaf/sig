// The browser/machine side of the claim tests (ADR-0004): the claim secret stands in for what
// `shepherd connect` writes through the Cloudflare API, and the one-time link is the way a
// browser signs in — minted by a paired machine, exactly as `shepherd login` does.
import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import { createHash } from "node:crypto";

export const BASE = "https://example.com";

/** SHA-256 of the bound SHEPHERD_CLAIM_SECRET — what a real connect run sends. */
export async function claimProof(): Promise<string> {
  return createHash("sha256").update(env.SHEPHERD_CLAIM_SECRET ?? "").digest("hex");
}

export interface Machine {
  deviceId: string;
  token: string;
}

/** Claims through /pair exactly as the connector CLI does. */
export async function claim(name = "mac-studio"): Promise<{ machine: Machine; loginUrl: string | null }> {
  const res = await SELF.fetch(`${BASE}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimProof: await claimProof(), name }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceId: string; token: string; loginUrl: string | null };
  return { machine: { deviceId: body.deviceId, token: body.token }, loginUrl: body.loginUrl };
}

/** What a signed-in browser sends with every request. */
export interface Browser {
  cookie: string;
  csrf: string;
  headers(extra?: Record<string, string>): Record<string, string>;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, extra?: Record<string, string>): Promise<Response>;
  json<T = Record<string, any>>(path: string): Promise<T>;
}

/** Opens a one-time link (the way every browser session starts now) and reads the CSRF token. */
export async function signIn(link: string): Promise<Browser> {
  const open = await SELF.fetch(link, { redirect: "manual" });
  expect(open.status).toBe(303);
  const cookie = open.headers.get("set-cookie")!.split(";")[0]!;
  const browser: Browser = {
    cookie,
    csrf: "",
    headers: (extra = {}) => ({ cookie, ...extra }),
    get: (path) => SELF.fetch(`${BASE}${path}`, { headers: browser.headers() }),
    post: (path, body, extra = {}) =>
      SELF.fetch(`${BASE}${path}`, {
        method: "POST",
        headers: browser.headers({ "content-type": "application/json", "x-csrf-token": browser.csrf, origin: BASE, ...extra }),
        body: JSON.stringify(body),
      }),
    json: async (path) => (await browser.get(path)).json(),
  };
  browser.csrf = (await browser.json<{ csrf: string }>("/app/api/workspace")).csrf;
  return browser;
}

/** A one-time link minted on a paired machine — the `shepherd login` path. */
export async function loginLink(machine: Machine): Promise<string> {
  const res = await SELF.fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${machine.token}` },
    body: "{}",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

/** Polls `get` until `pred` holds. */
export async function waitFor<T>(get: () => T | Promise<T>, pred: (value: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (pred(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not reached (${what}): ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
