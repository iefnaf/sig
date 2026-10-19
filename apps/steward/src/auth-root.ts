// The authorization root (ADR-0004): the Durable Object generates this secret on first boot
// and keeps it in its own storage. Everything that used to be signed with the deploy-time
// SERVER_KEY is signed with it instead — device tokens, application sessions, one-time links
// and claim grants — so a Deploy-to-Cloudflare deployment needs no secret typed by hand.
//
// The Worker layer keeps a copy in module scope for its stateless pre-checks; a deploy
// evicts it and the next request re-reads it from the Durable Object (which outlives code
// deploys), exactly like a SERVER_KEY rotation window behaves today.
export interface AuthRoot {
  /** HMAC-SHA256 key material, hex. */
  secret: string;
}

const STORAGE_KEY = "auth:root";

export async function readAuthRoot(storage: DurableObjectStorage): Promise<AuthRoot | null> {
  return (await storage.get<AuthRoot>(STORAGE_KEY)) ?? null;
}

/** Returns the existing root or creates and persists one; callers serialize through the DO. */
export async function ensureAuthRoot(storage: DurableObjectStorage): Promise<AuthRoot> {
  const existing = await readAuthRoot(storage);
  if (existing) return existing;
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const root: AuthRoot = { secret };
  await storage.put(STORAGE_KEY, root);
  return root;
}
