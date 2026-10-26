// AES-GCM sealing for secrets at rest (steward.md §9.0 / spec §12.2: "credentials are stored
// encrypted"). The AES key is HKDF-derived from the deployment signing key (an explicit
// SERVER_KEY or the generated key held by the owner Durable Object).
//
// Format v2 — `v2.<keyId>.<iv>.<cipher>` — embeds the sealing key's id (the same derivation as
// device tokens, see protocol/token.ts), so during an explicit-key rotation the opener picks
// the right key from the configured set. Format v1 — `v1.<iv>.<cipher>`, sealed before keyIds
// existed — is tried against every configured key. Callers are encouraged to re-seal under the
// primary key after a non-primary open (the steward does this lazily on read), so ciphertexts
// converge onto the current key and the window can close.
import { deriveKeyId, type ServerKey } from "@alexlikevibe/protocol";

const enc = new TextEncoder();

export async function sealSecret(key: ServerKey, plaintext: string): Promise<string> {
  const aes = await deriveKey(key.secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(plaintext));
  return `v2.${key.id}.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export interface OpenedSecret {
  text: string;
  /** Key that opened the ciphertext; null for legacy v1 blobs (no embedded id). */
  keyId: string | null;
}

/** Returns null when the ciphertext does not open under any configured key (rotated-away key,
 * corruption). Opening with a non-primary key signals the caller to re-seal under the primary. */
export async function openSecret(keys: ServerKey | ServerKey[], sealed: string): Promise<OpenedSecret | null> {
  const keySet = Array.isArray(keys) ? keys : [keys];
  const parts = sealed.split(".");
  let keyId: string | null = null;
  let ivText: string;
  let cipherText: string;
  if (parts.length === 4 && parts[0] === "v2") {
    if (!/^[0-9a-f]{8}$/.test(parts[1]!)) return null;
    keyId = parts[1]!;
    ivText = parts[2]!;
    cipherText = parts[3]!;
  } else if (parts.length === 3 && parts[0] === "v1") {
    ivText = parts[1]!;
    cipherText = parts[2]!;
  } else {
    return null;
  }

  let iv: Uint8Array<ArrayBuffer>;
  let cipher: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(ivText);
    cipher = fromBase64(cipherText);
  } catch {
    return null;
  }

  // v2: try the named key first; v1: try them all.
  const candidates = keyId === null ? keySet : keySet.filter((k) => k.id === keyId);
  for (const key of candidates) {
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await deriveKey(key.secret), cipher);
      return { text: new TextDecoder().decode(plain), keyId: key.id };
    } catch {
      // wrong key — next candidate
    }
  }
  return null;
}

function deriveKey(serverKeySecret: string): Promise<CryptoKey> {
  return crypto.subtle
    .importKey("raw", enc.encode(serverKeySecret), "HKDF", false, ["deriveKey"])
    .then((hkdf) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("sig:channel-secret:v1") },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
