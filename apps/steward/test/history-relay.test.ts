// The DO's half of the §6.6 history relay (issue #23): the browser's history_open becomes a
// SQLite relay row plus a history_req to the machine's connector; chunks flow back through DO
// memory — never into storage or logs — with the browser's acks forwarded to slide the
// connector's window. Offline machines answer machine_offline directly (spec §7.4 / §11.4),
// an unanswered relay dies with the 60 s TTL, and role crossing is refused (protocol §5.3).
import { SELF, runInDurableObject } from "cloudflare:test";
import { CloseCode } from "@alexlikevibe/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import { sessionCookieValue } from "../src/web.ts";
import {
  FakeConnector,
  configureAndBind,
  connectWeb,
  nextClose,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

const MARKER = "MARKER-L3-8f3a21-never-stored";

/** Six scripted entries → three 2-entry chunks: enough to exercise the window. */
function scriptedHistory(): Array<Record<string, unknown>> {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `e${i + 1}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: i === 4 ? `assistant text containing ${MARKER}` : `entry ${i + 1}`,
    ...(i === 1 ? { tools: [{ name: "edit", args: "src/a.ts" }] } : {}),
  }));
}

/** Dispatches one worker through the deterministic path (post-#6: the model's start_worker
 * tool drives this same code) and waits for the scripted fake run to settle. */
async function dispatchOneWorker(fake: FakeConnector): Promise<{ threadId: string; workerId: string }> {
  await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
  return waitForWorkerState("idle");
}

async function relayRowCount(): Promise<number> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray) => T[] }).sql.bind(instance);
    return sql<{ n: number }>`SELECT COUNT(*) AS n FROM history_relay`[0]!.n;
  });
}

/** The live relay row's reqId (DO-minted; only the machine's connector ever sees it). */
async function relayReqId(): Promise<string | null> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray) => T[] }).sql.bind(instance);
    return sql<{ reqId: string }>`SELECT reqId FROM history_relay`[0]?.reqId ?? null;
  });
}

/** Scans every DO table (and thus every log row) for a string that must never be persisted. */
async function findMarkerInStorage(marker: string): Promise<string[]> {
  return runInDurableObject(ownerStub(), (_instance: Steward, state: { storage: { sql: { exec: (q: string) => Iterable<Record<string, unknown>> } } }) => {
    const hits: string[] = [];
    for (const table of state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table'")) {
      const name = String(table.name);
      let text: string;
      try {
        text = JSON.stringify([...state.storage.sql.exec(`SELECT * FROM ${name}`)]);
      } catch {
        continue;
      }
      if (text.includes(marker)) hits.push(name);
    }
    return hits;
  });
}

function openStream(ws: WebSocket, workerId: string, opts: { maxBytes?: number; since?: string } = {}): void {
  ws.send(
    JSON.stringify({
      t: "history_open",
      id: `open-${Math.random()}`,
      workerId,
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}),
    }),
  );
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

describe("the §6.6 relay: browser ↔ DO ↔ connector", () => {
  it("streams chunks through, forwards acks, and stores nothing but bookkeeping", async () => {
    const fake = await pairFakeConnector("mac-studio");
    fake.historyEntries = scriptedHistory();
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId);

    // Window 2: chunks 0 and 1 arrive; the third waits for an ack (which must be relayed).
    const chunk0 = await reader.nextWhere((m) => m.t === "history_chunk" && m.n === 0);
    const chunk1 = await reader.nextWhere((m) => m.t === "history_chunk" && m.n === 1);
    expect((chunk0.entries as unknown[]).map((e) => (e as { id: string }).id)).toEqual(["e1", "e2"]);
    expect(chunk1.entries).toHaveLength(2);
    await expect(reader.nextWhere((m) => m.t === "history_chunk" && m.n === 2, 400)).rejects.toThrow();
    expect(await relayRowCount()).toBe(1); // the stream is live

    ws.send(JSON.stringify({ t: "history_ack", re: chunk0.re, n: 0 }));
    const chunk2 = await reader.nextWhere((m) => m.t === "history_chunk" && m.n === 2);
    expect(chunk2.done).toBe(true);
    expect((chunk2.entries as unknown[]).map((e) => (e as { id: string }).id)).toEqual(["e5", "e6"]);
    expect(chunk2.cursor).toBe("e6");
    // done terminates the relay row.
    await expect(relayRowCount()).resolves.toBe(0);

    // The marker text flowed through the DO — and landed nowhere in storage or logs.
    expect(await findMarkerInStorage(MARKER)).toEqual([]);
    // The relay table itself carries ids and meters only.
    ws.close();
  });

  it("answers machine_offline when the machine is not connected", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    fake.close(); // the machine went offline

    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);
    ws.send(JSON.stringify({ t: "history_open", id: "open-offline", workerId }));
    const reply = await reader.nextWhere((m) => m.t === "machine_offline");
    expect(reply.re).toBe("open-offline");
    expect(await relayRowCount()).toBe(0);
    ws.close();
  });

  it("a machine dropping mid-stream notifies the browser and clears the relay row", async () => {
    const fake = await pairFakeConnector("mac-studio");
    fake.historyEntries = scriptedHistory();
    fake.historyCloseAfterChunks = 1; // the connector dies after chunk 0
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId);
    const chunk0 = await reader.nextWhere((m) => m.t === "history_chunk" && m.n === 0);
    expect(chunk0.done).toBe(false);

    const offline = await reader.nextWhere((m) => m.t === "machine_offline");
    expect(offline.re).toBe(chunk0.re); // §6.6: the reason references the DO-minted reqId
    await expect(relayRowCount()).resolves.toBe(0);
    ws.close();
  });

  it("forwards a connector load failure as an error on the same reqId", async () => {
    const fake = await pairFakeConnector("mac-studio");
    fake.historyError = { code: "no_history", message: "worker has no session file" };
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId);
    const error = await reader.nextWhere((m) => m.t === "error");
    expect(error).toMatchObject({ code: "no_history", message: "worker has no session file" });
    await expect(relayRowCount()).resolves.toBe(0);
    ws.close();
  });

  it("cuts a stream that would exceed the browser's maxBytes and synthesizes the end", async () => {
    const fake = await pairFakeConnector("mac-studio");
    fake.historyEntries = scriptedHistory();
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId, { maxBytes: 64 }); // no real chunk can fit
    // The DO's own cap answers first: one synthesized done chunk, nothing forwarded. The cut
    // carries the budget verdict (truncated) and no cursor — nothing was ever forwarded.
    const cut = await reader.nextWhere((m) => m.t === "history_chunk");
    expect(cut.done).toBe(true);
    expect(cut.truncated).toBe(true);
    expect(cut.entries).toEqual([]);
    expect(cut.cursor).toBeNull();
    await expect(reader.nextWhere((m) => m.t === "history_chunk" && (m.entries as unknown[]).length > 0, 400)).rejects.toThrow();
    await expect(relayRowCount()).resolves.toBe(0);
    ws.close();
  });

  it("drops a chunk arriving on a different machine's connection (relay belongs to one device)", async () => {
    const machineA = await pairFakeConnector("mac-a");
    machineA.historySilent = true; // A gets the request but never answers
    await machineA.connect();
    const { workerId } = await dispatchOneWorker(machineA);
    const machineB = await pairFakeConnector("mac-b");
    await machineB.connect();

    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId);
    // The relay row appears when the DO digests the fire-and-forget history_open — poll for
    // it instead of asserting instantly (same race the TTL test below documents: on a loaded
    // runner the ws frame can trail this RPC by seconds; a zero-tolerance assert failed CI
    // twice under the reshuffled test grouping).
    const reqDeadline = Date.now() + 8000;
    let reqId = await relayReqId();
    while (reqId === null) {
      if (Date.now() > reqDeadline) throw new Error("relay row never appeared after history_open");
      await new Promise((resolve) => setTimeout(resolve, 50));
      reqId = await relayReqId();
    }

    // B guesses/knows the reqId and tries to inject content into A's relay: dropped, the
    // relay row survives (A may still answer), the browser hears nothing.
    machineB.ws!.send(
      JSON.stringify({ t: "history_chunk", re: reqId, n: 0, entries: [{ id: "x1", role: "assistant", text: "injected" }], cursor: "x1", done: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(reader.nextWhere((m) => m.t === "history_chunk", 300)).rejects.toThrow();
    await expect(relayRowCount()).resolves.toBe(1);
    ws.close();
  }, 20_000);

  it("an unanswered relay is swept by the TTL alarm", async () => {
    await runInDurableObject(ownerStub(), (instance: Steward) => {
      // 10s, not 2s: the sanity assert below must land before the ceil(TTL)-granularity
      // sweep alarm can fire — under a loaded runner (parallel test processes) the assert's
      // RPC can queue behind seconds of DO work, and a 2s TTL got the row swept (or the poll
      // deadline hit) before the first observation on CI's 4-vCPU runners.
      (instance as unknown as { historyRelayTtlMs: number }).historyRelayTtlMs = 10_000;
    });
    const fake = await pairFakeConnector("mac-studio");
    fake.historySilent = true; // the machine never answers
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    await openStream(ws, workerId);
    // The relay row appears when the DO digests the fire-and-forget history_open — poll for
    // it instead of asserting instantly (the ws frame and this RPC are different input
    // channels; under load creation can trail the send, and the ceil(TTL)-granularity sweep
    // must never race this first observation either).
    const rowDeadline = Date.now() + 8000;
    for (;;) {
      if ((await relayRowCount()) === 1) break;
      if (Date.now() > rowDeadline) throw new Error("relay row never appeared after history_open");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if ((await relayRowCount()) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await relayRowCount()).toBe(0);
    // The browser heard nothing: no chunks, no errors — just silence (its JS watchdog
    // ends the view; the page no longer parks on 连接中… forever).
    await expect(reader.nextWhere(() => true, 300)).rejects.toThrow();
    ws.close();
  }, 45_000);
});

describe("role fence (protocol §5.3)", () => {
  it("refuses connector-type messages from a web connection and browser-type from a connector", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();

    const { ws, reader } = await connectWeb(cookie);
    ws.send(JSON.stringify({ t: "events", id: "e-1", batch: [{ workerId, seq: 999, ts: 1, type: "progress" }] }));
    const refused = await reader.nextWhere((m) => m.t === "error");
    expect(refused).toMatchObject({ code: "forbidden" });
    ws.close();

    // The connector's authenticated socket is equally fenced out of browser messages.
    fake.ws!.send(JSON.stringify({ t: "history_open", id: "open-x", workerId }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !fake.errors.some((e) => e.code === "forbidden")) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fake.errors).toContainEqual(expect.objectContaining({ t: "error", code: "forbidden" }));
  });

  it("refuses a web-role upgrade without a valid session cookie (Worker-layer pre-check)", async () => {
    // The HMAC check in the Worker's onBeforeConnect rejects before the DO is ever woken.
    await expect(connectWeb("sig_session=ws1.garbage.deadbeef")).rejects.toThrow(/web role connect failed: 401/);
  });

  it("closes a web-role upgrade whose session no longer exists (DO-layer liveness)", async () => {
    const dead = `sig_session=${await sessionCookieValue("test-server-key-not-a-secret", "ab".repeat(32))}`;
    const res = await SELF.fetch("https://example.com/agents/steward/owner?role=web", {
      headers: { Upgrade: "websocket", cookie: dead },
    });
    expect(res.status).toBe(101); // the Worker's MAC pre-check passes; liveness is the DO's
    const ws = res.webSocket!;
    ws.accept();
    expect((await nextClose(ws)).code).toBe(CloseCode.UNAUTHORIZED);
  });
});
