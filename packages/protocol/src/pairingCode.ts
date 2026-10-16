// 8-char Crockford base32 pairing code (40 bits), protocol §5.2.
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CROCKFORD_ALPHABET[b & 31]).join("");
}
