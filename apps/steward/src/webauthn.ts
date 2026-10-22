// WebAuthn/passkey protocol verification (candidate-2 design §"webauthn.ts", synthesis graft 1):
// the only file that names the browser's wire-format shapes or imports @simplewebauthn/server.
// Everything else in the codebase carries a registration/assertion payload as `unknown` and
// hands it here unexamined — these two functions are the sole place that parses/asserts it.
//
// The COSE/CBOR decoding, origin/type/challenge/rpIdHash checks, attestation-format dispatch
// (including self-attested "packed", which platform authenticators commonly use alongside
// "none"), signature verification and sign-counter regression check are all done by
// @simplewebauthn/server itself (Web-Crypto based, so it runs on Workers without leaning on
// nodejs_compat) — this module is a thin adapter from Sig's own minimal wire shape and typed
// result/error types to that library's richer `*ResponseJSON` shapes, not a reimplementation.
import {
  verifyRegistrationResponse as libVerifyRegistration,
  verifyAuthenticationResponse as libVerifyAuthentication,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";

export class WebauthnVerifyError extends Error {
  constructor(
    public readonly reason:
      | "bad_client_data"
      | "type_mismatch"
      | "origin_mismatch"
      | "challenge_mismatch"
      | "rp_id_mismatch"
      | "user_not_present"
      | "signature_invalid"
      | "counter_regressed"
      | "unknown_algorithm"
      | "malformed_cbor",
  ) {
    super(reason);
  }
}

export interface RegistrationCeremony {
  rpId: string;
  origin: string;
  /** base64url; already HMAC/expiry-verified by web.ts before this is called. */
  expectedChallenge: string;
}

export interface RegistrationResult {
  credentialId: string;
  publicKeyCose: string;
  signCount: number;
  transports: string[];
}

export interface AssertionCeremony {
  rpId: string;
  origin: string;
  expectedChallenge: string;
  /** base64url, from sh_web_credential — the row web.ts already matched by credentialId. */
  storedPublicKeyCose: string;
  storedSignCount: number;
}

export interface AssertionResult {
  newSignCount: number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The library's `*ResponseJSON.id`/`.rawId` are only checked against each other and for the
 * "public-key" credential type (verified by reading its source) — never used in any
 * cryptographic step, so a fixed placeholder here is correct, not a shortcut: Sig's own wire
 * format carries no separate id/rawId fields (the credential id lives inside attestationObject
 * for registration, and is matched by web.ts's own SELECT before an assertion ever reaches
 * this file).
 */
const UNUSED_ID = "AA";

/** Maps the library's message-only Error into one of Sig's typed reasons. Best-effort: the
 *  library does not export error subtypes, so this is a substring match over its (stable,
 *  English, hand-written) messages rather than a discriminated catch. */
function translateError(err: unknown): WebauthnVerifyError {
  const message = err instanceof Error ? err.message : String(err);
  if (/challenge/i.test(message)) return new WebauthnVerifyError("challenge_mismatch");
  if (/origin/i.test(message)) return new WebauthnVerifyError("origin_mismatch");
  if (/\btype\b/i.test(message)) return new WebauthnVerifyError("type_mismatch");
  if (/RP ID/i.test(message)) return new WebauthnVerifyError("rp_id_mismatch");
  if (/presence|not present/i.test(message)) return new WebauthnVerifyError("user_not_present");
  if (/counter/i.test(message)) return new WebauthnVerifyError("counter_regressed");
  if (/\balg\b|algorithm/i.test(message)) return new WebauthnVerifyError("unknown_algorithm");
  return new WebauthnVerifyError("malformed_cbor");
}

/**
 * Parses and fully verifies a `navigator.credentials.create()` response (WebAuthn L2 §7.1,
 * trimmed: no attestation-trust-chain validation beyond what @simplewebauthn/server's own
 * format dispatch does with its bundled, offline root certificates — no network call is ever
 * reachable from the formats this deployment will see). Throws WebauthnVerifyError and writes
 * nothing on any failure; the caller (web.ts) does the only write, after this returns.
 */
export async function verifyRegistrationResponse(response: unknown, ceremony: RegistrationCeremony): Promise<RegistrationResult> {
  const wire = response !== null && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const clientDataJSON = str(wire.clientDataJSON);
  const attestationObject = str(wire.attestationObject);
  if (!clientDataJSON || !attestationObject) throw new WebauthnVerifyError("bad_client_data");

  const credential: RegistrationResponseJSON = {
    id: UNUSED_ID,
    rawId: UNUSED_ID,
    response: { clientDataJSON, attestationObject },
    clientExtensionResults: {},
    type: "public-key",
  };

  let result;
  try {
    result = await libVerifyRegistration({
      response: credential,
      expectedChallenge: ceremony.expectedChallenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      requireUserPresence: true,
      requireUserVerification: false,
    });
  } catch (err) {
    throw translateError(err);
  }
  if (!result.verified) throw new WebauthnVerifyError("signature_invalid");

  return {
    credentialId: result.registrationInfo.credential.id,
    publicKeyCose: isoBase64URL.fromBuffer(result.registrationInfo.credential.publicKey),
    signCount: result.registrationInfo.credential.counter,
    transports: result.registrationInfo.credential.transports ?? [],
  };
}

/**
 * Parses and verifies a `navigator.credentials.get()` response against one already-selected
 * stored credential (web.ts looks the row up by credentialId before calling this — this
 * function has no DB access and never will).
 */
export async function verifyAssertionResponse(response: unknown, ceremony: AssertionCeremony): Promise<AssertionResult> {
  const wire = response !== null && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const clientDataJSON = str(wire.clientDataJSON);
  const authenticatorData = str(wire.authenticatorData);
  const signature = str(wire.signature);
  if (!clientDataJSON || !authenticatorData || !signature) throw new WebauthnVerifyError("bad_client_data");

  const assertion: AuthenticationResponseJSON = {
    id: UNUSED_ID,
    rawId: UNUSED_ID,
    response: { clientDataJSON, authenticatorData, signature },
    clientExtensionResults: {},
    type: "public-key",
  };
  const storedCredential: WebAuthnCredential = {
    id: UNUSED_ID,
    publicKey: isoBase64URL.toBuffer(ceremony.storedPublicKeyCose),
    counter: ceremony.storedSignCount,
  };

  let result;
  try {
    result = await libVerifyAuthentication({
      response: assertion,
      expectedChallenge: ceremony.expectedChallenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      credential: storedCredential,
      requireUserVerification: false,
    });
  } catch (err) {
    throw translateError(err);
  }
  if (!result.verified) throw new WebauthnVerifyError("signature_invalid");

  return { newSignCount: result.authenticationInfo.newCounter };
}
