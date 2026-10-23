// WebAuthn/passkey login end to end (candidate-2 design, synthesis grafts): the owner
// registers a passkey from an open session, then signs in with it from a fresh, sessionless
// request the same way a browser would — through the real Worker routes and the real Durable
// Object, with a software authenticator (real P-256 keys, real CBOR, real DER signatures)
// standing in for the browser + platform authenticator. webauthn.test.ts already covers the
// protocol-verification functions in isolation; this file covers the HTTP/session/DB wiring
// around them: single-use challenges, RP ID binding, sign-count regression, and remove.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { mintWebauthnChallenge, WEBAUTHN_CHALLENGE_TTL_MS } from "../src/web.ts";
import { configureAndBind, ownerStub, resetLedgerState, webLogin } from "./helpers.ts";
import type { Steward } from "../src/steward.ts";

const BASE = "https://example.com";
const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const SERVER_KEY = "test-server-key-not-a-secret";
let testIp = "";
let ipCounter = 0;

beforeEach(async () => {
  testIp = `198.18.0.${++ipCounter}`;
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => unknown }).sql.bind(instance);
    sql`DELETE FROM sh_auth_limit`;
  });
});

interface Settings {
  model: unknown;
  passkeys: Array<{ credentialId: string; label: string; transports: string[]; createdAt: number; lastUsedAt: number | null }>;
}

/** A signed-in browser: the cookie, the CSRF token, and a mutation poster that carries both. */
async function browser() {
  const cookie = await webLogin();
  const workspace = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as { csrf: string };
  const csrf = workspace.csrf;
  const post = (path: string, body: unknown = {}) =>
    SELF.fetch(`${BASE}/app/api/${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
  const get = async (path: string) => (await SELF.fetch(`${BASE}/app/api/${path}`, { headers: { cookie } })).json();
  return { cookie, csrf, post, get, settings: () => get("settings") as Promise<Settings> };
}

type Bytes = Uint8Array<ArrayBuffer>;
type Cbor = Parameters<typeof isoCBOR.encode>[0];

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function derEncodeEcdsaSignature(raw: Bytes): Bytes {
  const r = raw.slice(0, 32);
  const s = raw.slice(32, 64);
  const encodeInt = (bytes: Bytes): Bytes => {
    let trimmed = bytes;
    while (trimmed.length > 1 && trimmed[0] === 0 && (trimmed[1]! & 0x80) === 0) trimmed = trimmed.slice(1);
    const needsPad = (trimmed[0]! & 0x80) !== 0;
    const body = needsPad ? Uint8Array.from([0, ...trimmed]) : trimmed;
    return Uint8Array.from([0x02, body.length, ...body]);
  };
  const rEnc = encodeInt(r);
  const sEnc = encodeInt(s);
  const body = Uint8Array.from([...rEnc, ...sEnc]);
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** A minimal software authenticator: real P-256 keys, real CBOR, real ECDSA signatures — the
 *  same shapes a genuine browser + platform authenticator would produce. `rpId` is settable
 *  per call so a test can forge a credential signed under a different RP ID than the one the
 *  HTTP request actually targets. */
async function makeFakeAuthenticator() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const x = rawPublicKey.slice(1, 33);
  const y = rawPublicKey.slice(33, 65);
  const coseKey = isoCBOR.encode(
    new Map<number, number | Bytes>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const credentialIdB64 = isoBase64URL.fromBuffer(credentialId);

  async function authenticatorData(opts: { signCount: number; attestedCredential?: boolean; rpId?: string }): Promise<Bytes> {
    const rpIdHash = await sha256(new TextEncoder().encode(opts.rpId ?? RP_ID));
    const flags = 0x01 | (opts.attestedCredential ? 0x40 : 0);
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, opts.signCount, false);
    const head = Uint8Array.from([...rpIdHash, flags, ...counter]);
    if (!opts.attestedCredential) return head;
    const aaguid = new Uint8Array(16);
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, credentialId.length, false);
    return Uint8Array.from([...head, ...aaguid, ...idLen, ...credentialId, ...coseKey]);
  }

  async function sign(data: Bytes): Promise<Bytes> {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, data));
    return derEncodeEcdsaSignature(raw);
  }

  async function registrationAttestation(challenge: string, opts: { rpId?: string; origin?: string; signCount?: number } = {}) {
    const clientDataJSON = isoBase64URL.fromUTF8String(
      JSON.stringify({ type: "webauthn.create", challenge, origin: opts.origin ?? ORIGIN, crossOrigin: false }),
    );
    const authData = await authenticatorData({ signCount: opts.signCount ?? 0, attestedCredential: true, rpId: opts.rpId });
    const cbor = isoCBOR.encode(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { clientDataJSON, attestationObject: isoBase64URL.fromBuffer(cbor) };
  }

  async function assertion(challenge: string, signCount: number, opts: { rpId?: string; origin?: string } = {}) {
    const clientDataJSON = isoBase64URL.fromUTF8String(
      JSON.stringify({ type: "webauthn.get", challenge, origin: opts.origin ?? ORIGIN, crossOrigin: false }),
    );
    const authData = await authenticatorData({ signCount, rpId: opts.rpId });
    const clientDataHash = await sha256(isoBase64URL.toBuffer(clientDataJSON));
    const signedData = Uint8Array.from([...authData, ...clientDataHash]);
    const signature = await sign(signedData);
    return {
      credentialId: credentialIdB64,
      clientDataJSON,
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(signature),
    };
  }

  return { credentialIdB64, registrationAttestation, assertion };
}

interface RegisterOptions {
  challenge: string;
  challengeToken: string;
  rpId: string;
  userId: string;
  excludeCredentials: { id: string; transports: string[] }[];
}

/** Registers a fresh passkey for the already-signed-in `browser()` and returns its authenticator. */
async function registerPasskey(session: Awaited<ReturnType<typeof browser>>, label = "MacBook Pro") {
  const auth = await makeFakeAuthenticator();
  const options = (await (await session.post("settings/webauthn/register/options")).json()) as RegisterOptions;
  const attestation = await auth.registrationAttestation(options.challenge);
  const verify = await session.post("settings/webauthn/register/verify", { challengeToken: options.challengeToken, ...attestation, label });
  expect(verify.status).toBe(200);
  return auth;
}

interface LoginOptions {
  challenge: string;
  challengeToken: string;
  rpId: string;
}

async function loginOptions(): Promise<LoginOptions> {
  const res = await SELF.fetch(`${BASE}/webauthn/login/options`, { method: "POST", headers: { origin: ORIGIN, "CF-Connecting-IP": testIp } });
  expect(res.status).toBe(200);
  return (await res.json()) as LoginOptions;
}

describe("registering a passkey from an open session", () => {
  it("stores the credential and lists it in settings", async () => {
    const session = await browser();
    expect((await session.settings()).passkeys).toEqual([]);
    const auth = await registerPasskey(session, "MacBook Pro");
    const passkeys = (await session.settings()).passkeys;
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]).toMatchObject({ credentialId: auth.credentialIdB64, label: "MacBook Pro", lastUsedAt: null });
  });

  it("rejects a registration whose challenge was minted for a different session (defense in depth alongside CSRF)", async () => {
    const session = await browser();
    const auth = await makeFakeAuthenticator();
    const foreign = await mintWebauthnChallenge(SERVER_KEY, "register", "someone-elses-sid");
    const attestation = await auth.registrationAttestation(foreign.challenge);
    const res = await session.post("settings/webauthn/register/verify", { challengeToken: foreign.token, ...attestation, label: "x" });
    expect(res.status).toBe(400);
  });
});

/** The full two-leg login ceremony against one already-registered authenticator. */
async function signIn(auth: { assertion: (challenge: string, signCount: number, opts?: { rpId?: string; origin?: string }) => Promise<Record<string, string>> }, signCount: number, opts: { host?: string } = {}) {
  const host = opts.host ?? BASE;
  const optionsRes = await SELF.fetch(`${host}/webauthn/login/options`, { method: "POST", headers: { origin: host, "CF-Connecting-IP": testIp } });
  const options = (await optionsRes.json()) as LoginOptions;
  const assertion = await auth.assertion(options.challenge, signCount);
  const verify = await SELF.fetch(`${host}/webauthn/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: host, "CF-Connecting-IP": testIp },
    body: JSON.stringify({ challengeToken: options.challengeToken, ...assertion }),
  });
  return verify;
}

describe("signing in with a passkey (full ceremony)", () => {
  it("issues the same session cookie shape the link flow issues", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    const verify = await signIn(auth, 1);
    expect(verify.status).toBe(200);
    const setCookie = verify.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^sig_session=ws1\.[0-9a-f]{64}\.[0-9a-f]{64}/);
    expect(setCookie).toContain("HttpOnly");

    // The new cookie opens the workspace exactly like a link-issued one.
    const cookie = setCookie.split(";")[0]!;
    const opened = await SELF.fetch(`${BASE}/app`, { headers: { cookie } });
    expect(opened.status).toBe(200);
  });

  it("rejects a replayed login challenge", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    const options = await loginOptions();
    const assertion = await auth.assertion(options.challenge, 1);
    const body = JSON.stringify({ challengeToken: options.challengeToken, ...assertion });
    const first = await SELF.fetch(`${BASE}/webauthn/login/verify`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp }, body });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`${BASE}/webauthn/login/verify`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp }, body });
    expect(second.status).toBe(409);
  });

  it("keeps a used assertion unusable after a deployment password reset", async () => {
    await ownerStub().configureBrowserPasswordForTests("an earlier owner password 41!");
    const session = await browser();
    const auth = await registerPasskey(session);
    const options = await loginOptions();
    const assertion = await auth.assertion(options.challenge, 1);
    const body = JSON.stringify({ challengeToken: options.challengeToken, ...assertion });
    const first = await SELF.fetch(`${BASE}/webauthn/login/verify`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp }, body });
    expect(first.status).toBe(200);

    await ownerStub().configureBrowserPasswordForTests("a replacement owner password 52!");
    const replay = await SELF.fetch(`${BASE}/webauthn/login/verify`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp }, body });
    expect(replay.status).toBe(409);
  });

  it("rejects an expired challenge", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    const expired = await mintWebauthnChallenge(SERVER_KEY, "authenticate", "-", Date.now() - WEBAUTHN_CHALLENGE_TTL_MS - 1000);
    const assertion = await auth.assertion(expired.challenge, 1);
    const res = await SELF.fetch(`${BASE}/webauthn/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp },
      body: JSON.stringify({ challengeToken: expired.token, ...assertion }),
    });
    expect(res.status).toBe(410);
  });

  it("rejects an assertion signed for a different RP ID than the request's own host", async () => {
    const session = await browser();
    const auth = await registerPasskey(session); // registered under RP_ID "example.com"
    const options = await loginOptions();
    // Signed as if for "not-example.com", but the clientData origin still claims example.com —
    // isolates the rpIdHash check from the (separately-checked) origin check.
    const assertion = await auth.assertion(options.challenge, 1, { rpId: "not-example.com" });
    const res = await SELF.fetch(`${BASE}/webauthn/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "CF-Connecting-IP": testIp },
      body: JSON.stringify({ challengeToken: options.challengeToken, ...assertion }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("验证失败");
  });

  it("rejects a signature count that regresses, without corrupting the stored count", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    expect((await signIn(auth, 5)).status).toBe(200);
    expect((await signIn(auth, 3)).status).toBe(401); // regression: rejected
    expect((await signIn(auth, 6)).status).toBe(200); // still only compared against 5, not 3
  });

  it("rejects an assertion for a credential that was removed", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    const [passkey] = (await session.settings()).passkeys;
    const removed = await session.post("settings/webauthn/remove", { credentialId: passkey!.credentialId });
    expect(removed.status).toBe(200);
    expect((await session.settings()).passkeys).toEqual([]);
    expect((await signIn(auth, 1)).status).toBe(401);
  });

  it("keeps registered passkeys usable after a deployment password reset", async () => {
    const session = await browser();
    const auth = await registerPasskey(session);
    await ownerStub().configureBrowserPasswordForTests("a replacement owner password 51!");

    const oldSession = await SELF.fetch(`${BASE}/app`, { headers: { cookie: session.cookie } });
    expect(oldSession.status).toBe(200);
    expect(await oldSession.text()).toContain('id="password-form"');
    expect((await signIn(auth, 1)).status).toBe(200);
  });
});
