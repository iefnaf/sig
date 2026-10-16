import { SELF, env } from "cloudflare:test";
import type { Steward } from "../src/steward.ts";

export function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

export async function pairDevice(name: string): Promise<{ deviceId: string; token: string }> {
  const { code } = await ownerStub().createPairing();
  const res = await SELF.fetch("https://example.com/pair", { method: "POST", body: JSON.stringify({ code, name }) });
  return res.json();
}

export function connect(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch("https://example.com/agents/steward/owner?role=connector", { headers });
}

export function helloPayload(deviceId: string, connEpoch: number, overrides: Record<string, unknown> = {}) {
  return {
    t: "hello",
    id: `hello-${connEpoch}-${Math.random()}`,
    protocol: { min: 1, max: 1 },
    deviceId,
    bootId: "boot-1",
    connEpoch,
    connector: { version: "0.1.0", os: "darwin", arch: "arm64", node: "22.13.0" },
    machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
    agents: [],
    repos: [],
    limits: { maxWorkers: 4, running: 0 },
    workers: [],
    pendingAcks: [],
    ...overrides,
  };
}

// Buffered message reader: attached before the first frame can arrive, so server-pushed
// messages (cmd redelivery, events_ack, resync) triggered by unrelated RPC calls are never
// dropped the way an attach-after-send `once` listener can be.
export class MessageReader {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((m: Record<string, unknown>) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return this.nextWhere(() => true, timeoutMs);
  }

  async nextWhere(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const index = this.queue.findIndex(pred);
    if (index >= 0) return this.queue.splice(index, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for a matching message (${this.queue.length} queued)`));
      }, timeoutMs);
      const waiter = (m: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }
}

export function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
}

// Connects, attaches a MessageReader, says hello, and awaits the welcome. The reader stays
// valid for every subsequent frame on this connection.
export async function connectAndHello(
  deviceId: string,
  token: string,
  connEpoch = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ ws: WebSocket; reader: MessageReader; welcome: Record<string, unknown> }> {
  const res = await connect(token);
  const ws = res.webSocket!;
  ws.accept();
  const reader = new MessageReader(ws);
  ws.send(JSON.stringify(helloPayload(deviceId, connEpoch, overrides)));
  const welcome = await reader.nextWhere((m) => m.t === "welcome");
  return { ws, reader, welcome };
}
