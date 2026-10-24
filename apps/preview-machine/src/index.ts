import { Agent } from "agents";
import {
  browseDirectory,
  buildHello,
  registerRepository,
  scriptForStartWorker,
  workerEvent,
  type MachinePhase,
  type StoredCredentials,
  type WorkerSnapshot,
} from "./protocol.ts";

interface PairResponse {
  deviceId?: unknown;
  token?: unknown;
}

interface MachineRow extends StoredCredentials {
  bootId: string;
  connEpoch: number;
  phase: MachinePhase;
  lastError: string | null;
  updatedAt: number;
}

interface CommandRow {
  cmdId: string;
  state: "accepted" | "done" | "failed";
  result: string | null;
}

const CONTROL_PATHS = new Set(["/start", "/status", "/reconnect"]);
const RECONNECT_ALARM_MS = 20_000;
const WELCOME_TIMEOUT_MS = 15_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function constantTimeEquals(got: string, want: string): boolean {
  if (got.length !== want.length) return false;
  let difference = 0;
  for (let index = 0; index < want.length; index += 1) {
    difference |= got.charCodeAt(index) ^ want.charCodeAt(index);
  }
  return difference === 0;
}

function websocketUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "https:" : "http:";
  url.pathname = "/agents/steward/owner";
  url.search = "?role=connector&proto=1";
  return url.toString();
}

export class PreviewMachine extends Agent<Env> {
  private socket: WebSocket | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS machine_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        serverUrl TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        token TEXT NOT NULL,
        bootId TEXT NOT NULL,
        connEpoch INTEGER NOT NULL,
        phase TEXT NOT NULL,
        lastError TEXT,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_result (
        cmdId TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS worker (
        workerId TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        state TEXT NOT NULL,
        lastSeq INTEGER NOT NULL,
        sessionId TEXT NOT NULL,
        lastOutcome TEXT NOT NULL DEFAULT ''
      );
    `;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!CONTROL_PATHS.has(url.pathname)) return json({ error: "not_found" }, 404);
    if ((request.method === "GET") !== (url.pathname === "/status")) return json({ error: "method_not_allowed" }, 405);

    const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeEquals(key, this.env.PREVIEW_MACHINE_KEY)) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/status") return json(this.status());
    if (url.pathname === "/reconnect") {
      await this.reconnect();
      return json(this.status());
    }

    let body: { serverUrl?: unknown; pairingCode?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    if (typeof body.serverUrl !== "string" || typeof body.pairingCode !== "string") {
      return json({ error: "bad_request" }, 400);
    }
    try {
      await this.pair(body.serverUrl, body.pairingCode);
      await this.connectToSteward();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ...this.status(), error: message }, 502);
    }
    return this.waitForWelcome();
  }

  async alarm(): Promise<void> {
    const state = this.readStateOrNull();
    if (!state) return;
    if (this.socket?.readyState === WebSocket.OPEN && state.phase === "welcomed") {
      this.send({ t: "ping", id: `ping-${Date.now()}` });
    } else {
      await this.connectToSteward();
    }
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_ALARM_MS);
  }

  private async waitForWelcome(): Promise<Response> {
    const deadline = Date.now() + WELCOME_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = this.readState();
      if (state.phase === "welcomed") return json(this.status());
      if (state.phase === "error" || state.phase === "disconnected") {
        return json({ ...this.status(), error: state.lastError ?? state.phase }, 503);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return json({ ...this.status(), error: "welcome timeout" }, 504);
  }

  private async pair(serverUrlInput: string, pairingCode: string): Promise<void> {
    const serverUrl = new URL(serverUrlInput).toString().replace(/\/$/, "");
    const response = await fetch(new URL("/pair", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: pairingCode, name: "preview-machine" }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`pairing failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const result = (await response.json()) as PairResponse;
    if (typeof result.deviceId !== "string" || typeof result.token !== "string") {
      throw new Error("pairing response is missing credentials");
    }
    const previous = this.readStateOrNull();
    this.sql`
      INSERT OR REPLACE INTO machine_state
        (id, serverUrl, deviceId, token, bootId, connEpoch, phase, lastError, updatedAt)
      VALUES (1, ${serverUrl}, ${result.deviceId}, ${result.token}, ${previous?.bootId ?? crypto.randomUUID()}, 0, 'connecting', NULL, ${Date.now()})
    `;
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_ALARM_MS);
  }

  private async connectToSteward(): Promise<void> {
    const state = this.readState();
    if (state.phase === "unpaired") return;
    const connEpoch = state.connEpoch + 1;
    this.setPhase("connecting", connEpoch, null);
    try {
      const response = await fetch(websocketUrl(state.serverUrl), {
        headers: { authorization: `Bearer ${state.token}`, upgrade: "websocket" },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`websocket upgrade failed with HTTP ${response.status}`);
      }
      const socket = response.webSocket;
      socket.accept();
      socket.addEventListener("message", (event) => {
        void this.handleMessage(socket, event.data);
      });
      socket.addEventListener("close", (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.setPhase("disconnected", connEpoch, `websocket closed: ${event.code}`);
        void this.ctx.storage.setAlarm(Date.now() + 2_000);
      });
      socket.addEventListener("error", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.setPhase("error", connEpoch, "websocket error");
        void this.ctx.storage.setAlarm(Date.now() + 2_000);
      });
      this.socket = socket;
      this.send(buildHello(state, state.bootId, connEpoch, this.workerSnapshots()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPhase("error", connEpoch, message);
      await this.ctx.storage.setAlarm(Date.now() + 2_000);
    }
  }

  private async handleMessage(socket: WebSocket, rawData: unknown): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(rawData)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.t === "welcome") {
      if (typeof message.token === "string" && message.token.length > 0) {
        this.sql`
          UPDATE machine_state SET token = ${message.token}, updatedAt = ${Date.now()} WHERE id = 1
        `;
      }
      this.setPhase("welcomed", undefined, null);
      return;
    }
    if (message.t === "directory_list") {
      if (typeof message.id !== "string") return;
      this.send({
        t: "directory_listing",
        re: message.id,
        ...browseDirectory({ path: message.path, showHidden: message.showHidden }),
      });
      return;
    }
    if (message.t === "cmd" && typeof message.id === "string" && typeof message.kind === "string") {
      await this.handleCommand(socket, message.id, message.kind, (message.args ?? {}) as Record<string, unknown>);
    }
  }

  private async handleCommand(socket: WebSocket, cmdId: string, kind: string, args: Record<string, unknown>): Promise<void> {
    const known = this.commandResult(cmdId);
    if (known) {
      this.send({
        t: "cmd_ack",
        re: cmdId,
        status: known.state === "accepted" ? "accepted" : "duplicate",
        ...(known.state === "accepted" ? {} : { result: known.result }),
      });
      return;
    }
    this.sql`
      INSERT INTO command_result (cmdId, state, result) VALUES (${cmdId}, 'accepted', NULL)
    `;
    this.send({ t: "cmd_ack", re: cmdId, status: "accepted" });

    if (kind === "register_repo") {
      const registration = registerRepository(args.path);
      if (!registration.ok) {
        const error = { code: registration.code };
        this.finishCommand(cmdId, false, error);
        this.send({ t: "cmd_ack", re: cmdId, status: "rejected", code: registration.code });
        this.send({ t: "cmd_result", re: cmdId, ok: false, error });
        return;
      }
      const data = { repo: registration.repo };
      this.finishCommand(cmdId, true, data);
      this.send({ t: "cmd_result", re: cmdId, ok: true, data });
      return;
    }

    if (kind === "start_worker") {
      const script = scriptForStartWorker(args);
      if (!script.ok) {
        const error = script.error;
        this.finishCommand(cmdId, false, error);
        this.send({ t: "cmd_ack", re: cmdId, status: "rejected", code: error.code });
        this.send({ t: "cmd_result", re: cmdId, ok: false, error });
        return;
      }
      this.finishCommand(cmdId, true, script.data);
      this.send({ t: "cmd_result", re: cmdId, ok: true, data: script.data });
      this.saveWorker(script.workerId, script.data.sessionId, 0, "running");
      this.emit(script.workerId, "started", {
        sessionId: script.data.sessionId,
        cwd: script.data.cwd,
        branch: script.data.branch,
      });
      this.emit(script.workerId, "progress", {
        type: "progress",
        phase: "tool",
        tool: "edit",
        target: "src/preview.ts",
        turn: 1,
      });
      this.emit(script.workerId, "report", {
        type: "report",
        status: "done",
        summary: "Preview machine completed the scripted task.",
        git: { ...script.git, pushed: true },
      });
      this.emit(script.workerId, "settled", {
        type: "settled",
        outcome: "reported",
        usage: { tokens: { input: 100, output: 20 }, cost: 0 },
      });
      this.saveWorker(script.workerId, script.data.sessionId, 4, "idle");
      return;
    }

    if (kind === "pr_worker") {
      const data = { url: `https://example.com/sig/preview/${encodeURIComponent(String(args.workerId ?? "worker"))}` };
      this.finishCommand(cmdId, true, data);
      this.send({ t: "cmd_result", re: cmdId, ok: true, data });
      return;
    }

    if (kind === "send" || kind === "interrupt" || kind === "stop_process" || kind === "resume" || kind === "cleanup_worktree") {
      this.finishCommand(cmdId, true, {});
      this.send({ t: "cmd_result", re: cmdId, ok: true, data: {} });
      return;
    }

    const error = { code: "unsupported_command", message: `Preview machine does not implement ${kind}` };
    this.finishCommand(cmdId, false, error);
    this.send({ t: "cmd_ack", re: cmdId, status: "rejected", code: error.code });
    this.send({ t: "cmd_result", re: cmdId, ok: false, error });
  }

  private finishCommand(cmdId: string, ok: boolean, payload: unknown): void {
    const result = JSON.stringify({ ok, ...(ok ? { data: payload } : { error: payload }) });
        this.sql`
      UPDATE command_result SET state = ${ok ? "done" : "failed"}, result = ${result}
      WHERE cmdId = ${cmdId}
    `;
  }

  private commandResult(cmdId: string): { state: "accepted" | "done" | "failed"; result: unknown } | null {
    const row = this.sql<CommandRow>`
      SELECT cmdId, state, result FROM command_result WHERE cmdId = ${cmdId}
    `[0];
    if (!row) return null;
    return { state: row.state, result: row.result === null ? null : (JSON.parse(row.result) as unknown) };
  }

  private emit(workerId: string, type: "started" | "progress" | "report" | "settled", fields: Record<string, unknown>): void {
    const row = this.sql<{ seq: number }>`
      SELECT lastSeq FROM worker WHERE workerId = ${workerId}
    `[0];
    const seq = (row?.seq ?? 0) + 1;
    this.sql`UPDATE worker SET lastSeq = ${seq} WHERE workerId = ${workerId}`;
    this.send({ t: "events", ...workerEvent(workerId, seq, type, fields) });
  }

  private saveWorker(workerId: string, sessionId: string, lastSeq: number, state: string): void {
    this.sql`
      INSERT INTO worker (workerId, agent, state, lastSeq, sessionId, lastOutcome)
      VALUES (${workerId}, 'pi', ${state}, ${lastSeq}, ${sessionId}, '')
      ON CONFLICT(workerId) DO UPDATE SET state = excluded.state, lastSeq = excluded.lastSeq
    `;
  }

  private workerSnapshots(): WorkerSnapshot[] {
    return this.sql<WorkerSnapshot>`
      SELECT workerId, agent, state, lastSeq, sessionId, lastOutcome FROM worker ORDER BY workerId
    `;
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private setPhase(phase: MachinePhase, connEpoch = this.readState().connEpoch, lastError: string | null): void {
    this.sql`
      UPDATE machine_state SET phase = ${phase}, connEpoch = ${connEpoch}, lastError = ${lastError}, updatedAt = ${Date.now()}
      WHERE id = 1
    `;
  }

  private readStateOrNull(): MachineRow | null {
    return this.sql<MachineRow>`SELECT * FROM machine_state WHERE id = 1`[0] ?? null;
  }

  private readState(): MachineRow {
    return (
      this.readStateOrNull() ?? {
        serverUrl: "",
        deviceId: "",
        token: "",
        bootId: crypto.randomUUID(),
        connEpoch: 0,
        phase: "unpaired",
        lastError: null,
        updatedAt: Date.now(),
      }
    );
  }

  private status(): Record<string, unknown> {
    const state = this.readState();
    return {
      phase: state.phase,
      serverUrl: state.serverUrl,
      deviceId: state.deviceId,
      connEpoch: state.connEpoch,
      lastError: state.lastError,
      workers: this.workerSnapshots(),
    };
  }

  private async reconnect(): Promise<void> {
    if (!this.readStateOrNull()) return;
    await this.connectToSteward();
    await this.ctx.storage.setAlarm(Date.now() + RECONNECT_ALARM_MS);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!CONTROL_PATHS.has(url.pathname)) return json({ error: "not_found" }, 404);
    const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantTimeEquals(key, env.PREVIEW_MACHINE_KEY)) return json({ error: "unauthorized" }, 401);
    const stub = env.PreviewMachine.get(env.PreviewMachine.idFromName("singleton"));
    return stub.fetch(request);
  },
};
