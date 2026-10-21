// Device token, see docs/design/connector-do-protocol.md §5.1.
// Format: st1.<keyId>.<deviceId>.<epoch>.<issuedAt>.<mac>
//   mac   = HMAC-SHA256(secret, "st1." + keyId + "." + deviceId + "." + epoch + "." + issuedAt)
//   keyId = first 8 hex chars of SHA-256("sig:keyid:v1:" + secret)
// The keyId makes SERVER_KEY rotatable (issue #27): the verifier keeps a set of keys — the
// current SERVER_KEY plus SERVER_KEY_PREVIOUS during a rotation window — and picks the one the
// token names. Tokens minted before the keyId existed (five segments, no keyId) are tried
// against every configured key, so they keep verifying throughout the window too.
const enc = new TextEncoder();

/** A signing key and its derived id. `id` is deterministic per secret. */
export interface ServerKey {
  id: string;
  secret: string;
}

export async function deriveKeyId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`sig:keyid:v1:${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

/** Wraps a raw secret with its derived key id. */
export async function serverKey(secret: string): Promise<ServerKey> {
  return { id: await deriveKeyId(secret), secret };
}

function hmacKey(secret: string, usage: KeyUsage[]): PromiseLike<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  const out = new Uint8Array(pairs.length);
  pairs.forEach((pair, i) => {
    out[i] = parseInt(pair, 16);
  });
  return out;
}

export async function mintToken(key: ServerKey, deviceId: string, epoch: number, issuedAt = Date.now()): Promise<string> {
  const base = `st1.${key.id}.${deviceId}.${epoch}.${issuedAt}`;
  const mac = toHex(await crypto.subtle.sign("HMAC", await hmacKey(key.secret, ["sign"]), enc.encode(base)));
  return `${base}.${mac}`;
}

export interface ParsedToken {
  deviceId: string;
  epoch: number;
  /** Id of the key that verified the token; primary-key minted tokens carry the primary id. */
  keyId: string;
}

/**
 * Verifies a token against one key or a set (primary first — during a rotation window the
 * previous key stays in the set so existing device tokens keep verifying, issue #27).
 * Legacy five-segment tokens (no keyId) are tried against every key in the set.
 */
export async function parseToken(keys: ServerKey | ServerKey[], token: string | null): Promise<ParsedToken | null> {
  if (!token) return null;
  const keySet = Array.isArray(keys) ? keys : [keys];
  if (keySet.length === 0) return null;
  const parts = token.split(".");

  // Current format: st1.<keyId>.<deviceId>.<epoch>.<issuedAt>.<mac>
  if (parts.length === 6 && parts[0] === "st1") {
    if (!/^[0-9a-f]{8}$/.test(parts[1]!) || !/^[0-9a-f]{64}$/.test(parts[5]!)) return null;
    const key = keySet.find((k) => k.id === parts[1]);
    if (!key) return null;
    const base = parts.slice(0, 5).join(".");
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(key.secret, ["verify"]), fromHex(parts[5]!) as BufferSource, enc.encode(base));
    return ok ? { deviceId: parts[2]!, epoch: Number(parts[3]), keyId: key.id } : null;
  }

  // Legacy format (pre-keyId): st1.<deviceId>.<epoch>.<issuedAt>.<mac> — minted before a
  // rotation, so try every configured key; the first that verifies owns it.
  if (parts.length === 5 && parts[0] === "st1") {
    if (!/^[0-9a-f]{64}$/.test(parts[4]!)) return null;
    const base = parts.slice(0, 4).join(".");
    for (const key of keySet) {
      const ok = await crypto.subtle.verify("HMAC", await hmacKey(key.secret, ["verify"]), fromHex(parts[4]!) as BufferSource, enc.encode(base));
      if (ok) return { deviceId: parts[1]!, epoch: Number(parts[2]), keyId: key.id };
    }
    return null;
  }

  return null;
}
