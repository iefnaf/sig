// The steward Durable Object: device pairing, auth, the hello/welcome handshake, the command
// outbox, the event inbox, and the bidirectional heartbeat. See docs/design/connector-do-protocol.md
// §4 (envelope and reliability), §6.2-6.4 (commands/events), ADR-0001 (heartbeat + redelivery
// corrections), and docs/spike-conclusions.md bugs 5 and 10.
//
// Channel layer (issue #4, steward.md §6.1 / §9): the SETUP_TOKEN-guarded setup page, manual
// Feishu credentials, the webhook inbound path, and the alarm-driven outbound queue.
//
// Ledger core (issue #5, steward.md §2/§5/§6): machines/repositories from hello, online state
// from connections, the deterministic event reducer (one transaction, derived Thread state),
// core-template done reports with no LLM, and fixed-phrase dispatch. Every sh_ledger table is
// reached through the memory module (ledger.ts); this class only wires it to the transports.
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import {
  CloseCode,
  CmdAckMessageSchema,
  CmdResultMessageSchema,
  EventsGapMessageSchema,
  EventsMessageSchema,
  HelloMessageSchema,
  PingMessageSchema,
  PROTOCOL_VERSION,
  generatePairingCode,
  mintToken,
  parseToken,
  ulid,
  type CmdMessage,
  type ErrorMessage,
  type EventsAckMessage,
  type PongMessage,
  type ResyncMessage,
  type WelcomeMessage,
} from "@shepherd/protocol";
import { bearer } from "./auth.ts";
import {
  FeishuAdapter,
  SEND_TIMEOUT_MS,
  TOKEN_REFRESH_MARGIN_MS,
  type FeishuCredentials,
} from "./channel/feishu.ts";
import { RetriableChannelError, type InboundEvent } from "./channel/types.ts";
import { Dispatcher } from "./dispatch.ts";
import { createLedger, type Ledger, type LedgerSql, type NotifyRow } from "./ledger.ts";
import { failureCard, reportCardFor } from "./report-template.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { renderSetupPage } from "./setup-page.ts";

interface ConnState {
  deviceId: string;
  connEpoch?: number;
}

export interface OutboxRow {
  cmdId: string;
  deviceId: string;
  workerId: string | null;
  cseq: number;
  kind: string;
  payload: string;
  notAfter: number | null;
  state: string;
  failReason: string | null;
  attempts: number;
  sentAt: number | null;
  ackDeadline: number | null;
  result: string | null;
  createdAt: number;
}

// Protocol §4.2: 15s ack deadline; "re-sends once more... after two failures it marks the
// machine suspect" — one resend (attempt 2), then a second timeout marks failed(ack_timeout).
const ACK_DEADLINE_MS = 15_000;
const MAX_SEND_ATTEMPTS = 2;
// spike-conclusions bug 5: a command queued for an offline device must not wait forever.
const IDLE_FAIL_MS = 30 * 60_000;
const IDLE_SWEEP_INTERVAL_S = 60;
// New commands default to a 10-minute expiry (protocol §4.2); callers that want "wait for it
// to come online" pass `notAfter: null` explicitly.
const DEFAULT_NOTAFTER_MS = 10 * 60_000;

// ---- Channel: Feishu webhook inbound + outbound queue (steward.md §6.1, §9; spike bugs 1, 3) ----
// A claim is the double-send guard (bug 1): the conditional UPDATE hands a row to exactly one
// delivery pass; it outlives the 10s send timeout so a merely-slow send keeps its owner.
const OUTBOUND_CLAIM_MS = 30_000;
// feishu-channel.md §4: 5 QPS per receiver — space sends ≥220ms apart, with margin.
const OUTBOUND_SEND_SPACING_MS = 220;
// Alarm-driven exponential backoff retries (bug 3): 5s, 10s, 20s … capped at 15min, terminal
// after 8 attempts (~1h of retrying).
const OUTBOUND_BACKOFF_BASE_MS = 5_000;
const OUTBOUND_BACKOFF_CAP_MS = 15 * 60_000;
const OUTBOUND_MAX_ATTEMPTS = 8;
const OUTBOUND_BATCH = 20;
const OWNER_BOUND_REPLY = "✅ 已绑定，设置完成。此后直接在这里与 Shepherd 对话即可；设置页面已永久关闭。";

export interface ShOutboundRow {
  id: string;
  channel: string;
  kind: string;
  receiveId: string;
  threadId: string | null;
  payload: string;
  urgency: string;
  status: string;
  attempts: number;
  claimToken: string | null;
  claimExpiresAt: number | null;
  nextAttemptAt: number;
  providerMsgId: string | null;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function versionRangesOverlap(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  return a.min <= b.max && b.min <= a.max;
}

// Base `Connection` (unknown state) is used in overridden signatures — narrowing the state
// generic there breaks Liskov substitutability against `Agent`'s own declarations; state is
// cast at the read/write sites instead (same tradeoff the do-protocol spike made).
export class Steward extends Agent<Env> {
  onStart(): void {
    runMigrations(this.sql.bind(this), MIGRATIONS);
  }

  // The memory module (steward.md §2): all sh_* ledger SQL lives behind this handle. Bound
  // lazily because `sql`/`ctx` only mean something once the DO is live.
  private ledger_?: Ledger;
  private get ledger(): Ledger {
    return (this.ledger_ ??= createLedger({
      sql: this.sql.bind(this) as unknown as LedgerSql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    }));
  }

  private dispatcher_?: Dispatcher;
  private get dispatcher(): Dispatcher {
    return (this.dispatcher_ ??= new Dispatcher({
      ledger: this.ledger,
      enqueueCommand: (deviceId, kind, args, opts) => this.enqueue(deviceId, kind, args, opts),
      // Withdraw only what never left the DO (still `queued`); a sent command may already be
      // persisted connector-side, and at-most-once beats a maybe-duplicate cancel (§4.2).
      cancelQueuedCommand: (cmdId) => {
        this.sql`UPDATE outbox SET state = 'expired' WHERE cmdId = ${cmdId} AND state = 'queued'`;
        return this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      },
      sendText: async (text, threadId) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "text", to: owner, text, threadId: threadId ?? null, urgency: "push" });
      },
      sendCard: async (card, threadId) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "card", to: owner, card, threadId, urgency: "push" });
      },
    }));
  }

  private ownerOpenIdSync(): string | null {
    return this.sql<{ ownerOpenId: string | null }>`
      SELECT ownerOpenId FROM sh_channel WHERE channel = 'feishu'
    `[0]?.ownerOpenId ?? null;
  }

  // Plain-HTTP surface reached via the Worker's stub.fetch forwards (index.ts): the Feishu
  // webhook (unauthenticated — the adapter validates Feishu's own token) and the setup page
  // (the Worker has already checked SETUP_TOKEN before forwarding).
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/channels/feishu/events" && request.method === "POST") {
      return this.handleFeishuWebhook(request);
    }
    if (url.pathname === "/setup" && (request.method === "GET" || request.method === "POST")) {
      return this.handleSetup(request);
    }
    return new Response("not found", { status: 404 });
  }

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  async getConnectionTags(_connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const parsed = await parseToken(this.env.SERVER_KEY, bearer(ctx.request));
    return parsed ? [`dev:${parsed.deviceId}`] : [];
  }

  private sendError(connection: Connection, code: ErrorMessage["code"], message: string, re?: string): void {
    connection.send(JSON.stringify({ t: "error", re, code, message, retriable: false }));
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const parsed = await parseToken(this.env.SERVER_KEY, bearer(ctx.request));
    if (!parsed) {
      connection.close(CloseCode.UNAUTHORIZED, "unauthorized");
      return;
    }
    const row = this.sql<{ name: string | null; epoch: number; revoked: number }>`
      SELECT name, epoch, revoked FROM device WHERE deviceId = ${parsed.deviceId}
    `[0];
    if (!row) {
      connection.close(CloseCode.UNAUTHORIZED, "unknown device");
      return;
    }
    if (row.revoked || row.epoch !== parsed.epoch) {
      connection.close(CloseCode.REVOKED, "revoked");
      return;
    }
    connection.setState({ deviceId: parsed.deviceId } satisfies ConnState);
    // Machine online state derives from live connections (issue #5): this and onClose are the
    // only writers. hello fills in the machine's real name and facts moments later.
    this.ledger.machines.setOnline(parsed.deviceId, true, row.name ?? undefined);
  }

  onClose(connection: Connection): void {
    const state = connection.state as unknown as ConnState | null;
    if (!state?.deviceId) return;
    // A superseded old connection closes after its replacement is live: only the last
    // connection for the device takes the machine offline.
    const remaining = [...this.getConnections<ConnState>(`dev:${state.deviceId}`)].filter((c) => c.id !== connection.id);
    if (remaining.length === 0) this.ledger.machines.setOnline(state.deviceId, false);
  }

  async onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendError(connection, "bad_request", "invalid JSON");
      return;
    }
    const t = (message as { t?: unknown }).t;
    switch (t) {
      case "hello":
        this.handleHello(connection, message);
        return;
      case "ping":
        this.handlePing(connection, message);
        return;
      case "cmd_ack":
        this.handleCmdAck(message);
        return;
      case "cmd_result":
        this.handleCmdResult(message);
        return;
      case "events":
        this.handleEvents(connection, message);
        return;
      case "events_gap":
        // protocol §4.3: the connector's local log already evicted the requested range.
        // Surfacing this to the steward (timeline + `reconcile`) is a later ticket; for now
        // the DO just accepts the report instead of answering "unsupported".
        EventsGapMessageSchema.safeParse(message);
        return;
      default:
        break;
    }
    const opt = (message as { opt?: unknown }).opt === true;
    if (opt) return;
    const id = (message as { id?: unknown }).id;
    this.sendError(connection, "unsupported", `unknown message type ${JSON.stringify(t)}`, typeof id === "string" ? id : undefined);
  }

  private handlePing(connection: Connection, raw: unknown): void {
    const parsed = PingMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    connection.send(JSON.stringify({ t: "pong", re: parsed.data.id } satisfies PongMessage));
  }

  private handleHello(connection: Connection, raw: unknown): void {
    const parsedHello = HelloMessageSchema.safeParse(raw);
    if (!parsedHello.success) {
      this.sendError(connection, "bad_request", "invalid hello");
      return;
    }
    const hello = parsedHello.data;
    if (!versionRangesOverlap(hello.protocol, PROTOCOL_VERSION)) {
      connection.close(CloseCode.VERSION_MISMATCH, `supported ${PROTOCOL_VERSION.min}-${PROTOCOL_VERSION.max}`);
      return;
    }
    const auth = connection.state as unknown as ConnState | null;
    if (!auth?.deviceId || auth.deviceId !== hello.deviceId) {
      connection.close(CloseCode.UNAUTHORIZED, "device mismatch");
      return;
    }
    for (const other of this.getConnections<ConnState>(`dev:${auth.deviceId}`)) {
      if (other.id === connection.id) continue;
      const otherEpoch = other.state?.connEpoch ?? -1;
      if (hello.connEpoch <= otherEpoch) {
        connection.close(CloseCode.SUPERSEDED, "superseded by an existing connection");
        return;
      }
      other.close(CloseCode.SUPERSEDED, "superseded by a newer connection");
    }
    connection.setState({ deviceId: auth.deviceId, connEpoch: hello.connEpoch } satisfies ConnState);
    // hello is the machine/repo snapshot's source of truth (protocol §6.1, steward.md §2.2):
    // name, agents, limits, and the full repo list — removals included — land in the ledger.
    this.ledger.machines.upsertFromHello(hello);
    const acks = Object.fromEntries(
      this.sql<{ workerId: string; upTo: number }>`SELECT workerId, upTo FROM worker_ack`.map((row) => [row.workerId, row.upTo]),
    );
    const welcome: WelcomeMessage = {
      t: "welcome",
      re: hello.id,
      protocol: PROTOCOL_VERSION.max,
      serverTime: Date.now(),
      sessionId: ulid(),
      acks,
      limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
    };
    connection.send(JSON.stringify(welcome));
    // Reconciliation (protocol §6.1): the connector reports the states of commands that never
    // settled (e.g. `ambiguous` after a crash mid-sending). Settle the matching outbox rows;
    // ambiguous rows are never re-delivered (§4.2).
    for (const pending of hello.pendingAcks) {
      if (pending.state === "ambiguous") {
        this.sql`UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')`;
      } else if (pending.state === "done" || pending.state === "failed") {
        this.sql`
          UPDATE outbox SET state = ${pending.state}, result = ${JSON.stringify({ source: "pendingAck" })}
          WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
        `;
      }
    }
    this.redeliverOutbox(auth.deviceId);
    // A reconnect is also the natural catch-up point for events persisted but not yet reduced
    // (crash between the events_ack and the reducer, protocol §4.3): drain, then notify.
    this.applyLedgerEvents();
  }

  // protocol §4.2 + ADR-0001 (spike bug 10): hello redelivers queued, sent, AND
  // ack-timeout-failed commands — a silently-dead downlink must not permanently lose a
  // command just because its ack deadline happened to expire before the reconnect.
  private redeliverOutbox(deviceId: string): void {
    this.sql`
      UPDATE outbox SET state = 'queued', attempts = 0, failReason = NULL
      WHERE deviceId = ${deviceId} AND state = 'failed' AND failReason = 'ack_timeout'
    `;
    const pending = this.sql<{ cmdId: string }>`
      SELECT cmdId FROM outbox WHERE deviceId = ${deviceId} AND state IN ('queued', 'sent') ORDER BY cseq
    `;
    for (const row of pending) this.deliver(row.cmdId);
  }

  private handleCmdAck(raw: unknown): void {
    const parsed = CmdAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const ack = parsed.data;
    if (ack.status === "accepted") {
      this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
    } else if (ack.status === "duplicate") {
      if (ack.result) {
        this.sql`
          UPDATE outbox SET state = ${ack.result.ok ? "done" : "failed"}, result = ${JSON.stringify(ack.result)}
          WHERE cmdId = ${ack.re}
        `;
      } else {
        this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
      }
    } else if (ack.status === "rejected") {
      this.sql`
        UPDATE outbox SET state = 'failed', failReason = 'rejected', result = ${JSON.stringify({ code: ack.code ?? null })}
        WHERE cmdId = ${ack.re}
      `;
      this.noteCommandFailure(ack.re, `连接器拒绝（${ack.code ?? "未知原因"}）`);
    } else if (ack.status === "ambiguous") {
      // protocol §4.2: a crash during `sending`, undecidable — no automatic re-send.
      this.sql`UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${ack.re}`;
    }
  }

  private handleCmdResult(raw: unknown): void {
    const parsed = CmdResultMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const result = parsed.data;
    this.sql`
      UPDATE outbox SET state = ${result.ok ? "done" : "failed"}, result = ${JSON.stringify(result.ok ? result.data ?? null : result.error ?? null)}
      WHERE cmdId = ${result.re}
    `;
    if (!result.ok) {
      const error = (result.error ?? {}) as { code?: unknown; message?: unknown };
      const reason = [typeof error.code === "string" ? error.code : null, typeof error.message === "string" ? error.message : null]
        .filter((part): part is string => part !== null)
        .join("：") || "未知原因";
      this.noteCommandFailure(result.re, reason);
    }
  }

  // A start_worker the connector could not run: the worker lands `broken`, the failure reaches
  // the timeline + the user deterministically (there is no LLM to relay it in M1). Idempotent
  // on the cmdId — cmd_result redeliveries re-run this handler.
  private noteCommandFailure(cmdId: string, reason: string): void {
    const row = this.sql<{ workerId: string | null; kind: string }>`
      SELECT workerId, kind FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || row.kind !== "start_worker" || !row.workerId) return;
    if (this.ledger.workers.markStartFailed(row.workerId, cmdId, reason)) {
      void this.drainNotifications();
    }
  }

  private handleEvents(connection: Connection, raw: unknown): void {
    const parsed = EventsMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(connection, "bad_request", "invalid events");
      return;
    }
    const touched = new Set<string>();
    for (const event of parsed.data.batch) {
      const exists = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${event.workerId} AND seq = ${event.seq}
      `[0]!.n;
      if (!exists) {
        this.sql`
          INSERT INTO event_inbox (workerId, seq, payload, receivedAt) VALUES (${event.workerId}, ${event.seq}, ${JSON.stringify(event)}, ${Date.now()})
        `;
      }
      touched.add(event.workerId);
    }
    for (const workerId of touched) {
      this.sql`INSERT OR IGNORE INTO worker_ack (workerId, upTo) VALUES (${workerId}, 0)`;
      // advance the cumulative ack through every contiguous seq already received
      for (;;) {
        const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
        const hasNext = this.sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq = ${upTo + 1}
        `[0]!.n;
        if (!hasNext) break;
        this.sql`UPDATE worker_ack SET upTo = ${upTo + 1} WHERE workerId = ${workerId}`;
      }
      const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
      connection.send(JSON.stringify({ t: "events_ack", workerId, upTo } satisfies EventsAckMessage));
      const gapCount = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq > ${upTo + 1}
      `[0]!.n;
      if (gapCount > 0) {
        connection.send(JSON.stringify({ t: "resync", workerId, from: upTo + 1 } satisfies ResyncMessage));
      }
    }
    // Persisted and acked above; now reduce into the ledger (protocol §4.3 keeps the two
    // decoupled — a crash here leaves the rows pending for the next wake's catch-up).
    this.applyLedgerEvents();
  }

  /** Reduces everything pending, then turns notification intents into outbound cards (§5.1). */
  private applyLedgerEvents(): void {
    try {
      const { applied } = this.ledger.applyPendingEvents();
      if (applied > 0) void this.drainNotifications();
    } catch (err) {
      this.logChannel("ledger_apply_failed", errorText(err));
    }
  }

  // Single-flight drain, same pattern as deliverOutbound: concurrent wake sources (events,
  // hello, cmd failures) chain instead of racing, so an intent is enqueued exactly once.
  private notifyChain: Promise<void> = Promise.resolve();

  drainNotifications(): Promise<void> {
    const run = this.notifyChain.then(() => this.drainNotifyPass());
    this.notifyChain = run.catch(() => {});
    return run;
  }

  private async drainNotifyPass(): Promise<void> {
    const cfg = await this.loadFeishuConfig();
    for (const intent of this.ledger.notifications.pending()) {
      try {
        if (!cfg?.ownerOpenId) continue; // no owner yet: the intent stays pending, not lost
        const card = this.renderNotification(intent);
        if (card === null) {
          // Its data is gone (thread archived / worker pruned); drop the intent rather than
          // retry forever.
          this.ledger.notifications.markSent(intent.id);
          continue;
        }
        await this.enqueueOutbound({ kind: "card", to: cfg.ownerOpenId, threadId: intent.threadId, card, urgency: "push" });
        this.ledger.notifications.markSent(intent.id);
      } catch (err) {
        this.logChannel("notify_drain_failed", `${intent.id} ${errorText(err)}`);
      }
    }
  }

  /** Deterministic core templates (steward.md §6.2 source 1): data in, card out, no LLM. */
  private renderNotification(intent: NotifyRow): unknown | null {
    const worker = intent.workerId ? this.ledger.workers.get(intent.workerId) : null;
    const thread = this.ledger.threads.get(intent.threadId);
    if (!worker || !thread) return null;
    const machine = this.ledger.machines.get(worker.deviceId);
    const machineName = machine?.name ?? worker.deviceId;
    const footer = `Thread「${thread.title}」 · ${worker.agent} @ ${machineName} · 引用回复可继续这个 Thread`;

    if (intent.kind === "done_report" || intent.kind === "attention_report") {
      const report = this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      if (!report) return null;
      return reportCardFor(report, worker, machineName, thread.title);
    }

    // failure_push: either the start never happened or the run ended in a failure class that
    // needs a human (steward.md §5.3); the matching open question carries the specifics.
    if (worker.lastOutcome?.startsWith("start_failed:")) {
      return failureCard(
        `派发失败：任务没有开始`,
        `${worker.lastOutcome.slice("start_failed:".length)}。重新 /派发 一次即可。`,
        thread.title,
        footer,
      );
    }
    const question = this.ledger.questions.openForThread(thread.threadId);
    return failureCard("运行出错，需要你决定下一步", question?.text ?? "查看 Thread 时间线了解详情。", thread.title, footer);
  }

  // Not wired to any HTTP route yet (the setup page / chat command that triggers this is a
  // later ticket); callable via RPC on the stub. `/pair` below is the only consumer for now.
  async createPairing(): Promise<{ code: string }> {
    const code = generatePairingCode();
    this.sql`INSERT INTO pairing (code, expiresAt) VALUES (${code}, ${Date.now() + 10 * 60_000})`;
    return { code };
  }

  async pair(code: string, name: string): Promise<{ deviceId: string; token: string } | null> {
    const row = this.sql<{ expiresAt: number; used: number }>`
      SELECT expiresAt, used FROM pairing WHERE code = ${code}
    `[0];
    if (!row || row.used || row.expiresAt < Date.now()) return null;
    this.sql`UPDATE pairing SET used = 1 WHERE code = ${code}`;
    const deviceId = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.sql`INSERT INTO device (deviceId, name, epoch, createdAt) VALUES (${deviceId}, ${name}, 1, ${Date.now()})`;
    const token = await mintToken(this.env.SERVER_KEY, deviceId, 1);
    return { deviceId, token };
  }

  async revoke(deviceId: string): Promise<void> {
    this.sql`UPDATE device SET epoch = epoch + 1, revoked = 1 WHERE deviceId = ${deviceId}`;
    for (const connection of this.getConnections<ConnState>(`dev:${deviceId}`)) {
      connection.close(CloseCode.REVOKED, "revoked");
    }
  }

  // Enqueues a command for a device's outbox and attempts immediate delivery (protocol §4.2).
  // `notAfter` defaults to issuance + 10 minutes; pass `null` explicitly for "wait until online".
  // `ackTimeoutMs` overrides the 15s ack deadline (tests shrink it to exercise alarm paths fast).
  async enqueue(
    deviceId: string,
    kind: string,
    args: unknown,
    opts: { workerId?: string; notAfter?: number | null; ackTimeoutMs?: number } = {},
  ): Promise<{ cmdId: string; cseq: number; state: string }> {
    const cseq = (this.sql<{ m: number | null }>`SELECT MAX(cseq) AS m FROM outbox WHERE deviceId = ${deviceId}`[0]?.m ?? 0) + 1;
    const cmdId = ulid();
    const notAfter = opts.notAfter === undefined ? Date.now() + DEFAULT_NOTAFTER_MS : opts.notAfter;
    this.sql`
      INSERT INTO outbox (cmdId, deviceId, workerId, cseq, kind, payload, notAfter, state, createdAt)
      VALUES (${cmdId}, ${deviceId}, ${opts.workerId ?? null}, ${cseq}, ${kind}, ${JSON.stringify(args ?? {})}, ${notAfter}, 'queued', ${Date.now()})
    `;
    this.deliver(cmdId, opts.ackTimeoutMs);
    const state = this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${cmdId}`[0]!.state;
    return { cmdId, cseq, state };
  }

  async outboxRow(cmdId: string): Promise<OutboxRow | null> {
    return (this.sql`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0] as OutboxRow | undefined) ?? null;
  }

  async inboxCount(workerId: string): Promise<number> {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId}`[0]!.n;
  }

  private connFor(deviceId: string): Connection | undefined {
    for (const connection of this.getConnections<ConnState>(`dev:${deviceId}`)) return connection;
    return undefined;
  }

  // Sends one outbox row if the device has a live connection and the command hasn't expired;
  // (re)arms the ack-deadline alarm. Returns whether the command was actually sent.
  private deliver(cmdId: string, ackTimeoutMs = ACK_DEADLINE_MS): boolean {
    const row = this.sql<{
      deviceId: string;
      workerId: string | null;
      cseq: number;
      kind: string;
      payload: string;
      notAfter: number | null;
      state: string;
    }>`
      SELECT deviceId, workerId, cseq, kind, payload, notAfter, state FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || (row.state !== "queued" && row.state !== "sent")) return false;
    const now = Date.now();
    if (row.notAfter !== null && row.notAfter < now) {
      this.sql`UPDATE outbox SET state = 'expired' WHERE cmdId = ${cmdId}`;
      return false;
    }
    const connection = this.connFor(row.deviceId);
    if (!connection) {
      void this.schedule(IDLE_SWEEP_INTERVAL_S, "sweepIdle");
      return false;
    }
    const cmd: CmdMessage = {
      t: "cmd",
      id: cmdId,
      cseq: row.cseq,
      kind: row.kind,
      workerId: row.workerId ?? undefined,
      notAfter: row.notAfter,
      args: JSON.parse(row.payload),
    };
    connection.send(JSON.stringify(cmd));
    const ackDeadline = now + ackTimeoutMs;
    this.sql`
      UPDATE outbox SET state = 'sent', attempts = attempts + 1, sentAt = ${now}, ackDeadline = ${ackDeadline} WHERE cmdId = ${cmdId}
    `;
    void this.schedule(Math.max(1, Math.ceil(ackTimeoutMs / 1000)), "resendUnacked");
    return true;
  }

  // Alarm-driven, survives hibernation: state lives in SQLite, not in-memory timers.
  async resendUnacked(): Promise<void> {
    const due = this.sql<{ cmdId: string; attempts: number }>`
      SELECT cmdId, attempts FROM outbox WHERE state = 'sent' AND ackDeadline <= ${Date.now()}
    `;
    for (const row of due) {
      if (row.attempts >= MAX_SEND_ATTEMPTS) {
        this.sql`UPDATE outbox SET state = 'failed', failReason = 'ack_timeout' WHERE cmdId = ${row.cmdId}`;
      } else if (!this.deliver(row.cmdId)) {
        // Deadline passed and there is no live connection (deliver refused): park the row back
        // in `queued` for redelivery at the next hello. Leaving it `sent` would hot-loop the
        // alarm every second and never settle. The idle sweep backstops a device that never
        // returns; notAfter already-expired rows were marked by deliver itself.
        this.sql`UPDATE outbox SET state = 'queued' WHERE cmdId = ${row.cmdId} AND state = 'sent'`;
      }
    }
    // `schedule()` has whole-second granularity, so an alarm can fire slightly before a
    // millisecond-precision ackDeadline. Re-arm while anything is still waiting for an ack,
    // or a command could get stuck in `sent` forever (the spike's bug, protocol §4.2).
    const waiting = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent'`[0]!.n;
    if (waiting > 0) void this.schedule(1, "resendUnacked");
  }

  // Periodic backstop (spike-conclusions bug 5): a command queued for a device that never
  // comes back must not wait forever even when `notAfter` is null ("wait until online").
  async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_FAIL_MS;
    const stale = this.sql<{ cmdId: string }>`SELECT cmdId FROM outbox WHERE state = 'queued' AND createdAt <= ${cutoff}`;
    for (const row of stale) {
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'idle' WHERE cmdId = ${row.cmdId}`;
    }
    const waiting = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM outbox WHERE state = 'queued'`[0]!.n;
    if (waiting > 0) void this.schedule(IDLE_SWEEP_INTERVAL_S, "sweepIdle");
  }

  // =================================================================================================
  // Channel: setup page, Feishu webhook inbound, outbound queue (steward.md §6.1, §9)
  // =================================================================================================

  // Tests shrink this via runInDurableObject to exercise the timeout path quickly.
  protected feishuSendTimeoutMs = SEND_TIMEOUT_MS;

  // Single-flight delivery: concurrent passes (inline enqueue fire + alarm + explicit calls)
  // chain here instead of racing. Without this, two passes could interleave around the
  // per-receiver pacing sleep and burst past the 5 QPS cap; the claim token still guards the
  // row itself, this keeps the *wire* quiet too.
  private deliveryChain: Promise<void> = Promise.resolve();

  private async loadFeishuConfig(): Promise<(FeishuCredentials & { ownerOpenId: string | null }) | null> {
    const row = this.sql<{ appId: string; appSecretEnc: string; verificationTokenEnc: string; ownerOpenId: string | null }>`
      SELECT appId, appSecretEnc, verificationTokenEnc, ownerOpenId FROM sh_channel WHERE channel = 'feishu'
    `[0];
    if (!row) return null;
    // A failed open means SERVER_KEY was rotated (secretbox.ts): read back as unconfigured so
    // the SETUP_TOKEN-guarded setup page accepts fresh credentials — recovery, not a deadlock.
    const appSecret = await openSecret(this.env.SERVER_KEY, row.appSecretEnc);
    const verificationToken = await openSecret(this.env.SERVER_KEY, row.verificationTokenEnc);
    if (appSecret === null || verificationToken === null) return null;
    return { appId: row.appId, appSecret, verificationToken, ownerOpenId: row.ownerOpenId };
  }

  protected newFeishuAdapter(credentials: FeishuCredentials): FeishuAdapter {
    return new FeishuAdapter({
      credentials,
      tokenStore: {
        getCachedToken: () =>
          (this.sql<{ token: string; expiresAt: number }>`
            SELECT token, expiresAt FROM sh_channel_token WHERE channel = 'feishu'
          `[0] ?? null),
        saveToken: (token, expiresAt) => {
          this.sql`
            INSERT INTO sh_channel_token (channel, token, expiresAt) VALUES ('feishu', ${token}, ${expiresAt})
            ON CONFLICT (channel) DO UPDATE SET token = excluded.token, expiresAt = excluded.expiresAt
          `;
          // steward.md §9.2: the token is refreshed by an alarm ahead of its expiry.
          void this.schedule(
            Math.max(1, Math.ceil((expiresAt - TOKEN_REFRESH_MARGIN_MS - Date.now()) / 1000)),
            "refreshChannelToken",
          );
        },
      },
      // FEISHU_API exists only in tests (a service binding that mocks Feishu); production
      // calls the real endpoint via global fetch.
      fetcher: this.env.FEISHU_API ? (this.env.FEISHU_API.fetch.bind(this.env.FEISHU_API) as typeof fetch) : undefined,
      sendTimeoutMs: this.feishuSendTimeoutMs,
    });
  }

  // Scheduled callback: keep tenant_access_token fresh even while nothing is being sent.
  async refreshChannelToken(): Promise<void> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return;
    const cached = this.sql<{ token: string; expiresAt: number }>`
      SELECT token, expiresAt FROM sh_channel_token WHERE channel = 'feishu'
    `[0];
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return;
    try {
      await this.newFeishuAdapter(cfg).getTenantAccessToken();
    } catch {
      // Retry lazily; a send needing the token retries the fetch on demand anyway.
      void this.schedule(600, "refreshChannelToken");
    }
  }

  private async handleSetup(request: Request): Promise<Response> {
    const cfg = await this.loadFeishuConfig();
    // ADR-0001 decision 8: once the owner is bound the setup page is closed permanently.
    if (cfg?.ownerOpenId) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const webhookUrl = `${url.origin}/channels/feishu/events`;
    const page = (opts: { state: "form" | "awaiting_owner"; error?: string; appIdValue?: string }) =>
      new Response(renderSetupPage({ ...opts, actionUrl: `${url.pathname}${url.search}`, webhookUrl }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    if (request.method === "GET") {
      return page({ state: cfg ? "awaiting_owner" : "form" });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return page({ state: "form", error: "表单解析失败，请重试。" });
    }
    const appId = String(form.get("appId") ?? "").trim();
    const appSecret = String(form.get("appSecret") ?? "").trim();
    const verificationToken = String(form.get("verificationToken") ?? "").trim();
    if (!appId || !appSecret || !verificationToken) {
      return page({ state: "form", error: "三个字段都必填。", appIdValue: appId });
    }

    // Validate live: a tenant_access_token must actually be obtainable with these credentials
    // (and the fresh token is cached for the first send). adapter.getTenantAccessToken() is
    // public for exactly this reuse.
    try {
      await this.newFeishuAdapter({ appId, appSecret, verificationToken }).getTenantAccessToken();
    } catch (err) {
      return page({ state: "form", error: `凭据校验失败：${errorText(err)}`, appIdValue: appId });
    }

    const [appSecretEnc, verificationTokenEnc] = await Promise.all([
      sealSecret(this.env.SERVER_KEY, appSecret),
      sealSecret(this.env.SERVER_KEY, verificationToken),
    ]);
    this.sql`
      INSERT INTO sh_channel (channel, appId, appSecretEnc, verificationTokenEnc, ownerOpenId, configuredAt, boundAt)
      VALUES ('feishu', ${appId}, ${appSecretEnc}, ${verificationTokenEnc}, NULL, ${Date.now()}, NULL)
      ON CONFLICT (channel) DO UPDATE SET
        appId = excluded.appId, appSecretEnc = excluded.appSecretEnc,
        verificationTokenEnc = excluded.verificationTokenEnc, configuredAt = excluded.configuredAt
    `;
    return page({ state: "awaiting_owner" });
  }

  async setupState(): Promise<{ state: "unconfigured" | "awaiting_owner" | "bound"; appId: string | null; ownerOpenId: string | null }> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return { state: "unconfigured", appId: null, ownerOpenId: null };
    return { state: cfg.ownerOpenId ? "bound" : "awaiting_owner", appId: cfg.appId, ownerOpenId: cfg.ownerOpenId };
  }

  private async handleFeishuWebhook(request: Request): Promise<Response> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return new Response("not found", { status: 404 });
    const parsed = await this.newFeishuAdapter(cfg).verifyAndParse(request);
    if (parsed instanceof Response) return parsed;

    // Persist before 200 (steward.md §9.1): the dedup insert below is the durable record, and
    // the dispatch that follows only touches SQLite synchronously (its sole await, enqueue,
    // is sync SQL plus a void-fired delivery) — so the 200 goes out only after the event's
    // effects are on disk. The Feishu send itself settles later through the durable queue.
    const dup = this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${parsed.msgId}`;
    if (dup.length > 0) return Response.json({ code: 0 }); // Feishu redelivery: ack and drop
    this.sql`
      INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt)
      VALUES ('feishu', ${parsed.msgId}, ${parsed.eventId}, ${parsed.eventType}, ${Date.now()})
    `;

    if (parsed.kind === "message") {
      await this.dispatchInboundMessage(parsed, cfg.ownerOpenId);
    } else if (parsed.kind === "card_action") {
      await this.dispatchCardAction(parsed, cfg.ownerOpenId);
    } else {
      this.logChannel("event_ignored_other", `${parsed.eventType} ${parsed.eventId}`);
    }
    return Response.json({ code: 0 });
  }

  private async dispatchInboundMessage(ev: InboundEvent, ownerOpenId: string | null): Promise<void> {
    if (ev.chatType !== "p2p") {
      this.logChannel("ignored_group", `${ev.senderId ?? "?"} ${ev.msgId}`);
      return;
    }
    if (ownerOpenId === null) {
      // First p2p DM after credentials were saved binds the sender as owner (issue #4, spec
      // §12.1). Everything before this point was SETUP_TOKEN-guarded, and only someone who
      // can already reach this private bot can be here; first-DM-wins is the accepted design.
      this.sql`UPDATE sh_channel SET ownerOpenId = ${ev.senderId!}, boundAt = ${Date.now()} WHERE channel = 'feishu'`;
      this.logChannel("owner_bound", ev.senderId!);
      await this.enqueueOutbound({ kind: "text", to: ev.senderId!, text: OWNER_BOUND_REPLY, urgency: "push" });
      return;
    }
    if (ev.senderId !== ownerOpenId) {
      this.logChannel("ignored_not_owner", `${ev.senderId} ${ev.msgId}`);
      return;
    }
    if (ev.messageType !== "text") {
      // Attachments land via fetchAttachment once ingestion is wired (§9.1); for now they are
      // durably recorded in sh_inbound and logged.
      this.logChannel("ignored_message_type", `${ev.messageType} ${ev.msgId}`);
      return;
    }
    // The owner's text: fixed-phrase dispatch and quote-reply routing (issue #5). Natural
    // language understanding is the M2 steward's job; here everything is deterministic.
    this.logChannel("owner_message", `${ev.msgId} parent=${ev.parentId ?? "-"} ${ev.text ?? ""}`.slice(0, 500));
    await this.dispatcher.handleOwnerText({ text: ev.text ?? "", parentId: ev.parentId, msgId: ev.msgId });
  }

  // Card button callbacks (issue #5): the Thread is resolved from the card's providerMsgId —
  // never from data stuffed into the button (steward.md §3.1, spike bug list).
  private async dispatchCardAction(ev: InboundEvent, ownerOpenId: string | null): Promise<void> {
    if (ownerOpenId === null || !ev.operatorId || !ev.cardMsgId) {
      this.logChannel("ignored_card_no_owner", `${ev.eventId}`);
      return;
    }
    if (ev.operatorId !== ownerOpenId) {
      this.logChannel("ignored_card_not_owner", `${ev.operatorId} ${ev.eventId}`);
      return;
    }
    await this.dispatcher.handleCardAction({ operatorId: ev.operatorId, action: ev.action ?? "", cardMsgId: ev.cardMsgId });
  }

  private logChannel(reason: string, detail: string): void {
    this.sql`INSERT INTO sh_channel_log (ts, channel, reason, detail) VALUES (${Date.now()}, 'feishu', ${reason}, ${detail})`;
  }

  async channelLogEntries(limit = 50): Promise<{ ts: number; reason: string; detail: string | null }[]> {
    return this.sql<{ ts: number; reason: string; detail: string | null }>`
      SELECT ts, reason, detail FROM sh_channel_log ORDER BY seq DESC LIMIT ${limit}
    `;
  }

  async inboundSeen(msgId: string): Promise<boolean> {
    return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId}`.length > 0;
  }

  // ---- Outbound queue (steward.md §6.1) ----------------------------------------------------------
  // Row writes go through the memory module (ledger.outbound owns the sh_outbound table);
  // what stays here is delivery mechanics only: claims, pacing, backoff, the adapter call.

  async enqueueOutbound(input: {
    kind: "text" | "card";
    to: string;
    text?: string;
    card?: unknown;
    threadId?: string | null;
    urgency?: "push" | "quiet";
  }): Promise<{ id: string }> {
    const id = this.ledger.outbound.enqueue(input);
    void this.deliverOutbound();
    return { id };
  }

  async outboundRow(id: string): Promise<ShOutboundRow | null> {
    return (this.ledger.outbound.row(id) as unknown as ShOutboundRow | undefined) ?? null;
  }

  async outboundRows(limit = 10): Promise<ShOutboundRow[]> {
    return this.ledger.outbound.rows(limit) as unknown as ShOutboundRow[];
  }

  /** Read-only ledger view for tests: threads, workers, reports, questions, timeline. */
  async debugSnapshot(): Promise<ReturnType<Steward["ledger"]["debug"]["snapshot"]>> {
    return this.ledger.debug.snapshot();
  }

  // Scheduled callback (also fired inline after each enqueue): claims due rows, sends them
  // through the adapter, and re-arms itself. Safe to run concurrently — passes serialize on
  // deliveryChain and the claim guard still makes every row the property of exactly one pass.
  deliverOutbound(): Promise<void> {
    const run = this.deliveryChain.then(() => this.deliverOutboundPass());
    this.deliveryChain = run.catch(() => {});
    return run;
  }

  private async deliverOutboundPass(): Promise<void> {
    // Reclaim rows whose delivery pass died mid-send (claim expired): back to queued.
    this.ledger.outbound.reclaimExpiredClaims(Date.now());
    for (const id of this.ledger.outbound.dueIds(Date.now(), OUTBOUND_BATCH)) {
      await this.deliverOneOutbound(id);
    }
    this.rearmDeliveryAlarm();
  }

  private async deliverOneOutbound(id: string): Promise<void> {
    // The claim (spike bug 1): only a queued row (or one whose claim has expired) can be
    // taken, so two concurrent passes never both send it.
    const row = this.ledger.outbound.claimForDelivery(id, Date.now(), OUTBOUND_CLAIM_MS);
    if (!row) return; // another pass owns this row

    const cfg = await this.loadFeishuConfig();
    if (!cfg) {
      this.ledger.outbound.settleFailure(id, row.claim, row.attempts + 1, "channel_not_configured", null, Date.now());
      return;
    }

    // 5 QPS per receiver (feishu-channel.md §4): space this send from the previous one.
    const pace = this.sql<{ lastSendAt: number }>`
      SELECT lastSendAt FROM sh_channel_pace WHERE channel = ${row.channel} AND receiveId = ${row.receiveId}
    `[0];
    const wait = pace ? pace.lastSendAt + OUTBOUND_SEND_SPACING_MS - Date.now() : 0;
    if (wait > 0) await sleep(wait);

    const payload = JSON.parse(row.payload) as { text?: string; card?: unknown };
    try {
      const { providerMsgId } = await this.newFeishuAdapter(cfg).send({
        id,
        to: row.receiveId,
        kind: row.kind === "card" ? "card" : "text",
        text: payload.text,
        card: payload.card,
        threadId: row.threadId,
      });
      this.touchPace(row.channel, row.receiveId);
      this.ledger.outbound.settleSent(id, row.claim, providerMsgId, Date.now());
    } catch (err) {
      // The attempt hit the wire (or timed out at 10s — spike bug 3), so it counts against
      // the receiver's rate budget either way.
      this.touchPace(row.channel, row.receiveId);
      if (!this.ledger.outbound.stillOwns(id, row.claim)) return; // a reclaim took over mid-send; its send settles
      const attempts = row.attempts + 1;
      const retriable = err instanceof RetriableChannelError;
      const permanent = !retriable || attempts >= OUTBOUND_MAX_ATTEMPTS;
      const delay = permanent
        ? null
        : Math.min(OUTBOUND_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOUND_BACKOFF_CAP_MS);
      this.ledger.outbound.settleFailure(
        id,
        row.claim,
        attempts,
        errorText(err),
        permanent ? null : Date.now() + (delay ?? 0),
        Date.now(),
      );
    }
  }

  private touchPace(channel: string, receiveId: string): void {
    this.sql`
      INSERT INTO sh_channel_pace (channel, receiveId, lastSendAt) VALUES (${channel}, ${receiveId}, ${Date.now()})
      ON CONFLICT (channel, receiveId) DO UPDATE SET lastSendAt = excluded.lastSendAt
    `;
  }

  private rearmDeliveryAlarm(): void {
    const at = this.ledger.outbound.nextWake(Date.now());
    if (at === null) return;
    void this.schedule(Math.max(1, Math.ceil((at - Date.now()) / 1000)), "deliverOutbound");
  }
}
