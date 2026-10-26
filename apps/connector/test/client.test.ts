import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloseCode, HelloMessageSchema } from "@alexlikevibe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorClient } from "../src/client.ts";
import { LocalStore } from "../src/store.ts";

class FakeWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  readyState = 0;
  terminated = false;
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    public readonly url: string,
    public readonly options: unknown,
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.emit("close", code ?? 1000, reason ?? "");
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, "heartbeat");
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  simulateMessage(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }

  simulateClose(code: number, reason = ""): void {
    this.emit("close", code, reason);
  }
}

let dir: string;
let store: LocalStore;

beforeEach(() => {
  FakeWebSocket.instances = [];
  dir = mkdtempSync(join(tmpdir(), "sig-connector-client-test-"));
  store = new LocalStore(join(dir, "connector.sqlite"));
  store.saveCredentials({ serverUrl: "https://example.com", deviceId: "dev_abc", token: "st1.dev_abc.1.100.deadbeef" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  vi.useRealTimers();
});

describe("ConnectorClient", () => {
  it("connects to wss://<host>/agents/steward/owner and sends a well-formed hello with an incrementing connEpoch", () => {
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never });
    client.start();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://example.com/agents/steward/owner?role=connector&proto=1");
    expect((ws.options as { headers: Record<string, string> }).headers.authorization).toBe("Bearer st1.dev_abc.1.100.deadbeef");

    ws.simulateOpen();
    expect(ws.sent).toHaveLength(1);
    const hello = JSON.parse(ws.sent[0]!);
    expect(HelloMessageSchema.safeParse(hello).success).toBe(true);
    expect(hello.deviceId).toBe("dev_abc");
    expect(hello.connEpoch).toBe(1);
  });

  it("passes the ws proxy agent for proxied targets and none for bypassed ones (issue #68)", () => {
    const agent = {} as never; // opaque token: the wiring, not the agent, is under test
    const proxied = new ConnectorClient({
      store,
      WebSocketImpl: FakeWebSocket as never,
      wsAgent: (url) => (url.startsWith("wss://example.com") ? agent : undefined),
    });
    proxied.start();
    const withAgent = FakeWebSocket.instances.at(-1)!;
    expect((withAgent.options as { agent?: unknown }).agent).toBe(agent);

    const bypassed = new ConnectorClient({
      store,
      WebSocketImpl: FakeWebSocket as never,
      wsAgent: () => undefined,
    });
    bypassed.start();
    const withoutAgent = FakeWebSocket.instances.at(-1)!;
    expect((withoutAgent.options as { agent?: unknown }).agent).toBeUndefined();
  });

  it("calls onWelcome and resets backoff when a welcome arrives", () => {
    const onWelcome = vi.fn();
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never, onWelcome });
    client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ t: "welcome", re: "x", protocol: 1, serverTime: 1, sessionId: "s", acks: {}, limits: {} });
    expect(onWelcome).toHaveBeenCalledTimes(1);
  });

  it("persists a rotation token from welcome and uses it on the next connect (issue #27)", async () => {
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never, minBackoffMs: 1, maxBackoffMs: 5 });
    client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    const rekeyed = "st1.0f0e0d0c.dev_abc.1.200." + "a".repeat(64);
    ws.simulateMessage({ t: "welcome", re: "x", protocol: 1, serverTime: 1, sessionId: "s", acks: {}, limits: {}, token: rekeyed });

    // The credentials row is updated in place: same device, new token.
    expect(store.getCredentials()).toMatchObject({ deviceId: "dev_abc", token: rekeyed, serverUrl: "https://example.com" });

    // The current connection is untouched; the next connect authenticates with the new token.
    ws.simulateClose(1000, "rotation window");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect((FakeWebSocket.instances[1]!.options as { headers: Record<string, string> }).headers.authorization).toBe(`Bearer ${rekeyed}`);
  });

  it("leaves the stored token alone when welcome carries no rotation token", () => {
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never });
    client.start();
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage({ t: "welcome", re: "x", protocol: 1, serverTime: 1, sessionId: "s", acks: {}, limits: {} });
    expect(store.getCredentials()!.token).toBe("st1.dev_abc.1.100.deadbeef");
  });

  it("reconnects with jittered exponential backoff on a reconnect-eligible close code", () => {
    vi.useFakeTimers();
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never, minBackoffMs: 1000, maxBackoffMs: 60_000 });
    client.start();
    FakeWebSocket.instances[0]!.simulateClose(1000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999); // strictly under the un-jittered minimum
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(300); // comfortably past the 20% jitter ceiling (max +200ms)
    expect(FakeWebSocket.instances).toHaveLength(2);

    // second attempt's connEpoch continues to increment
    const secondHello = (() => {
      FakeWebSocket.instances[1]!.simulateOpen();
      return JSON.parse(FakeWebSocket.instances[1]!.sent[0]!);
    })();
    expect(secondHello.connEpoch).toBe(2);

    FakeWebSocket.instances[1]!.simulateClose(1000);
    vi.advanceTimersByTime(1999); // strictly under the doubled, un-jittered backoff
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(500); // comfortably past the 20% jitter ceiling (max +400ms)
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it.each([
    [CloseCode.NORMAL, true],
    [CloseCode.SERVICE_RESTART, true],
    [CloseCode.RATE_LIMITED, true],
    [CloseCode.INTERNAL_ERROR, true],
    [CloseCode.UNAUTHORIZED, false],
    [CloseCode.REVOKED, false],
    [CloseCode.SUPERSEDED, false],
    [CloseCode.VERSION_MISMATCH, false],
  ])("honours the close-code table: code %i reconnects=%s", async (code, shouldReconnect) => {
    vi.useFakeTimers();
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never, minBackoffMs: 10, maxBackoffMs: 100 });
    client.start();
    FakeWebSocket.instances[0]!.simulateClose(code);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(shouldReconnect ? 2 : 1);
  });

  it.each([CloseCode.UNAUTHORIZED, CloseCode.REVOKED])("clears local credentials on close code %i", (code) => {
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never });
    client.start();
    FakeWebSocket.instances[0]!.simulateClose(code);
    expect(store.getCredentials()).toBeNull();
  });

  it.each([CloseCode.SUPERSEDED, CloseCode.VERSION_MISMATCH])("keeps local credentials on close code %i", (code) => {
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never });
    client.start();
    FakeWebSocket.instances[0]!.simulateClose(code);
    expect(store.getCredentials()).not.toBeNull();
  });

  it("stop() closes the socket and suppresses reconnection", () => {
    vi.useFakeTimers();
    const client = new ConnectorClient({ store, WebSocketImpl: FakeWebSocket as never, minBackoffMs: 10 });
    client.start();
    client.stop();
    expect(FakeWebSocket.instances[0]!.closed).toEqual({ code: 1000, reason: "stopping" });
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
