// Composition root: LocalStore + WorkerManager + ConnectorClient. Commands arriving on the
// authenticated connection drive the WorkerManager through the client's handleCommand hook
// (CommandLog dedup happens there); worker events flow back via client.emit — persisted to
// the durable EventLog before the wire (connector-pi.md §11.3, connector-do-protocol.md §7.1).
import os from "node:os";
import { ConnectorClient, type ClientOptions } from "./client.ts";
import type { CommandResult } from "./commands.ts";
import type { CmdMessage } from "@shepherd/protocol";
import { EventLog } from "./events.ts";
import type { LocalStore } from "./store.ts";
import { CommandError, WorkerManager } from "./worker-manager.ts";

export interface ConnectorAppOptions {
  store: LocalStore;
  stateDir: string;
  machineName?: string;
  WebSocketImpl?: ClientOptions["WebSocketImpl"];
  /** Overrides the agent adapter (tests inject fake-pi). */
  adapter?: import("./agent.ts").AgentAdapter;
  /** Coarse lifecycle logging (daemon): event names and ids only, never session content. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Connection lifecycle hooks, forwarded to the client (the daemon logs these). */
  onWelcome?: ClientOptions["onWelcome"];
  onClose?: ClientOptions["onClose"];
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
      emit: (workerId, fields) => {
        options.log?.("worker_event", { workerId, type: fields.type });
        this.client.emit(workerId, fields);
      },
    });

    this.client = new ConnectorClient({
      store: options.store,
      machineName: options.machineName,
      WebSocketImpl: options.WebSocketImpl,
      handleCommand: (cmd: CmdMessage) => this.runCommand(cmd, options.log),
      snapshot: () => this.snapshot(),
      onWelcome: options.onWelcome,
      onClose: options.onClose,
      workersSnapshot: () =>
        this.store.listWorkers().map((w) => ({
          workerId: w.workerId,
          agent: "pi",
          state: w.state,
          lastSeq: events.nextSeq(w.workerId) - 1,
          sessionId: w.sessionId ?? "",
          lastOutcome: w.lastOutcome ?? "",
        })),
    });
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  private async runCommand(
    cmd: CmdMessage,
    log?: (event: string, fields?: Record<string, unknown>) => void,
  ): Promise<CommandResult> {
    log?.("command_received", { cmdId: cmd.id, kind: cmd.kind });
    try {
      const data = await this.manager.handleCommand(cmd.id, cmd.kind, cmd.args ?? {});
      log?.("command_settled", { cmdId: cmd.id, kind: cmd.kind, ok: true });
      return { ok: true, data };
    } catch (err) {
      if (err instanceof CommandError) {
        log?.("command_settled", {
          cmdId: cmd.id,
          kind: cmd.kind,
          ok: false,
          code: err.code,
        });
        return { ok: false, error: { code: err.code, message: err.message, retriable: err.retriable } };
      }
      const code = (err as { code?: string }).code ?? "internal";
      const message = err instanceof Error ? err.message : String(err);
      log?.("command_settled", { cmdId: cmd.id, kind: cmd.kind, ok: false, code });
      return { ok: false, error: { code, message, retriable: false } };
    }
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
