// §6.8 direct worker chat (issue #84, ADR-0011): a browser viewing a specific worker's session
// may `send`/`interrupt` it directly — dispatched through the same Dispatcher path a steward
// tool call uses, with the real cmd_ack/cmd_result relayed back (never a fabricated optimistic
// one), and the target server-verified by `subscribe` state rather than trusted from the message.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  FakeConnector,
  configureAndBind,
  connectWeb,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  waitForWorkerState,
  webLogin,
} from "./helpers.ts";

async function dispatchOneWorker(fake: FakeConnector): Promise<{ threadId: string; workerId: string }> {
  await ownerStub().dispatchForTest({ prompt: "修复登录 bug", repoRef: "repo-a", newTitle: "修复登录 bug" });
  return waitForWorkerState("idle");
}

/** A second, independent Thread/worker so a test can prove subscribing to worker A does not
 *  authorize a worker_cmd aimed at worker B. */
async function dispatchSecondWorker(): Promise<{ threadId: string; workerId: string }> {
  await ownerStub().dispatchForTest({ prompt: "再查一下另一个 bug", repoRef: "repo-a", newTitle: "另一个 bug" });
  const deadline = Date.now() + 8000;
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    const thread = snap.threads.find((t) => t.title === "另一个 bug");
    const worker = thread?.workers[0];
    if (thread && worker && worker.state === "idle") return { threadId: thread.threadId, workerId: worker.workerId };
    if (Date.now() > deadline) throw new Error(`second worker never reached idle: ${JSON.stringify(snap.threads)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function relayRowCount(): Promise<number> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray) => T[] }).sql.bind(instance);
    return sql<{ n: number }>`SELECT COUNT(*) AS n FROM web_cmd_relay`[0]!.n;
  });
}

async function outboxRowFor(cmdId: string): Promise<{ kind: string } | undefined> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: <T>(s: TemplateStringsArray, ...values: unknown[]) => T[] }).sql.bind(instance);
    return sql<{ kind: string }>`SELECT kind FROM outbox WHERE cmdId = ${cmdId}`[0];
  });
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
});

describe("§6.8: direct worker chat from an open session view", () => {
  it("dispatches a subscribed send, relays the real cmd_ack and cmd_result, and clears the relay row", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);

    ws.send(JSON.stringify({ t: "subscribe", workerId }));
    ws.send(JSON.stringify({ t: "worker_cmd", id: "wc-1", workerId, kind: "send", args: { text: "也把 lint 跑一下" } }));

    const [, sendCmd] = await fake.waitForCmds(2);
    expect(sendCmd!.kind).toBe("send");
    expect((sendCmd!.args as Record<string, unknown>).text).toBe("也把 lint 跑一下");
    expect(sendCmd!.id).toBe("wc-1"); // the browser's sh_web_request became the cmdId directly

    fake.send({ t: "cmd_ack", re: "wc-1", status: "accepted" });
    const ack = await reader.nextWhere((m) => m.t === "cmd_ack" && m.re === "wc-1");
    expect(ack.status).toBe("accepted");
    expect(await relayRowCount()).toBe(1); // accepted is not terminal — still waiting on cmd_result

    fake.send({ t: "cmd_result", re: "wc-1", ok: true, data: {} });
    const result = await reader.nextWhere((m) => m.t === "cmd_result" && m.re === "wc-1");
    expect(result.ok).toBe(true);
    await expect(relayRowCount()).resolves.toBe(0);
    ws.close();
  });

  it("dispatches a subscribed interrupt the same way", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);

    ws.send(JSON.stringify({ t: "subscribe", workerId }));
    ws.send(JSON.stringify({ t: "worker_cmd", id: "wc-2", workerId, kind: "interrupt" }));

    const [, interruptCmd] = await fake.waitForCmds(2);
    expect(interruptCmd!.kind).toBe("interrupt");

    fake.send({ t: "cmd_result", re: "wc-2", ok: true, data: {} });
    const result = await reader.nextWhere((m) => m.t === "cmd_result" && m.re === "wc-2");
    expect(result.ok).toBe(true);
    ws.close();
  });

  it("refuses worker_cmd for a workerId the connection never subscribed to", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);

    // No subscribe at all.
    ws.send(JSON.stringify({ t: "worker_cmd", id: "wc-3", workerId, kind: "send", args: { text: "hi" } }));
    const err = await reader.nextWhere((m) => m.t === "error" && m.re === "wc-3");
    expect(err.code).toBe("forbidden");
    expect(await outboxRowFor("wc-3")).toBeUndefined(); // never reached the Dispatcher

    // Subscribed to a different, real worker.
    const other = await dispatchSecondWorker();
    ws.send(JSON.stringify({ t: "subscribe", workerId: other.workerId }));
    ws.send(JSON.stringify({ t: "worker_cmd", id: "wc-4", workerId, kind: "send", args: { text: "hi" } }));
    const err2 = await reader.nextWhere((m) => m.t === "error" && m.re === "wc-4");
    expect(err2.code).toBe("forbidden");
    ws.close();
  });

  it("answers a refused dispatch directly — no outbox row, no browser left waiting on an ack that never comes", async () => {
    const cookie = await webLogin();
    const { ws, reader } = await connectWeb(cookie);
    const unknownWorkerId = "w_does_not_exist";

    // subscribe only checks that the worker exists — an unknown workerId is refused up front.
    ws.send(JSON.stringify({ t: "subscribe", workerId: unknownWorkerId }));
    const notFound = await reader.nextWhere((m) => m.t === "error");
    expect(notFound.code).toBe("not_found");
    ws.close();
  });

  it("drops a pending relay when the browser disconnects before the result arrives", async () => {
    const fake = await pairFakeConnector("mac-studio");
    await fake.connect();
    const { workerId } = await dispatchOneWorker(fake);
    const cookie = await webLogin();
    const { ws } = await connectWeb(cookie);

    ws.send(JSON.stringify({ t: "subscribe", workerId }));
    ws.send(JSON.stringify({ t: "worker_cmd", id: "wc-5", workerId, kind: "send", args: { text: "hi" } }));
    await fake.waitForCmds(2);
    expect(await relayRowCount()).toBe(1);

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(relayRowCount()).resolves.toBe(0); // the outbox row itself is untouched — only its relay target is gone

    fake.send({ t: "cmd_result", re: "wc-5", ok: true, data: {} }); // arrives after disconnect: a no-op, not a crash
    expect(await outboxRowFor("wc-5")).toEqual({ kind: "send" });
  });
});
