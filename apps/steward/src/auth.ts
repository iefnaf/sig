import { serverKey, type ServerKey } from "@alexlikevibe/protocol";

export function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

/**
 * Resolve an explicit-key deployment's signing/sealing set: SERVER_KEY first, plus
 * SERVER_KEY_PREVIOUS when set (issue #27 rotation window). Tokens and ciphertexts made under
 * the previous key keep verifying/opening until the operator drops it; everything new uses the
 * primary only.
 */
export async function resolveServerKeys(env: { SERVER_KEY?: string; SERVER_KEY_PREVIOUS?: string }): Promise<ServerKey[]> {
  if (!env.SERVER_KEY) throw new Error("SERVER_KEY is unavailable");
  return resolveKeySecrets([env.SERVER_KEY, env.SERVER_KEY_PREVIOUS]);
}

/** Resolve an already-authorized internal key set, primary first. */
export async function resolveKeySecrets(secrets: readonly (string | undefined)[]): Promise<ServerKey[]> {
  const usable = secrets.filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
  if (usable.length === 0) throw new Error("deployment signing keys are unavailable");
  const keys = await Promise.all(usable.map((secret) => serverKey(secret)));
  return keys;
}
