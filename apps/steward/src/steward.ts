// The steward Durable Object: device pairing, auth, the hello/welcome handshake, the command
// outbox, the event inbox, and the bidirectional heartbeat. See docs/design/connector-do-protocol.md
// §4 (envelope and reliability), §6.2-6.4 (commands/events), ADR-0001 (heartbeat + redelivery
// corrections), and docs/spike-conclusions.md bugs 5 and 10.
//
// Channel layer (issue #4, steward.md §6.1 / §9): the SETUP_TOKEN-guarded setup page, manual
// Feishu credentials, the webhook inbound path, and the alarm-driven outbound queue.
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
  type ServerKey,
  type WelcomeMessage,
} from "@shepherd/protocol";
import { bearer, resolveServerKeys } from "./auth.ts";
import {
  FeishuAdapter,
  SEND_TIMEOUT_MS,
  TOKEN_REFRESH_MARGIN_MS,
  type FeishuCredentials,
} from "./channel/feishu.ts";
import { RetriableChannelError, type InboundEvent } from "./channel/types.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { renderSetupPage } from "./setup-page.ts";

interface ConnState {
  deviceId: string;
  epoch: number;
  /** Key that authenticated the connection (issue #27): ≠ primary ⇒ welcome rekeys. */
  keyId: string;
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

// /pair brute-force lockout (protocol doc §5.2, issue #27): 5 failures lock the bucket —
// per source IP and globally — for 15 minutes.
export const PAIR_MAX_FAILURES = 5;
export const PAIR_LOCK_MS = 15 * 60_000;

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

export type PairResult =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; reason: "invalid_code" }
  | { ok: false; reason: "rate_limited"; retryAfterSec: number };

// Base `Connection` (unknown state) is used in overridden signatures — narrowing the state
// generic there breaks Liskov substitutability against `Agent`'s own declarations; state is
// cast at the read/write sites instead (same tradeoff the do-protocol spike made).
export class Steward extends Agent<Env> {
  onStart(): void {
    runMigrations(this.sql.bind(this), MIGRATIONS);
  }

  // The signing/sealing key set (primary = SERVER_KEY, plus SERVER_KEY_PREVIOUS during a
  // rotation window). Overridable so tests can simulate rotation states inside the DO.
  protected async serverKeys(): Promise<ServerKey[]> {
    return resolveServerKeys(this.env);
  }

  // Tests shrink the /pair lockout (see feishuSendTimeoutMs for the same pattern).
  protected pairLockMs = PAIR_LOCK_MS;

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
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    return parsed ? [`dev:${parsed.deviceId}`] : [];
  }

  private sendError(connection: Connection, code: ErrorMessage["code"], message: string, re?: string): void {
    connection.send(JSON.stringify({ t: "error", re, code, message, retriable: false }));
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    if (!parsed) {
      connection.close(CloseCode.UNAUTHORIZED, "unauthorized");
      return;
    }
    const row = this.sql<{ epoch: number; revoked: number }>`
      SELECT epoch, revoked FROM device WHERE deviceId = ${parsed.deviceId}
    `[0];
    if (!row) {
      connection.close(CloseCode.UNAUTHORIZED, "unknown device");
      return;
    }
    if (row.revoked || row.epoch !== parsed.epoch) {
      connection.close(CloseCode.REVOKED, "revoked");
      return;
    }
    connection.setState({ deviceId: parsed.deviceId, epoch: parsed.epoch, keyId: parsed.keyId } satisfies ConnState);
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

  private async handleHello(connection: Connection, raw: unknown): Promise<void> {
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
    connection.setState({ deviceId: auth.deviceId, epoch: auth.epoch, keyId: auth.keyId, connEpoch: hello.connEpoch } satisfies ConnState);
    const acks = Object.fromEntries(
      this.sql<{ workerId: string; upTo: number }>`SELECT workerId, upTo FROM worker_ack`.map((row) => [row.workerId, row.upTo]),
    );
    // SERVER_KEY rotation (issue #27): the connection authenticated with a non-primary key —
    // hand the connector a fresh primary-key token so it can rekey without re-pairing. The
    // connector persists it for reconnects; once every machine has reconnected once, the
    // operator can drop SERVER_KEY_PREVIOUS.
    const [primary] = await this.serverKeys();
    const rotatedToken = primary && auth.keyId !== primary.id ? await mintToken(primary, auth.deviceId, auth.epoch) : undefined;
    const welcome: WelcomeMessage = {
      t: "welcome",
      re: hello.id,
      protocol: PROTOCOL_VERSION.max,
      serverTime: Date.now(),
      sessionId: ulid(),
      acks,
      limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
      ...(rotatedToken ? { token: rotatedToken } : {}),
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
  }

  // Not wired to any HTTP route yet (the setup page / chat command that triggers this is a
  // later ticket); callable via RPC on the stub. `/pair` below is the only consumer for now.
  async createPairing(): Promise<{ code: string }> {
    const code = generatePairingCode();
    this.sql`INSERT INTO pairing (code, expiresAt) VALUES (${code}, ${Date.now() + 10 * 60_000})`;
    return { code };
  }

  // Pairing + brute-force lockout (protocol doc §5.2, issue #27). The code's entropy and the
  // 10-minute validity make enumeration infeasible on top of this; the lockout bounds the
  // trying either way — per source IP and globally, 5 failures each lock for `pairLockMs`.
  // `clientIp` comes from the Worker's CF-Connecting-IP; attempts without one (local dev)
  // share the "unknown" bucket.
  async pair(code: string, name: string, clientIp = "unknown"): Promise<PairResult> {
    const now = Date.now();
    const lockedFor = (scope: string, key: string) =>
      this.sql<{ until: number }>`SELECT lockedUntil AS until FROM pair_fail WHERE scope = ${scope} AND key = ${key}`[0]?.until ?? 0;
    const retryAfterMs = Math.max(lockedFor("ip", clientIp), lockedFor("all", "*")) - now;
    if (retryAfterMs > 0) {
      return { ok: false, reason: "rate_limited", retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    }

    const row = this.sql<{ expiresAt: number; used: number }>`
      SELECT expiresAt, used FROM pairing WHERE code = ${code}
    `[0];
    if (!row || row.used || row.expiresAt < now) {
      this.registerPairFailure("ip", clientIp, now);
      this.registerPairFailure("all", "*", now);
      return { ok: false, reason: "invalid_code" };
    }
    this.sql`UPDATE pairing SET used = 1 WHERE code = ${code}`;
    // A success proves the caller is mid-onboarding, not guessing: clear their IP bucket so a
    // lockout from earlier fat-fingered attempts does not outlive the pairing.
    this.sql`DELETE FROM pair_fail WHERE scope = 'ip' AND key = ${clientIp}`;
    const deviceId = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.sql`INSERT INTO device (deviceId, name, epoch, createdAt) VALUES (${deviceId}, ${name}, 1, ${now})`;
    const [primary] = await this.serverKeys();
    const token = await mintToken(primary!, deviceId, 1);
    return { ok: true, deviceId, token };
  }

  // Sliding failure window: the window spans `pairLockMs`; hitting PAIR_MAX_FAILURES inside it
  // locks until now + pairLockMs and leaves a clean bucket behind for when the lock lifts.
  private registerPairFailure(scope: string, key: string, now: number): void {
    const row = this.sql<{ fails: number; windowStart: number; lockedUntil: number }>`
      SELECT fails, windowStart, lockedUntil FROM pair_fail WHERE scope = ${scope} AND key = ${key}
    `[0];
    if (!row) {
      this.sql`
        INSERT INTO pair_fail (scope, key, fails, windowStart, lockedUntil, updatedAt)
        VALUES (${scope}, ${key}, 1, ${now}, 0, ${now})
      `;
      return;
    }
    const windowExpired = row.lockedUntil <= now && now - row.windowStart >= this.pairLockMs;
    const fails = windowExpired ? 1 : row.fails + 1;
    if (fails >= PAIR_MAX_FAILURES) {
      this.sql`
        UPDATE pair_fail SET fails = 0, windowStart = ${now}, lockedUntil = ${now + this.pairLockMs}, updatedAt = ${now}
        WHERE scope = ${scope} AND key = ${key}
      `;
      return;
    }
    this.sql`
      UPDATE pair_fail SET fails = ${fails}, windowStart = ${windowExpired ? now : row.windowStart}, updatedAt = ${now}
      WHERE scope = ${scope} AND key = ${key}
    `;
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
    const keys = await this.serverKeys();
    // Open with any configured key (rotation window, issue #27). A failed open means the
    // ciphertext was sealed under a key that has since been dropped entirely: read back as
    // unconfigured so the SETUP_TOKEN-guarded setup page accepts fresh credentials — recovery,
    // not a deadlock. A non-primary open re-seals under the primary so the window can close.
    const appSecret = await openSecret(keys, row.appSecretEnc);
    const verificationToken = await openSecret(keys, row.verificationTokenEnc);
    if (appSecret === null || verificationToken === null) return null;
    if (appSecret.keyId !== keys[0]!.id || verificationToken.keyId !== keys[0]!.id) {
      const [appSecretEnc, verificationTokenEnc] = await Promise.all([
        sealSecret(keys[0]!, appSecret.text),
        sealSecret(keys[0]!, verificationToken.text),
      ]);
      this.sql`
        UPDATE sh_channel SET appSecretEnc = ${appSecretEnc}, verificationTokenEnc = ${verificationTokenEnc}
        WHERE channel = 'feishu'
      `;
    }
    return { appId: row.appId, appSecret: appSecret.text, verificationToken: verificationToken.text, ownerOpenId: row.ownerOpenId };
  }

  protected newFeishuAdapter(credentials: FeishuCredentials): FeishuAdapter {
    return new FeishuAdapter({
      credentials,
      tokenStore: {
        // The tenant_access_token is a Feishu bearer credential, so it is sealed at rest like
        // every other secret (issue #27); opening it needs the key set, hence async halves.
        getCachedToken: async () => {
          const row = this.sql<{ tokenEnc: string; expiresAt: number }>`
            SELECT tokenEnc, expiresAt FROM sh_channel_token WHERE channel = 'feishu'
          `[0];
          if (!row) return null;
          const opened = await openSecret(await this.serverKeys(), row.tokenEnc);
          return opened ? { token: opened.text, expiresAt: row.expiresAt } : null;
        },
        saveToken: async (token, expiresAt) => {
          const [primary] = await this.serverKeys();
          const tokenEnc = await sealSecret(primary!, token);
          this.sql`
            INSERT INTO sh_channel_token (channel, tokenEnc, expiresAt) VALUES ('feishu', ${tokenEnc}, ${expiresAt})
            ON CONFLICT (channel) DO UPDATE SET tokenEnc = excluded.tokenEnc, expiresAt = excluded.expiresAt
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
    // Expiry check only — no need to decrypt just to decide whether to refresh.
    const cached = this.sql<{ expiresAt: number }>`
      SELECT expiresAt FROM sh_channel_token WHERE channel = 'feishu'
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

    const [primary] = await this.serverKeys();
    const [appSecretEnc, verificationTokenEnc] = await Promise.all([
      sealSecret(primary!, appSecret),
      sealSecret(primary!, verificationToken),
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

  // ---- Model credentials (spec §12.2 "model keys stored encrypted", issue #27) ---------------
  // The provider API key is AES-GCM sealed under SERVER_KEY exactly like the Feishu secrets
  // (sh_model.apiKeyEnc); the plaintext exists only in transit and in memory. The LLM wiring
  // (M2) reads it back through modelConfig(). Not reachable over HTTP — RPC on the stub only,
  // which the routes-audit test pins down.

  async setModelConfig(provider: string, apiKey: string): Promise<void> {
    if (!provider.trim() || !apiKey.trim()) throw new Error("provider and apiKey are required");
    const [primary] = await this.serverKeys();
    const apiKeyEnc = await sealSecret(primary!, apiKey);
    this.sql`
      INSERT INTO sh_model (id, provider, apiKeyEnc, updatedAt) VALUES (0, ${provider}, ${apiKeyEnc}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, apiKeyEnc = excluded.apiKeyEnc, updatedAt = excluded.updatedAt
    `;
  }

  async modelConfig(): Promise<{ provider: string; apiKey: string } | null> {
    const row = this.sql<{ provider: string; apiKeyEnc: string }>`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0`[0];
    if (!row) return null;
    const opened = await openSecret(await this.serverKeys(), row.apiKeyEnc);
    // Sealed under a dropped key: report unconfigured rather than failing calls forever.
    if (!opened) return null;
    return { provider: row.provider, apiKey: opened.text };
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
    // The DM is durably recorded (sh_inbound) and logged; handing it to the steward
    // conversation (harness.submit, sh_run) is the M2 ticket — nothing here decides routing yet.
    this.logChannel("owner_message", `${ev.msgId} parent=${ev.parentId ?? "-"} ${ev.text ?? ""}`.slice(0, 500));
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

  async enqueueOutbound(input: {
    kind: "text" | "card";
    to: string;
    text?: string;
    card?: unknown;
    threadId?: string | null;
    urgency?: "push" | "quiet";
  }): Promise<{ id: string }> {
    const id = ulid(); // stable across retries; doubles as the provider-side uuid
    this.sql`
      INSERT INTO sh_outbound (id, channel, kind, receiveId, threadId, payload, urgency, status, attempts, nextAttemptAt, createdAt)
      VALUES (${id}, 'feishu', ${input.kind}, ${input.to}, ${input.threadId ?? null},
              ${JSON.stringify({ text: input.text, card: input.card })}, ${input.urgency ?? "quiet"}, 'queued', 0, ${Date.now()}, ${Date.now()})
    `;
    void this.deliverOutbound();
    return { id };
  }

  async outboundRow(id: string): Promise<ShOutboundRow | null> {
    return (this.sql`SELECT * FROM sh_outbound WHERE id = ${id}`[0] as ShOutboundRow | undefined) ?? null;
  }

  async outboundRows(limit = 10): Promise<ShOutboundRow[]> {
    return this.sql`SELECT * FROM sh_outbound ORDER BY createdAt, id LIMIT ${limit}` as ShOutboundRow[];
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
    this.sql`UPDATE sh_outbound SET status = 'queued' WHERE status = 'sending' AND claimExpiresAt <= ${Date.now()}`;
    const due = this.sql<{ id: string }>`
      SELECT id FROM sh_outbound WHERE status = 'queued' AND nextAttemptAt <= ${Date.now()}
      ORDER BY createdAt, id LIMIT ${OUTBOUND_BATCH}
    `;
    for (const row of due) await this.deliverOneOutbound(row.id);
    this.rearmDeliveryAlarm();
  }

  private async deliverOneOutbound(id: string): Promise<void> {
    const claim = crypto.randomUUID();
    // The claim (spike bug 1): one conditional, synchronous UPDATE — only a queued row (or one
    // whose claim has expired) can be taken, so two concurrent passes never both send it.
    this.sql`
      UPDATE sh_outbound SET status = 'sending', claimToken = ${claim}, claimExpiresAt = ${Date.now() + OUTBOUND_CLAIM_MS}
      WHERE id = ${id} AND (status = 'queued' OR (status = 'sending' AND claimExpiresAt <= ${Date.now()}))
    `;
    const row = this.sql<{ kind: string; receiveId: string; channel: string; attempts: number; payload: string; threadId: string | null }>`
      SELECT kind, receiveId, channel, attempts, payload, threadId FROM sh_outbound WHERE id = ${id} AND claimToken = ${claim}
    `[0];
    if (!row) return; // another pass owns this row

    const cfg = await this.loadFeishuConfig();
    if (!cfg || !this.stillOwnsClaim(id, claim)) {
      this.settleOutboundFailure(id, claim, row.attempts + 1, "channel_not_configured", true);
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
      if (!this.stillOwnsClaim(id, claim)) return; // a reclaim took over mid-send; its send settles
      this.sql`
        UPDATE sh_outbound SET status = 'sent', providerMsgId = ${providerMsgId}, sentAt = ${Date.now()},
                               attempts = attempts + 1, claimToken = NULL, claimExpiresAt = NULL, lastError = NULL
        WHERE id = ${id}
      `;
    } catch (err) {
      // The attempt hit the wire (or timed out at 10s — spike bug 3), so it counts against
      // the receiver's rate budget either way.
      this.touchPace(row.channel, row.receiveId);
      if (!this.stillOwnsClaim(id, claim)) return;
      const attempts = row.attempts + 1;
      const retriable = err instanceof RetriableChannelError;
      this.settleOutboundFailure(id, claim, attempts, errorText(err), !retriable || attempts >= OUTBOUND_MAX_ATTEMPTS);
    }
  }

  private settleOutboundFailure(id: string, claim: string, attempts: number, error: string, permanent: boolean): void {
    if (!this.stillOwnsClaim(id, claim)) return;
    if (permanent) {
      this.sql`
        UPDATE sh_outbound SET status = 'failed', attempts = ${attempts}, lastError = ${error},
                               claimToken = NULL, claimExpiresAt = NULL
        WHERE id = ${id}
      `;
      return;
    }
    const delay = Math.min(OUTBOUND_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOUND_BACKOFF_CAP_MS);
    this.sql`
      UPDATE sh_outbound SET status = 'queued', attempts = ${attempts}, nextAttemptAt = ${Date.now() + delay},
                             lastError = ${error}, claimToken = NULL, claimExpiresAt = NULL
      WHERE id = ${id}
    `;
  }

  private stillOwnsClaim(id: string, claim: string): boolean {
    const row = this.sql<{ claimToken: string | null }>`SELECT claimToken FROM sh_outbound WHERE id = ${id}`[0];
    return row?.claimToken === claim;
  }

  private touchPace(channel: string, receiveId: string): void {
    this.sql`
      INSERT INTO sh_channel_pace (channel, receiveId, lastSendAt) VALUES (${channel}, ${receiveId}, ${Date.now()})
      ON CONFLICT (channel, receiveId) DO UPDATE SET lastSendAt = excluded.lastSendAt
    `;
  }

  private rearmDeliveryAlarm(): void {
    const nextDue = this.sql<{ at: number | null }>`
      SELECT MIN(nextAttemptAt) AS at FROM sh_outbound WHERE status = 'queued'
    `[0]?.at ?? null;
    const nextReclaim = this.sql<{ at: number | null }>`
      SELECT MIN(claimExpiresAt) AS at FROM sh_outbound WHERE status = 'sending'
    `[0]?.at ?? null;
    const candidates = [nextDue, nextReclaim].filter((v): v is number => v !== null);
    if (candidates.length === 0) return;
    const at = Math.min(...candidates);
    void this.schedule(Math.max(1, Math.ceil((at - Date.now()) / 1000)), "deliverOutbound");
  }
}
