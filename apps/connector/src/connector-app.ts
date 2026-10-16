// Composition root: LocalStore + WorkerManager + ConnectorClient. Commands arriving on the
// authenticated connection drive the WorkerManager through the client's handleCommand hook
// (CommandLog dedup happens there); worker events flow back via client.emit — persisted to
// the durable EventLog before the wire (connector-pi.md §11.3, connector-do-protocol.md §7.1).
// On boot the §9.1 reconciliation runs BEFORE the first hello, so the hello.workers snapshot
// the DO reconciles against already reflects the crash (issue #12).
import os from "node:os";
import { ConnectorClient, type ClientOptions } from "./client.ts";
import type { CommandResult } from "./commands.ts";
import type { CmdMessage } from "@shepherd/protocol";
import { EventLog } from "./events.ts";
import type { LocalStore } from "./store.ts";
import { CommandError, WorkerManager, type RecoveryOptions } from "./worker-manager.ts";

export interface ConnectorAppOptions {
  store: LocalStore;
  stateDir: string;
  machineName?: string;
  WebSocketImpl?: ClientOptions["WebSocketImpl"];
  /** Overrides the agent adapter (tests inject fake-pi). */
  adapter?: import("./agent.ts").AgentAdapter;
  /** §9 recovery knobs (tests shrink timers and inject process I/O). */
  recovery?: RecoveryOptions;
}

/** §12: clamp(floor(0.5 × total memory MB / 250 MB), 1, 8), configurable later. */
export function maxWorkersFromMemory(): number {
  return Math.min(8, Math.max(1, Math.floor(0.5 * (os.totalmem() / 1_000_000) / 250)));
}

export class ConnectorApp {
  private readonly store: LocalStore;
  readonly manager: WorkerManager;
  readonly client: ConnectorClient;

  constructor(options: ConnectorAppOptions) {
    this.store = options.store;
    const events = new EventLog(options.store.database);
    this.manager = new WorkerManager({
      store: options.store,
      stateDir: options.stateDir,
      adapter: options.adapter,
      recovery: options.recovery,
      emit: (workerId, fields) => this.client.emit(workerId, fields),
    });

    this.client = new ConnectorClient({
      store: options.store,
      machineName: options.machineName,
      WebSocketImpl: options.WebSocketImpl,
      handleCommand: (cmd: CmdMessage) => this.runCommand(cmd),
      snapshot: () => this.snapshot(),
      workersSnapshot: () => this.workersSnapshot(),
    });
  }

  /**
   * Reconcile first (§9.1: orphan cleanup, stale locks, session-tail checks, resume
   * scheduling), then connect — the first hello's workers snapshot and bootId let the DO
   * reconcile against post-crash reality instead of stale pre-crash states.
   */
  async start(): Promise<void> {
    await this.manager.reconcileStartup();
    this.client.start();
  }

  stop(): void {
    this.manager.stop();
    this.client.stop();
  }

  /** Test support: emulate a connector crash (issue #12 fault injection). */
  simulateCrash(): void {
    this.manager.simulateCrash();
    this.client.stop();
  }

  private async runCommand(cmd: CmdMessage): Promise<CommandResult> {
    try {
      let data: unknown;
      if (cmd.kind === "reconcile") {
        // protocol §6.2: a fresh hello.workers snapshot on demand.
        data = { workers: this.workersSnapshot() };
      } else {
        data = await this.manager.handleCommand(cmd.id, cmd.kind, cmd.args ?? {}, cmd.workerId);
      }
      return { ok: true, data };
    } catch (err) {
      if (err instanceof CommandError) {
        return { ok: false, error: { code: err.code, message: err.message, retriable: err.retriable } };
      }
      const code = (err as { code?: string }).code ?? "internal";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code, message, retriable: false } };
    }
  }

  /** The hello.workers snapshot (protocol §6.1): every worker from the connector's point of
   * view — the DO's reconciliation input. `lastSeq` lets the DO skip workers whose event
   * stream is still in flight. */
  workersSnapshot(): Array<Record<string, unknown>> {
    const events = new EventLog(this.store.database);
    return this.store.listWorkers().map((w) => ({
      workerId: w.workerId,
      agent: "pi",
      state: w.state,
      lastSeq: events.nextSeq(w.workerId) - 1,
      sessionId: w.sessionId ?? "",
      lastOutcome: w.lastOutcome ?? "",
    }));
  }

  /** Honest hello snapshot (protocol §6.1): agents, repos, limits. */
  private snapshot() {
    const workers = this.store.listWorkers();
    return {
      agents: this.manager.agents.map((a) => ({ kind: a.kind, capabilities: a.capabilities })),
      repos: this.store.listRepos().map((r) => ({
        repoId: r.repoId,
        name: r.name,
        path: r.path,
        defaultBranch: r.defaultBranch ?? "",
        remote: r.remote ?? "",
      })),
      limits: {
        maxWorkers: maxWorkersFromMemory(),
        running: workers.filter((w) => w.state === "running" || w.state === "starting").length,
      },
    };
  }
}
