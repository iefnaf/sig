// The steward Durable Object: device pairing, auth, and the hello/welcome handshake.
// Outbox/command delivery and the event stream are out of scope here (later tickets).
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import {
  CloseCode,
  HelloMessageSchema,
  PROTOCOL_VERSION,
  generatePairingCode,
  mintToken,
  parseToken,
  ulid,
  type ErrorMessage,
  type WelcomeMessage,
} from "@shepherd/protocol";
import { bearer } from "./auth.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";

interface ConnState {
  deviceId: string;
  connEpoch?: number;
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
    connection.setState({ deviceId: parsed.deviceId } satisfies ConnState);
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
    if (t === "hello") {
      this.handleHello(connection, message);
      return;
    }
    const opt = (message as { opt?: unknown }).opt === true;
    if (opt) return;
    const id = (message as { id?: unknown }).id;
    this.sendError(
      connection,
      "unsupported",
      `unknown message type ${JSON.stringify(t)}`,
      typeof id === "string" ? id : undefined,
    );
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
    const welcome: WelcomeMessage = {
      t: "welcome",
      re: hello.id,
      protocol: PROTOCOL_VERSION.max,
      serverTime: Date.now(),
      sessionId: ulid(),
      acks: {},
      limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
    };
    connection.send(JSON.stringify(welcome));
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
}
