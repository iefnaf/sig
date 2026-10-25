// PR #45 review round 2 regressions (R2-1..R2-3): the three LOW residuals the second
// review asked a follow-up commit for — transition chaining (an interrupt in the overlap
// of two transitions must wait the live one out), the forced then-prompt falling through
// to a cold relaunch when the process died during the settle wait, and a partial
// interrupt failure (clear_queue ok, abort failed) still surfacing queue_returned.
// These need precise interleaving control, so they drive a fully scriptable AgentAdapter
// instead of fake-pi's real process boundary.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerManager } from "../src/worker-manager.ts";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { tmpDir, waitFor } from "./helpers.ts";
import type {
  AgentAdapter,
  AgentCapabilities,
  Delivery,
  InterruptResult,
  RawAdapterEvent,
  StartSpec,
  WorkerHandle,
} from "../src/agent.ts";
import { PartialInterruptError } from "../src/agent.ts";

interface EmittedEvent {
  workerId: string;
  seq: number;
  ts: number;
  type: string;
  [key: string]: unknown;
}

/** Adapter starts pend until the test resolves them; send/interrupt behaviors are set per
 *  test. This is the timing control fake-pi cannot give (its boundary is a real process). */
class ScriptedAdapter implements AgentAdapter {
  readonly kind = "pi" as const;
  readonly capabilities: AgentCapabilities = {
    steer: true,
    followUp: true,
    interrupt: true,
    resume: true,
    history: true,
    images: true,
    structuredReport: true,
    readonly: true,
  };
  readonly running = new Set<string>();
  readonly streaming = new Set<string>();
  readonly pendingStarts: Array<{
    spec: StartSpec;
    resolve: (handle: WorkerHandle) => void;
    reject: (err: Error) => void;
  }> = [];
  readonly startSpecs: StartSpec[] = [];
  /** Thrown by every send() — models a dead process (code not_running) or any RPC failure. */
  sendError?: Error;
  /** Texts the next interrupt's clear_queue hands back. */
  nextReturned: string[] = [];
  /** Reject the next interrupt's abort after clear_queue succeeded (R2-3). */
  failAbortAfterClearQueue?: Error;

  on(_event: "worker-event", _fn: (e: RawAdapterEvent) => void): void {}
  start(spec: StartSpec): Promise<WorkerHandle> {
    this.startSpecs.push(spec);
    return new Promise((resolve, reject) => {
      this.pendingStarts.push({ spec, resolve, reject });
    });
  }
  async send(_id: string, _input: { text: string }, _how: Delivery): Promise<{ effect?: string }> {
    if (this.sendError) throw this.sendError;
    return {};
  }
  async interrupt(_id: string): Promise<InterruptResult> {
    const returned = this.nextReturned;
    this.nextReturned = [];
    if (this.failAbortAfterClearQueue) {
      const cause = this.failAbortAfterClearQueue;
      this.failAbortAfterClearQueue = undefined;
      throw new PartialInterruptError(returned, cause);
    }
    return { returned };
  }
  async resume(): Promise<void> {}
  async stopProcess(id: string): Promise<void> {
    this.running.delete(id);
  }
  isRunning(id: string): boolean {
    return this.running.has(id);
  }
  isStreaming(id: string): boolean {
    return this.streaming.has(id);
  }
}

/** Resolves the oldest pending start as a successful boot. */
function resolveStart(adapter: ScriptedAdapter): void {
  const pending = adapter.pendingStarts.shift();
  if (!pending) throw new Error("no pending adapter start to resolve");
  pending.resolve({ workerId: pending.spec.workerId, sessionId: pending.spec.workerId, cwd: pending.spec.cwd });
}

let dir: string;
let store: LocalStore;
let events: EmittedEvent[];
let adapter: ScriptedAdapter;
let manager: WorkerManager;

beforeEach(() => {
  dir = tmpDir("sig-review-round2-test");
  const stateDir = join(dir, "state");
  const repoDir = join(dir, "repo-a");
  mkdirSync(repoDir, { recursive: true });
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  const eventLog = new EventLog(store.database);
  events = [];
  store.addRepo({ repoId: "repo-x", name: "repo-a", path: repoDir, capability: { kind: "git", gitRoot: repoDir, defaultBranch: "main", remote: null } });
  store.upsertWorker({
    workerId: "w-r2",
    threadId: "t1",
    repoId: "repo-x",
    mode: "write",
    state: "idle",
    sessionId: "w-r2",
    sessionFile: null,
  });
  adapter = new ScriptedAdapter();
  manager = new WorkerManager({
    store,
    stateDir,
    adapter,
    // R2-2's settle wait times out fast; nothing else in these tests waits on it.
    recovery: { abortSettleTimeoutMs: 60 },
    emit: (workerId, fields) => {
      const stored = eventLog.append(workerId, fields);
      events.push(JSON.parse(stored.payload) as EmittedEvent);
    },
  });
});

afterEach(() => {
  manager?.stop();
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe("review round 2 regressions (R2-1..R2-3)", () => {
  it("R2-1: transitions on one worker chain — an interrupt in the overlap waits the live transition out", async () => {
    // T1: a manual resume on the idle-cold worker; its adapter start pends.
    const resumeCmd = manager.handleCommand("cmd-resume-1", "resume", { workerId: "w-r2", reason: "test" });
    await waitFor(() => (adapter.pendingStarts.length === 1 ? true : undefined), 2000, "resume start pending");

    // T2: a send racing it on the idle-cold row. The old code registered T2 by overwriting
    // T1, T2 lost the lock loudly (lock_held), and its settle deleted the still-running
    // T1's entry — an interrupt in that window found nothing to wait and raced the boot.
    const sendCmd = manager.handleCommand("cmd-send-1", "send", { workerId: "w-r2", text: "竞态指令", intent: "auto" });
    sendCmd.catch(() => {}); // rejects below; silences the pre-assertion window

    const interruptCmd = manager.handleCommand("cmd-int-1", "interrupt", { workerId: "w-r2" });
    const early = await Promise.race([
      interruptCmd.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 150)),
    ]);
    expect(early).toBe("still-waiting"); // the interrupt is held by the live transition

    // T1 lands; T2 then runs chained and loses the lock loudly (T1's boot holds it) —
    // exactly the backstop the review walked, now without breaking the map invariant.
    adapter.running.add("w-r2");
    resolveStart(adapter);
    await expect(resumeCmd).resolves.toMatchObject({ resumed: true });
    await expect(sendCmd).rejects.toMatchObject({ code: "lock_held" });
    await expect(interruptCmd).resolves.toMatchObject({ aborted: true, queueReturned: 0 });
  }, 15_000);

  it("R2-2: the forced then-prompt hits a dead process → falls through to the cold relaunch", async () => {
    // The store stalled at `running` with pi's run window closed (review #2's forced-prompt
    // branch) — and the process died during the bounded settle wait.
    store.setWorkerState("w-r2", "running");
    adapter.sendError = Object.assign(new Error("no live pi process for worker w-r2"), { code: "not_running" });

    const cmd = manager.handleCommand("cmd-int-1", "interrupt", {
      workerId: "w-r2",
      then: { text: "停；换新方向重做" },
    });
    // The settle wait times out (nothing settles), the forced prompt hits the dead process
    // — and the fall-through cold-relaunches with the then-text as its prompt.
    await waitFor(() => (adapter.pendingStarts.length === 1 ? true : undefined), 5000, "cold relaunch started");
    resolveStart(adapter);
    await expect(cmd).resolves.toMatchObject({ aborted: false, then: { delivery: "prompt", relaunched: true } });
    expect(adapter.startSpecs[0]!.prompt).toBe("停；换新方向重做");
  }, 15_000);

  it("R2-3: a partial interrupt failure (clear_queue ok, abort failed) still surfaces queue_returned", async () => {
    store.setWorkerState("w-r2", "running");
    adapter.running.add("w-r2");
    adapter.streaming.add("w-r2");
    adapter.nextReturned = ["停之前未送达的转向"];
    adapter.failAbortAfterClearQueue = new Error("rpc timed out after 15000ms");

    const cmd = manager.handleCommand("cmd-int-1", "interrupt", { workerId: "w-r2" });
    await expect(cmd).rejects.toThrow(/interrupt failed after clear_queue/);
    // clear_queue already emptied pi's queue — the retrieved texts rode the failure, so
    // queue_returned still reached the steward instead of vanishing with the command.
    expect(events.find((e) => e.type === "queue_returned")).toMatchObject({ texts: ["停之前未送达的转向"] });
  }, 15_000);
});
