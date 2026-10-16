// connect <url> <code>, protocol §5.2: redeem a pairing code once, then persist credentials.
import type { LocalStore } from "./store.ts";

export interface PairResult {
  deviceId: string;
  token: string;
  wsUrl: string;
}

export interface ConnectOptions {
  store: LocalStore;
  fetchImpl?: typeof fetch;
}

export async function connect(serverUrl: string, code: string, machineName: string, options: ConnectOptions): Promise<PairResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(new URL("/pair", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: machineName }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pairing failed: ${res.status} ${body}`);
  }
  const result = (await res.json()) as PairResult;
  options.store.saveCredentials({ serverUrl, deviceId: result.deviceId, token: result.token });
  return result;
}
