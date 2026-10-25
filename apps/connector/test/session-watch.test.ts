// Issue #15 (connector-pi.md §6.3, §10): the crash-window and external-change slice.
// Command recovery reads the session tail for the ADR-0001 marker (delivered / not_delivered
// / ambiguous, never a re-send); the pre-launch gate answers session_in_use for a session a
// live foreign pi process holds, and emits external_activity (counts, timestamps, coarse
// summary) when the tail moved past lastKnownEntryId.
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLog } from "../src/commands.ts";
import { ConnectorApp } from "../src/connector-app.ts";
import { parseProcessArguments, referencesSession } from "../src/session-holders.ts";
import { inspectCommandDelivery, observeSession } from "../src/session-observation.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager, type RecoveryOptions } from "../src/worker-manager.ts";
import { EventLog } from "../src/events.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  textBlock,
  tmpDir,
  waitFor,
  writeScenario,
  writeSessionFile,
} from "./helpers.ts";

let dir: string;
let stateDir: string;
let sessionsDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
const events: Array<Record<string, unknown>> = [];
let eventLog: EventLog;
const apps: ConnectorApp[] = [];

beforeEach(async () => {
  dir = tmpDir("sig-session-watch");
  stateDir = join(dir, "state");
  sessionsDir = join(dir, "sessions");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  eventLog = new EventLog(store.database);
  events.length = 0;
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  for (const app of apps) app.stop();
  apps.length = 0;
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** A session entry shaped like real pi's: id + parentId + ISO timestamp. */
function entry(id: string, body: Record<string, unknown>, parentId: string | null = null): Record<string, unknown> {
  return { id, parentId, timestamp: new Date().toISOString(), ...body };
}

function userEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return entry(id, { type: "message", message: { role: "user", content: text } }, parentId);
}

function assistantEntry(id: string, parentId: string | null, content: unknown, stopReason = "stop"): Record<string, unknown> {
  return entry(id, { type: "message", message: { role: "assistant", content, stopReason } }, parentId);
}

/** A marker entry exactly as the injected extension writes it (ADR-0001). */
function markerEntry(commandId: string): Record<string, unknown> {
  return entry(`m-${commandId}`, { type: "custom", customType: "sig.command", data: { commandId, at: Date.now() } });
}

/** Writes a session file whose entries chain like real pi's (each parents the next). */
function writeChainedSession(workerId: string, entries: Array<Record<string, unknown>>): string {
  let parent: string | null = null;
  const chained = entries.map((body, i) => {
    if (typeof body.id === "string" && typeof body.parentId === "string" || body.parentId === null) {
      parent = (typeof body.id === "string" ? body.id : null) ?? parent;
      return body;
    }
    const withId = { id: `c${i}`, parentId: parent, ...body };
    parent = withId.id;
    return withId;
  });
  return writeSessionFile(sessionsDir, workerId, chained);
}

function seededWorker(workerId: string, sessionFile: string, lastKnownEntryId: string | null) {
  store.upsertWorker({
    workerId,
    threadId: "the-thread",
    repoId: repo,
    mode: "write",
    state: "idle",
    sessionId: workerId,
    sessionFile,
    lastKnownEntryId,
  });
}

describe("session observation (§6.3 evidence and §10 baselines)", () => {
  it("finds the marker a delivered command leaves, including off the active branch", () => {
    const file = writeChainedSession("w-obs-1", [
      userEntry("u0", null, "earlier"),
      markerEntry("cmd-1"),
      assistantEntry("a0", "u0", [textBlock("done")]),
    ]);
    expect(inspectCommandDelivery(file, "cmd-1")).toBe("delivered");
    expect(inspectCommandDelivery(file, "cmd-2")).toBe("not_delivered");
  });

  it("absence is proven only by a fully read, self-consistent tail", () => {
    // A marker whose commandId merely appears inside message text is NOT a delivery marker.
    const file = writeChainedSession("w-obs-2", [
      userEntry("u0", null, "please rerun cmd-9 for me"),
      assistantEntry("a0", "u0", [textBlock("ok")]),
    ]);
    expect(inspectCommandDelivery(file, "cmd-9")).toBe("not_delivered");
    // A torn final write (crash mid-append) keeps the verdict honest: ambiguous.
    const torn = writeChainedSession("w-obs-3", [userEntry("u0", null, "x")]);
    fsSync.writeFileSync(torn, fsSync.readFileSync(torn, "utf8") + '{"type":"custom","customType":"sig.co');
    expect(inspectCommandDelivery(torn, "cmd-1")).toBe("ambiguous");
  });
});

describe("command recovery (§6.3: delivered / not_delivered / ambiguous, never resent)", () => {
  it("a marker command whose marker is on disk recovers as delivered", async () => {
    const sessionFile = writeChainedSession("w-rec-1", [
      userEntry("u0", null, "earlier"),
      markerEntry("cmd-delivered"),
      userEntry("u1", null, "do it"),
    ]);
    const log = new CommandLog(store.database);
    log.begin("cmd-delivered", { kind: "send", workerId: "w-rec-1" });
    log.expectMarker("cmd-delivered", { sessionFile });
    log.markSending("cmd-delivered");
    seededWorker("w-rec-1", sessionFile, null);

    const app = bootApp(null);
    await app.start();
    await mock.waitHello();
    const hello = mock.hellos().at(-1) as { pendingAcks: Array<{ cmdId: string; state: string }> };
    const ack = hello.pendingAcks.find((p) => p.cmdId === "cmd-delivered");
    expect(ack?.state).toBe("done");

    mock.sendCmd("send", { workerId: "w-rec-1", text: "again" }, "cmd-delivered"); // DO redelivery
    await waitFor(
      () => (mock.acksFor("cmd-delivered") as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "duplicate ack with the recovered result",
    );
    expect(mock.acksFor("cmd-delivered")).toMatchObject({
      status: "duplicate",
      result: { ok: true, data: { recovered: "delivered_after_connector_restart" } },
    });
  }, 30_000);

  it("a marker command whose marker is provably absent recovers as failed(not_delivered)", async () => {
    const sessionFile = writeChainedSession("w-rec-2", [
      userEntry("u0", null, "earlier turn"),
      assistantEntry("a0", "u0", [textBlock("done")]),
    ]);
    const log = new CommandLog(store.database);
    log.begin("cmd-lost", { kind: "send", workerId: "w-rec-2" });
    log.expectMarker("cmd-lost", { sessionFile });
    log.markSending("cmd-lost");
    seededWorker("w-rec-2", sessionFile, null);

    await bootApp(null).start();
    await mock.waitHello();
    const hello = mock.hellos().at(-1) as { pendingAcks: Array<{ cmdId: string; state: string }> };
    expect(hello.pendingAcks.find((p) => p.cmdId === "cmd-lost")?.state).toBe("failed");

    mock.sendCmd("send", { workerId: "w-rec-2", text: "again" }, "cmd-lost");
    await waitFor(
      () => (mock.acksFor("cmd-lost") as { status?: string } | undefined)?.status === "duplicate",
      10_000,
      "duplicate ack",
    );
    expect(mock.acksFor("cmd-lost")).toMatchObject({
      status: "duplicate",
      result: { ok: false, error: { code: "not_delivered", retriable: true } },
    });
  }, 30_000);

  it("a command with no marker expectation stays honestly ambiguous; an unstarted one is not delivered", async () => {
    const sessionFile = writeChainedSession("w-rec-3", [userEntry("u0", null, "x")]);
    const log = new CommandLog(store.database);
    log.begin("cmd-stop", { kind: "stop_process", workerId: "w-rec-3" }); // no marker possible
    log.markSending("cmd-stop");
    log.begin("cmd-never", { kind: "send", workerId: "w-rec-3" });
    // left in `accepted`: the handler never began, so nothing was sent.

    await bootApp(null).start();
    await mock.waitHello();
    const hello = mock.hellos().at(-1) as { pendingAcks: Array<{ cmdId: string; state: string }> };
    expect(hello.pendingAcks.find((p) => p.cmdId === "cmd-stop")?.state).toBe("ambiguous");
    expect(hello.pendingAcks.find((p) => p.cmdId === "cmd-never")?.state).toBe("failed");
  }, 30_000);
});

describe("external-change detection (§10)", () => {
  function managerWith(recovery: RecoveryOptions = {}): WorkerManager {
    return new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]), {
        FAKE_PI_SESSIONS_DIR: sessionsDir,
      }),
      recovery: { autoResumeBackoffMs: 30, ...recovery },
      emit: (workerId, fields) => {
        eventLog.append(workerId, fields);
        events.push({ workerId, ...fields });
      },
    });
  }

  it("a tail that moved past lastKnownEntryId emits external_activity with counts, timestamps, and a summary", async () => {
    const sessionFile = writeChainedSession("w-ext-1", [
      userEntry("u0", null, "original task"),
      assistantEntry("a0", "u0", [textBlock("done")]),
    ]);
    const baseline = observeSession(sessionFile).lastEntryId;
    seededWorker("w-ext-1", sessionFile, baseline);
    // The owner continues the session by hand: two entries appended at the keyboard.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "message", id: "x1", parentId: baseline, timestamp: "2026-10-16T10:00:00.000Z", message: { role: "user", content: "顺手把测试也补上" } }),
        JSON.stringify({
          type: "message",
          id: "x2",
          parentId: "x1",
          timestamp: "2026-10-16T10:01:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "edit", arguments: { file_path: "src/a.ts" } }],
            stopReason: "stop",
          },
        }),
      ].join("\n") + "\n",
    );

    const manager = managerWith({ sessionInUseWindowMs: 1 });
    const result = await manager
      .handleCommand("cmd-resume-1", "resume", { workerId: "w-ext-1", reason: "manual" })
      .catch((err: unknown) => err);
    // The fixture's external timestamps are old (2026-10-16T10:00Z), so the in-use window
    // does not trip; the resume relaunches and the comparison reports the two entries.
    expect(result).toMatchObject({ resumed: true });

    const activity = events.find((e) => e.type === "external_activity") as Record<string, unknown>;
    expect(activity).toBeDefined();
    expect(activity.entries).toBe(2);
    expect(activity.firstAt).toBe("2026-10-16T10:00:00.000Z");
    expect(activity.lastAt).toBe("2026-10-16T10:01:00.000Z");
    expect(activity.changedFiles).toEqual(["src/a.ts"]);
    expect(String(activity.summary)).toContain("顺手把测试也补上");
    // The baseline advanced: a second relaunch does not re-report the same entries.
    await manager.stopProcess("w-ext-1").catch(() => undefined);
    events.length = 0;
    await manager.handleCommand("cmd-resume-2", "resume", { workerId: "w-ext-1", reason: "manual" }).catch(() => undefined);
    expect(events.find((e) => e.type === "external_activity")).toBeUndefined();
    manager.stop();
  }, 60_000);

  it("an unchanged tail relaunches silently", async () => {
    const sessionFile = writeChainedSession("w-ext-2", [
      userEntry("u0", null, "task"),
      assistantEntry("a0", "u0", [textBlock("done")]),
    ]);
    const baseline = observeSession(sessionFile).lastEntryId;
    seededWorker("w-ext-2", sessionFile, baseline);

    const manager = managerWith();
    await manager.handleCommand("cmd-resume-3", "resume", { workerId: "w-ext-2", reason: "manual" });
    expect(events.find((e) => e.type === "external_activity")).toBeUndefined();
    await manager.stopProcess("w-ext-2").catch(() => undefined);
    manager.stop();
  }, 60_000);
});

describe("session_in_use (§10: another live pi process holds the session)", () => {
  function managerWithHolders(recovery: RecoveryOptions, holders: Array<{ pid: number; args: string }>) {
    return new WorkerManager({
      store,
      stateDir,
      adapter: fakePiAdapter(stateDir, writeScenario(dir, "scenario", [reportRun({ status: "done", summary: "done" })]), {
        FAKE_PI_SESSIONS_DIR: sessionsDir,
      }),
      recovery: { autoResumeBackoffMs: 30, ...recovery },
      emit: (workerId, fields) => {
        eventLog.append(workerId, fields);
        events.push({ workerId, ...fields });
      },
    });
  }

  it("a foreign process holding the session fails the relaunch with session_in_use, retriable", async () => {
    const sessionFile = writeChainedSession("w-inuse-1", [
      userEntry("u0", null, "task"),
      assistantEntry("a0", "u0", [textBlock("done")]),
    ]);
    seededWorker("w-inuse-1", sessionFile, observeSession(sessionFile).lastEntryId);
    const manager = managerWithHolders({ findSessionHolders: async () => [{ pid: 424242, args: "pi --session ..." }] }, []);

    await expect(
      manager.handleCommand("cmd-inuse-1", "resume", { workerId: "w-inuse-1", reason: "manual" }),
    ).rejects.toMatchObject({ code: "session_in_use", retriable: true });
    expect(store.getWorker("w-inuse-1")?.state).not.toBe("running");
    expect(store.getWorker("w-inuse-1")?.state).not.toBe("starting");
    manager.stop();
  }, 30_000);

  it("an ARGV-matched holder is detected by the real ps scan (macOS shape; Linux reads the same argv via /proc)", async () => {
    // A real, live process holding the session by argument — the shape a user's own pi run
    // takes during its startup window (before pi retitles itself and hides its argv).
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--session-id", "w-inuse-2"], {
      stdio: "ignore",
    });
    try {
      const sessionFile = writeChainedSession("w-inuse-2", [
        userEntry("u0", null, "task"),
        assistantEntry("a0", "u0", [textBlock("done")]),
      ]);
      seededWorker("w-inuse-2", sessionFile, observeSession(sessionFile).lastEntryId);
      const manager = managerWithHolders({}, []);
      await expect(
        manager.handleCommand("cmd-inuse-2", "resume", { workerId: "w-inuse-2", reason: "manual" }),
      ).rejects.toMatchObject({ code: "session_in_use" });
      manager.stop();
    } finally {
      holder.kill("SIGKILL");
    }
  }, 45_000);

  it("ps output parses on both platform shapes and matching stays strict", () => {
    const macOS = [
      " 1234 pi                     --session-id wabcdefghij",
      " 1235 node /opt/pi/dist/cli.js --session /tmp/sessions/2026-01_wabcdefghij.jsonl",
      " 1236 tail -f /tmp/sessions/2026-01_wabcdefghij.jsonl",
      " 1237 pi",
    ].join("\n");
    const rows = parseProcessArguments(macOS);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ pid: 1234, args: "pi                     --session-id wabcdefghij" });
    expect(referencesSession(rows[0]!.args, "wabcdefghij", "/other.jsonl")).toBe(true);
    expect(referencesSession("pi --session wabcdefghij", "wabcdefghij", "/other.jsonl")).toBe(true); // id prefix form
    expect(referencesSession("pi --session=wabcdefghij", "wabcdefghij", "/other.jsonl")).toBe(true);
    expect(referencesSession("pi --session-id wabcdefghij", "wabcdefghij", "/other.jsonl")).toBe(true);
    expect(referencesSession("pi --session-id otherworker", "wabcdefghij", "/other.jsonl")).toBe(false);
    expect(referencesSession("pi", "wabcdefghij", "/other.jsonl")).toBe(false); // retitle-blind, no reference
    expect(referencesSession("pi --continue", "wabcdefghij", "/other.jsonl")).toBe(false); // undetectable form
    expect(referencesSession("pi -c", "wabcdefghij", "/other.jsonl")).toBe(false);
    expect(referencesSession("tail -f /other.jsonl", "wabcdefghij", "/other.jsonl")).toBe(true); // positional path...
    // ...but the caller's viewer denylist keeps `tail` from counting as a holder.
  });
});

function bootApp(scenarioPath: string | null): ConnectorApp {
  const app = new ConnectorApp({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenarioPath ?? writeScenario(dir, `empty-${apps.length}`, []), {
      FAKE_PI_SESSIONS_DIR: sessionsDir,
    }),
  });
  apps.push(app);
  return app;
}
