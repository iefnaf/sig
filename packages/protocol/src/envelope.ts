// ULID (26-char Crockford base32: 10 timestamp chars + 16 random chars), used as message `id`.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(timestamp = Date.now()): string {
  let t = timestamp;
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ENCODING[t % 32]!;
    t = Math.floor(t / 32);
  }
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const randomChars = Array.from(randomBytes, (b) => ENCODING[b % 32]).join("");
  return timeChars.join("") + randomChars;
}

export interface Envelope {
  t: string;
  id: string;
  re?: string | null;
  ts: number;
}
