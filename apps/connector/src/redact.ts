// Log redaction (issue #26): everything under ~/.sig/logs must stay free of keys and
// session content. Callers never log secrets in the first place — this is defense in depth
// for the cases nobody thought of (error messages quoting headers, pi diagnostics, crashes).

/** Secret-shaped token patterns scrubbed from anything destined for ~/.sig/logs. */
const KEY_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // OpenAI-style keys (sk-…, sk-proj-…)
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, replacement: "[redacted]" },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "[redacted]" },
  // AWS access key ids
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted]" },
  // Authorization headers of any shape
  { re: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, replacement: "$1[redacted]" },
];

/** Replaces known secret values and secret-shaped tokens with [redacted]. */
export function redactText(text: string, secrets: Iterable<string> = []): string {
  let out = text;
  for (const secret of secrets) {
    // Short strings would redact unrelated content; the device token is always longer.
    if (secret.length >= 12) out = out.split(secret).join("[redacted]");
  }
  for (const { re, replacement } of KEY_PATTERNS) out = out.replace(re, replacement);
  return out;
}
