// Issue #23, connector half: `history_req` over the real transport answers with windowed
// `history_chunk`s driven by acks (§6.6), and WorkerManager.history picks the right source —
// live `get_entries` while the process runs (fake-pi), the session JSONL along the current
// branch once it is gone (connector-pi.md §11.4).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakePiAdapter, makeGitRepo, tmpDir, waitFor, writeScenario, type ScenarioStep } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

const WORKER = "w-hist-e2e";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
let app: ConnectorApp;

beforeEach(async () => {
  dir = tmpDir("sig-history-e2e");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  app?.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

/** A run that records a real (small) conversation into the session JSONL and settles. */
function conversationRun(userText: string, assistantText: string): ScenarioStep[] {
  return [
    { emit: { type: "agent_start" } },
    { session: { id: "s1", parentId: "e2", type: "message", message: { role: "user", content: userText } } },
    { emit: { type: "turn_start" } },
    {
      session: {
        id: "s2",
        parentId: "s1",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: assistantText },
            { type: "toolCall", id: "c1", name: "edit", arguments: { file_path: "src/auth/session.ts" } },
          ],
          stopReason: "stop",
        },
      },
    },
    { emit: { type: "agent_settled", aborted: false } },
  ];
}

/** A run that records `count` 4 000-char entries — enough to need multiple 256 KiB chunks. */
function bulkConversationRun(count: number): ScenarioStep[] {
  const steps: ScenarioStep[] = [{ emit: { type: "agent_start" } }];
  const text = "y".repeat(4000);
  for (let i = 0; i < count; i++) {
    const id = `b${i}`;
    steps.push({
      session: {
        id,
        parentId: i === 0 ? null : `b${i - 1}`,
        type: "message",
        message: { role: i % 2 === 0 ? "user" : "assistant", content: text },
      },
    });
  }
  steps.push({ emit: { type: "agent_settled", aborted: false } });
  return steps;
}

async function startWorker(scenarioPath: string, workerId = WORKER): Promise<void> {
  app = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, scenarioPath, { FAKE_PI_SESSIONS_DIR: join(dir, "sessions") }) });
  await app.start();
  await mock.waitConnected();
  const cmdId = mock.sendCmd("start_worker", {
    workerId,
    threadId: "t-history",
    repoId: repo,
    mode: "write",
    prompt: "do the thing",
  });
  const result = await waitFor(() => mock.resultsFor(cmdId), 15_000, "start_worker result");
  expect(result).toMatchObject({ ok: true });
}

describe("WorkerManager.history source selection", () => {
  it("reads through the live process while it runs, then from the session file after stop_process", async () => {
    const scenario = writeScenario(dir, "scenario", [conversationRun("fix the login bug", "Done, tests pass")]);
    await startWorker(scenario);

    // Idle-hot after settling: the process is alive, so get_entries serves the page. The
    // leading e2 entry is the delivered prompt (fake-pi persists it with its §6.3 marker).
    const live = await app.manager.history(WORKER, undefined, 2 * 1024 * 1024);
    expect(live.entries).toEqual([
      { id: "e2", role: "user", text: "do the thing" },
      { id: "s1", role: "user", text: "fix the login bug" },
      { id: "s2", role: "assistant", text: "Done, tests pass", tools: [{ name: "edit", args: "src/auth/session.ts" }] },
    ]);
    expect(live.done).toBe(true);
    expect(live.cursor).toBe("s2");

    // Pagination: since the cursor, only the tail comes back.
    const tail = await app.manager.history(WORKER, "s1", 2 * 1024 * 1024);
    expect(tail.entries.map((e) => e.id)).toEqual(["s2"]);

    // After the process is gone, the same page is parsed straight from the JSONL.
    await app.manager.stopProcess(WORKER);
    const cold = await app.manager.history(WORKER, undefined, 2 * 1024 * 1024);
    expect(cold.entries).toEqual([
      { id: "e2", role: "user", text: "do the thing" },
      { id: "s1", role: "user", text: "fix the login bug" },
      { id: "s2", role: "assistant", text: "Done, tests pass", tools: [{ name: "edit", args: "src/auth/session.ts" }] },
    ]);
  }, 60_000);

  it("unknown workers answer not_found; known-but-never-started ones answer no_history", async () => {
    const scenario = writeScenario(dir, "scenario", [conversationRun("u", "a")]);
    await startWorker(scenario);
    await expect(app.manager.history("w-never-seen", undefined, 1024)).rejects.toMatchObject({ code: "not_found" });

    // A worker row without a session file (registered by hand, never started).
    const solo = new WorkerManager({ store, stateDir });
    store.upsertWorker({ workerId: "w-no-file", threadId: "t", repoId: repo, mode: "write", state: "broken" });
    await expect(solo.history("w-no-file", undefined, 1024)).rejects.toMatchObject({ code: "no_history" });
    solo.stop();
  }, 60_000);
});

describe("history_req over the real transport (§6.6)", () => {
  it("streams windowed chunks: two in flight, acks release the rest, done terminates", async () => {
    // ~800 KB of entries → 4 chunks at the 256 KiB wire cap.
    const scenario = writeScenario(dir, "scenario", [bulkConversationRun(200)]);
    await startWorker(scenario);

    const reqId = mock.sendHistoryReq(WORKER, { maxBytes: 2 * 1024 * 1024 });
    await waitFor(() => mock.historyChunksFor(reqId).length >= 2, 20_000, "windowed first two chunks");
    let chunks = mock.historyChunksFor(reqId);
    expect(chunks.map((c) => c.n)).toEqual([0, 1]);
    expect(chunks.every((c) => c.done === false)).toBe(true);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(256 * 1024);
    }

    // No ack, no third chunk — the window is genuinely closed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mock.historyChunksFor(reqId)).toHaveLength(2);

    mock.ackHistory(reqId, 0);
    await waitFor(() => mock.historyChunksFor(reqId).length >= 3, 10_000, "chunk 2 after ack 0");
    mock.ackHistory(reqId, 1);
    await waitFor(() => mock.historyChunksFor(reqId).length >= 4, 10_000, "final chunk after ack 1");
    chunks = mock.historyChunksFor(reqId);
    expect(chunks.map((c) => c.n)).toEqual([0, 1, 2, 3]);
    const last = chunks[3]!;
    expect(last.done).toBe(true);
    expect(last.cursor).toBe("b199");
    expect(last.truncated).toBeUndefined(); // the whole transcript fit the 2 MB budget
    // Nothing lost across the split. The leading e2 entry is the delivered prompt
    // (fake-pi persists it with its §6.3 marker), so the transcript has 201 entries.
    const ids = chunks.flatMap((c) => (c.entries as Array<{ id: string }>).map((e) => e.id));
    expect(ids).toEqual(["e2", ...Array.from({ length: 200 }, (_, i) => `b${i}`)]);
  }, 90_000);

  it("marks a budget-cut page truncated and resumes from the cursor on the next request", async () => {
    const scenario = writeScenario(dir, "scenario", [bulkConversationRun(20)]);
    await startWorker(scenario);

    // A budget far below the whole transcript: the page cuts mid-way.
    const reqId = mock.sendHistoryReq(WORKER, { maxBytes: 20_000 });
    const chunks = await waitFor(() => {
      const got = mock.historyChunksFor(reqId);
      return got.length > 0 && got[got.length - 1]!.done === true ? got : undefined;
    }, 20_000, "budget-cut page");
    const last = chunks[chunks.length - 1]!;
    expect(last.truncated).toBe(true);
    expect(typeof last.cursor).toBe("string");
    const delivered = chunks.flatMap((c) => (c.entries as Array<{ id: string }>).map((e) => e.id));
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(20);

    // Continuing from the reported cursor serves the tail.
    const tailReq = mock.sendHistoryReq(WORKER, { since: last.cursor as string, maxBytes: 2 * 1024 * 1024 });
    const tail = await waitFor(() => {
      const got = mock.historyChunksFor(tailReq);
      return got.length > 0 && got[got.length - 1]!.done === true ? got : undefined;
    }, 20_000, "tail page");
    const tailIds = tail.flatMap((c) => (c.entries as Array<{ id: string }>).map((e) => e.id));
    expect(tailIds).toEqual(["e2", ...Array.from({ length: 20 }, (_, i) => `b${i}`)].slice(delivered.length));
    expect(tail[tail.length - 1]!.truncated).toBeUndefined();
  }, 90_000);

  it("answers an unknown worker with error{not_found} on the same reqId", async () => {
    const scenario = writeScenario(dir, "scenario", [conversationRun("u", "a")]);
    await startWorker(scenario);
    const reqId = mock.sendHistoryReq("w-ghost", {});
    const error = await waitFor(() => mock.errorsFor(reqId), 10_000, "error reply");
    expect(error).toMatchObject({ t: "error", re: reqId, code: "not_found" });
  }, 60_000);

  it("drops pending streams when the connection dies (nothing is re-sent)", async () => {
    const scenario = writeScenario(dir, "scenario", [bulkConversationRun(200)]);
    await startWorker(scenario);
    const reqId = mock.sendHistoryReq(WORKER, { maxBytes: 2 * 1024 * 1024 });
    await waitFor(() => mock.historyChunksFor(reqId).length >= 2, 20_000, "first two chunks");

    mock.dropConn();
    await waitFor(() => mock.upgrades() >= 2, 20_000, "reconnect");
    // The old request is not replayed on the new connection (§6.6: never re-sent).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mock.historyChunksFor(reqId)).toHaveLength(2);
  }, 90_000);
});

/** Joins the fragments of a full read back into the recorded JSON lines. */
function recordsOf(entries: Array<{ id: string; fragment?: { data: string; offset: number; total: number } }>): Array<Record<string, any>> {
  const lines: string[] = [];
  let open: string[] = [];
  for (const entry of entries) {
    const fragment = entry.fragment!;
    if (fragment.offset === 0) open = [];
    open.push(fragment.data);
    if (open.join("").length === fragment.total) lines.push(open.join(""));
  }
  return lines.map((text) => JSON.parse(text));
}

describe("full session reads (ADR-0003)", () => {
  it("serve the agent's own file record for record, whether or not its process is running", async () => {
    const scenario = writeScenario(dir, "scenario", [conversationRun("fix the login bug", "Done, tests pass")]);
    await startWorker(scenario);

    for (const phase of ["running", "stopped"]) {
      if (phase === "stopped") await app.manager.stopProcess(WORKER);
      const page = await app.manager.history(WORKER, undefined, 1024 * 1024, "full");
      expect(page.format, phase).toBe("full");
      expect(page.done, phase).toBe(true);
      const records = recordsOf(page.entries);
      const ids = records.filter((record) => record.type === "message").map((record) => record.id);
      expect(ids, phase).toEqual(["e2", "s1", "s2"]);
      // Nothing summarized: the tool call keeps its full arguments, the text its full length.
      const assistant = records.find((record) => record.id === "s2")!;
      expect(assistant.message.content[1]).toEqual({ type: "toolCall", id: "c1", name: "edit", arguments: { file_path: "src/auth/session.ts" } });
    }
  }, 60_000);

  it("answer no_history for a worker that has recorded nothing", async () => {
    const solo = new WorkerManager({ store, stateDir });
    store.upsertWorker({ workerId: "w-no-record", threadId: "t", repoId: repo, mode: "write", state: "broken" });
    await expect(solo.history("w-no-record", undefined, 1024 * 1024, "full")).rejects.toMatchObject({ code: "no_history" });
    await expect(solo.history("w-unknown", undefined, 1024 * 1024, "full")).rejects.toMatchObject({ code: "not_found" });
    solo.stop();
  });

  it("find a Claude Code worker's transcript in Claude Code's own folder", async () => {
    const config = join(dir, "claude-config");
    const sessionId = "0b7a5d5e-6f1b-5c0e-9a53-8a5b1d3c2e10";
    const folder = join(config, "projects", "elsewhere");
    mkdirSync(folder, { recursive: true });
    const records = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "fix it" } },
      { type: "assistant", uuid: "u2", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    ];
    writeFileSync(join(folder, `${sessionId}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    store.upsertWorker({ workerId: "w-claude", threadId: "t", repoId: repo, mode: "write", state: "idle", agent: "claude-code", sessionId });
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const solo = new WorkerManager({ store, stateDir });
    try {
      const page = await solo.history("w-claude", undefined, 1024 * 1024, "full");
      expect(recordsOf(page.entries)).toEqual(records);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      solo.stop();
    }
  });
});

describe("full history_req over the real transport", () => {
  it("streams fragments marked as a full read, resumable from the cursor", async () => {
    const scenario = writeScenario(dir, "scenario", [bulkConversationRun(30)]);
    await startWorker(scenario);

    const first = mock.sendHistoryReq(WORKER, { format: "full", maxBytes: 40_000 });
    const cut = await waitFor(() => {
      const got = mock.historyChunksFor(first);
      for (const chunk of got) mock.ackHistory(first, chunk.n as number); // release the window like the browser
      return got.length > 0 && got[got.length - 1]!.done === true ? got : undefined;
    }, 20_000, "the first page");
    expect(cut.every((chunk) => chunk.format === "full")).toBe(true);
    const last = cut[cut.length - 1]!;
    expect(last.truncated).toBe(true); // the budget ran out; there is more
    expect(typeof last.cursor).toBe("string");

    const second = mock.sendHistoryReq(WORKER, { format: "full", since: last.cursor as string, maxBytes: 2 * 1024 * 1024 });
    const rest = await waitFor(() => {
      const got = mock.historyChunksFor(second);
      for (const chunk of got) mock.ackHistory(second, chunk.n as number);
      return got.length > 0 && got[got.length - 1]!.done === true ? got : undefined;
    }, 20_000, "the rest");
    expect(rest[rest.length - 1]!.truncated).toBeUndefined();

    const entries = [...cut, ...rest].flatMap((chunk) => chunk.entries as Array<{ id: string; fragment?: { data: string; offset: number; total: number } }>);
    const messages = recordsOf(entries).filter((record) => record.type === "message").map((record) => record.id);
    expect(messages).toEqual(["e2", ...Array.from({ length: 30 }, (_, i) => `b${i}`)]);
  }, 90_000);

  it("answers a missing record with error{no_history}", async () => {
    const scenario = writeScenario(dir, "scenario", [conversationRun("u", "a")]);
    await startWorker(scenario);
    store.upsertWorker({ workerId: "w-bare", threadId: "t", repoId: repo, mode: "write", state: "broken" });
    const reqId = mock.sendHistoryReq("w-bare", { format: "full" });
    expect(await waitFor(() => mock.errorsFor(reqId), 10_000, "error reply")).toMatchObject({ t: "error", re: reqId, code: "no_history" });
  }, 60_000);
});
