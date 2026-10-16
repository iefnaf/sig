// Device token: st1.<deviceId>.<epoch>.<issuedAt>.<mac>, see docs/design/connector-do-protocol.md §5.1.
const enc = new TextEncoder();

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

export async function mintToken(secret: string, deviceId: string, epoch: number, issuedAt = Date.now()): Promise<string> {
  const base = `st1.${deviceId}.${epoch}.${issuedAt}`;
  const mac = toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(base)));
  return `${base}.${mac}`;
}

export interface ParsedToken {
  deviceId: string;
  epoch: number;
}

export async function parseToken(secret: string, token: string | null): Promise<ParsedToken | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "st1" || !/^[0-9a-f]{64}$/.test(parts[4]!)) return null;
  const base = parts.slice(0, 4).join(".");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), fromHex(parts[4]!) as BufferSource, enc.encode(base));
  return ok ? { deviceId: parts[1]!, epoch: Number(parts[2]) } : null;
}
