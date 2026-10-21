// The daemon behind the background service (issue #26): loads credentials from the
// LocalStore, (re)installs the versioned pi assets, wires the ConnectorApp to the JSONL
// logger, and holds the connection open. Signal handling lives in the CLI (`daemon`
// subcommand); this module stays import-pure so tests can drive it directly.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter } from "./agent.ts";
import { ConnectorApp } from "./connector-app.ts";
import { installAssets } from "./install.ts";
import { Logger } from "./logger.ts";
import { applyProxy, proxyLogFields, resolveProxyConfig } from "./proxy.ts";
import { LocalStore } from "./store.ts";
import { VERSION } from "./version.ts";

export interface DaemonOptions {
  stateDir: string;
  machineName?: string;
  /** Test seams: fake agent adapters and injected WebSocket. */
  adapters?: AgentAdapter[];
  /** Single-adapter test seam. */
  adapter?: AgentAdapter;
  WebSocketImpl?: import("./client.ts").ClientOptions["WebSocketImpl"];
  /** Test seam: skip proxy activation (keeps process.env and the global dispatcher clean). */
  noProxy?: boolean;
  logger?: Logger;
}

export interface DaemonHandle {
  readonly logger: Logger;
  stop(): Promise<void>;
}

export async function runDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const dbPath = join(options.stateDir, "connector.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(`not paired: no local store at ${dbPath}; run \`sig connect <url> <code>\` first`);
  }
  const store = new LocalStore(dbPath);
  const credentials = store.getCredentials();
  if (!credentials) {
    store.close();
    throw new Error("not paired: no credentials in the local store; run `sig connect <url> <code>` first");
  }

  // The device token is the one secret the daemon holds; the logger scrubs it from every line.
  const logger =
    options.logger ??
    new Logger({ dir: join(options.stateDir, "logs"), secrets: [credentials.token] });

  // Every boot rewrites the versioned extension and prompt files (issue #26): after an
  // upgrade the new package's assets land here before any worker starts.
  const assets = installAssets(options.stateDir);
  logger.info("daemon_start", {
    version: VERSION,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    deviceId: credentials.deviceId,
    serverUrl: credentials.serverUrl,
    stateDir: options.stateDir,
    extension: assets.extensionPath,
  });

  // Issue #68: a proxy stored by `sig connect --proxy` / `sig proxy` is activated at boot —
  // env for children (git, pi workers), a global EnvHttpProxyAgent for fetch, a per-URL
  // agent for the WebSocket. Nothing rides on the service unit's environment.
  const resolved = resolveProxyConfig({ stored: store.getProxyConfig(), env: process.env });
  let wsAgent: import("./client.ts").ClientOptions["wsAgent"];
  if (resolved.config && !options.noProxy) {
    const application = applyProxy(resolved.config);
    wsAgent = application.wsAgentFor;
    logger.info("proxy_enabled", { ...proxyLogFields(resolved.config), source: resolved.source });
  }

  // A connection that drops without a close frame (1006) usually means the network path
  // is gone — on filtered networks that is the missing-proxy signature. Hint once after a
  // few in a row instead of letting the reconnect loop look like a steward bug.
  let abnormalCloses = 0;
  let hinted = false;

  const app = new ConnectorApp({
    store,
    stateDir: options.stateDir,
    machineName: options.machineName,
    adapters: options.adapters ?? (options.adapter ? [options.adapter] : undefined),
    adapter: options.adapter,
    WebSocketImpl: options.WebSocketImpl,
    wsAgent,
    log: (event, fields) => logger.info(event, fields),
    onWelcome: () => {
      abnormalCloses = 0; // a clean handshake proves the path works
      logger.info("welcomed", { serverUrl: credentials.serverUrl });
    },
    onClose: (code, reason) => {
      logger.warn("connection_closed", { code, reason: reason.slice(0, 200) });
      if (code === 1006 && ++abnormalCloses === 3 && !hinted) {
        hinted = true;
        logger.warn("connection_hint", {
          hint: "repeated abnormal closes: if the steward is only reachable through a proxy, set one with `sig proxy <url>` and diagnose with `sig doctor`",
        });
      }
    },
  });
  // §9.1 reconciliation completes before the first hello, so the workers snapshot + bootId
  // the DO reconciles against reflect the crash that preceded this boot (issue #12). A
  // reconciliation failure fails the daemon start (the supervisor restarts it).
  await app.start();

  return {
    logger,
    stop: async () => {
      app.stop();
      store.close();
      logger.info("daemon_stop", { pid: process.pid });
    },
  };
}
