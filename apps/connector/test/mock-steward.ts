// A local mock steward for connector contract tests: upgrades the WS endpoint after a bearer
// check, welcomes hello, answers pings (and counts them), acks event batches cumulatively,
// records everything, and can inject commands. Fault knobs: swallow acks, swallow every frame
// (downlink half-death), swallow pongs (uplink pong loss) — the failure modes the spike hit live.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

export interface MockSteward {
  token: string;
  deviceId: string;
  listen: () => Promise<number>;
  close: () => Promise<void>;
  waitConnected: (ms?: number) => Promise<void>;
  /** Wait until `n` hellos (default 1) have been RECORDED. `waitConnected` only covers the
   *  socket reaching OPEN — on slow CI runners the hello frame can still be in flight, and
   *  reading `hellos().at(-1)` right after it races (observed as PR #44 / #13 CI flakes). */
  waitHello: (n?: number, ms?: number) => Promise<void>;
  sendCmd: (kind: string, args: Record<string, unknown>, id?: string) => string;
  /** §6.6: push a history_req; the DO's relay role, for contract tests. */
  sendHistoryReq: (workerId: string, opts?: { since?: string; maxBytes?: number; format?: "full" }) => string;
  /** §6.6: relay a browser ack for chunk `n`. */
  ackHistory: (reqId: string, n: number) => void;
  dropConn: () => void;
  events: () => Array<Record<string, unknown>>;
  hellos: () => Array<Record<string, unknown>>;
  acksFor: (cmdId: string) => Record<string, unknown> | undefined;
  resultsFor: (cmdId: string) => Record<string, unknown> | undefined;
  historyChunksFor: (reqId: string) => Array<Record<string, unknown>>;
  errorsFor: (re: string) => Record<string, unknown> | undefined;
  pings: () => number;
  upgrades: () => number;
  setSwallowAcks: (v: boolean) => void;
  setSwallowAllFrames: (v: boolean) => void;
  setSwallowPongs: (v: boolean) => void;
  setWelcomeAcks: (acks: Record<string, number>) => void;
}

export function startMockSteward(): MockSteward {
  const token = `st1.mock.${randomUUID().slice(0, 8)}`;
  const deviceId = "dev_mock";
  const events: Array<Record<string, unknown>> = [];
  const hellos: Array<Record<string, unknown>> = [];
  const cmdAcks = new Map<string, Record<string, unknown>>();
  const cmdResults = new Map<string, Record<string, unknown>>();
  const historyChunks = new Map<string, Array<Record<string, unknown>>>();
  const errorReplies = new Map<string, Record<string, unknown>>();
  const ackedUpTo = new Map<string, number>();
  let welcomeAcks: Record<string, number> = {};
  let swallowAcks = false;
  let swallowAllFrames = false;
  let swallowPongs = false;
  let upgradeCount = 0;
  let pingCount = 0;
  let conn: WebSocket | null = null;
  let ackSeq = 0;
  // Frames queued while no live connection exists (device "offline"); flushed on the next upgrade,
  // standing in for the DO's outbox redelivery-at-hello behaviour.
  const offlineQueue: Array<Record<string, unknown>> = [];

  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("mock steward");
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    upgradeCount++;
    if (!req.url?.startsWith("/agents/steward/owner")) {
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.write("HTTP/1.1 401\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      conn = ws;
      for (const frame of offlineQueue.splice(0)) ws.send(JSON.stringify(frame));
      ws.on("message", (data) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>;
        switch (m.t) {
          case "ping":
            pingCount++;
            if (!swallowAllFrames && !swallowPongs) ws.send(JSON.stringify({ t: "pong", re: m.id }));
            break;
          case "hello": {
            hellos.push(m);
            if (!swallowAllFrames) {
              ws.send(
                JSON.stringify({
                  t: "welcome",
                  re: m.id,
                  protocol: 1,
                  serverTime: Date.now(),
                  sessionId: `mock-${++ackSeq}`,
                  acks: welcomeAcks,
                  limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
                }),
              );
            }
            break;
          }
          case "events": {
            const batch = m.batch as Array<{ workerId: string; seq: number }>;
            events.push(...(batch as Array<Record<string, unknown>>));
            if (!swallowAllFrames && !swallowAcks) {
              for (const workerId of new Set(batch.map((e) => e.workerId))) {
                const upTo = Math.max(...batch.filter((e) => e.workerId === workerId).map((e) => e.seq));
                ackedUpTo.set(workerId, Math.max(ackedUpTo.get(workerId) ?? 0, upTo));
                ws.send(JSON.stringify({ t: "events_ack", workerId, upTo: ackedUpTo.get(workerId)! }));
              }
            }
            break;
          }
          case "cmd_ack":
            cmdAcks.set(String(m.re), m);
            break;
          case "cmd_result":
            cmdResults.set(String(m.re), m);
            break;
          case "history_chunk": {
            const list = historyChunks.get(String(m.re)) ?? [];
            list.push(m);
            historyChunks.set(String(m.re), list);
            break;
          }
          case "error":
            if (typeof m.re === "string") errorReplies.set(m.re, m);
            break;
          default:
            break;
        }
      });
    });
  });

  const send = (o: Record<string, unknown>): void => {
    if (conn && conn.readyState === WebSocket.OPEN) conn.send(JSON.stringify(o));
    else offlineQueue.push(o); // device offline: redelivered when it returns
  };
  const sendCmd = (kind: string, args: Record<string, unknown>, id: string = randomUUID()): string => {
    send({ t: "cmd", id, cseq: ackSeq++, kind, args });
    return id;
  };
  const sendHistoryReq = (
    workerId: string,
    opts: { since?: string; maxBytes?: number; format?: "full" } = {},
    id: string = randomUUID(),
  ): string => {
    // Same wire as cmd but outside the outbox semantics (§6.6): no cseq, no re-send.
    send({ t: "history_req", id, workerId, since: opts.since, maxBytes: opts.maxBytes, ...(opts.format ? { format: opts.format } : {}) });
    return id;
  };

  const waitConnected = (ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () =>
        conn && conn.readyState === WebSocket.OPEN
          ? resolve()
          : Date.now() - t0 > ms
            ? reject(new Error("connector never connected"))
            : setTimeout(tick, 25);
      tick();
    });

  // Same polling shape as waitConnected, but for recorded hello frames — see the interface.
  const waitHello = (n = 1, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () =>
        hellos.length >= n
          ? resolve()
          : Date.now() - t0 > ms
            ? reject(new Error(`only ${hellos.length}/${n} hellos arrived`))
            : setTimeout(tick, 25);
      tick();
    });

  return {
    token,
    deviceId,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise<void>((done) => {
        try {
          conn?.close();
        } catch {}
        wss.close();
        server.close(() => done());
      }),
    waitConnected,
    waitHello,
    sendCmd,
    sendHistoryReq,
    ackHistory: (reqId, n) => send({ t: "history_ack", re: reqId, n }),
    dropConn: () => {
      try {
        conn?.close();
      } catch {}
      conn = null;
    },
    events: () => events,
    hellos: () => hellos,
    acksFor: (cmdId) => cmdAcks.get(cmdId),
    resultsFor: (cmdId) => cmdResults.get(cmdId),
    historyChunksFor: (reqId) => historyChunks.get(reqId) ?? [],
    errorsFor: (re) => errorReplies.get(re),
    pings: () => pingCount,
    upgrades: () => upgradeCount,
    setSwallowAcks: (v) => {
      swallowAcks = v;
    },
    setSwallowAllFrames: (v) => {
      swallowAllFrames = v;
    },
    setSwallowPongs: (v) => {
      swallowPongs = v;
    },
    setWelcomeAcks: (acks) => {
      welcomeAcks = acks;
    },
  };
}
