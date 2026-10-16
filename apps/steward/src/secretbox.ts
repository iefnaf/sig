// AES-GCM sealing for channel credentials (steward.md §9.0: "credentials are stored
// encrypted"). The key is HKDF-derived from SERVER_KEY, so a raw storage dump alone does not
// expose the app secret. Rotating SERVER_KEY makes existing ciphertext undecryptable; the
// channel then reads back as unconfigured and the (SETUP_TOKEN-guarded) setup page accepts
// fresh credentials — the accepted recovery path, not a silent failure.

const enc = new TextEncoder();

export async function sealSecret(serverKey: string, plaintext: string): Promise<string> {
  const key = await deriveKey(serverKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

/** Returns null when the ciphertext does not open (wrong/rotated key, corruption). */
export async function openSecret(serverKey: string, sealed: string): Promise<string | null> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  let iv: Uint8Array<ArrayBuffer>;
  let cipher: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(parts[1]!);
    cipher = fromBase64(parts[2]!);
  } catch {
    return null;
  }
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, (await deriveKey(serverKey)) as CryptoKey, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function deriveKey(serverKey: string): Promise<CryptoKey> {
  return crypto.subtle
    .importKey("raw", enc.encode(serverKey), "HKDF", false, ["deriveKey"])
    .then((hkdf) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("shepherd:channel-secret:v1") },
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
