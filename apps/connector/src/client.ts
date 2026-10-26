// Connector WebSocket client: connect, hello/welcome, reconnect (protocol §3.3/§3.5), the
// reliable command/event exchange (§4), and the bidirectional application-level heartbeat
// (ADR-0001 correction to §3.2): uplink `ping` with a pong timeout, plus an inter-frame
// timeout, so a half-dead TCP link is torn down and reconnected instead of buffering silently.
import { randomUUID } from "node:crypto";
import os from "node:os";
import WebSocket from "ws";
import {
  CloseCode,
  DirectoryListMessageSchema,
  PROTOCOL_VERSION,
  reconnectOn,
  ulid,
  type CmdMessage,
  type DirectoryListingMessage,
  type WelcomeMessage,
} from "@alexlikevibe/protocol";
import { CommandLog, type CommandResult } from "./commands.ts";
import { EventLog, type StoredEvent } from "./events.ts";
import { HistoryStreams } from "./history-stream.ts";
import type { HistoryPage } from "@alexlikevibe/protocol";
import type { Agent } from "node:http";
import type { LocalStore } from "./store.ts";
import { VERSION } from "./version.ts";
import { browseDirectory } from "./directory-browser.ts";

export type CommandHandler = (cmd: CmdMessage) => Promise<CommandResult>;

export interface ClientOptions {
  store: LocalStore;
  machineName?: string;
  WebSocketImpl?: typeof WebSocket;
  /** Per-URL `ws` agent (issue #68): returns an https/http proxy agent for targets that
   *  should be proxied, undefined for bypassed targets (loopback, no_proxy). */
  wsAgent?: (url: string) => Agent | undefined;
  onWelcome?: (welcome: WelcomeMessage) => void;
  onClose?: (code: number, reason: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  // Real command execution arrives with the connector-pi integration; without a handler the
  // connector rejects every kind so the DO's outbox row settles immediately.
  handleCommand?: CommandHandler;
  workersSnapshot?: () => Array<Record<string, unknown>>;
  /** Honest hello snapshot for the non-worker sections (protocol §6.1): agents, repos, limits. */
  snapshot?: () => { agents: unknown[]; repos: unknown[]; limits: { maxWorkers: number; running: number } };
  /** L3 raw-history loader (connector-pi.md §11.4): when set, `history_req` messages are
   *  answered with windowed `history_chunk` streams; without it they get `error{unsupported}`. */
  loadHistory?: (workerId: string, since: string | undefined, maxBytes: number, format?: "full") => Promise<HistoryPage>;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  deadAfterMs?: number;
  batchMs?: number;
  batchEvents?: number;
  batchBytes?: number;
}

const CREDENTIALS_CLEARING_CODES: ReadonlySet<number> = new Set([CloseCode.UNAUTHORIZED, CloseCode.REVOKED]);

const DEFAULT_PING_INTERVAL_MS = 25_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;
const DEFAULT_DEAD_AFTER_MS = 90_000;
const DEFAULT_BATCH_MS = 250;
const DEFAULT_BATCH_EVENTS = 50;
const DEFAULT_BATCH_BYTES = 64 * 1024;

export class ConnectorClient {
  private readonly store: LocalStore;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly bootId = randomUUID();
  private readonly commands: CommandLog;
  private readonly events: EventLog;
  private readonly options: ClientOptions;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly deadAfterMs: number;
  private readonly batchMs: number;
  private readonly batchEvents: number;
  private readonly batchBytes: number;
  private backoffMs: number;
  private stopped = true;
  private ws?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private pendingPing?: { id: string; sentAt: number };
  private lastFrameAt = 0;
  private sendQueue: StoredEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private directoryReads = 0;
  /** §6.6 history streams for the current connection; reset whenever the socket dies. */
  private readonly history: HistoryStreams | undefined;

  constructor(options: ClientOptions) {
    this.options = options;
    this.store = options.store;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.backoffMs = this.minBackoffMs;
    this.commands = new CommandLog(options.store.database);
    this.events = new EventLog(options.store.database);
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.deadAfterMs = options.deadAfterMs ?? DEFAULT_DEAD_AFTER_MS;
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS;
    this.batchEvents = options.batchEvents ?? DEFAULT_BATCH_EVENTS;
    this.batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
    this.history = options.loadHistory
      ? new HistoryStreams({
          // Always targets the current socket: a chunk for a dead connection is dropped by
          // the readyState check, and the close handler resets the streams anyway (§6.6: a
          // history request is never re-sent over a new connection).
          send: (message) => {
            const ws = this.ws;
            if (ws && ws.readyState === this.WebSocketImpl.OPEN) ws.send(JSON.stringify(message));
          },
          load: options.loadHistory,
        })
      : undefined;
    // A crash mid-`sending` is adjudicated from the persisted evidence at the next boot
    // (§6.3): marker commands become delivered/not_delivered from the session tail; the rest
    // stay honestly ambiguous. All outcomes ride hello.pendingAcks (protocol §6.1).
    this.commands.reconcileCrashed();
  }

  start(): void {
    this.stopped = false;
    this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000, "stopping");
  }

  // Appends an event to the durable log and queues it for the next batch (protocol §3.6).
  emit(workerId: string, fields: Record<string, unknown>): number {
    const stored = this.events.append(workerId, fields);
    this.enqueue([stored]);
    this.scheduleFlush();
    return stored.seq;
  }

  private connectOnce(): void {
    const credentials = this.store.getCredentials();
    if (!credentials) throw new Error("no credentials saved; pair with `connect <url> <code>` first");
    const connEpoch = this.store.nextConnEpoch();

    const wsUrl = `${toWsOrigin(credentials.serverUrl)}/agents/steward/owner?role=connector&proto=1`;
    const agent = this.options.wsAgent?.(wsUrl);
    const ws = new this.WebSocketImpl(wsUrl, agent ? { headers: { authorization: `Bearer ${credentials.token}` }, agent } : { headers: { authorization: `Bearer ${credentials.token}` } });
    this.ws = ws;

    ws.on("open", () => {
      this.lastFrameAt = Date.now();
      this.pendingPing = undefined;
      ws.send(
        JSON.stringify({
          t: "hello",
          id: ulid(),
          protocol: PROTOCOL_VERSION,
          deviceId: credentials.deviceId,
          bootId: this.bootId,
          connEpoch,
          connector: { version: VERSION, os: process.platform, arch: process.arch, node: process.version },
          capabilities: { directoryBrowse: true },
          machine: {
            name: this.options.machineName ?? os.hostname(),
            memTotalMB: Math.round(os.totalmem() / 1_000_000),
            memFreeMB: Math.round(os.freemem() / 1_000_000),
          },
          agents: this.options.snapshot?.().agents ?? [],
          repos: this.options.snapshot?.().repos ?? [],
          limits: this.options.snapshot?.().limits ?? { maxWorkers: 1, running: 0 },
          workers: this.options.workersSnapshot?.() ?? [],
          pendingAcks: this.commands.pendingAcks(),
        }),
      );
      this.startPingTimer(ws);
    });

    ws.on("message", (data: unknown) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      this.lastFrameAt = Date.now();
      this.handleMessage(ws, message);
    });

    ws.on("close", (code: number, reasonBuf: unknown) => {
      this.clearConnectionTimers();
      this.sendQueue = []; // unsent events stay in the durable log and are replayed after welcome
      this.history?.reset(); // §6.6: history requests are not re-sent; the browser retries
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

  private handleMessage(ws: WebSocket, message: Record<string, unknown>): void {
    switch (message.t) {
      case "welcome": {
        this.backoffMs = this.minBackoffMs;
        const welcome = message as unknown as WelcomeMessage;
        // SERVER_KEY rotation (issue #27): a welcome carrying `token` means the connection
        // authenticated with a key the steward is rotating away from; persist the fresh
        // primary-key token so the next reconnect uses it (no re-pairing needed).
        if (typeof welcome.token === "string" && welcome.token) {
          this.store.updateToken(welcome.token);
        }
        // welcome.acks doubles as a cumulative events_ack: everything <= upTo is durably
        // persisted server-side, so truncate locally, then replay what is still unacked (§4.3).
        for (const [workerId, upTo] of Object.entries(welcome.acks ?? {})) {
          this.events.truncate(workerId, upTo);
        }
        for (const workerId of this.events.workers()) {
          this.enqueue(this.events.pending(workerId));
        }
        this.scheduleFlush();
        this.options.onWelcome?.(welcome);
        return;
      }
      case "pong":
        this.pendingPing = undefined;
        return;
      case "events_ack":
        this.events.truncate(String(message.workerId), Number(message.upTo));
        return;
      case "resync": {
        const workerId = String(message.workerId);
        const from = Number(message.from);
        const { replay, gapFrom, gapTo } = this.events.rangeAvailable(from, workerId);
        if (gapFrom !== null && gapTo !== null) {
          // The local log already evicted the requested range (size cap): report the gap; the
          // DO marks it on the timeline and reconciles (protocol §4.3).
          this.send(ws, { t: "events_gap", workerId, from: gapFrom, to: gapTo });
        }
        this.enqueue(replay);
        this.scheduleFlush();
        return;
      }
      case "cmd":
        this.handleCmd(ws, message as unknown as CmdMessage);
        return;
      case "directory_list": {
        const parsed = DirectoryListMessageSchema.safeParse(message);
        if (!parsed.success) return;
        const request = parsed.data;
        if (this.directoryReads >= 4) {
          this.send(ws, { t: "directory_listing", re: request.id, ok: false, code: "busy" } satisfies DirectoryListingMessage);
          return;
        }
        this.directoryReads++;
        void browseDirectory(request).then((result) => {
          if (this.ws === ws) this.send(ws, { t: "directory_listing", re: request.id, ...result } satisfies DirectoryListingMessage);
        }).finally(() => { this.directoryReads--; });
        return;
      }
      case "history_req": {
        // §6.6: same wire as cmd but deliberately outside the outbox/command log — a fresh
        // request per browser view, deduped by nothing, re-sent by nobody.
        const req = message as { id?: unknown; workerId?: unknown; since?: unknown; maxBytes?: unknown; format?: unknown };
        if (typeof req.id !== "string" || typeof req.workerId !== "string") return;
        if (this.history) {
          this.history.onRequest({
            id: req.id,
            workerId: req.workerId,
            since: typeof req.since === "string" && req.since.length > 0 ? req.since : undefined,
            maxBytes: typeof req.maxBytes === "number" ? req.maxBytes : undefined,
            ...(req.format === "full" ? { format: "full" as const } : {}),
          });
        } else {
          this.send(ws, { t: "error", re: req.id, code: "unsupported", message: "history reads are not available on this connector", retriable: false });
        }
        return;
      }
      case "history_ack": {
        if (typeof message.re === "string" && typeof message.n === "number") this.history?.onAck(message.re, message.n);
        return;
      }
      default:
        return;
    }
  }

  private handleCmd(ws: WebSocket, cmd: CmdMessage): void {
    const known = this.commands.get(cmd.id);
    if (known) {
      if (known.state === "done" || known.state === "failed") {
        this.send(ws, { t: "cmd_ack", re: cmd.id, status: "duplicate", result: known.result ?? undefined });
      } else if (known.state === "ambiguous") {
        this.send(ws, { t: "cmd_ack", re: cmd.id, status: "ambiguous" });
      } else {
        // accepted/sending: already in flight; the result will arrive separately.
        this.send(ws, { t: "cmd_ack", re: cmd.id, status: "accepted" });
      }
      return;
    }
    this.commands.begin(cmd.id, commandMeta(cmd));
    const handler = this.options.handleCommand;
    if (!handler) {
      this.commands.settle(cmd.id, { ok: false, error: { code: "unsupported" } });
      this.send(ws, { t: "cmd_ack", re: cmd.id, status: "rejected", code: "unsupported" });
      return;
    }
    this.send(ws, { t: "cmd_ack", re: cmd.id, status: "accepted" });
    void this.runHandler(ws, handler, cmd);
  }

  private async runHandler(ws: WebSocket, handler: CommandHandler, cmd: CmdMessage): Promise<void> {
    this.commands.markSending(cmd.id);
    let result: CommandResult;
    try {
      result = await handler(cmd);
    } catch (err) {
      result = { ok: false, error: { code: "internal", message: err instanceof Error ? err.message : String(err) } };
    }
    // A zombie continuation (the handler outliving a shutdown/crash in tests; a stopping
    // daemon racing its last command in production) must not crash the process on the way
    // out: the restarted connector's recovery already owns the row, and the socket is gone.
    try {
      this.commands.settle(cmd.id, result);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ERR_INVALID_STATE") throw err;
      console.error("[sig] late command settle skipped (store closed):", cmd.id);
      return;
    }
    this.send(ws, { t: "cmd_result", re: cmd.id, ok: result.ok, data: result.data, error: result.error });
  }

  // ---- heartbeat ----

  private startPingTimer(ws: WebSocket): void {
    this.clearConnectionTimers();
    this.pingTimer = setInterval(() => this.pingTick(ws), this.pingIntervalMs);
  }

  private pingTick(ws: WebSocket): void {
    if (this.ws !== ws || this.stopped || ws.readyState !== this.WebSocketImpl.OPEN) return;
    const now = Date.now();
    const pongOverdue = this.pendingPing && now - this.pendingPing.sentAt > this.pongTimeoutMs;
    const dead = now - this.lastFrameAt > this.deadAfterMs;
    if (pongOverdue || dead) {
      // Half-dead link (spike bug 10): terminate forces an immediate TCP teardown so the
      // reconnect loop builds a fresh connection instead of buffering into a black hole.
      try {
        ws.terminate();
      } catch {
        // already closed; the close handler drives reconnection
      }
      return;
    }
    if (this.pendingPing) return; // still waiting for the previous pong
    this.pendingPing = { id: ulid(), sentAt: now };
    this.send(ws, { t: "ping", id: this.pendingPing.id });
  }

  private clearConnectionTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pendingPing = undefined;
  }

  // ---- event batching (protocol §3.6: 250ms | 50 items | 64KiB, whichever first) ----

  private enqueue(events: StoredEvent[]): void {
    if (events.length === 0) return;
    const queued = new Set(this.sendQueue.map((e) => `${e.workerId}:${e.seq}`));
    for (const event of events) {
      const key = `${event.workerId}:${event.seq}`;
      if (!queued.has(key)) {
        this.sendQueue.push(event);
        queued.add(key);
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.sendQueue.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.batchMs);
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== this.WebSocketImpl.OPEN) return; // stays queued; retried after welcome
    const batch: StoredEvent[] = [];
    let bytes = 0;
    while (this.sendQueue.length > 0 && batch.length < this.batchEvents) {
      const next = this.sendQueue[0]!;
      const size = next.payload.length;
      if (batch.length > 0 && bytes + size > this.batchBytes) break;
      batch.push(this.sendQueue.shift()!);
      bytes += size;
    }
    if (batch.length === 0) return;
    this.send(ws, { t: "events", id: ulid(), batch: batch.map((e) => JSON.parse(e.payload)) });
    if (this.sendQueue.length > 0) this.scheduleFlush();
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== this.WebSocketImpl.OPEN) return;
    ws.send(JSON.stringify(message));
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

function commandMeta(cmd: CmdMessage): import("./commands.ts").CommandMeta {
  const workerId = typeof cmd.args?.workerId === "string" && cmd.args.workerId.length > 0 ? cmd.args.workerId : cmd.workerId;
  return { workerId: workerId ?? null, kind: cmd.kind };
}
