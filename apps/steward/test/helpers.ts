import { SELF, env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import type { ShOutboundRow, Steward } from "../src/steward.ts";
import type { FauxRequestRecord } from "../src/llm/models.ts";

export function ownerStub() {
  const id = env.Steward.idFromName("owner");
  return env.Steward.get(id) as unknown as DurableObjectStub<Steward> & Steward;
}

// DO SQLite is NOT rolled back between tests in this setup (state visibly carries over), so
// every channel test starts by clearing the sh_* tables the same way the outbox tests reach
// in with raw SQL.
export async function resetChannelState(): Promise<void> {
  // Any RPC first: it flows through the SDK lifecycle, which runs onStart() → migrations.
  // Hitting runInDurableObject on a cold DO would find no sh_* tables yet.
  await ownerStub().setupState();
  await runInDurableObject(ownerStub(), (instance: Steward) => {
    // `.bind` matters: the SDK's sql tagged template reads `this.ctx`, so it must be invoked
    // through the instance (the outbox tests use method-call form for the same reason).
    const sql = (
      instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }
    ).sql.bind(instance);
    sql`DELETE FROM sh_channel`;
    sql`DELETE FROM sh_qr_setup`;
    sql`DELETE FROM sh_inbound`;
    sql`DELETE FROM sh_outbound`;
    sql`DELETE FROM sh_channel_log`;
    sql`DELETE FROM sh_channel_token`;
    sql`DELETE FROM sh_channel_pace`;
  });
}

/** Clears everything issue #5's loop touches: the ledger tables, the protocol queues, pairing. */
export async function resetLedgerState(): Promise<void> {
  await resetChannelState();
  await runInDurableObject(ownerStub(), async (instance: Steward) => {
    // Routines/follow-ups own SDK schedules that outlive table rows — cancel them first
    // (issue #20), or a stray fire lands in whichever test runs next.
    await instance.resetRoutineStateForTests();
    // The steward conversation must not leak between tests: dispose pi, drop its tables,
    // and clear the run/wake bookkeeping (sh_run/sh_wake are ledger-owned but reset here as
    // part of the LLM state, together with the pi tables they mirror).
    await instance.resetLlmStateForTests();
    // The tagged template needs literal fragments; table names are looped, so use the raw
    // storage executor instead (same SQLite the migrations run on). `ctx` is protected on the
    // SDK class, hence the shape cast.
    const storage = (instance as unknown as { ctx: { storage: { sql: { exec: (query: string) => unknown } } } }).ctx.storage;
    for (const table of [
      "sh_machine", "sh_repo", "sh_thread", "sh_thread_repo", "sh_thread_summary", "sh_worker", "sh_report",
      "sh_timeline", "sh_question", "sh_notify", "sh_note", "sh_note_log", "event_inbox", "worker_ack", "outbox",
      "sh_web_link", "sh_web_session", "sh_deploy", "device", "pairing", "sh_reap_pending",

    ]) {
      storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}

/** llmState's shape, declared locally: through the RPC stub's inferred type the class method's
 *  return collapses to `never`, so tests read it through this view instead. */
export interface LlmStateView {
  runs: Array<{ operationId: string; kind: string; status: string; text: string; resultStatus: string | null; resultReason: string | null; resultText: string | null; replyOutboundId: string | null; replyTo: string | null; routedThreadId: string | null; dispatchCount: number }>;
  inputs: Array<{ operationId: string; kind: string; text: string }>;
  assistantTexts: string[];
  raw: unknown[];
}

export async function llmState(): Promise<LlmStateView> {
  return ownerStub().llmState();
}

// ---- The scripted steward model (issue #6) -------------------------------------------------------
// The DO's STEWARD_MODEL binding points at the faux provider; these helpers queue replies and
// read back what the model saw. Steps are built with fauxAssistantMessage/fauxToolCall from
// pi-ai (plain JSON, RPC-serializable).

export async function scriptModel(...steps: unknown[]): Promise<void> {
  await ownerStub().fauxScript(steps as never[]);
}

export async function modelRequests(): Promise<FauxRequestRecord[]> {
  return ownerStub().fauxRequests();
}

/**
 * Polls ONLY the outbound queue until a sent text row equals `text` — deliberately never
 * touches pollRuns/drainWakes, so alarm-driven paths (review #1's regression) must carry the
 * run home on their own.
 */
export async function waitForSentText(text: string, timeoutMs = 25_000): Promise<ShOutboundRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await ownerStub().outboundRows(50);
    const hit = rows.find((r) => r.kind === "text" && r.status === "sent" && (JSON.parse(r.payload as string) as { text?: string }).text === text);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`sent text never arrived: ${text} (rows: ${JSON.stringify(rows.map((r) => [r.kind, r.status]))})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Polls until every sh_run row is settled and no wake is pending (the alarm paths settle). */
export async function waitRunsSettled(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await llmState();
    const snap = await ownerStub().debugSnapshot();
    const openRuns = state.runs.filter((r) => r.status === "open");
    const pendingWakes = snap.wakes.filter((w) => w.status === "pending");
    if (openRuns.length === 0 && pendingWakes.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`runs/wakes still pending: ${JSON.stringify({ runs: state.runs, wakes: snap.wakes })}`);
    }
    // The alarm-driven poll runs every 2s in production; nudge it for deterministic tests.
    await ownerStub().pollRuns();
    await ownerStub().drainWakes();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- Feishu mock (service binding FEISHU_API, wired in vitest.config.ts) ----

export interface MockReply {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

export interface RecordedCall {
  method: string;
  path: string;
  url: string;
  body: string | null;
  at: number;
}

const MOCK = "https://feishu.invalid";

// vitest.config.ts always binds FEISHU_API; the optionality only exists for production.
function feishuMock(): Fetcher {
  if (!env.FEISHU_API) throw new Error("FEISHU_API service binding missing — check vitest.config.ts");
  return env.FEISHU_API;
}

export async function mockReset(): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/reset`, { method: "POST" });
}

export async function mockQueue(...replies: MockReply[]): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/queue`, { method: "POST", body: JSON.stringify(replies) });
}

/** Scripts the device flow (see vitest.config.ts): `begin`/`polls` are FIFO arrays whose last entry repeats. */
export async function mockRegistration(script: { begin?: unknown[]; polls?: unknown[] }): Promise<void> {
  await feishuMock().fetch(`${MOCK}/__control/registration`, { method: "POST", body: JSON.stringify(script) });
}

export async function mockCalls(): Promise<RecordedCall[]> {
  const res = await feishuMock().fetch(`${MOCK}/__control/calls`, { method: "POST" });
  return res.json();
}

export function sendCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "POST" && c.path.startsWith("/open-apis/im/v1/messages"));
}

export function tokenCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.path.startsWith("/open-apis/auth/v3/tenant_access_token"));
}

export function registrationCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.path === "/oauth/v1/app/registration");
}

export function configPatchCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === "PATCH" && /\/open-apis\/application\/v7\/applications\/[^/]+\/config$/.test(c.path));
}

// The credentials every helper below uses; the webhook's verification token must match
// `messageEvent({ token })` and `urlVerification({ token })`.
export const TEST_APP_ID = "cli_test_app";
export const TEST_APP_SECRET = "sec_test_secret";
export const TEST_VERIFY_TOKEN = "verify-token";
export const SETUP_URL = "https://example.com/setup?token=test-setup-token-not-a-secret";

export async function submitSetupCredentials(
  appId = TEST_APP_ID,
  appSecret = TEST_APP_SECRET,
  verificationToken = TEST_VERIFY_TOKEN,
): Promise<Response> {
  const body = new URLSearchParams({ action: "manual", appId, appSecret, verificationToken });
  return SELF.fetch(SETUP_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** Posts a setup-page action (QR flow start / scope scan / webhook PATCH). */
export function postSetupAction(action: string): Promise<Response> {
  return SELF.fetch(SETUP_URL, {
    method: "POST",
    body: new URLSearchParams({ action }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

/** Polls the QR state machine until the given phase appears (alarm-driven, so async). */
export async function waitForQrPhase(phase: string | string[], timeoutMs = 20_000): Promise<void> {
  const wanted = Array.isArray(phase) ? phase : [phase];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await ownerStub().qrSetupState();
    if (row && wanted.includes(row.phase)) return;
    if (Date.now() > deadline) throw new Error(`qr phase ${wanted.join("|")} not reached; now: ${row?.phase ?? "none"} err=${row?.lastError ?? "-"}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The decrypted channel config, read inside the DO — tests need the QR-generated verification token. */
export interface ChannelConfigView {
  appId: string;
  appSecret: string;
  verificationToken: string;
  ownerOpenId: string | null;
  brand: "feishu" | "lark";
  source: "manual" | "qr";
  webhookStatus: string | null;
}
export async function readChannelConfig(): Promise<ChannelConfigView | null> {
  return runInDurableObject(ownerStub(), async (instance: Steward) => {
    const load = (instance as unknown as { loadFeishuConfig: () => Promise<ChannelConfigView | null> }).loadFeishuConfig;
    return await load.call(instance);
  });
}

/** Submits credentials and binds `ou_owner` with a first DM; the confirmation send settles. */
export async function configureAndBind(senderId = "ou_owner"): Promise<void> {
  await submitSetupCredentials();
  const res = await postEvent(messageEvent({ msgId: `om_bind_${senderId}`, senderId, text: "hi" }));
  expect(res.status).toBe(200);
  await waitWhileOutboundPending();
}

export interface MessageEventOptions {
  msgId?: string;
  senderId?: string;
  chatType?: "p2p" | "group";
  text?: string;
  parentId?: string;
  messageType?: string;
  createTime?: number;
  token?: string;
  appId?: string;
}

export function messageEvent(opts: MessageEventOptions = {}) {
  const now = Date.now();
  return {
    schema: "2.0",
    header: {
      event_id: `evt_${opts.msgId ?? "om_default"}`,
      event_type: "im.message.receive_v1",
      create_time: String(opts.createTime ?? now),
      token: opts.token ?? TEST_VERIFY_TOKEN,
      app_id: opts.appId ?? TEST_APP_ID,
    },
    event: {
      message: {
        message_id: opts.msgId ?? "om_default",
        root_id: "",
        parent_id: opts.parentId ?? "",
        create_time: String(opts.createTime ?? now),
        chat_id: "oc_default",
        chat_type: opts.chatType ?? "p2p",
        message_type: opts.messageType ?? "text",
        content: JSON.stringify({ text: opts.text ?? "hello" }),
      },
      sender: {
        sender_id: { open_id: opts.senderId ?? "ou_owner" },
        sender_type: "user",
        tenant_key: "tenant",
      },
    },
  };
}

export function postEvent(body: unknown): Promise<Response> {
  return SELF.fetch("https://example.com/channels/feishu/events", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

export function urlVerification(token = TEST_VERIFY_TOKEN): Promise<Response> {
  return postEvent({ type: "url_verification", challenge: "ch-123", token });
}

/** Polls until no sh_outbound row is queued/sending (the void-fired delivery settled). */
export async function waitWhileOutboundPending(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pending = await ownerStub().outboundRows(20);
    if (pending.every((row) => row.status === "sent" || row.status === "failed")) return;
    if (Date.now() > deadline) throw new Error(`outbound rows still pending: ${JSON.stringify(pending.map((r) => [r.id, r.status]))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function pairDevice(name: string): Promise<{ deviceId: string; token: string }> {
  const { code } = await ownerStub().createPairing();
  const res = await SELF.fetch("https://example.com/pair", { method: "POST", body: JSON.stringify({ code, name }) });
  return res.json();
}

export function connect(token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch("https://example.com/agents/steward/owner?role=connector", { headers });
}

export function helloPayload(deviceId: string, connEpoch: number, overrides: Record<string, unknown> = {}) {
  return {
    t: "hello",
    id: `hello-${connEpoch}-${Math.random()}`,
    protocol: { min: 1, max: 1 },
    deviceId,
    bootId: "boot-1",
    connEpoch,
    connector: { version: "0.1.0", os: "darwin", arch: "arm64", node: "22.13.0" },
    machine: { name: "mac-studio", memTotalMB: 65536, memFreeMB: 31000 },
    agents: [],
    repos: [],
    limits: { maxWorkers: 4, running: 0 },
    workers: [],
    pendingAcks: [],
    ...overrides,
  };
}

// Buffered message reader: attached before the first frame can arrive, so server-pushed
// messages (cmd redelivery, events_ack, resync) triggered by unrelated RPC calls are never
// dropped the way an attach-after-send `once` listener can be.
export class MessageReader {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: ((m: Record<string, unknown>) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  next(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return this.nextWhere(() => true, timeoutMs);
  }

  async nextWhere(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const index = this.queue.findIndex(pred);
    if (index >= 0) return this.queue.splice(index, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for a matching message (${this.queue.length} queued)`));
      }, timeoutMs);
      const waiter = (m: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }
}

export function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
  });
}

// Connects, attaches a MessageReader, says hello, and awaits the welcome. The reader stays
// valid for every subsequent frame on this connection.
export async function connectAndHello(
  deviceId: string,
  token: string,
  connEpoch = 1,
  overrides: Record<string, unknown> = {},
): Promise<{ ws: WebSocket; reader: MessageReader; welcome: Record<string, unknown> }> {
  const res = await connect(token);
  const ws = res.webSocket!;
  ws.accept();
  const reader = new MessageReader(ws);
  ws.send(JSON.stringify(helloPayload(deviceId, connEpoch, overrides)));
  const welcome = await reader.nextWhere((m) => m.t === "welcome");
  return { ws, reader, welcome };
}

// ---- The protocol-level fake worker (issue #5 e2e) ----------------------------------------------
//
// The connector's own e2e (apps/connector/test/e2e-worker.test.ts) drives the real
// WorkerManager with fake-pi over a mock steward. Steward-side tests run inside workerd,
// where Node APIs (node:sqlite, child_process) do not exist — so this class stands in for
// "connector + fake-pi" at the protocol level: it speaks hello/cmd_ack/cmd_result/events and
// plays a scripted worker (started → progress → report(+git) → settled) for every start_worker
// it receives, with the same event shapes fake-pi produces.

export interface FakeRepo {
  repoId: string;
  name: string;
  path?: string;
}

export interface FakeWorkerRun {
  status?: "done" | "blocked" | "needs_decision";
  summary?: string;
  changes?: string[];
  question?: string;
  next?: string;
  leftovers?: string[];
  tests?: { ran: boolean; passed?: boolean; note?: string };
  /** Emitted as the `started` event's branch and the report's git facts. */
  branch?: string;
  /** Extra delay (ms) between the report and settled events. */
  settleDelayMs?: number;
}

export class FakeConnector {
  readonly deviceId: string;
  readonly token: string;
  readonly machineName: string;
  readonly repos: FakeRepo[];
  /** Carried in hello (protocol §6.1): set per simulated connector boot. */
  bootId = "boot-1";
  /** Full workers snapshot for hello.workers (reconciliation input, issue #12). */
  workers: Array<Record<string, unknown>> = [];
  /** Scripted L3 history (issue #23): entries replayed as windowed chunks on history_req. */
  historyEntries: Array<Record<string, unknown>> = [];
  /** Entries per chunk — lets tests force multi-chunk streams. */
  historyChunkEntries = 2;
  /** When set, history_req is answered with this error instead of chunks. */
  historyError: { code: string; message: string } | null = null;
  /** When true, history_req is swallowed entirely (a machine that never answers). */
  historySilent = false;
  /** When set, the connector drops its connection after sending this many chunks. */
  historyCloseAfterChunks: number | undefined;
  ws: WebSocket | null = null;
  reader: MessageReader | null = null;
  /** Every `cmd` frame received so far; assert with `waitForCmds`. */
  readonly cmds: Array<Record<string, unknown>> = [];
  /** Every `error` frame received so far (e.g. §5.3 role-fence refusals). */
  readonly errors: Array<Record<string, unknown>> = [];
  private readonly seqs = new Map<string, number>();
  private readonly connEpochs = new Map<string, number>();
  private readonly runs: FakeWorkerRun[] = [];
  private readonly autorun: boolean;
  /** §6.6 window state for the stream in flight (one at a time, like a browser page). */
  private historyStream: { reqId: string; chunks: Array<Record<string, unknown>>; next: number; acked: number; closeAfter?: number } | null = null;

  constructor(options: {
    deviceId: string;
    token: string;
    machineName?: string;
    repos: FakeRepo[];
    run?: FakeWorkerRun | null;
    /** Set false to script worker behavior by hand (`emit`) instead of the canned run. */
    autorun?: boolean;
  }) {
    this.deviceId = options.deviceId;
    this.token = options.token;
    this.machineName = options.machineName ?? "mac-studio";
    this.repos = options.repos;
    this.runs = options.run === null ? [] : [options.run ?? {}];
    this.autorun = options.autorun ?? true;
  }

  /** Per-run script: each start_worker consumes the next entry (default: a plain done run). */
  queueRun(run: FakeWorkerRun | null): void {
    this.runs.push(run ?? {});
  }

  helloOverrides(): Record<string, unknown> {
    return {
      bootId: this.bootId,
      workers: this.workers,
      machine: { name: this.machineName, memTotalMB: 65536, memFreeMB: 31000 },
      agents: [
        {
          kind: "pi",
          version: "1.2.0",
          capabilities: { steer: true, followUp: true, interrupt: true, resume: true, history: true, images: true, structuredReport: true, readonly: true },
        },
      ],
      repos: this.repos.map((r) => ({
        repoId: r.repoId,
        name: r.name,
        path: r.path ?? `/srv/${r.name}`,
        defaultBranch: "main",
        remote: `git@github.com:example/${r.name}.git`,
      })),
      limits: { maxWorkers: 4, running: 0 },
    };
  }

  async connect(connEpoch?: number): Promise<void> {
    const epoch = connEpoch ?? (this.connEpochs.get(this.deviceId) ?? 0) + 1;
    this.connEpochs.set(this.deviceId, epoch);
    const { ws, reader } = await connectAndHello(this.deviceId, this.token, epoch, this.helloOverrides());
    this.ws = ws;
    this.reader = reader;
    void this.listen();
  }

  /** Single consumer of the shared reader: records cmds, plays scripted runs. */
  private async listen(): Promise<void> {
    const reader = this.reader;
    const ws = this.ws;
    if (!reader || !ws) return;
    while (this.ws === ws && this.reader === reader) {
      let message: Record<string, unknown>;
      try {
        message = await reader.next(250);
      } catch {
        continue; // poll timeout: re-check liveness so close() ends the loop
      }
      if (message.t === "history_req") {
        this.startHistory(message);
        continue;
      }
      if (message.t === "error") {
        this.errors.push(message);
        continue;
      }
      if (message.t === "history_ack") {
        this.onHistoryAck(message);
        continue;
      }
      if (message.t !== "cmd") continue;
      this.cmds.push(message);
      if (this.autorun && message.kind === "start_worker") {
        const run = this.runs.length > 1 ? this.runs.shift() : (this.runs[0] ?? {});
        try {
          await this.playRun(message, run ?? {});
        } catch {
          // socket closed mid-run; the reconnect test replays from there
        }
      }
    }
  }

  /** Waits until `count` cmd frames have arrived and returns them in order. */
  async waitForCmds(count: number, timeoutMs = 5000): Promise<Array<Record<string, unknown>>> {
    const startedAt = Date.now();
    for (;;) {
      if (this.cmds.length >= count) return this.cmds.slice(0, count);
      if (Date.now() - startedAt > timeoutMs) throw new Error(`only ${this.cmds.length}/${count} cmds arrived`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** §6.6: splits the scripted entries into chunks and sends the first window. */
  private startHistory(req: Record<string, unknown>): void {
    if (this.historySilent) return;
    if (this.historyError) {
      this.send({
        t: "error",
        re: String(req.id),
        code: this.historyError.code,
        message: this.historyError.message,
        retriable: false,
      });
      return;
    }
    const per = Math.max(1, this.historyChunkEntries);
    const entries = this.historyEntries;
    const chunks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < entries.length; i += per) {
      const slice = entries.slice(i, i + per) as Array<{ id: string }>;
      chunks.push({
        t: "history_chunk",
        re: String(req.id),
        n: chunks.length,
        entries: slice,
        cursor: slice.length > 0 ? slice[slice.length - 1]!.id : null,
        done: false,
      });
    }
    if (chunks.length === 0) chunks.push({ t: "history_chunk", re: String(req.id), n: 0, entries: [], cursor: null, done: true });
    const last = chunks[chunks.length - 1]!;
    last.done = true;
    last.cursor = entries.length > 0 ? (entries[entries.length - 1] as { id: string }).id : null;
    this.historyStream = { reqId: String(req.id), chunks, next: 0, acked: -1, closeAfter: this.historyCloseAfterChunks };
    this.pumpHistory();
  }

  private onHistoryAck(message: Record<string, unknown>): void {
    const stream = this.historyStream;
    if (!stream || stream.reqId !== String(message.re)) return;
    const n = Number(message.n);
    if (n === stream.acked + 1) stream.acked = n;
    this.pumpHistory();
  }

  private pumpHistory(): void {
    const stream = this.historyStream;
    if (!stream) return;
    while (stream.next < stream.chunks.length && stream.next <= stream.acked + 2) {
      this.send(stream.chunks[stream.next]!);
      stream.next += 1;
      if (stream.closeAfter !== undefined && stream.next >= stream.closeAfter) {
        this.historyStream = null;
        this.close(); // the machine dropped offline mid-stream
        return;
      }
    }
    if (stream.next >= stream.chunks.length) this.historyStream = null;
  }

  /** Scripted worker behavior: ack → result → started → progress → report(+git) → settled. */
  private async playRun(cmd: Record<string, unknown>, run: FakeWorkerRun): Promise<void> {
    const args = cmd.args as Record<string, unknown>;
    const workerId = String(args.workerId);
    const branch = run.branch ?? `shepherd/${String(args.threadId).replace(/[^a-zA-Z0-9._-]/g, "")}-1`;
    this.send({ t: "cmd_ack", re: cmd.id, status: "accepted" });
    this.send({
      t: "cmd_result",
      re: cmd.id,
      ok: true,
      data: { sessionId: workerId, branch, cwd: `/srv/${String(args.repoId)}` },
    });
    await this.emit("started", workerId, { sessionId: workerId, cwd: "/srv", branch });
    await this.emit("progress", workerId, { type: "progress", phase: "tool", tool: "edit", target: "src/a.ts", turn: 1 });
    await this.emit("report", workerId, {
      type: "report",
      status: run.status ?? "done",
      summary: run.summary ?? "任务完成",
      ...(run.changes ? { changes: run.changes } : {}),
      ...(run.question ? { question: run.question } : {}),
      ...(run.next ? { next: run.next } : {}),
      ...(run.leftovers ? { leftovers: run.leftovers } : {}),
      ...(run.tests ? { tests: run.tests } : {}),
      git: { branch, base: "main", ahead: 1, dirty: 0, filesChanged: 2, insertions: 10, deletions: 2, pushed: false },
    });
    if (run.settleDelayMs) await new Promise((resolve) => setTimeout(resolve, run.settleDelayMs));
    await this.emit("settled", workerId, {
      type: "settled",
      outcome: "reported",
      usage: { tokens: { input: 100, output: 20 }, cost: 0.001 },
    });
  }

  /** Sends one worker event with the next seq for that worker (connector-persisted seqs). */
  async emit(
    kind: "started" | "progress" | "report" | "settled" | "lost" | "resumed" | "queue_returned" | "queued" | "broken",
    workerId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const seq = (this.seqs.get(workerId) ?? 0) + 1;
    this.seqs.set(workerId, seq);
    this.send({ t: "events", id: `evt-${workerId}-${seq}`, batch: [{ workerId, seq, ts: Date.now(), type: kind, ...fields }] });
  }

  send(message: Record<string, unknown>): void {
    if (!this.ws) throw new Error("fake connector not connected");
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.reader = null;
    try {
      ws?.close(); // real close: the DO's onClose flips the machine offline
    } catch {
      // already closed
    }
  }
}

/** Pairs a device for the fake connector and returns it, ready to connect. */
export async function pairFakeConnector(
  name = "mac-studio",
  options: { run?: FakeWorkerRun | null; repos?: FakeRepo[]; autorun?: boolean } = {},
): Promise<FakeConnector> {
  const { deviceId, token } = await pairDevice(name);
  return new FakeConnector({
    deviceId,
    token,
    repos: options.repos ?? [{ repoId: "/srv/repo-a", name: "repo-a" }],
    run: options.run,
    ...(options.autorun === undefined ? {} : { autorun: options.autorun }),
  });
}

// ---- The owner's web session (issue #22 login, reused by the L3 stream tests) -------------------

/** Sends the owner's DM (fixed-phrase dispatch etc.) and waits for the replies to settle. */
export async function ownerDm(text: string): Promise<void> {
  const res = await postEvent(messageEvent({ msgId: `om_${crypto.randomUUID().slice(0, 8)}`, text }));
  if (res.status !== 200) throw new Error(`owner DM failed: ${res.status}`);
  await waitWhileOutboundPending();
}

/** Logs in via /网页 and returns the session cookie header value. */
export async function webLogin(): Promise<string> {
  await ownerDm("/网页");
  const rows = await ownerStub().outboundRows(20);
  const texts = rows
    .filter((r) => r.kind === "text" && r.status === "sent")
    .map((r) => JSON.parse(r.payload as string).text as string);
  const linkUrl = texts.join(" ").match(/https:\/\/example\.com\/link\/\S+/)![0]!;
  const res = await SELF.fetch(linkUrl, { redirect: "manual" });
  if (res.status !== 303) throw new Error(`link did not log in: ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Opens a web-role WebSocket (protocol §5.3): the L3 stream's browser connection. */
export async function connectWeb(cookie: string): Promise<{ ws: WebSocket; reader: MessageReader }> {
  const res = await SELF.fetch("https://example.com/agents/steward/owner?role=web", {
    headers: { Upgrade: "websocket", cookie },
  });
  if (res.status !== 101 || !res.webSocket) throw new Error(`web role connect failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  return { ws, reader: new MessageReader(ws) };
}

/** Waits until the first thread's first worker reaches `state`. */
export async function waitForWorkerState(state: string, timeoutMs = 8000): Promise<{ threadId: string; workerId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await ownerStub().debugSnapshot();
    const thread = snap.threads[0];
    const worker = thread?.workers[0];
    if (thread && worker && worker.state === state) return { threadId: thread.threadId, workerId: worker.workerId };
    if (Date.now() > deadline) throw new Error(`worker never reached ${state}: ${JSON.stringify(snap.threads)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
