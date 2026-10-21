// Native proxy support (issue #68): networks that filter `*.workers.dev` by SNI (mainland
// China) leave the connector with two Node blind spots — global fetch ignores
// `HTTP(S)_PROXY` (undici reads it only via NODE_USE_ENV_PROXY, a Node ≥ 24.5 boot flag),
// and `ws` has no proxy support of its own. This module closes both gaps from one stored
// config, and exports the env so children (the connector's own `git` calls, pi workers via
// childEnv) inherit it — the background service itself needs no proxy entries in its unit.
//
// Precedence (`resolveProxyConfig`): an explicit `--proxy` flag beats a stored config
// beats the connecting shell's HTTPS_PROXY (which `sig connect` promotes into storage, so
// the launchd/systemd daemon never depends on an inherited environment).
//
// Security: a proxy URL may carry credentials (`http://user:pass@host`); `proxyLogFields`
// is the only shape allowed into logs, and loopback is bypassed unconditionally.
import type { Agent } from "node:http";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from "undici";

/** The stored proxy choice. `noProxy` is a comma-separated no_proxy list; loopback is
 *  excluded regardless, so `noProxy` only widens the bypass set. */
export interface ProxyConfig {
  url: string;
  noProxy?: string;
}

/** Hosts that are never proxied, whatever noProxy says: the connector and its workers
 *  talk to local servers (the report MCP, dev stewards) over loopback. */
const ALWAYS_BYPASS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

/** Parses and validates a proxy URL. Accepts `http://`/`https://` (HTTP CONNECT proxies —
 *  what Clash & friends expose on their mixed port) and the bare `host:port` shorthand.
 *  SOCKS is refused with a pointer at the proxy client's HTTP/mixed port, not a generic
 *  "invalid url". */
export function normalizeProxyConfig(url: string, noProxy?: string): ProxyConfig {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("proxy URL is empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`'${trimmed}' is not a valid proxy URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `'${trimmed}': ${parsed.protocol.replace(":", "")} proxies are not supported — point the connector at your proxy client's HTTP/mixed port, e.g. http://127.0.0.1:7890`,
    );
  }
  if (!parsed.hostname) throw new Error(`'${trimmed}' is not a valid proxy URL`);
  const config: ProxyConfig = { url: parsed.toString() };
  const list = noProxy?.trim();
  if (list) config.noProxy = list;
  return config;
}

/** Splits a no_proxy entry into its host and optional port, keeping IPv6 literals whole:
 *  `example.com:443` → [example.com, 443]; `[::1]:443` → [::1, 443]; a bare `2001:db8::1`
 *  (more than one colon — a port can't be told apart, curl's reading) stays one host. */
function splitNoProxyEntry(entry: string): [host: string, port: string | undefined] {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close !== -1) {
      const rest = entry.slice(close + 1);
      return [entry.slice(1, close), rest.startsWith(":") && rest.length > 1 ? rest.slice(1) : undefined];
    }
  }
  if (entry.split(":").length > 2) return [entry, undefined];
  const separator = entry.lastIndexOf(":");
  if (separator === -1) return [entry, undefined];
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}

/** Standard-ish no_proxy matching: comma-separated entries, any of which can bypass
 *  (curl semantics — every entry is consulted); `*` bypasses everything; a leading `.` or
 *  `*.` suffix-matches subdomains; `host:port` entries match only that port; IPv6 literals
 *  stay whole. Loopback is handled separately (always bypassed) — an empty list proxies
 *  every non-loopback host. */
export function hostBypassed(host: string, port: number | null, noProxy: string | undefined): boolean {
  const hostname = host.toLowerCase();
  const list = (noProxy ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  for (const entry of list) {
    if (entry === "*") return true;
    const [entryHost, entryPort] = splitNoProxyEntry(entry);
    // "example.com:443" only matches that port; a bare host matches any port.
    if (entryPort !== undefined && port !== null && String(port) !== entryPort) continue;
    if (entryHost === hostname) return true;
    // `.example.com` and `*.example.com` both match the domain and its subdomains (curl's
    // no_proxy semantics); look-alikes (notexample.com) never match.
    const suffix = entryHost.replace(/^\*?\./, "");
    if (suffix !== entryHost && (hostname === suffix || hostname.endsWith(`.${suffix}`))) return true;
    // No match on this entry — a later entry may still bypass, so keep scanning.
  }
  return false;
}

/** Whether connections to `targetUrl` should go through `config`. */
export function shouldProxy(targetUrl: string, config: ProxyConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  // WHATWG URLs keep brackets on IPv6 hostnames (`wss://[::1]/` → `[::1]`); strip them so
  // loopback and no_proxy entries match the unbracketed form both sides write.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (ALWAYS_BYPASS.has(hostname) || hostname.endsWith(".localhost")) return false;
  // An explicit port or the scheme's default — so `example.com:443` matches an
  // https://example.com URL that never spelled the port out (wss defaults to 443 and ws
  // to 80, the steward WebSocket's effective ports).
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? 443
      : 80;
  return !hostBypassed(hostname, port, config.noProxy);
}

/** The no_proxy list actually exported to the fetch channel and children: the user's
 *  entries with the loopback defaults merged in. EnvHttpProxyAgent has no loopback bypass
 *  of its own, so the exported list — not just the ws matcher — has to carry the
 *  "loopback is never proxied" invariant. */
export function effectiveNoProxy(config: ProxyConfig): string {
  const entries = new Set(DEFAULT_NO_PROXY.split(",").map((entry) => entry.trim()).filter(Boolean));
  for (const entry of (config.noProxy ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
    entries.add(entry);
  }
  return [...entries].join(",");
}

/** The env vars children and EnvHttpProxyAgent see: both cases, because git/curl read the
 *  uppercase forms while some tooling only reads lowercase. */
export function proxyEnvFor(config: ProxyConfig): Record<string, string> {
  const value: Record<string, string> = {
    HTTPS_PROXY: config.url,
    https_proxy: config.url,
    HTTP_PROXY: config.url,
    http_proxy: config.url,
    NO_PROXY: effectiveNoProxy(config),
  };
  value.no_proxy = value.NO_PROXY!;
  return value;
}

/** Log-safe fields for a proxy config — the URL may embed credentials. */
export function proxyLogFields(config: ProxyConfig): { proxy: string; noProxy: string } {
  return { proxy: `${new URL(config.url).protocol}//${new URL(config.url).host}`, noProxy: config.noProxy?.trim() || DEFAULT_NO_PROXY };
}

export interface ProxyApplication {
  readonly config: ProxyConfig;
  /** The EnvHttpProxyAgent every proxied fetch goes through. */
  readonly dispatcher: Dispatcher;
  /** The `ws` agent for a target URL, or undefined when the target is bypassed. */
  wsAgentFor(targetUrl: string): Agent | undefined;
  /** A fetch bound to `dispatcher`. Node's built-in fetch and a bundled undici dispatcher
   *  can mismatch request-handler protocols across Node versions (undici 8 rejects the
   *  internal handler on Node 22, and undici 7's ProxyAgent hangs on Node 26), so the
   *  connector's proxied calls (pairing, doctor) go through undici's own fetch with the
   *  dispatcher passed explicitly — same package on every Node. */
  fetch: typeof fetch;
}

/** Activates a stored config in this process: env for children (git, pi workers — childEnv
 *  copies it), a global EnvHttpProxyAgent for every fetch (reads the env just set), and a
 *  per-target agent factory for the WebSocket. Idempotent per process. */
export function applyProxy(config: ProxyConfig): ProxyApplication {
  Object.assign(process.env, proxyEnvFor(config));
  const dispatcher = new EnvHttpProxyAgent();
  // Belt for anything reading the global dispatcher symbol; the connector's own calls go
  // through `fetch` below instead (see the note on ProxyApplication.fetch).
  setGlobalDispatcher(dispatcher);
  const httpsAgent = new HttpsProxyAgent(config.url);
  const httpAgent = new HttpProxyAgent(config.url);
  return {
    config,
    dispatcher,
    wsAgentFor(targetUrl: string): Agent | undefined {
      if (!shouldProxy(targetUrl, config)) return undefined;
      try {
        return new URL(targetUrl).protocol === "https:" ? httpsAgent : httpAgent;
      } catch {
        return undefined;
      }
    },
    fetch(input, init) {
      // Only string/URL inputs ever reach here; the cast absorbs the structural drift
      // between @types/node's globals and undici's own Request/Response types.
      return undiciFetch(input as string | URL, {
        ...init,
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    },
  };
}

/** Resolution result: where the effective config came from (connect prints it). */
export type ProxySource = "flag" | "stored" | "env";

export function resolveProxyConfig(options: {
  flag?: string;
  stored?: ProxyConfig | null;
  env?: Record<string, string | undefined>;
}): { config: ProxyConfig | null; source: ProxySource | null } {
  if (options.flag) return { config: normalizeProxyConfig(options.flag), source: "flag" };
  if (options.stored) return { config: options.stored, source: "stored" };
  const envUrl = options.env?.HTTPS_PROXY ?? options.env?.https_proxy;
  if (envUrl) {
    return { config: normalizeProxyConfig(envUrl, options.env?.NO_PROXY ?? options.env?.no_proxy), source: "env" };
  }
  return { config: null, source: null };
}
