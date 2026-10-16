// Issue #15, steward half (protocol §4.2, connector-pi.md §6.3/§10): a command the connector
// can only report `ambiguous` settles the outbox row, lands on the Thread's timeline, and
// wakes the steward to ask the user — never an automatic re-send. `external_activity` events
// (the owner used the session at the keyboard) carry counts/timestamps/summary onto the
// timeline and wake the steward at low priority over the 10-minute merge window. The
// delivery-class failures `session_in_use` and `not_delivered` reach the timeline + a wake.
import { beforeEach, describe, expect, it } from "vitest";
import {
  configureAndBind,
  connectAndHello,
  mockReset,
  ownerStub,
  pairDevice,
  resetLedgerState,
} from "./helpers.ts";

beforeEach(async () => {
  await resetLedgerState();
  await mockReset();
  await configureAndBind("ou_owner");
});

/** Pairs a machine that has repo-a and connects it (hello.repos is what the ledger learns,
 *  and what the dispatcher's machine selection reads). */
async function connectedMachine(machine: string) {
  const { deviceId, token } = await pairDevice(machine);
  const { ws, reader } = await connectAndHello(deviceId, token, 1, {
    machine: { name: machine, memTotalMB: 65536, memFreeMB: 31000 },
    agents: [{ kind: "pi", version: "1.2.0", capabilities: { steer: true } }],
    repos: [{ repoId: "/srv/repo-a", name: "repo-a", path: "/srv/repo-a", defaultBranch: "main", remote: "git@example:repo-a.git" }],
    limits: { maxWorkers: 4, running: 0 },
  });
  return { deviceId, token, ws, reader };
}

/** Dispatches a write task through the deterministic service (the LLM tool's own code path)
 *  and acks the command — leaving worker + outbox row in the state a mid-`sending` crash
 *  would find them in. */
async function seedAmbiguousWorker(machine: string) {
  const connector = await connectedMachine(machine);
  const { ws, reader } = connector;
  const outcome = await ownerStub().dispatchForTest({ prompt: "修一下登录 bug", repoRef: "repo-a", newTitle: "修一下登录 bug" });
  expect(outcome.kind).toBe("dispatched");
  const cmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
  const workerId = String((cmd.args as { workerId: unknown }).workerId);
  ws.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
  return { ...connector, cmdId: String(cmd.id), workerId };
}

describe("ambiguous commands (protocol §4.2, connector-pi.md §6.3)", () => {
  it("cmd_ack ambiguous marks the row, notes the thread, and wakes the steward to ask", async () => {
    const seed = await seedAmbiguousWorker("crash-machine");
    try {
      seed.ws.send(JSON.stringify({ t: "cmd_ack", re: seed.cmdId, status: "ambiguous" }));
      // A ping round-trip proves the DO processed the ack before assertions run.
      seed.ws.send(JSON.stringify({ t: "ping", id: "sync-1" }));
      await seed.reader.nextWhere((m) => m.t === "pong");


      const row = await ownerStub().outboxRow(seed.cmdId);
      expect(row?.state).toBe("ambiguous");

      const snap = await ownerStub().debugSnapshot();
      const thread = snap.threads.find((t) => t.workers.some((w) => w.workerId === seed.workerId));
      expect(thread).toBeDefined();
      expect(thread!.timeline.some((e) => e.text.includes("不确定"))).toBe(true);

      const wake = snap.wakes.find((w) => w.dedupeKey === `ambiguous:${seed.cmdId}`);
      expect(wake?.priority).toBe("high");
      expect(wake?.text).toContain(seed.workerId);
      expect(wake?.text).toContain("不会自动重发");
      expect(wake?.text).toContain("ask_user");
    } finally {
      seed.ws.close();
    }
  });

  it("hello.pendingAcks ambiguous takes the same path, and only once per cmdId", async () => {
    const seed = await seedAmbiguousWorker("crash-machine");
    try {
      // The connector crashed before any result; its restart's hello reports the command.
      const second = await connectAndHello(seed.deviceId, seed.token, 2, {
        pendingAcks: [{ cmdId: seed.cmdId, state: "ambiguous", workerId: seed.workerId }],
      });
      try {
        expect((await ownerStub().outboxRow(seed.cmdId))?.state).toBe("ambiguous");
        let snap = await ownerStub().debugSnapshot();
        expect(snap.wakes.filter((w) => w.dedupeKey === `ambiguous:${seed.cmdId}`)).toHaveLength(1);

        // A duplicate hello (reconnect) must not queue a second wake or a second note.
        const third = await connectAndHello(seed.deviceId, seed.token, 3, {
          pendingAcks: [{ cmdId: seed.cmdId, state: "ambiguous", workerId: seed.workerId }],
        });
        try {
          snap = await ownerStub().debugSnapshot();
          expect(snap.wakes.filter((w) => w.dedupeKey === `ambiguous:${seed.cmdId}`)).toHaveLength(1);
          expect(snap.timelineRecent.filter((e) => e.text.includes("不确定"))).toHaveLength(1);
        } finally {
          third.ws.close();
        }
      } finally {
        second.ws.close();
      }
    } finally {
      seed.ws.close();
    }
  });

  it("a redelivered ambiguous command is never re-sent to the connector", async () => {
    const seed = await seedAmbiguousWorker("crash-machine");
    // The ambiguous ack first (the connector died right after writing it to the wire).
    seed.ws.send(JSON.stringify({ t: "cmd_ack", re: seed.cmdId, status: "ambiguous" }));
    seed.ws.close(); // the device drops; its restart reconnects with the pendingAck

    const second = await connectAndHello(seed.deviceId, seed.token, 2, {
      pendingAcks: [{ cmdId: seed.cmdId, state: "ambiguous", workerId: seed.workerId }],
    });
    try {
      // Nothing arrives: ambiguous rows are excluded from redelivery (§4.2).
      const reply = await Promise.race([
        second.reader.next(1500).then(
          (m) => new Error("unexpected frame: " + JSON.stringify(m)),
          (err: Error) => err,
        ),
        new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("no redelivery")), 1200)),
      ]);
      expect(reply.message).toBe("no redelivery");
    } finally {
      second.ws.close();
    }
  });
});

describe("external_activity (connector-pi.md §10, steward.md §5.3)", () => {
  it("lands on the timeline with counts and summary, and wakes the steward at low priority", async () => {
    const connector = await connectedMachine("keyboard-machine");
    const { ws, reader } = connector;
    try {
      const outcome = await ownerStub().dispatchForTest({ prompt: "修一下登录 bug", repoRef: "repo-a", newTitle: "修一下登录 bug" });
      expect(outcome.kind).toBe("dispatched");
      const cmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
      const workerId = String((cmd.args as { workerId: unknown }).workerId);
      ws.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
      ws.send(JSON.stringify({ t: "cmd_result", re: cmd.id, ok: true, data: { sessionId: workerId } }));
      ws.send(
        JSON.stringify({
          t: "events",
          id: "evt-1",
          batch: [
            { workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId, cwd: "/srv", branch: "shepherd/t-1" },
            {
              workerId,
              seq: 2,
              ts: Date.now(),
              type: "external_activity",
              entries: 2,
              firstAt: "2026-10-16T10:00:00.000Z",
              lastAt: "2026-10-16T10:01:00.000Z",
              changedFiles: ["src/a.ts"],
              summary: "User messages: 顺手把测试也补上",
            },
          ],
        }),
      );
      // Give the synchronous reducer a beat (events are handled on arrival), then inspect.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const snap = await ownerStub().debugSnapshot();
      const thread = snap.threads.find((t) => t.workers.some((w) => w.workerId === workerId));
      expect(thread).toBeDefined();
      const note = snap.timelineRecent.find((e) => e.threadId === thread!.threadId && e.text.includes("被直接使用过"));
      expect(note).toBeDefined();
      expect(note!.text).toContain("2 条记录");
      expect(note!.text).toContain("src/a.ts");
      const wake = snap.wakes.find((w) => w.text.includes("被直接使用过"));
      expect(wake).toBeDefined();
      expect(wake!.priority).toBe("low");
      expect(wake!.dueAt - wake!.createdAt).toBeGreaterThanOrEqual(10 * 60_000 - 1);
      expect(wake!.text).toContain("update_thread");
    } finally {
      ws.close();
    }
  });
});

describe("delivery-class failures reach the user (session_in_use / not_delivered)", () => {
  it("a session_in_use cmd_result lands on the timeline and wakes the steward", async () => {
    const connector = await connectedMachine("busy-machine");
    const { deviceId, ws, reader } = connector;
    try {
      const outcome = await ownerStub().dispatchForTest({ prompt: "修一下登录 bug", repoRef: "repo-a", newTitle: "修一下登录 bug" });
      expect(outcome.kind).toBe("dispatched");
      const cmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
      const workerId = String((cmd.args as { workerId: unknown }).workerId);
      ws.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
      ws.send(JSON.stringify({ t: "cmd_result", re: cmd.id, ok: true, data: { sessionId: workerId } }));
      ws.send(
        JSON.stringify({
          t: "events",
          id: "evt-2",
          batch: [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId, cwd: "/srv", branch: "b" }],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The steward later sends an instruction; the connector answers session_in_use.
      const send = await ownerStub().enqueue(deviceId, "send", { workerId, text: "改用 pnpm" }, { workerId });
      const cmd2 = await reader.nextWhere((m) => m.t === "cmd" && m.id === send.cmdId);
      ws.send(JSON.stringify({ t: "cmd_ack", re: cmd2.id, status: "accepted" }));
      ws.send(
        JSON.stringify({
          t: "cmd_result",
          re: cmd2.id,
          ok: false,
          error: { code: "session_in_use", message: "another live pi process holds the session", retriable: true },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      const row = await ownerStub().outboxRow(send.cmdId);
      expect(row?.state).toBe("failed");
      const snap = await ownerStub().debugSnapshot();
      expect(snap.timelineRecent.some((e) => e.text.includes("正被机器上的另一个 pi 进程使用"))).toBe(true);
      const wake = snap.wakes.find((w) => w.text.includes("另一个 pi 进程使用"));
      expect(wake).toBeDefined();
    } finally {
      ws.close();
    }
  });

  it("a not_delivered cmd_result (recovered §6.3 evidence) does the same", async () => {
    const connector = await connectedMachine("undelivered-machine");
    const { deviceId, ws, reader } = connector;
    try {
      const outcome = await ownerStub().dispatchForTest({ prompt: "修一下登录 bug", repoRef: "repo-a", newTitle: "修一下登录 bug" });
      expect(outcome.kind).toBe("dispatched");
      const cmd = await reader.nextWhere((m) => m.t === "cmd" && m.kind === "start_worker");
      const workerId = String((cmd.args as { workerId: unknown }).workerId);
      ws.send(JSON.stringify({ t: "cmd_ack", re: cmd.id, status: "accepted" }));
      ws.send(JSON.stringify({ t: "cmd_result", re: cmd.id, ok: true, data: { sessionId: workerId } }));
      ws.send(
        JSON.stringify({
          t: "events",
          id: "evt-3",
          batch: [{ workerId, seq: 1, ts: Date.now(), type: "started", sessionId: workerId, cwd: "/srv", branch: "b" }],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      const send = await ownerStub().enqueue(deviceId, "send", { workerId, text: "补上测试" }, { workerId });
      const cmd2 = await reader.nextWhere((m) => m.t === "cmd" && m.id === send.cmdId);
      ws.send(JSON.stringify({ t: "cmd_ack", re: cmd2.id, status: "accepted" }));
      ws.send(
        JSON.stringify({
          t: "cmd_result",
          re: cmd2.id,
          ok: false,
          error: { code: "not_delivered", message: "connector restarted before delivery", retriable: true },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      const snap = await ownerStub().debugSnapshot();
      expect(snap.timelineRecent.some((e) => e.text.includes("没有送达"))).toBe(true);
      const wake = snap.wakes.find((w) => w.text.includes("没有送达"));
      expect(wake).toBeDefined();
      expect(wake!.text).toContain("不要自行重发");
    } finally {
      ws.close();
    }
  });
});
