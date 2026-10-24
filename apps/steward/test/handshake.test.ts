import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";

function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

async function pairDevice(name: string): Promise<{ deviceId: string; token: string }> {
  const { code } = await ownerStub().createPairing();
  const res = await SELF.fetch("https://example.com/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  return res.json();
}

function connect(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch("https://example.com/agents/steward/owner?role=connector", { headers });
}

function helloPayload(deviceId: string, connEpoch: number, overrides: Record<string, unknown> = {}) {
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

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
}

describe("auth pre-check (Worker layer)", () => {
  it("rejects a connection with no token with HTTP 401, never upgrading", async () => {
    const res = await connect(null);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered token with HTTP 401, never upgrading", async () => {
    const { token } = await pairDevice("tamper-test");
    const tampered = token.slice(0, -4) + (token.endsWith("0000") ? "1111" : "0000");
    const res = await connect(tampered);
    expect(res.status).toBe(401);
  });
});

describe("hello/welcome handshake", () => {
  it("replies with welcome echoing the hello id, after a valid connect", async () => {
    const { deviceId, token } = await pairDevice("mac-studio");
    const res = await connect(token);
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const hello = helloPayload(deviceId, 1);
    ws.send(JSON.stringify(hello));
    const welcome = await nextMessage(ws);
    expect(welcome).toMatchObject({ t: "welcome", re: hello.id, protocol: 1, acks: {} });
    expect(typeof welcome.sessionId).toBe("string");
    ws.close();
  });

  it("closes with 4426 when the protocol range does not overlap", async () => {
    const { deviceId, token } = await pairDevice("old-connector");
    const res = await connect(token);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify(helloPayload(deviceId, 1, { protocol: { min: 2, max: 2 } })));
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4426);
  });
});

describe("single-connection constraint (connEpoch supersede)", () => {
  it("a higher connEpoch supersedes the existing connection with 4409", async () => {
    const { deviceId, token } = await pairDevice("laptop");
    const resA = await connect(token);
    const wsA = resA.webSocket!;
    wsA.accept();
    wsA.send(JSON.stringify(helloPayload(deviceId, 1)));
    await nextMessage(wsA); // welcome

    const closedA = nextClose(wsA);
    const resB = await connect(token);
    const wsB = resB.webSocket!;
    wsB.accept();
    wsB.send(JSON.stringify(helloPayload(deviceId, 2)));
    const welcomeB = await nextMessage(wsB);
    expect(welcomeB.t).toBe("welcome");

    const closeA = await closedA;
    expect(closeA.code).toBe(4409);
  });

  it("a lower-or-equal connEpoch is itself rejected with 4409, leaving the existing connection open", async () => {
    const { deviceId, token } = await pairDevice("desktop");
    const resA = await connect(token);
    const wsA = resA.webSocket!;
    wsA.accept();
    wsA.send(JSON.stringify(helloPayload(deviceId, 5)));
    await nextMessage(wsA); // welcome

    const resB = await connect(token);
    const wsB = resB.webSocket!;
    wsB.accept();
    wsB.send(JSON.stringify(helloPayload(deviceId, 3)));
    const closedB = await nextClose(wsB);
    expect(closedB.code).toBe(4409);

    // The original connection is still alive and usable.
    wsA.send(JSON.stringify({ t: "bogus", id: "p1" }));
    const reply = await nextMessage(wsA);
    expect(reply.code).toBe("unsupported");
  });
});

describe("revocation", () => {
  it("closes a live connection with 4403 when the device is revoked", async () => {
    const { deviceId, token } = await pairDevice("revoke-me");
    const res = await connect(token);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify(helloPayload(deviceId, 1)));
    await nextMessage(ws); // welcome

    const closed = nextClose(ws);
    await ownerStub().revoke(deviceId);
    expect((await closed).code).toBe(4403);
  });

  it("rejects a new connection attempt from a revoked device with 4403 (after the Worker-layer mac check still passes)", async () => {
    const { deviceId, token } = await pairDevice("revoke-reconnect");
    await ownerStub().revoke(deviceId);
    const res = await connect(token);
    expect(res.status).toBe(101); // mac is still well-formed; DO-layer rejects next
    const ws = res.webSocket!;
    ws.accept();
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4403);
  });
});
