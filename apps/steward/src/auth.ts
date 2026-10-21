import { serverKey, type ServerKey } from "@nightboats/protocol";

export function bearer(request: Request): string | null {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

/**
 * The signing/sealing key set: the current SERVER_KEY first, plus SERVER_KEY_PREVIOUS when set
 * (issue #27 rotation window). Tokens and ciphertexts made under the previous key keep
 * verifying/opening until the operator drops SERVER_KEY_PREVIOUS; everything new is minted and
 * sealed under the primary only. Duplicate values collapse to one entry.
 */
export async function resolveServerKeys(env: { SERVER_KEY: string; SERVER_KEY_PREVIOUS?: string }): Promise<ServerKey[]> {
  const primary = await serverKey(env.SERVER_KEY);
  if (!env.SERVER_KEY_PREVIOUS) return [primary];
  const previous = await serverKey(env.SERVER_KEY_PREVIOUS);
  return previous.id === primary.id ? [primary] : [primary, previous];
}
