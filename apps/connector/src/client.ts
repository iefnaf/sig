// Connector WebSocket client: connect, hello/welcome, and reconnect per protocol §3.3/§3.5.
import { randomUUID } from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import { CloseCode, PROTOCOL_VERSION, reconnectOn, ulid } from "@shepherd/protocol";
import type { LocalStore } from "./store.ts";

export interface ClientOptions {
  store: LocalStore;
  machineName?: string;
  WebSocketImpl?: typeof WebSocket;
  onWelcome?: (welcome: Record<string, unknown>) => void;
  onClose?: (code: number, reason: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const CREDENTIALS_CLEARING_CODES: ReadonlySet<number> = new Set([CloseCode.UNAUTHORIZED, CloseCode.REVOKED]);

export class ConnectorClient {
  private readonly store: LocalStore;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly bootId = randomUUID();
  private backoffMs: number;
  private stopped = true;
  private ws?: WebSocket;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.store = options.store;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.backoffMs = this.minBackoffMs;
  }

  start(): void {
    this.stopped = false;
    this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000, "stopping");
  }

  private connectOnce(): void {
    const credentials = this.store.getCredentials();
    if (!credentials) throw new Error("no credentials saved; pair with `connect <url> <code>` first");
    const connEpoch = this.store.nextConnEpoch();

    const wsUrl = `${toWsOrigin(credentials.serverUrl)}/agents/steward/owner?role=connector&proto=1`;
    const ws = new this.WebSocketImpl(wsUrl, { headers: { authorization: `Bearer ${credentials.token}` } });
    this.ws = ws;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          t: "hello",
          id: ulid(),
          protocol: PROTOCOL_VERSION,
          deviceId: credentials.deviceId,
          bootId: this.bootId,
          connEpoch,
          connector: { version: "0.1.0", os: process.platform, arch: process.arch, node: process.version },
          machine: {
            name: this.options.machineName ?? os.hostname(),
            memTotalMB: Math.round(os.totalmem() / 1_000_000),
            memFreeMB: Math.round(os.freemem() / 1_000_000),
          },
          agents: [],
          repos: [],
          limits: { maxWorkers: 1, running: 0 },
          workers: [],
          pendingAcks: [],
        }),
      );
    });

    ws.on("message", (data: unknown) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.t === "welcome") {
        this.backoffMs = this.minBackoffMs;
        this.options.onWelcome?.(message);
      }
    });

    ws.on("close", (code: number, reasonBuf: unknown) => {
      const reason = reasonBuf ? String(reasonBuf) : "";
      this.options.onClose?.(code, reason);
      if (CREDENTIALS_CLEARING_CODES.has(code)) this.store.clearCredentials();
      if (this.stopped || !reconnectOn(code)) return;
      // Protocol §3.5 says 4429 should back off per `retryAfterMs` rather than the generic
      // backoff; the doc doesn't specify where that value lives in the close frame, so this
      // falls back to the standard jittered backoff until the wire encoding is settled.
      this.scheduleReconnect();
    });

    // "close" always follows "error" on the `ws` client; reconnect decisions live there.
    ws.on("error", () => {});
  }

  private scheduleReconnect(): void {
    const jitter = Math.floor(Math.random() * this.backoffMs * 0.2);
    const delay = this.backoffMs + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    setTimeout(() => {
      if (!this.stopped) this.connectOnce();
    }, delay);
  }
}

function toWsOrigin(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}
