// webauthn.ts has no precedent elsewhere in the codebase to pattern-match against (grounding
// doc, candidate-2 design §"Next implementation step"), so it gets verified in isolation here,
// against a real ceremony built the way a browser + platform authenticator would: an ECDSA
// P-256 keypair, a CBOR-encoded authenticatorData/attestationObject, and a DER-wrapped ECDSA
// signature over authenticatorData || SHA-256(clientDataJSON) — not a stub or a mock of the
// verification itself. No HTTP route is wired up yet; this only exercises the pure functions.
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { verifyAssertionResponse, verifyRegistrationResponse, WebauthnVerifyError } from "../src/webauthn.ts";

const RP_ID = "example.com";
const ORIGIN = "https://example.com";
const CHALLENGE = isoBase64URL.fromUTF8String("wc1.authenticate.-.9999999999999.deadbeef.cafef00d");

/** `Uint8Array` alone defaults to the `ArrayBufferLike`-backed variant under this repo's
 *  TypeScript; @simplewebauthn/server's own `Uint8Array_` (and BufferSource) want the
 *  `ArrayBuffer`-backed one, which `Uint8Array.from`/`new Uint8Array(arrayBuffer)` produce. */
type Bytes = Uint8Array<ArrayBuffer>;

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

/** ASN.1 DER-wraps a raw WebCrypto ECDSA signature (r || s, 32 bytes each for P-256) — the
 *  format WebAuthn requires on the wire, which `crypto.subtle.sign` does not itself produce. */
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

interface FakeAuthenticator {
  credentialIdB64: string;
  publicKeyCoseB64: string;
  authenticatorData(opts: { signCount: number; attestedCredential?: boolean }): Promise<Bytes>;
  sign(data: Bytes): Promise<Bytes>;
}

/** A minimal software authenticator: real P-256 keys, real CBOR, real ECDSA signatures — the
 *  same shapes @simplewebauthn/server's decoders expect from a genuine browser response. */
async function makeFakeAuthenticator(): Promise<FakeAuthenticator> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const x = rawPublicKey.slice(1, 33);
  const y = rawPublicKey.slice(33, 65);
  const coseKey = isoCBOR.encode(
    new Map<number, number | Bytes>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, x],
      [-3, y],
    ]),
  );
  const credentialId = crypto.getRandomValues(new Uint8Array(16));

  return {
    credentialIdB64: isoBase64URL.fromBuffer(credentialId),
    publicKeyCoseB64: isoBase64URL.fromBuffer(coseKey),
    async authenticatorData({ signCount, attestedCredential = false }) {
      const rpIdHash = await sha256(new TextEncoder().encode(RP_ID));
      const flags = 0x01 | (attestedCredential ? 0x40 : 0); // up, + attested credential data
      const counter = new Uint8Array(4);
      new DataView(counter.buffer).setUint32(0, signCount, false);
      const head = Uint8Array.from([...rpIdHash, flags, ...counter]);
      if (!attestedCredential) return head;
      const aaguid = new Uint8Array(16);
      const idLen = new Uint8Array(2);
      new DataView(idLen.buffer).setUint16(0, credentialId.length, false);
      return Uint8Array.from([...head, ...aaguid, ...idLen, ...credentialId, ...coseKey]);
    },
    async sign(data) {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, data));
      return derEncodeEcdsaSignature(raw);
    },
  };
}

function clientDataJSONFor(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): string {
  return isoBase64URL.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** The attestation object's CBOR map value type (the library's own `CBORType` is not exported
 *  under a public name, so this is inferred from `encode`'s own parameter instead of guessed). */
type Cbor = Parameters<typeof isoCBOR.encode>[0];

async function attestationObjectFor(auth: FakeAuthenticator, signCount: number): Promise<string> {
  const authData = await auth.authenticatorData({ signCount, attestedCredential: true });
  const cbor = isoCBOR.encode(
    new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  return isoBase64URL.fromBuffer(cbor);
}

describe("verifyRegistrationResponse", () => {
  it("accepts a real fmt:none attestation and returns the stored-credential shape", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.create", CHALLENGE, ORIGIN);
    const attestationObject = await attestationObjectFor(auth, 0);

    const result = await verifyRegistrationResponse(
      { clientDataJSON, attestationObject },
      { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE },
    );

    expect(result.credentialId).toBe(auth.credentialIdB64);
    expect(result.publicKeyCose).toBe(auth.publicKeyCoseB64);
    expect(result.signCount).toBe(0);
    expect(result.transports).toEqual([]);
  });

  it("rejects a mismatched challenge", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.create", "a-different-challenge", ORIGIN);
    const attestationObject = await attestationObjectFor(auth, 0);
    await expect(
      verifyRegistrationResponse({ clientDataJSON, attestationObject }, { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ reason: "challenge_mismatch" } satisfies Partial<WebauthnVerifyError>);
  });

  it("rejects a mismatched origin", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.create", CHALLENGE, "https://evil.example");
    const attestationObject = await attestationObjectFor(auth, 0);
    await expect(
      verifyRegistrationResponse({ clientDataJSON, attestationObject }, { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ reason: "origin_mismatch" });
  });

  it("rejects the wrong ceremony type (a login response replayed as a registration)", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.get", CHALLENGE, ORIGIN);
    const attestationObject = await attestationObjectFor(auth, 0);
    await expect(
      verifyRegistrationResponse({ clientDataJSON, attestationObject }, { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ reason: "type_mismatch" });
  });

  it("rejects an attestation signed for a different RP ID", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.create", CHALLENGE, ORIGIN);
    const attestationObject = await attestationObjectFor(auth, 0);
    await expect(
      verifyRegistrationResponse({ clientDataJSON, attestationObject }, { rpId: "not-" + RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE }),
    ).rejects.toMatchObject({ reason: "rp_id_mismatch" });
  });

  it("rejects a response with the user-present flag unset", async () => {
    const auth = await makeFakeAuthenticator();
    const clientDataJSON = clientDataJSONFor("webauthn.create", CHALLENGE, ORIGIN);
    const authData = await auth.authenticatorData({ signCount: 0, attestedCredential: true });
    authData[32] = authData[32]! & ~0x01; // clear the "up" bit
    const cbor = isoCBOR.encode(new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    await expect(
      verifyRegistrationResponse(
        { clientDataJSON, attestationObject: isoBase64URL.fromBuffer(cbor) },
        { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE },
      ),
    ).rejects.toMatchObject({ reason: "user_not_present" });
  });

  it("rejects a malformed or missing wire payload without throwing something other than WebauthnVerifyError", async () => {
    await expect(verifyRegistrationResponse({}, { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE })).rejects.toMatchObject({
      reason: "bad_client_data",
    });
    await expect(verifyRegistrationResponse(null, { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE })).rejects.toMatchObject({
      reason: "bad_client_data",
    });
    await expect(
      verifyRegistrationResponse(
        { clientDataJSON: "not-base64url-json", attestationObject: "also-not-cbor" },
        { rpId: RP_ID, origin: ORIGIN, expectedChallenge: CHALLENGE },
      ),
    ).rejects.toBeInstanceOf(WebauthnVerifyError);
  });
});

describe("verifyAssertionResponse", () => {
  async function signedAssertion(auth: FakeAuthenticator, signCount: number, challenge = CHALLENGE, origin = ORIGIN) {
    const clientDataJSON = clientDataJSONFor("webauthn.get", challenge, origin);
    const authenticatorData = await auth.authenticatorData({ signCount });
    const clientDataHash = await sha256(isoBase64URL.toBuffer(clientDataJSON));
    const signedData = Uint8Array.from([...authenticatorData, ...clientDataHash]);
    const signature = await auth.sign(signedData);
    return {
      clientDataJSON,
      authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
      signature: isoBase64URL.fromBuffer(signature),
    };
  }

  it("verifies a real assertion and reports the authenticator's sign count", async () => {
    const auth = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 7);
    const result = await verifyAssertionResponse(response, {
      rpId: RP_ID,
      origin: ORIGIN,
      expectedChallenge: CHALLENGE,
      storedPublicKeyCose: auth.publicKeyCoseB64,
      storedSignCount: 3,
    });
    expect(result.newSignCount).toBe(7);
  });

  it("accepts a sign count that stays at 0 (authenticators that don't support counters)", async () => {
    const auth = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 0);
    const result = await verifyAssertionResponse(response, {
      rpId: RP_ID,
      origin: ORIGIN,
      expectedChallenge: CHALLENGE,
      storedPublicKeyCose: auth.publicKeyCoseB64,
      storedSignCount: 0,
    });
    expect(result.newSignCount).toBe(0);
  });

  it("rejects a replayed/regressed sign count", async () => {
    const auth = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 3);
    await expect(
      verifyAssertionResponse(response, {
        rpId: RP_ID,
        origin: ORIGIN,
        expectedChallenge: CHALLENGE,
        storedPublicKeyCose: auth.publicKeyCoseB64,
        storedSignCount: 5,
      }),
    ).rejects.toMatchObject({ reason: "counter_regressed" });
  });

  it("rejects a signature that verifies under a different credential's public key", async () => {
    const auth = await makeFakeAuthenticator();
    const impostor = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 1);
    await expect(
      verifyAssertionResponse(response, {
        rpId: RP_ID,
        origin: ORIGIN,
        expectedChallenge: CHALLENGE,
        storedPublicKeyCose: impostor.publicKeyCoseB64,
        storedSignCount: 0,
      }),
    ).rejects.toMatchObject({ reason: "signature_invalid" });
  });

  it("rejects an assertion signed for a different RP ID", async () => {
    const auth = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 1);
    await expect(
      verifyAssertionResponse(response, {
        rpId: "not-" + RP_ID,
        origin: ORIGIN,
        expectedChallenge: CHALLENGE,
        storedPublicKeyCose: auth.publicKeyCoseB64,
        storedSignCount: 0,
      }),
    ).rejects.toMatchObject({ reason: "rp_id_mismatch" });
  });

  it("rejects a stale/replayed challenge", async () => {
    const auth = await makeFakeAuthenticator();
    const response = await signedAssertion(auth, 1, "a-stale-challenge");
    await expect(
      verifyAssertionResponse(response, {
        rpId: RP_ID,
        origin: ORIGIN,
        expectedChallenge: CHALLENGE,
        storedPublicKeyCose: auth.publicKeyCoseB64,
        storedSignCount: 0,
      }),
    ).rejects.toMatchObject({ reason: "challenge_mismatch" });
  });
});
