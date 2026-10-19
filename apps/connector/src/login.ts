// `shepherd login` (ADR-0004): a paired machine mints a one-time browser sign-in link.
// The steward's /login endpoint takes the machine's own device credential — the same Bearer
// token its WebSocket uses — so only a machine this deployment trusts can open a door for a
// browser. The link is the Feishu-era single-use token (web.ts openLink): it works once and
// expires in minutes.
import type { LocalStore } from "./store.ts";

export async function loginLink(store: LocalStore, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const credentials = store.getCredentials();
  if (!credentials) return null;
  const res = await fetchImpl(new URL("/login", credentials.serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credentials.token}` },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`login link failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as { url?: string };
  if (typeof body.url !== "string") throw new Error("login link failed: malformed reply");
  return body.url;
}
