// Native proxy support (issue #68): URL normalization, no_proxy matching, env export,
// precedence resolution, process-wide activation, and a real forward-proxy round trip for
// the fetch channel (the wiring `sig doctor` and the daemon rely on).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import {
  DEFAULT_NO_PROXY,
  applyProxy,
  hostBypassed,
  normalizeProxyConfig,
  proxyEnvFor,
  resolveProxyConfig,
  shouldProxy,
} from "../src/proxy.ts";

const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;

/** Snapshots and clears the proxy env + global dispatcher around a test body. */
async function withCleanProxyState(body: () => Promise<void> | void): Promise<void> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of PROXY_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const savedDispatcher = getGlobalDispatcher();
  try {
    await body();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    setGlobalDispatcher(savedDispatcher as Dispatcher);
  }
}

describe("normalizeProxyConfig", () => {
  it("accepts http and https proxy URLs and the host:port shorthand", () => {
    expect(normalizeProxyConfig("http://127.0.0.1:7890")).toMatchObject({ url: "http://127.0.0.1:7890/" });
    expect(normalizeProxyConfig("127.0.0.1:7890").url).toBe("http://127.0.0.1:7890/");
    expect(normalizeProxyConfig("http://proxy.lan:3128").url).toBe("http://proxy.lan:3128/");
    expect(normalizeProxyConfig("https://proxy.example.com:8443").url).toBe("https://proxy.example.com:8443/");
  });

  it("keeps a trimmed no_proxy list", () => {
    expect(normalizeProxyConfig("http://127.0.0.1:7890", " localhost, .corp.example ")).toMatchObject({
      noProxy: "localhost, .corp.example",
    });
    expect(normalizeProxyConfig("http://127.0.0.1:7890", "  ").noProxy).toBeUndefined();
  });

  it("refuses SOCKS with a pointer at the HTTP/mixed port, and garbage as invalid", () => {
    expect(() => normalizeProxyConfig("socks5://127.0.0.1:7891")).toThrow(/HTTP\/mixed port/);
    expect(() => normalizeProxyConfig("")).toThrow(/empty/);
    expect(() => normalizeProxyConfig("not a url at all")).toThrow(/not a valid proxy URL/);
  });
});

describe("no_proxy matching", () => {
  const config = { url: "http://127.0.0.1:7890" };

  it("never proxies loopback, whatever noProxy says", () => {
    expect(shouldProxy("https://127.0.0.1:443/app", config)).toBe(false);
    expect(shouldProxy("ws://localhost:8787/x", config)).toBe(false);
    expect(shouldProxy("wss://[::1]:443/agents", config)).toBe(false);
    expect(shouldProxy("https://api.localhost/v1", { ...config, noProxy: "" })).toBe(false);
  });

  it("proxies everything else by default and honors exact-host entries", () => {
    expect(shouldProxy("wss://sig.example.workers.dev/agents/steward/owner", config)).toBe(true);
    // A bare host matches itself, not its subdomains (curl semantics).
    expect(shouldProxy("https://example.com/x", { ...config, noProxy: "example.com" })).toBe(false);
    expect(shouldProxy("https://sig.example.com/x", { ...config, noProxy: "example.com" })).toBe(true);
  });

  it("suffix-matches subdomains with a leading dot or wildcard, not look-alikes", () => {
    expect(shouldProxy("https://sig.example.com/x", { ...config, noProxy: ".example.com" })).toBe(false);
    expect(shouldProxy("https://example.com/x", { ...config, noProxy: ".example.com" })).toBe(false);
    expect(shouldProxy("https://notexample.com/x", { ...config, noProxy: ".example.com" })).toBe(true);
    expect(shouldProxy("https://a.b.example.com/x", { ...config, noProxy: "*.example.com" })).toBe(false);
  });

  it("matches host:port entries against the effective port (scheme defaults included)", () => {
    expect(shouldProxy("https://example.com/x", { ...config, noProxy: "example.com:443" })).toBe(false);
    expect(shouldProxy("https://example.com:8443/x", { ...config, noProxy: "example.com:443" })).toBe(true);
    expect(shouldProxy("http://example.com/x", { ...config, noProxy: "example.com:80" })).toBe(false);
  });

  it("treats '*' as bypass-everything and an empty list as proxy-everything", () => {
    expect(shouldProxy("https://anything.example/x", { ...config, noProxy: "*" })).toBe(false);
    expect(shouldProxy("https://anything.example/x", { ...config, noProxy: "" })).toBe(true);
  });

  it("hostBypassed is exact about ports when a port is given", () => {
    expect(hostBypassed("example.com", 443, "example.com:443")).toBe(true);
    expect(hostBypassed("example.com", 8443, "example.com:443")).toBe(false);
    expect(hostBypassed("example.com", 8443, "example.com")).toBe(true);
  });

  it("consults every entry of a multi-entry list, not just the first", () => {
    expect(hostBypassed("x.corp.example", 443, "localhost,.corp.example")).toBe(true);
    expect(shouldProxy("https://x.corp.example/x", { ...config, noProxy: "localhost,.corp.example" })).toBe(false);
    expect(shouldProxy("https://internal.example/x", { ...config, noProxy: ".corp.example,internal.example" })).toBe(false);
    // A port-mismatched entry is skipped; later entries are still consulted.
    expect(hostBypassed("x.corp.example", 8443, "other.com:443,.corp.example")).toBe(true);
    // And a listed host later in the list is not bypassed by an earlier non-entry alone.
    expect(shouldProxy("https://example.com/x", { ...config, noProxy: "other.com,example.com" })).toBe(false);
  });

  it("defaults wss to 443 and ws to 80 — the steward channel's effective ports", () => {
    expect(shouldProxy("wss://example.com/x", { ...config, noProxy: "example.com:443" })).toBe(false);
    expect(shouldProxy("wss://example.com/x", { ...config, noProxy: "example.com:80" })).toBe(true);
    expect(shouldProxy("ws://example.com/x", { ...config, noProxy: "example.com:80" })).toBe(false);
  });

  it("keeps IPv6 entries whole — bracketed and bare — when matching", () => {
    expect(shouldProxy("wss://[2001:db8::1]/x", { ...config, noProxy: "[2001:db8::1]" })).toBe(false);
    expect(shouldProxy("https://[2001:db8::1]:8443/x", { ...config, noProxy: "[2001:db8::1]:8443" })).toBe(false);
    expect(shouldProxy("https://[2001:db8::1]:8443/x", { ...config, noProxy: "[2001:db8::1]:443" })).toBe(true);
    expect(shouldProxy("https://[2001:db8::1]/x", { ...config, noProxy: "2001:db8::1" })).toBe(false);
    expect(shouldProxy("wss://[::1]/x", config)).toBe(false); // loopback still hard-bypassed
  });
});

describe("proxyEnvFor", () => {
  it("exports both cases and defaults NO_PROXY to loopback", () => {
    const env = proxyEnvFor({ url: "http://127.0.0.1:7890" });
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.https_proxy).toBe("http://127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe(DEFAULT_NO_PROXY);
    expect(env.no_proxy).toBe(DEFAULT_NO_PROXY);
  });

  it("carries a custom no_proxy list — merged with the loopback defaults", () => {
    // EnvHttpProxyAgent (the fetch channel) has no loopback bypass of its own, so the
    // exported list always keeps the defaults ("loopback never proxied" invariant).
    expect(proxyEnvFor({ url: "http://127.0.0.1:7890", noProxy: ".corp.example" }).NO_PROXY).toBe(
      "localhost,127.0.0.1,::1,.corp.example",
    );
    // A custom entry equal to a default is deduplicated, and `*` keeps matching everything.
    expect(proxyEnvFor({ url: "http://127.0.0.1:7890", noProxy: "localhost,*" }).NO_PROXY).toBe("localhost,127.0.0.1,::1,*");
  });
});

describe("resolveProxyConfig", () => {
  it("prefers flag over stored over environment", () => {
    const env = { HTTPS_PROXY: "http://from-env:1" };
    expect(resolveProxyConfig({ flag: "http://from-flag:1", stored: { url: "http://stored:1" }, env })).toMatchObject({
      source: "flag",
    });
    expect(resolveProxyConfig({ stored: { url: "http://stored:1" }, env })).toMatchObject({ source: "stored" });
    expect(resolveProxyConfig({ env })).toMatchObject({ source: "env", config: { url: "http://from-env:1/" } });
    expect(resolveProxyConfig({ env: {} })).toEqual({ config: null, source: null });
  });

  it("captures the shell's NO_PROXY alongside HTTPS_PROXY", () => {
    expect(resolveProxyConfig({ env: { HTTPS_PROXY: "http://from-env:1", NO_PROXY: ".corp.example" } }).config).toMatchObject({
      noProxy: ".corp.example",
    });
  });
});

describe("applyProxy", () => {
  it("sets child env, installs the global dispatcher, and maps ws targets to agents", async () => {
    await withCleanProxyState(() => {
      const application = applyProxy({ url: "http://127.0.0.1:7890", noProxy: ".corp.example" });
      expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
      expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.corp.example");
      expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);

      const remote = application.wsAgentFor("wss://sig.example.workers.dev/agents/steward/owner");
      expect(remote).toBeDefined(); // an agent for a proxied target…
      expect(application.wsAgentFor("ws://127.0.0.1:8787/dev-steward")).toBeUndefined(); // …none for loopback
      expect(application.wsAgentFor("wss://intranet.corp.example/x")).toBeUndefined(); // …none for no_proxy hosts
      expect(application.wsAgentFor("wss://sig.example.workers.dev/agents/steward/owner")).toBe(remote); // stable per target
    });
  });
});

describe("fetch through EnvHttpProxyAgent (the daemon's fetch channel)", () => {
  let proxy: Server;
  let seenUrls: string[] = [];
  const proxyPort = 0; // ephemeral, assigned on listen

  beforeAll(async () => {
    proxy = createServer((req, res) => {
      // A forward proxy sees absolute-form request targets; answering from the "proxy"
      // itself keeps the test off the real network entirely.
      seenUrls.push(String(req.url));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("via-proxy");
    });
    await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it("routes a global fetch through the configured proxy", async () => {
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP proxy address");
    seenUrls = [];
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: `http://127.0.0.1:${address.port}`,
      httpsProxy: `http://127.0.0.1:${address.port}`,
      noProxy: "", // test target is loopback; the real default bypasses it
    });
    // undici's own fetch, not the built-in one: the connector's proxied calls pass the
    // dispatcher to the same package's fetch, which can't mismatch handler protocols
    // across Node versions the way built-in fetch + a bundled dispatcher can.
    const res = await undiciFetch("http://127.0.0.1:64444/app", { dispatcher });
    expect(await res.text()).toBe("via-proxy");
    expect(seenUrls).toEqual(["http://127.0.0.1:64444/app"]);
  });
});
