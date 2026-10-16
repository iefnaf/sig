// The steward Durable Object: device pairing, auth, the hello/welcome handshake, the command
// outbox, the event inbox, and the bidirectional heartbeat. See docs/design/connector-do-protocol.md
// §4 (envelope and reliability), §6.2-6.4 (commands/events), ADR-0001 (heartbeat + redelivery
// corrections), and docs/spike-conclusions.md bugs 5 and 10.
//
// Channel layer (issue #4, steward.md §6.1 / §9): the SETUP_TOKEN-guarded setup page, manual
// Feishu credentials, the webhook inbound path, and the alarm-driven outbound queue.
//
// Ledger core (issue #5, steward.md §2/§5/§6): machines/repositories from hello, online state
// from connections, the deterministic event reducer (one transaction, derived Thread state),
// and core-template done reports with no LLM. Every sh_ledger table is reached through the
// memory module (ledger.ts); this class only wires it to the transports.
//
// The steward LLM (issue #6, steward.md §4-§6): a PiHarness root session with the
// `shepherd-steward` extension — user messages get their reply from the model (sh_run + alarm
// poll, §6.3), worker events wake it for bookkeeping through the durable wake queue (§5.1/
// §5.4), and in event-triggered runs its plain text is discarded by structure (§6.2): only
// notify_user / ask_user reach the user.
import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { PiHarness } from "agents/harness/pi";
import { Harness, createRegistry, type Extension, type Registry } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CloseCode,
  CmdAckMessageSchema,
  CmdResultMessageSchema,
  EventsGapMessageSchema,
  EventsMessageSchema,
  HelloMessageSchema,
  PingMessageSchema,
  PROTOCOL_VERSION,
  generatePairingCode,
  mintToken,
  parseToken,
  ulid,
  type CmdMessage,
  type ErrorMessage,
  type EventsAckMessage,
  type PongMessage,
  type ResyncMessage,
  type ServerKey,
  type WelcomeMessage,
} from "@shepherd/protocol";
import { bearer, resolveServerKeys } from "./auth.ts";
import {
  FeishuAdapter,
  SEND_TIMEOUT_MS,
  TOKEN_REFRESH_MARGIN_MS,
  apiBaseFor,
  type ApplicationConfigPatch,
  type FeishuCredentials,
} from "./channel/feishu.ts";
import {
  APP_CONFIG_PATCH_SCOPE,
  SLOW_DOWN_EXTRA_S,
  beginDeviceFlow,
  pollDeviceFlow as pollDeviceFlowOnce,
} from "./channel/registration.ts";
import { RetriableChannelError, type Brand, type InboundEvent } from "./channel/types.ts";
import { Dispatcher, parseOwnerCommand } from "./dispatch.ts";
import { buildSituationBrief } from "./llm/brief.ts";
import { buildStewardExtension, type StewardExtensionContext } from "./llm/extension.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  buildStewardModels,
  installModel,
  resolveModelConfig,
  type FauxRequestRecord,
  type StewardModels,
} from "./llm/models.ts";
import { createLedger, type Ledger, type LedgerSql, type NotifyRow, type RunRow } from "./ledger.ts";
import { failureCard, notifyCard, askUserText, reportCardFor, stallCard } from "./report-template.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { renderSetupPage, type SetupView } from "./setup-page.ts";
import { escapeMarkers } from "./wake-text.ts";
import { WebApp, linkTargetForThread } from "./web.ts";

interface ConnState {
  deviceId: string;
  epoch: number;
  /** Key that authenticated the connection (issue #27): ≠ primary ⇒ welcome rekeys. */
  keyId: string;
  connEpoch?: number;
}

export interface OutboxRow {
  cmdId: string;
  deviceId: string;
  workerId: string | null;
  cseq: number;
  kind: string;
  payload: string;
  notAfter: number | null;
  state: string;
  failReason: string | null;
  attempts: number;
  sentAt: number | null;
  ackDeadline: number | null;
  result: string | null;
  createdAt: number;
}

// Protocol §4.2: 15s ack deadline; "re-sends once more... after two failures it marks the
// machine suspect" — one resend (attempt 2), then a second timeout marks failed(ack_timeout).
const ACK_DEADLINE_MS = 15_000;
const MAX_SEND_ATTEMPTS = 2;
// spike-conclusions bug 5: a command queued for an offline device must not wait forever.
const IDLE_FAIL_MS = 30 * 60_000;
const IDLE_SWEEP_INTERVAL_S = 60;
// New commands default to a 10-minute expiry (protocol §4.2); callers that want "wait for it
// to come online" pass `notAfter: null` explicitly.
const DEFAULT_NOTAFTER_MS = 10 * 60_000;

// ---- Worker maintenance sweeps (issue #13, steward.md §8.4; spike-conclusions §2) --------------
// One alarm-driven pass every interval while any worker is in an active state: the §8.4 stall
// alarm (one template notice per silent stall, reset by the next event) and the DO-side reap
// sweep (running + offline 10 min, or online-but-silent 45 min → lost), so a Thread never
// wedges in "running" when its connector died or forgot the worker.
const STALL_ALARM_MS = 20 * 60_000;
const REAP_OFFLINE_MS = 10 * 60_000;
const REAP_SILENT_MS = 45 * 60_000;
const WORKER_SWEEP_INTERVAL_S = 60;

// ---- Channel: Feishu webhook inbound + outbound queue (steward.md §6.1, §9; spike bugs 1, 3) ----
// A claim is the double-send guard (bug 1): the conditional UPDATE hands a row to exactly one
// delivery pass; it outlives the 10s send timeout so a merely-slow send keeps its owner.
const OUTBOUND_CLAIM_MS = 30_000;
// feishu-channel.md §4: 5 QPS per receiver — space sends ≥220ms apart, with margin.
const OUTBOUND_SEND_SPACING_MS = 220;
// Alarm-driven exponential backoff retries (bug 3): 5s, 10s, 20s … capped at 15min, terminal
// after 8 attempts (~1h of retrying).
const OUTBOUND_BACKOFF_BASE_MS = 5_000;
const OUTBOUND_BACKOFF_CAP_MS = 15 * 60_000;
const OUTBOUND_MAX_ATTEMPTS = 8;
const OUTBOUND_BATCH = 20;
const OWNER_BOUND_REPLY = "✅ 已绑定，设置完成。此后直接在这里与 Shepherd 对话即可；设置页面已永久关闭。";
// steward.md §6.3: while any sh_run is open, an alarm-driven task polls every 2 seconds; on
// settlement a user run's final text becomes the reply, everything else is discarded.
const RUN_POLL_S = 2;
// Sent when the first event lands on the webhook after the QR switch: only a delivered event
// proves the transport actually moved (research §8.2 — the API's callback_type report stays
// out of sync with real delivery until the console republish lands).
const QR_SETUP_DONE_REPLY = "✅ 事件已切换为 webhook 投递，设置全部完成。此后直接在这里与 Shepherd 对话即可；设置页面已永久关闭。";
// The events/callbacks the config PATCH subscribes explicitly (additive; the QR template
// already has them — restating keeps the switch robust when it does not).
const WEBHOOK_EVENTS = ["im.message.receive_v1"];
const WEBHOOK_CALLBACKS = ["card.action.trigger"];

export interface ShQrSetupRow {
  id: number;
  phase: string;
  flow: string;
  deviceCode: string;
  brand: string;
  intervalS: number;
  expiresAt: number;
  qrUrl: string;
  userCode: string | null;
  origin: string | null;
  lastError: string | null;
  updatedAt: number;
}

// /pair brute-force lockout (protocol doc §5.2, issue #27): 5 failures lock the bucket —
// per source IP and globally — for 15 minutes.
export const PAIR_MAX_FAILURES = 5;
export const PAIR_LOCK_MS = 15 * 60_000;

export interface ShOutboundRow {
  id: string;
  channel: string;
  kind: string;
  receiveId: string;
  threadId: string | null;
  payload: string;
  urgency: string;
  status: string;
  attempts: number;
  claimToken: string | null;
  claimExpiresAt: number | null;
  nextAttemptAt: number;
  providerMsgId: string | null;
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function versionRangesOverlap(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  return a.min <= b.max && b.min <= a.max;
}

export type PairResult =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; reason: "invalid_code" }
  | { ok: false; reason: "rate_limited"; retryAfterSec: number };

// Base `Connection` (unknown state) is used in overridden signatures — narrowing the state
// generic there breaks Liskov substitutability against `Agent`'s own declarations; state is
// cast at the read/write sites instead (same tradeoff the do-protocol spike made).
export class Steward extends Agent<Env> {
  onStart(): void {
    runMigrations(this.sql.bind(this), MIGRATIONS);
    // A DO restart clears the in-memory arm-dedupe while storage alarms keep their own
    // clock: re-arm maintenance so a restart never strands active workers unwatched.
    this.armWorkerSweeps();
    // Wakes queued by past reducers (crash between queue and submit, §11) drain now.
    void this.drainWakes();
    void this.pollRuns();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.piHarness);
  }

  // ---- The steward LLM (issue #6, steward.md §4) -------------------------------------------------
  // Cache fields must be declared before `piHarness`: its initializer reads the vars config
  // eagerly (defaults.model), and with class-field semantics a later `undefined` initializer
  // would clobber what the getter wrote.

  private stewardModels_?: StewardModels;
  private piRegistry_?: Registry;
  private stewardExtension_?: Extension;

  /** The deploy-config selection (vars.STEWARD_MODEL; deepseek/deepseek-flash default). */
  private get modelVarsConfig(): ReturnType<typeof resolveModelConfig> {
    return resolveModelConfig(this.env.STEWARD_MODEL);
  }

  /**
   * The models collection handed to pi — built once per isolate, BEFORE any sealed key is
   * known: the PiHarness factory runs during lifecycle startup, ahead of onStart's
   * migrations, so it must not touch SQLite. ensureRootModel() later installs the keyed
   * provider onto this same mutable collection (models.setProvider — pi resolves models per
   * request against the live object).
   */
  private get llmModels(): StewardModels {
    return (this.stewardModels_ ??= buildStewardModels(this.modelVarsConfig, undefined));
  }

  private get stewardExtension(): Extension {
    return (this.stewardExtension_ ??= buildStewardExtension(this.stewardToolContext()));
  }

  private get registry(): Registry {
    if (this.piRegistry_ === undefined) {
      const registry = createRegistry();
      registry.install(this.stewardExtension);
      this.piRegistry_ = registry;
    }
    return this.piRegistry_;
  }

  /** The root pi session — the steward conversation (steward.md §4.1). */
  readonly piHarness = new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(
        storage,
        {
          models: this.llmModels.models,
          registry: this.registry,
          // pi's report channel (listener failures, section-render errors): into the channel
          // log, where a sick extension is diagnosable from the outside.
          onReport: (error) => this.logChannel("pi_report", errorText(error)),
        },
        context,
      ),
    defaults: { model: { provider: this.modelVarsConfig.provider, id: this.modelVarsConfig.modelId } },
  });

  /**
   * Applies the merged model selection to the live collection and the root session, before
   * the first submit of an isolate (and after any setModelConfig). The deploy config
   * (vars.STEWARD_MODEL) picks provider + model id; when it is unset, the sealed sh_model
   * row's provider (set via setModelConfig or seeded from MODEL_KEY, issue #25/#27) is the
   * user's choice. The API key is always the sealed row's (never an env var, spike bug 7),
   * and only when its provider matches the selection — a key sealed for another provider is
   * not silently sent elsewhere.
   */
  private async ensureRootModel(): Promise<void> {
    const sealed = await this.modelConfig();
    const vars = this.modelVarsConfig;
    const config = sealed && !vars.explicit ? { ...vars, provider: sealed.provider } : vars;
    const apiKey = sealed && sealed.provider === config.provider ? sealed.apiKey : undefined;
    installModel(this.llmModels.models, config, apiKey);
    // Review #10: a provider/model combination the catalog does not know (e.g. a sealed
    // provider whose key was collected for another vendor while vars still carry the default
    // model id) fails visibly as `no_model` — surface it in the channel log too, with the
    // fix, instead of a silent never-answering bot.
    if (this.llmModels.models.getModel(config.provider, config.modelId) === undefined) {
      this.logChannel(
        "model_config_error",
        `provider ${config.provider} 没有模型 ${config.modelId}；用 vars.STEWARD_MODEL 指定该 provider 存在的 modelId（或为 ${config.modelId} 配置对应 provider 的 sealed key）`,
      );
    }
    const signature = `${config.provider}/${config.modelId}/${apiKey ? "keyed" : "keyless"}`;
    if (this.appliedRootModel === signature) return;
    await this.piHarness.session().setModel({ provider: config.provider, id: config.modelId });
    this.appliedRootModel = signature;
  }

  private appliedRootModel: string | undefined;

  // The signing/sealing key set (primary = SERVER_KEY, plus SERVER_KEY_PREVIOUS during a
  // rotation window). Overridable so tests can simulate rotation states inside the DO.
  protected async serverKeys(): Promise<ServerKey[]> {
    return resolveServerKeys(this.env);
  }

  // Tests shrink the /pair lockout (see feishuSendTimeoutMs for the same pattern).
  protected pairLockMs = PAIR_LOCK_MS;


  // The memory module (steward.md §2): all sh_* ledger SQL lives behind this handle. Bound
  // lazily because `sql`/`ctx` only mean something once the DO is live.
  private ledger_?: Ledger;
  private get ledger(): Ledger {
    return (this.ledger_ ??= createLedger({
      sql: this.sql.bind(this) as unknown as LedgerSql,
      tx: (fn) => this.ctx.storage.transactionSync(fn),
    }));
  }

  private dispatcher_?: Dispatcher;
  private get dispatcher(): Dispatcher {
    return (this.dispatcher_ ??= new Dispatcher({
      ledger: this.ledger,
      enqueueCommand: (deviceId, kind, args, opts) => this.enqueue(deviceId, kind, args, opts),
      // Withdraw only what never left the DO (still `queued`); a sent command may already be
      // persisted connector-side, and at-most-once beats a maybe-duplicate cancel (§4.2).
      cancelQueuedCommand: (cmdId) => {
        this.sql`UPDATE outbox SET state = 'expired' WHERE cmdId = ${cmdId} AND state = 'queued'`;
        return this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      },
      // A start_worker that has not left the outbox pipeline yet (issue #13 review finding 3):
      // the run is alive even when its worker row was reaped away.
      hasDeliverableStart: (threadId) =>
        this.sql<{ one: number }>`
          SELECT 1 AS one FROM outbox o JOIN sh_worker w ON w.workerId = o.workerId
          WHERE w.threadId = ${threadId} AND o.kind = 'start_worker'
            AND o.state IN ('queued', 'sent') AND o.workerId IS NOT NULL
          LIMIT 1
        `.length > 0,
      commandExists: (cmdId) => this.sql`SELECT 1 AS one FROM outbox WHERE cmdId = ${cmdId}`.length > 0,
      sendText: async (text, threadId) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "text", to: owner, text, threadId: threadId ?? null, urgency: "push" });
      },
      sendCard: async (card, threadId) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "card", to: owner, card, threadId, urgency: "push" });
      },
      createPairing: () => this.createPairing(),
      deployOrigin: () => this.web.origin(),
      webLinkUrl: (target) => this.web.linkUrl(target),
    }));
  }

  // The signed-link web app (issue #22, steward.md §10): login exchange, Thread timeline,
  // machine management. Same lazy-bind pattern as the ledger.
  private web_?: WebApp;
  private get web(): WebApp {
    return (this.web_ ??= new WebApp({
      sql: this.sql.bind(this) as unknown as import("./schema.ts").SqlExecutor,
      secrets: [this.env.SERVER_KEY, this.env.SERVER_KEY_PREVIOUS].filter((k): k is string => typeof k === "string" && k.length > 0),
      ledger: this.ledger,
      listDevices: () =>
        this.sql<{ deviceId: string; name: string | null; revoked: number }>`
          SELECT deviceId, name, revoked FROM device ORDER BY createdAt, deviceId
        `.map((d) => ({ deviceId: d.deviceId, name: d.name, revoked: !!d.revoked })),
      revokeDevice: (deviceId) => void this.revoke(deviceId),
      audit: (reason, detail) => this.logChannel(reason, detail),
    }));
  }

  /** The tools' reach (steward.md §4.3): ledger, dispatch, outbound — nothing else. */
  private stewardToolContext(): StewardExtensionContext {
    return {
      ledger: this.ledger,
      buildBrief: () => buildSituationBrief(this.ledger),
      currentRun: () => this.currentRunBinding(),
      checkProvenanceRef: async (ref) => {
        // §7.2 (review #4): a `user:<msgId>` reference is valid only if this deployment
        // actually received that message. Routine/followup/watch ids join when #20 lands.
        if (!ref.startsWith("user:")) return false;
        const msgId = ref.slice("user:".length);
        if (msgId.length === 0) return false;
        return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId}`.length > 0;
      },
      startWorker: async (input) => {
        const outcome = await this.dispatcher.startWorker(input);
        // Review #8: a dispatch in this run picks/creates the Thread the conversation is now
        // about — backfill it onto the run so the run's reply (and quote-replies to it)
        // route to that Thread, exactly like an explicit quote-route does.
        if (outcome.kind === "dispatched" || outcome.kind === "asked_offline") {
          const run = await this.currentRunBinding();
          if (run && run.routedThreadId === null) {
            this.sql`UPDATE sh_run SET routedThreadId = ${outcome.threadId} WHERE operationId = ${run.operationId} AND routedThreadId IS NULL`;
          }
        }
        return outcome;
      },
      notifyUser: async (input) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        const thread = input.threadId ? this.ledger.threads.get(input.threadId) : null;
        // §6.4: the timeline link is appended by the system, never by the model — the same
        // fresh one-time link the core-template cards carry (issue #22).
        const detailsUrl = thread ? await this.web.linkUrl(linkTargetForThread(thread.threadId)) : null;
        await this.enqueueOutbound({
          id: input.dedupeId,
          kind: "card",
          to: owner,
          card: notifyCard({
            tone: input.tone,
            conclusion: input.conclusion,
            did: input.did,
            ...(input.needsYou !== undefined ? { needsYou: input.needsYou } : {}),
            ...(thread ? { threadTitle: thread.title, detailsUrl: detailsUrl ?? undefined } : {}),
          }),
          threadId: input.threadId ?? null,
          urgency: input.urgency,
        });
        if (thread) this.sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${thread.threadId}`;
        await this.markRunNotified();
      },
      askUser: async (input) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        const thread = input.threadId ? this.ledger.threads.get(input.threadId) : null;
        if (thread) {
          // §4.3: ask_user creates the question, flips the Thread to waiting_you, and ends the
          // turn. Answering later happens as a quote-reply routed back to the Thread (which
          // closes it — see submitUserMessage). One question per call: unique id (review #3 —
          // a per-run id collided and INSERT OR IGNORE silently swallowed repeats).
          const qid = `q_steward_${ulid()}`;
          this.sql`
            INSERT OR IGNORE INTO sh_question (qid, threadId, workerId, text, options, status, askedAt)
            VALUES (${qid}, ${thread.threadId}, NULL, ${input.question}, ${JSON.stringify(input.options)}, 'open', ${Date.now()})
          `;
          this.ledger.recomputeThreadState(thread.threadId);
          this.sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${thread.threadId}`; // news landed (§5.2)
        }
        await this.enqueueOutbound({
          id: input.dedupeId,
          kind: "text",
          to: owner,
          text: askUserText(input.question, input.options, thread?.title),
          threadId: thread?.threadId ?? null,
          urgency: "push",
        });
        await this.markRunNotified();
      },
      audit: (kind, detail) => {
        this.logChannel(kind, detail);
      },
    };
  }

  /**
   * The run that is *executing* right now (review #3): pi marks a submission `placed` while
   * an active run owns it, and PiHarness.pending() surfaces those as `running` — that, not
   * the oldest unsettled sh_run, is what tools are executing inside (a queued followUp starts
   * the moment the previous run answers, while sh_run only settles at the next 2s poll).
   * Falls back to the oldest open run between runs (passive entry writes, wake drains).
   */
  private async currentRunBinding(): Promise<{
    operationId: string;
    kind: string;
    provenance: string;
    routedThreadId: string | null;
  } | null> {
    const running = (await this.piHarness.pending()).find((p) => p.status === "running");
    if (running) {
      const row = this.ledger.runs.get(running.operationId);
      if (row) {
        // §7.1: the provenance of an event run is the wake's operationId; a user run's is
        // `user:<msgId>` — what start_worker records as createdFromMsg.
        return { operationId: row.operationId, kind: row.kind, provenance: row.operationId, routedThreadId: row.routedThreadId };
      }
    }
    const open = this.ledger.runs.openRows()[0];
    if (!open) return null;
    return { operationId: open.operationId, kind: open.kind, provenance: open.operationId, routedThreadId: open.routedThreadId };
  }

  /** Records that the *executing* run already produced user-facing output (review #9). */
  private async markRunNotified(): Promise<void> {
    const run = await this.currentRunBinding();
    if (run) this.sql`UPDATE sh_run SET notified = 1 WHERE operationId = ${run.operationId}`;
  }

  private ownerOpenIdSync(): string | null {
    return this.sql<{ ownerOpenId: string | null }>`
      SELECT ownerOpenId FROM sh_channel WHERE channel = 'feishu'
    `[0]?.ownerOpenId ?? null;
  }

  // Plain-HTTP surface reached via the Worker's stub.fetch forwards (index.ts): the Feishu
  // webhook (unauthenticated — the adapter validates Feishu's own token), the setup page
  // (the Worker has already checked SETUP_TOKEN before forwarding), and the signed-link web
  // (the Worker has already HMAC-verified the link token / session cookie before forwarding).
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Every request the DO serves reveals the deployment's public origin — the source for the
    // pairing command's URL and the absolute one-time card links (web.ts owns the value).
    if (url.protocol === "https:" || url.protocol === "http:") this.web.recordOrigin(url.origin);
    if (url.pathname === "/channels/feishu/events" && request.method === "POST") {
      return this.handleFeishuWebhook(request);
    }
    if (url.pathname === "/setup" && (request.method === "GET" || request.method === "POST")) {
      return this.handleSetup(request);
    }
    if (url.pathname.startsWith("/link/") && request.method === "GET") {
      // index.ts verified the HMAC and expiry before forwarding; single-use is decided here.
      const secure = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
      return this.web.openLink(url.pathname.slice("/link/".length), secure);
    }
    if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (request.method === "GET" || request.method === "POST")) {
      return this.web.handle(request);
    }
    return new Response("not found", { status: 404 });
  }

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  async getConnectionTags(_connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    return parsed ? [`dev:${parsed.deviceId}`] : [];
  }

  private sendError(connection: Connection, code: ErrorMessage["code"], message: string, re?: string): void {
    connection.send(JSON.stringify({ t: "error", re, code, message, retriable: false }));
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    if (!parsed) {
      connection.close(CloseCode.UNAUTHORIZED, "unauthorized");
      return;
    }
    const row = this.sql<{ name: string | null; epoch: number; revoked: number }>`
      SELECT name, epoch, revoked FROM device WHERE deviceId = ${parsed.deviceId}
    `[0];
    if (!row) {
      connection.close(CloseCode.UNAUTHORIZED, "unknown device");
      return;
    }
    if (row.revoked || row.epoch !== parsed.epoch) {
      connection.close(CloseCode.REVOKED, "revoked");
      return;
    }
    connection.setState({ deviceId: parsed.deviceId, epoch: parsed.epoch, keyId: parsed.keyId } satisfies ConnState);
    // Machine online state derives from live connections (issue #5): this and onClose are the
    // only writers. hello fills in the machine's real name and facts moments later.
    this.ledger.machines.setOnline(parsed.deviceId, true, row.name ?? undefined);
  }

  onClose(connection: Connection): void {
    const state = connection.state as unknown as ConnState | null;
    if (!state?.deviceId) return;
    // A superseded old connection closes after its replacement is live: only the last
    // connection for the device takes the machine offline.
    const remaining = [...this.getConnections<ConnState>(`dev:${state.deviceId}`)].filter((c) => c.id !== connection.id);
    if (remaining.length === 0) this.ledger.machines.setOnline(state.deviceId, false);
  }

  async onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    if (typeof raw !== "string") return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.sendError(connection, "bad_request", "invalid JSON");
      return;
    }
    const t = (message as { t?: unknown }).t;
    switch (t) {
      case "hello":
        this.handleHello(connection, message);
        return;
      case "ping":
        this.handlePing(connection, message);
        return;
      case "cmd_ack":
        this.handleCmdAck(message);
        return;
      case "cmd_result":
        this.handleCmdResult(message);
        return;
      case "events":
        this.handleEvents(connection, message);
        return;
      case "events_gap":
        // protocol §4.3: the connector's local log already evicted the requested range.
        // Surfacing this to the steward (timeline + `reconcile`) is a later ticket; for now
        // the DO just accepts the report instead of answering "unsupported".
        EventsGapMessageSchema.safeParse(message);
        return;
      default:
        break;
    }
    const opt = (message as { opt?: unknown }).opt === true;
    if (opt) return;
    const id = (message as { id?: unknown }).id;
    this.sendError(connection, "unsupported", `unknown message type ${JSON.stringify(t)}`, typeof id === "string" ? id : undefined);
  }

  private handlePing(connection: Connection, raw: unknown): void {
    const parsed = PingMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    connection.send(JSON.stringify({ t: "pong", re: parsed.data.id } satisfies PongMessage));
  }

  private async handleHello(connection: Connection, raw: unknown): Promise<void> {
    const parsedHello = HelloMessageSchema.safeParse(raw);
    if (!parsedHello.success) {
      this.sendError(connection, "bad_request", "invalid hello");
      return;
    }
    const hello = parsedHello.data;
    if (!versionRangesOverlap(hello.protocol, PROTOCOL_VERSION)) {
      connection.close(CloseCode.VERSION_MISMATCH, `supported ${PROTOCOL_VERSION.min}-${PROTOCOL_VERSION.max}`);
      return;
    }
    const auth = connection.state as unknown as ConnState | null;
    if (!auth?.deviceId || auth.deviceId !== hello.deviceId) {
      connection.close(CloseCode.UNAUTHORIZED, "device mismatch");
      return;
    }
    for (const other of this.getConnections<ConnState>(`dev:${auth.deviceId}`)) {
      if (other.id === connection.id) continue;
      const otherEpoch = other.state?.connEpoch ?? -1;
      if (hello.connEpoch <= otherEpoch) {
        connection.close(CloseCode.SUPERSEDED, "superseded by an existing connection");
        return;
      }
      other.close(CloseCode.SUPERSEDED, "superseded by a newer connection");
    }
    connection.setState({ deviceId: auth.deviceId, epoch: auth.epoch, keyId: auth.keyId, connEpoch: hello.connEpoch } satisfies ConnState);
    // hello is the machine/repo snapshot's source of truth (protocol §6.1, steward.md §2.2):
    // name, agents, limits, and the full repo list — removals included — land in the ledger.
    this.ledger.machines.upsertFromHello(hello);
    const acks = Object.fromEntries(
      this.sql<{ workerId: string; upTo: number }>`SELECT workerId, upTo FROM worker_ack`.map((row) => [row.workerId, row.upTo]),
    );
    // SERVER_KEY rotation (issue #27): the connection authenticated with a non-primary key —
    // hand the connector a fresh primary-key token so it can rekey without re-pairing. The
    // connector persists it for reconnects; once every machine has reconnected once, the
    // operator can drop SERVER_KEY_PREVIOUS.
    const [primary] = await this.serverKeys();
    const rotatedToken = primary && auth.keyId !== primary.id ? await mintToken(primary, auth.deviceId, auth.epoch) : undefined;
    const welcome: WelcomeMessage = {
      t: "welcome",
      re: hello.id,
      protocol: PROTOCOL_VERSION.max,
      serverTime: Date.now(),
      sessionId: ulid(),
      acks,
      limits: { maxMessageBytes: 262144, batchMs: 250, batchEvents: 50 },
      ...(rotatedToken ? { token: rotatedToken } : {}),
    };
    connection.send(JSON.stringify(welcome));
    // Reconciliation (protocol §6.1): the connector reports the states of commands that never
    // settled (e.g. `ambiguous` after a crash mid-sending). Settle the matching outbox rows;
    // ambiguous rows are never re-delivered (§4.2).
    for (const pending of hello.pendingAcks) {
      if (pending.state === "ambiguous") {
        this.sql`UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')`;
      } else if (pending.state === "done" || pending.state === "failed") {
        this.sql`
          UPDATE outbox SET state = ${pending.state}, result = ${JSON.stringify({ source: "pendingAck" })}
          WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
        `;
      }
    }
    this.redeliverOutbox(auth.deviceId);
    // A reconnect is also the natural catch-up point for events persisted but not yet reduced
    // (crash between the events_ack and the reducer, protocol §4.3): drain, then notify.
    this.applyLedgerEvents();
    // Reconciliation against hello.workers (issue #12, connector-pi.md §9.1 step 4): with the
    // pending events drained first, the gate inside (lastSeq <= processedUpTo) means this only
    // fires for workers whose event stream cannot tell the story anymore. Timeline, no push.
    this.ledger.workers.reconcileFromSnapshot(auth.deviceId, hello.workers);
    // The machine is back (or fresh workers appeared): the maintenance alarm must be live
    // for whatever is running now (issue #13).
    this.armWorkerSweeps();
  }

  // protocol §4.2 + ADR-0001 (spike bug 10): hello redelivers queued, sent, AND
  // ack-timeout-failed commands — a silently-dead downlink must not permanently lose a
  // command just because its ack deadline happened to expire before the reconnect.
  private redeliverOutbox(deviceId: string): void {
    this.sql`
      UPDATE outbox SET state = 'queued', attempts = 0, failReason = NULL
      WHERE deviceId = ${deviceId} AND state = 'failed' AND failReason = 'ack_timeout'
    `;
    const pending = this.sql<{ cmdId: string }>`
      SELECT cmdId FROM outbox WHERE deviceId = ${deviceId} AND state IN ('queued', 'sent') ORDER BY cseq
    `;
    for (const row of pending) this.deliver(row.cmdId);
  }

  private handleCmdAck(raw: unknown): void {
    const parsed = CmdAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const ack = parsed.data;
    if (ack.status === "accepted") {
      this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
    } else if (ack.status === "duplicate") {
      if (ack.result) {
        this.sql`
          UPDATE outbox SET state = ${ack.result.ok ? "done" : "failed"}, result = ${JSON.stringify(ack.result)}
          WHERE cmdId = ${ack.re}
        `;
      } else {
        this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
      }
    } else if (ack.status === "rejected") {
      this.sql`
        UPDATE outbox SET state = 'failed', failReason = 'rejected', result = ${JSON.stringify({ code: ack.code ?? null })}
        WHERE cmdId = ${ack.re}
      `;
      this.noteCommandFailure(ack.re, `连接器拒绝（${ack.code ?? "未知原因"}）`);
    } else if (ack.status === "ambiguous") {
      // protocol §4.2: a crash during `sending`, undecidable — no automatic re-send.
      this.sql`UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${ack.re}`;
    }
  }

  private handleCmdResult(raw: unknown): void {
    const parsed = CmdResultMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const result = parsed.data;
    this.sql`
      UPDATE outbox SET state = ${result.ok ? "done" : "failed"}, result = ${JSON.stringify(result.ok ? result.data ?? null : result.error ?? null)}
      WHERE cmdId = ${result.re}
    `;
    if (!result.ok) {
      const error = (result.error ?? {}) as { code?: unknown; message?: unknown };
      const reason = [typeof error.code === "string" ? error.code : null, typeof error.message === "string" ? error.message : null]
        .filter((part): part is string => part !== null)
        .join("：") || "未知原因";
      this.noteCommandFailure(result.re, reason);
    }
  }

  // A start_worker the connector could not run: the worker lands `broken`, the failure reaches
  // the timeline + the user deterministically (there is no LLM to relay it in M1). Idempotent
  // on the cmdId — cmd_result redeliveries re-run this handler.
  private noteCommandFailure(cmdId: string, reason: string): void {
    const row = this.sql<{ workerId: string | null; kind: string }>`
      SELECT workerId, kind FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || row.kind !== "start_worker" || !row.workerId) return;
    if (this.ledger.workers.markStartFailed(row.workerId, cmdId, reason)) {
      void this.drainNotifications();
    }
  }

  private handleEvents(connection: Connection, raw: unknown): void {
    const parsed = EventsMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(connection, "bad_request", "invalid events");
      return;
    }
    const touched = new Set<string>();
    for (const event of parsed.data.batch) {
      const exists = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${event.workerId} AND seq = ${event.seq}
      `[0]!.n;
      if (!exists) {
        this.sql`
          INSERT INTO event_inbox (workerId, seq, payload, receivedAt) VALUES (${event.workerId}, ${event.seq}, ${JSON.stringify(event)}, ${Date.now()})
        `;
      }
      touched.add(event.workerId);
    }
    for (const workerId of touched) {
      this.sql`INSERT OR IGNORE INTO worker_ack (workerId, upTo) VALUES (${workerId}, 0)`;
      // advance the cumulative ack through every contiguous seq already received
      for (;;) {
        const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
        const hasNext = this.sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq = ${upTo + 1}
        `[0]!.n;
        if (!hasNext) break;
        this.sql`UPDATE worker_ack SET upTo = ${upTo + 1} WHERE workerId = ${workerId}`;
      }
      const upTo = this.sql<{ upTo: number }>`SELECT upTo FROM worker_ack WHERE workerId = ${workerId}`[0]!.upTo;
      connection.send(JSON.stringify({ t: "events_ack", workerId, upTo } satisfies EventsAckMessage));
      const gapCount = this.sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId} AND seq > ${upTo + 1}
      `[0]!.n;
      if (gapCount > 0) {
        connection.send(JSON.stringify({ t: "resync", workerId, from: upTo + 1 } satisfies ResyncMessage));
      }
    }
    // Persisted and acked above; now reduce into the ledger (protocol §4.3 keeps the two
    // decoupled — a crash here leaves the rows pending for the next wake's catch-up).
    this.applyLedgerEvents();
  }

  /** Reduces everything pending, then turns notification intents into outbound cards (§5.1). */
  private applyLedgerEvents(): void {
    try {
      const { applied } = this.ledger.applyPendingEvents();
      if (applied > 0) {
        // Events catching up can release a parked hello-snapshot verdict for a reaped
        // worker (issue #13 review finding 2) — resolve before anything reads the state.
        this.ledger.workers.resolveReapPending();
        // Any applied event can start a run (started/resumed) or end one (settled/lost) —
        // the maintenance alarm follows suit (issue #13).
        this.armWorkerSweeps();
        void this.drainNotifications();
        // The reducer may have queued wake_requests (§5.1 step 4): drain what is already due
        // (the 3-second merge window keeps fresh rows waiting for their siblings) and arm the
        // alarm for the rest.
        void this.drainWakes();
      }
    } catch (err) {
      this.logChannel("ledger_apply_failed", errorText(err));
    }
  }

  // Single-flight drain, same pattern as deliverOutbound: concurrent wake sources (events,
  // hello, cmd failures) chain instead of racing, so an intent is enqueued exactly once.
  private notifyChain: Promise<void> = Promise.resolve();

  // The pending drainWakes schedule's id, so a fresh earlier wake can cancel and pull it in.
  private drainWakeScheduleId: string | undefined;

  drainNotifications(): Promise<void> {
    const run = this.notifyChain.then(() => this.drainNotifyPass());
    this.notifyChain = run.catch(() => {});
    return run;
  }

  private async drainNotifyPass(): Promise<void> {
    const cfg = await this.loadFeishuConfig();
    for (const intent of this.ledger.notifications.pending()) {
      try {
        if (!cfg?.ownerOpenId) continue; // no owner yet: the intent stays pending, not lost
        const card = await this.renderNotification(intent);
        if (card === null) {
          // Its data is gone (thread archived / worker pruned); drop the intent rather than
          // retry forever.
          this.ledger.notifications.markSent(intent.id);
          continue;
        }
        await this.enqueueOutbound({ kind: "card", to: cfg.ownerOpenId, threadId: intent.threadId, card, urgency: "push" });
        this.ledger.notifications.markSent(intent.id);
      } catch (err) {
        this.logChannel("notify_drain_failed", `${intent.id} ${errorText(err)}`);
      }
    }
  }

  /** Deterministic core templates (steward.md §6.2 source 1): data in, card out, no LLM. */
  private async renderNotification(intent: NotifyRow): Promise<unknown | null> {
    const worker = intent.workerId ? this.ledger.workers.get(intent.workerId) : null;
    const thread = this.ledger.threads.get(intent.threadId);
    if (!worker || !thread) return null;
    const machine = this.ledger.machines.get(worker.deviceId);
    const machineName = machine?.name ?? worker.deviceId;
    const footer = `Thread「${thread.title}」 · ${worker.agent} @ ${machineName} · 引用回复可继续这个 Thread`;
    // steward.md §6.4: the timeline link is appended by the system — a fresh one-time link
    // per card, never by the (M2) LLM.
    const detailsUrl = await this.web.linkUrl(linkTargetForThread(thread.threadId));

    if (intent.kind === "done_report" || intent.kind === "attention_report") {
      const report = this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      if (!report) return null;
      return reportCardFor(report, worker, machineName, thread.title, detailsUrl ?? undefined);
    }

    // stall_notice (§8.4): attention, not failure — the run may still be a very long tool
    // call. The minutes are recomputed at render time (no event has arrived since the stall,
    // or the intent would have been for a different, newer stall).
    if (intent.kind === "stall_notice") {
      const minutes = Math.max(1, Math.round((Date.now() - (worker.lastEventAt ?? worker.createdAt)) / 60_000));
      return stallCard(minutes, worker, machineName, thread.title, footer, detailsUrl ?? undefined);
    }

    // failure_push: either the start never happened or the run ended in a failure class that
    // needs a human (steward.md §5.3); the matching open question carries the specifics.
    if (worker.lastOutcome?.startsWith("start_failed:")) {
      return failureCard(
        `派发失败：任务没有开始`,
        `${worker.lastOutcome.slice("start_failed:".length)}。重新说一次要做什么即可。`,
        thread.title,
        footer,
        detailsUrl ?? undefined,
      );
    }
    const question = this.ledger.questions.openForThread(thread.threadId);
    return failureCard("运行出错，需要你决定下一步", question?.text ?? "查看 Thread 时间线了解详情。", thread.title, footer, detailsUrl ?? undefined);
  }

  // `/加机器` in chat is the trigger (issue #22); `/pair` is the only HTTP consumer of the
  // code. QR/setup-page issuance was never built — chat is the canonical path now.
  async createPairing(): Promise<{ code: string }> {
    const code = generatePairingCode();
    this.sql`INSERT INTO pairing (code, expiresAt) VALUES (${code}, ${Date.now() + 10 * 60_000})`;
    return { code };
  }

  // Pairing + brute-force lockout (protocol doc §5.2, issue #27). The code's entropy and the
  // 10-minute validity make enumeration infeasible on top of this; the lockout bounds the
  // trying either way — per source IP and globally, 5 failures each lock for `pairLockMs`.
  // `clientIp` comes from the Worker's CF-Connecting-IP; attempts without one (local dev)
  // share the "unknown" bucket.
  async pair(code: string, name: string, clientIp = "unknown"): Promise<PairResult> {
    const now = Date.now();
    const lockedFor = (scope: string, key: string) =>
      this.sql<{ until: number }>`SELECT lockedUntil AS until FROM pair_fail WHERE scope = ${scope} AND key = ${key}`[0]?.until ?? 0;
    const retryAfterMs = Math.max(lockedFor("ip", clientIp), lockedFor("all", "*")) - now;
    if (retryAfterMs > 0) {
      return { ok: false, reason: "rate_limited", retryAfterSec: Math.ceil(retryAfterMs / 1000) };
    }

    const row = this.sql<{ expiresAt: number; used: number }>`
      SELECT expiresAt, used FROM pairing WHERE code = ${code}
    `[0];
    if (!row || row.used || row.expiresAt < now) {
      this.registerPairFailure("ip", clientIp, now);
      this.registerPairFailure("all", "*", now);
      return { ok: false, reason: "invalid_code" };
    }
    this.sql`UPDATE pairing SET used = 1 WHERE code = ${code}`;
    // A success proves the caller is mid-onboarding, not guessing: clear their IP bucket so a
    // lockout from earlier fat-fingered attempts does not outlive the pairing.
    this.sql`DELETE FROM pair_fail WHERE scope = 'ip' AND key = ${clientIp}`;
    const deviceId = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.sql`INSERT INTO device (deviceId, name, epoch, createdAt) VALUES (${deviceId}, ${name}, 1, ${now})`;
    const [primary] = await this.serverKeys();
    const token = await mintToken(primary!, deviceId, 1);
    return { ok: true, deviceId, token };
  }

  // Sliding failure window: the window spans `pairLockMs`; hitting PAIR_MAX_FAILURES inside it
  // locks until now + pairLockMs and leaves a clean bucket behind for when the lock lifts.
  private registerPairFailure(scope: string, key: string, now: number): void {
    const row = this.sql<{ fails: number; windowStart: number; lockedUntil: number }>`
      SELECT fails, windowStart, lockedUntil FROM pair_fail WHERE scope = ${scope} AND key = ${key}
    `[0];
    if (!row) {
      this.sql`
        INSERT INTO pair_fail (scope, key, fails, windowStart, lockedUntil, updatedAt)
        VALUES (${scope}, ${key}, 1, ${now}, 0, ${now})
      `;
      return;
    }
    const windowExpired = row.lockedUntil <= now && now - row.windowStart >= this.pairLockMs;
    const fails = windowExpired ? 1 : row.fails + 1;
    if (fails >= PAIR_MAX_FAILURES) {
      this.sql`
        UPDATE pair_fail SET fails = 0, windowStart = ${now}, lockedUntil = ${now + this.pairLockMs}, updatedAt = ${now}
        WHERE scope = ${scope} AND key = ${key}
      `;
      return;
    }
    this.sql`
      UPDATE pair_fail SET fails = ${fails}, windowStart = ${windowExpired ? now : row.windowStart}, updatedAt = ${now}
      WHERE scope = ${scope} AND key = ${key}
    `;
  }

  async revoke(deviceId: string): Promise<void> {
    this.sql`UPDATE device SET epoch = epoch + 1, revoked = 1 WHERE deviceId = ${deviceId}`;
    for (const connection of this.getConnections<ConnState>(`dev:${deviceId}`)) {
      connection.close(CloseCode.REVOKED, "revoked");
    }
  }

  // Enqueues a command for a device's outbox and attempts immediate delivery (protocol §4.2).
  // `notAfter` defaults to issuance + 10 minutes; pass `null` explicitly for "wait until online".
  // `ackTimeoutMs` overrides the 15s ack deadline (tests shrink it to exercise alarm paths fast).
  async enqueue(
    deviceId: string,
    kind: string,
    args: unknown,
    opts: { workerId?: string; notAfter?: number | null; ackTimeoutMs?: number; cmdId?: string } = {},
  ): Promise<{ cmdId: string; cseq: number; state: string }> {
    const cseq = (this.sql<{ m: number | null }>`SELECT MAX(cseq) AS m FROM outbox WHERE deviceId = ${deviceId}`[0]?.m ?? 0) + 1;
    // `cmdId` is the idempotency key for steward tool replays (protocol §7.1): the start_worker
    // tool passes "tool:<taskId>" so a replayed call converges on the same command row —
    // the primary key guarantees no second command is ever created.
    const cmdId = opts.cmdId ?? ulid();
    const existing = opts.cmdId
      ? this.sql<{ cmdId: string; cseq: number; state: string }>`SELECT cmdId, cseq, state FROM outbox WHERE cmdId = ${cmdId}`[0]
      : undefined;
    if (existing) return { cmdId: existing.cmdId, cseq: existing.cseq, state: existing.state };
    const notAfter = opts.notAfter === undefined ? Date.now() + DEFAULT_NOTAFTER_MS : opts.notAfter;
    this.sql`
      INSERT INTO outbox (cmdId, deviceId, workerId, cseq, kind, payload, notAfter, state, createdAt)
      VALUES (${cmdId}, ${deviceId}, ${opts.workerId ?? null}, ${cseq}, ${kind}, ${JSON.stringify(args ?? {})}, ${notAfter}, 'queued', ${Date.now()})
    `;
    // A dispatch registers the worker before enqueueing: the moment the row exists, the
    // maintenance alarm (stall notice + reap) must be armed (issue #13).
    this.armWorkerSweeps();
    this.deliver(cmdId, opts.ackTimeoutMs);
    const state = this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${cmdId}`[0]!.state;
    return { cmdId, cseq, state };
  }

  async outboxRow(cmdId: string): Promise<OutboxRow | null> {
    return (this.sql`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0] as OutboxRow | undefined) ?? null;
  }

  async inboxCount(workerId: string): Promise<number> {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM event_inbox WHERE workerId = ${workerId}`[0]!.n;
  }

  private connFor(deviceId: string): Connection | undefined {
    for (const connection of this.getConnections<ConnState>(`dev:${deviceId}`)) return connection;
    return undefined;
  }

  // Sends one outbox row if the device has a live connection and the command hasn't expired;
  // (re)arms the ack-deadline alarm. Returns whether the command was actually sent.
  private deliver(cmdId: string, ackTimeoutMs = ACK_DEADLINE_MS): boolean {
    const row = this.sql<{
      deviceId: string;
      workerId: string | null;
      cseq: number;
      kind: string;
      payload: string;
      notAfter: number | null;
      state: string;
    }>`
      SELECT deviceId, workerId, cseq, kind, payload, notAfter, state FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || (row.state !== "queued" && row.state !== "sent")) return false;
    const now = Date.now();
    if (row.notAfter !== null && row.notAfter < now) {
      // The delivery window lapsed (queue timeout). NOT the user's cancellation — that is the
      // dispatcher's `expired` state (steward.ts cancelQueuedCommand), and conflating the two
      // made the sweep close the worker as a silent "user withdrew it". `failed/not_after`
      // is terminal: redeliverOutbox only re-queues `failed/ack_timeout`, and the connector
      // would reject a past-notAfter command anyway (protocol §4.2).
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'not_after' WHERE cmdId = ${cmdId}`;
      return false;
    }
    const connection = this.connFor(row.deviceId);
    if (!connection) {
      void this.schedule(IDLE_SWEEP_INTERVAL_S, "sweepIdle");
      return false;
    }
    const cmd: CmdMessage = {
      t: "cmd",
      id: cmdId,
      cseq: row.cseq,
      kind: row.kind,
      workerId: row.workerId ?? undefined,
      notAfter: row.notAfter,
      args: JSON.parse(row.payload),
    };
    connection.send(JSON.stringify(cmd));
    const ackDeadline = now + ackTimeoutMs;
    this.sql`
      UPDATE outbox SET state = 'sent', attempts = attempts + 1, sentAt = ${now}, ackDeadline = ${ackDeadline} WHERE cmdId = ${cmdId}
    `;
    void this.schedule(Math.max(1, Math.ceil(ackTimeoutMs / 1000)), "resendUnacked");
    return true;
  }

  // Alarm-driven, survives hibernation: state lives in SQLite, not in-memory timers.
  async resendUnacked(): Promise<void> {
    const due = this.sql<{ cmdId: string; attempts: number }>`
      SELECT cmdId, attempts FROM outbox WHERE state = 'sent' AND ackDeadline <= ${Date.now()}
    `;
    for (const row of due) {
      if (row.attempts >= MAX_SEND_ATTEMPTS) {
        this.sql`UPDATE outbox SET state = 'failed', failReason = 'ack_timeout' WHERE cmdId = ${row.cmdId}`;
      } else if (!this.deliver(row.cmdId)) {
        // Deadline passed and there is no live connection (deliver refused): park the row back
        // in `queued` for redelivery at the next hello. Leaving it `sent` would hot-loop the
        // alarm every second and never settle. The idle sweep backstops a device that never
        // returns; notAfter already-expired rows were marked by deliver itself.
        this.sql`UPDATE outbox SET state = 'queued' WHERE cmdId = ${row.cmdId} AND state = 'sent'`;
      }
    }
    // `schedule()` has whole-second granularity, so an alarm can fire slightly before a
    // millisecond-precision ackDeadline. Re-arm while anything is still waiting for an ack,
    // or a command could get stuck in `sent` forever (the spike's bug, protocol §4.2).
    const waiting = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent'`[0]!.n;
    if (waiting > 0) void this.schedule(1, "resendUnacked");
  }

  // Periodic backstop (spike-conclusions bug 5): a command queued for a device that never
  // comes back must not wait forever even when `notAfter` is null ("wait until online").
  async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - IDLE_FAIL_MS;
    const stale = this.sql<{ cmdId: string }>`SELECT cmdId FROM outbox WHERE state = 'queued' AND createdAt <= ${cutoff}`;
    for (const row of stale) {
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'idle' WHERE cmdId = ${row.cmdId}`;
    }
    const waiting = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM outbox WHERE state = 'queued'`[0]!.n;
    if (waiting > 0) void this.schedule(IDLE_SWEEP_INTERVAL_S, "sweepIdle");
  }

  // ---- Worker maintenance: stall alarm + reap sweep (issue #13) -----------------------------------
  // Thresholds are instance fields so tests can shrink them inside the DO (same pattern as
  // feishuSendTimeoutMs); the cadence follows suit.

  protected stallAlarmMs = STALL_ALARM_MS;
  protected reapOfflineMs = REAP_OFFLINE_MS;
  protected reapSilentMs = REAP_SILENT_MS;
  protected workerSweepIntervalS = WORKER_SWEEP_INTERVAL_S;
  /** In-memory dedupe of pending schedule() rows (the SDK fires every row; see armWorkerSweeps). */
  private lastSweepArmAt = 0;

  /** Arms the maintenance alarm while any worker is in an active state. Called from every
   * point that can change that (event reduction, hello reconciliation, dispatch enqueue);
   * sweepWorkers re-arms itself and lets the alarm lapse once nothing is active. */
  private armWorkerSweeps(): void {
    const active = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_worker WHERE state IN ('starting', 'running', 'recovering')
    `[0]!.n;
    if (active === 0) return;
    // schedule() rows each fire once: without this guard every wake that touches a worker
    // would add another row and the alarm would fan out. A DO reset clears the flag — the
    // cost is at most one redundant no-op pass. The window is interval − 1s, the SHORTEST
    // time a row armed at `lastSweepArmAt` can still be pending (schedule() truncates due
    // times to whole seconds): any longer and a row that already fired would strand the
    // chain — its re-arm eaten by a stale timestamp (0.9×interval was that bug; it bit
    // whenever the interval was shrunk below 10 s).
    if (Date.now() - this.lastSweepArmAt < Math.max(0, (this.workerSweepIntervalS - 1) * 1000)) return;
    this.lastSweepArmAt = Date.now();
    void this.schedule(this.workerSweepIntervalS, "sweepWorkers");
  }

  /**
   * One maintenance pass: the §8.4 stall alarm (online machine + silence past the threshold →
   * one template notice per stall) and the reap sweep (issue #13). Reap rules:
   * - `running`/`recovering`: machine offline for a real 10 minutes (measured from the
   *   offline transition, so a connection blip never reaps — review finding 4), or
   *   online-but-silent 45 min (the connector forgot the worker).
   * - `starting`: NEVER by silence clocks alone (review finding 3) — a start_worker that can
   *   still be delivered means the worker is queued, not lost, and reaping it would open the
   *   duplicate-dispatch door. The command's own lifecycle decides; only once it is terminal
   *   does the sweep close the worker out.
   * Offline workers skip the stall notice on purpose — they are the reap sweep's territory,
   * and "lost contact" is not news worth interrupting the user for (spec §9).
   */
  async sweepWorkers(): Promise<{ stalled: number; reaped: number }> {
    let stalled = 0;
    let reaped = 0;
    const now = Date.now();
    try {
      // Query with the shorter threshold and classify per worker in one pass.
      for (const worker of this.ledger.workers.silentSince(Math.min(this.reapOfflineMs, this.stallAlarmMs))) {
        const silentMs = now - (worker.lastEventAt ?? worker.createdAt);
        if (worker.state === "starting") {
          const cmd = worker.cmdId ? this.commandState(worker.cmdId) : null;
          if (cmd && (cmd.state === "failed" || cmd.state === "expired")) {
            const settled =
              cmd.state === "expired"
                ? // The user withdrew it (`expired` is the dispatcher's cancel state and its
                  // only writer): close quietly, no push (they already know).
                  this.ledger.workers.settleWithdrawnStart(worker.workerId)
                : // Failed undelivered — queue timeout (`idle`), delivery-window lapse
                  // (`not_after`), ack exhaustion (`ack_timeout`→terminal), or a connector
                  // rejection: the owner must hear that it never started.
                  this.ledger.workers.markStartFailed(worker.workerId, worker.cmdId, this.startFailureText(cmd));
            if (settled) reaped += 1;
            continue;
          }
          if (cmd && (cmd.state === "queued" || cmd.state === "sent")) {
            // Still deliverable (hello redelivery / the resend alarm): the run is queued, not
            // lost — the wait_online flow depends on the sweep never touching these.
            continue;
          }
          // The remaining shapes may or may not have started on the machine: `done` (resulted,
          // but the `started` event never landed), `accepted` (acked, then the connector died
          // before resulting — nothing else ever transitions that row), `ambiguous` (§4.2:
          // terminal but undecidable), or no command row at all (enqueue threw). Close only at
          // the online-but-silent horizon OR the measured-offline clock the running/recovering
          // reap uses — a connector that died right after acking must not lock the Thread for a
          // full 45 minutes (PR #46 review findings 1 and 4).
          const horizon =
            silentMs >= this.reapSilentMs ||
            (!worker.machineOnline && now - worker.machineLastSeen >= this.reapOfflineMs);
          if (!horizon) continue;
          if (cmd === null) {
            // The command row never came to exist: nothing can ever start. Close it with a
            // push so the owner re-dispatches.
            if (this.ledger.workers.markStartFailed(worker.workerId, null, "派发命令未能创建（内部错误）")) reaped += 1;
          } else if (this.ledger.workers.reapWorker(worker.workerId, worker.machineOnline)) {
            // Quiet lost+reaped: "it failed" might be a lie, and a live event resurrects.
            reaped += 1;
          }
          continue;
        }
        if (!worker.machineOnline) {
          if (now - worker.machineLastSeen >= this.reapOfflineMs) {
            if (this.ledger.workers.reapWorker(worker.workerId, false)) reaped += 1;
          }
          continue; // recently dropped, or not yet due: wait out the offline clock
        }
        if (silentMs >= this.reapSilentMs) {
          if (this.ledger.workers.reapWorker(worker.workerId, true)) reaped += 1;
          continue;
        }
        if (silentMs >= this.stallAlarmMs) {
          if (this.ledger.workers.notifyStall(worker.workerId, silentMs)) stalled += 1;
        }
      }
      // A settled queue-timeout queues a failure push (markStartFailed); drain for reaps too.
      if (stalled > 0 || reaped > 0) void this.drainNotifications();
    } finally {
      // Re-arm even when a pass throws mid-way: a ledger error must not kill the alarm chain.
      this.armWorkerSweeps();
    }
    return { stalled, reaped };
  }

  /** The outbox row's state/failReason for a worker's start_worker command, if it exists. */
  private commandState(cmdId: string): { state: string; failReason: string | null } | null {
    return this.sql<{ state: string; failReason: string | null }>`
      SELECT state, failReason FROM outbox WHERE cmdId = ${cmdId}
    `[0] ?? null;
  }

  /** The owner-facing reason a start_worker command failed before the worker ever ran. */
  private startFailureText(cmd: { state: string; failReason: string | null }): string {
    switch (cmd.failReason) {
      case "idle":
        // The wait-online queue gave up: the machine never came back within ~30 min.
        return "排队超时（机器长时间未上线）";
      case "not_after":
        // The delivery window lapsed while the machine was unreachable; when it reconnected
        // the command was too old to run (protocol §4.2 notAfter).
        return "命令过期未送达（机器断线太久，超出送达时限）";
      default:
        return `命令失败（${cmd.failReason ?? cmd.state}）`;
    }
  }

  // =================================================================================================
  // Channel: setup page, Feishu webhook inbound, outbound queue (steward.md §6.1, §9)
  // =================================================================================================

  // Tests shrink this via runInDurableObject to exercise the timeout path quickly.
  protected feishuSendTimeoutMs = SEND_TIMEOUT_MS;

  // Single-flight delivery: concurrent passes (inline enqueue fire + alarm + explicit calls)
  // chain here instead of racing. Without this, two passes could interleave around the
  // per-receiver pacing sleep and burst past the 5 QPS cap; the claim token still guards the
  // row itself, this keeps the *wire* quiet too.
  private deliveryChain: Promise<void> = Promise.resolve();

  private async loadFeishuConfig(): Promise<
    (FeishuCredentials & {
      ownerOpenId: string | null;
      brand: Brand;
      source: "manual" | "qr";
      webhookStatus: string | null;
    }) | null
  > {
    const row = this.sql<{
      appId: string;
      appSecretEnc: string;
      verificationTokenEnc: string;
      ownerOpenId: string | null;
      brand: string | null;
      source: string | null;
      webhookStatus: string | null;
    }>`
      SELECT appId, appSecretEnc, verificationTokenEnc, ownerOpenId, brand, source, webhookStatus
      FROM sh_channel WHERE channel = 'feishu'
    `[0];
    if (!row) return null;
    const keys = await this.serverKeys();
    // Open with any configured key (rotation window, issue #27). A failed open means the
    // ciphertext was sealed under a key that has since been dropped entirely: read back as
    // unconfigured so the SETUP_TOKEN-guarded setup page accepts fresh credentials — recovery,
    // not a deadlock. A non-primary open re-seals under the primary so the window can close.
    const appSecret = await openSecret(keys, row.appSecretEnc);
    const verificationToken = await openSecret(keys, row.verificationTokenEnc);
    if (appSecret === null || verificationToken === null) return null;
    if (appSecret.keyId !== keys[0]!.id || verificationToken.keyId !== keys[0]!.id) {
      const [appSecretEnc, verificationTokenEnc] = await Promise.all([
        sealSecret(keys[0]!, appSecret.text),
        sealSecret(keys[0]!, verificationToken.text),
      ]);
      this.sql`
        UPDATE sh_channel SET appSecretEnc = ${appSecretEnc}, verificationTokenEnc = ${verificationTokenEnc}
        WHERE channel = 'feishu'
      `;
    }
    return {
      appId: row.appId,
      appSecret: appSecret.text,
      verificationToken: verificationToken.text,
      ownerOpenId: row.ownerOpenId,
      brand: row.brand === "lark" ? "lark" : "feishu",
      source: row.source === "qr" ? "qr" : "manual",
      webhookStatus: row.webhookStatus,
    };
  }

  // FEISHU_API exists only in tests (a service binding that mocks Feishu); production calls
  // the real endpoints via global fetch. Covers both the open API and the accounts device flow.
  private feishuFetcher(): typeof fetch {
    return this.env.FEISHU_API ? (this.env.FEISHU_API.fetch.bind(this.env.FEISHU_API) as typeof fetch) : fetch;
  }

  protected newFeishuAdapter(
    credentials: FeishuCredentials & { brand?: Brand },
    opts: { looseHandshake?: boolean } = {},
  ): FeishuAdapter {
    return new FeishuAdapter({
      credentials,
      tokenStore: {
        // The tenant_access_token is a Feishu bearer credential, so it is sealed at rest like
        // every other secret (issue #27); opening it needs the key set, hence async halves.
        getCachedToken: async () => {
          const row = this.sql<{ tokenEnc: string; expiresAt: number }>`
            SELECT tokenEnc, expiresAt FROM sh_channel_token WHERE channel = 'feishu'
          `[0];
          if (!row) return null;
          const opened = await openSecret(await this.serverKeys(), row.tokenEnc);
          return opened ? { token: opened.text, expiresAt: row.expiresAt } : null;
        },
        saveToken: async (token, expiresAt) => {
          const [primary] = await this.serverKeys();
          const tokenEnc = await sealSecret(primary!, token);
          this.sql`
            INSERT INTO sh_channel_token (channel, tokenEnc, expiresAt) VALUES ('feishu', ${tokenEnc}, ${expiresAt})
            ON CONFLICT (channel) DO UPDATE SET tokenEnc = excluded.tokenEnc, expiresAt = excluded.expiresAt
          `;
          // steward.md §9.2: the token is refreshed by an alarm ahead of its expiry.
          void this.schedule(
            Math.max(1, Math.ceil((expiresAt - TOKEN_REFRESH_MARGIN_MS - Date.now()) / 1000)),
            "refreshChannelToken",
          );
        },
      },
      fetcher: this.feishuFetcher(),
      sendTimeoutMs: this.feishuSendTimeoutMs,
      apiBase: apiBaseFor(credentials.brand ?? "feishu"),
      looseHandshake: opts.looseHandshake,
    });
  }

  // Scheduled callback: keep tenant_access_token fresh even while nothing is being sent.
  async refreshChannelToken(): Promise<void> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return;
    // Expiry check only — no need to decrypt just to decide whether to refresh.
    const cached = this.sql<{ expiresAt: number }>`
      SELECT expiresAt FROM sh_channel_token WHERE channel = 'feishu'
    `[0];
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return;
    try {
      await this.newFeishuAdapter(cfg).getTenantAccessToken();
    } catch {
      // Retry lazily; a send needing the token retries the fetch on demand anyway.
      void this.schedule(600, "refreshChannelToken");
    }
  }

  // ADR-0001 decision 8: the setup page closes permanently once onboarding is complete. For
  // the manual flow that is the owner's first DM (issue #4); for the QR flow the owner is
  // bound at scan time, so completeness additionally requires verified webhook delivery —
  // until then the page must keep guiding the switch (issue #24, research §8.2).
  private setupClosed(cfg: Awaited<ReturnType<Steward["loadFeishuConfig"]>>): boolean {
    if (!cfg?.ownerOpenId) return false;
    return cfg.source !== "qr" || cfg.webhookStatus === "verified";
  }

  private qrRow(): ShQrSetupRow | null {
    return (this.sql`SELECT * FROM sh_qr_setup WHERE id = 1`[0] as ShQrSetupRow | undefined) ?? null;
  }

  async qrSetupState(): Promise<ShQrSetupRow | null> {
    return this.qrRow();
  }

  private async handleSetup(request: Request): Promise<Response> {
    const cfg = await this.loadFeishuConfig();
    if (cfg && this.setupClosed(cfg)) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const origin = url.origin;
    // The page's origin is the deployment's public address: the PATCH's request_url and the
    // prefilled bot name derive from it. Refreshed on every hit so a domain added mid-setup
    // is picked up without restarting the flow.
    if (this.qrRow()) {
      this.sql`UPDATE sh_qr_setup SET origin = ${origin}, updatedAt = ${Date.now()} WHERE id = 1`;
    }

    const respond = async (formError?: string, appIdValue?: string) => {
      const fresh = await this.loadFeishuConfig();
      return new Response(renderSetupPage({ view: this.setupView(fresh, formError, appIdValue), actionUrl: `${url.pathname}${url.search}`, webhookUrl: `${origin}/channels/feishu/events`, host: url.hostname }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    if (request.method === "GET") return respond();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return respond("表单解析失败，请重试。");
    }
    const action = String(form.get("action") ?? "manual");

    if (action === "start_qr" || action === "restart_qr") {
      if (cfg) return respond("已存在应用凭据，无法重新发起扫码创建；如需换应用请提交手动凭据。");
      try {
        await this.beginQrFlow("create", origin);
      } catch (err) {
        return respond(`发起扫码创建失败：${errorText(err)}`);
      }
      return respond();
    }

    if (action === "start_scope_scan") {
      if (!cfg || cfg.source !== "qr") return respond("尚未通过扫码创建机器人，无法发起第二步。");
      try {
        await this.beginQrFlow("addons", origin);
      } catch (err) {
        return respond(`发起第二步扫码失败：${errorText(err)}`);
      }
      return respond();
    }

    if (action === "patch_webhook") {
      const res = await this.patchWebhookConfig();
      if (!res.ok) return respond(`切换 webhook 失败：${res.error}`);
      return respond();
    }

    // Manual credential submission (issue #4) — the permanent fallback (issue #24). Cancels
    // any active QR flow; a different appId resets the owner binding (open_id is app-scoped).
    const appId = String(form.get("appId") ?? "").trim();
    const appSecret = String(form.get("appSecret") ?? "").trim();
    const verificationToken = String(form.get("verificationToken") ?? "").trim();
    if (!appId || !appSecret || !verificationToken) {
      return respond("三个字段都必填。", appId);
    }

    // Validate live: a tenant_access_token must actually be obtainable with these credentials
    // (and the fresh token is cached for the first send). adapter.getTenantAccessToken() is
    // public for exactly this reuse.
    try {
      await this.newFeishuAdapter({ appId, appSecret, verificationToken }).getTenantAccessToken();
    } catch (err) {
      return respond(`凭据校验失败：${errorText(err)}`, appId);
    }

    const [primary] = await this.serverKeys();
    const [appSecretEnc, verificationTokenEnc] = await Promise.all([
      sealSecret(primary!, appSecret),
      sealSecret(primary!, verificationToken),
    ]);
    const existing = this.sql<{ appId: string | null }>`SELECT appId FROM sh_channel WHERE channel = 'feishu'`[0];
    const sameApp = existing?.appId === appId;
    if (sameApp) {
      this.sql`
        INSERT INTO sh_channel (channel, appId, appSecretEnc, verificationTokenEnc, ownerOpenId, configuredAt, boundAt, source, brand)
        VALUES ('feishu', ${appId}, ${appSecretEnc}, ${verificationTokenEnc}, NULL, ${Date.now()}, NULL, 'manual', 'feishu')
        ON CONFLICT (channel) DO UPDATE SET
          appId = excluded.appId, appSecretEnc = excluded.appSecretEnc,
          verificationTokenEnc = excluded.verificationTokenEnc, configuredAt = excluded.configuredAt, source = 'manual'
      `;
    } else {
      this.sql`
        INSERT INTO sh_channel (channel, appId, appSecretEnc, verificationTokenEnc, ownerOpenId, configuredAt, boundAt, source, brand)
        VALUES ('feishu', ${appId}, ${appSecretEnc}, ${verificationTokenEnc}, NULL, ${Date.now()}, NULL, 'manual', 'feishu')
        ON CONFLICT (channel) DO UPDATE SET
          appId = excluded.appId, appSecretEnc = excluded.appSecretEnc,
          verificationTokenEnc = excluded.verificationTokenEnc, configuredAt = excluded.configuredAt, source = 'manual',
          ownerOpenId = NULL, boundAt = NULL, brand = 'feishu',
          webhookStatus = NULL, webhookPatchedAt = NULL, webhookVerifiedAt = NULL
      `;
      // The cached token belongs to the previous app; never reuse it.
      this.sql`DELETE FROM sh_channel_token WHERE channel = 'feishu'`;
    }
    this.sql`DELETE FROM sh_qr_setup`;
    this.logChannel("manual_credentials_saved", appId);
    return respond();
  }

  private setupView(
    cfg: Awaited<ReturnType<Steward["loadFeishuConfig"]>>,
    formError?: string,
    appIdValue?: string,
  ): SetupView {
    const qr = this.qrRow();
    const base = { appId: cfg?.appId, brand: cfg?.brand, formError, appIdValue };
    if (!cfg) {
      if (!qr) return { phase: "start", ...base };
      if (qr.phase === "awaiting_scan") return { phase: "scan1", qrUrl: qr.qrUrl, userCode: qr.userCode ?? "", expiresAt: qr.expiresAt, phaseError: qr.lastError ?? undefined, ...base };
      // No credentials + any other phase means the create scan failed terminally.
      return { phase: "failed", phaseError: qr.lastError ?? "扫码创建未完成。", ...base };
    }
    if (cfg.source === "manual") {
      return { phase: "awaiting_owner", ...base };
    }
    // QR source: closed is handled before rendering; the remaining phases guide the switch.
    if (qr?.phase === "awaiting_scope_scan") {
      return { phase: "scan2", qrUrl: qr.qrUrl, userCode: qr.userCode ?? "", expiresAt: qr.expiresAt, phaseError: qr.lastError ?? undefined, ...base };
    }
    if (qr?.phase === "scope_added") {
      return { phase: "scope_added", phaseError: qr.lastError ?? undefined, ...base };
    }
    if (qr?.phase === "webhook_patched" || cfg.webhookStatus === "patched") {
      return { phase: "patched", phaseError: qr?.lastError ?? undefined, ...base };
    }
    return { phase: "created", phaseError: qr?.lastError ?? undefined, ...base };
  }

  async setupState(): Promise<{
    state: "unconfigured" | "awaiting_owner" | "awaiting_webhook" | "bound";
    appId: string | null;
    ownerOpenId: string | null;
    source: "manual" | "qr" | null;
    brand: Brand | null;
    webhookStatus: string | null;
  }> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return { state: "unconfigured", appId: null, ownerOpenId: null, source: null, brand: null, webhookStatus: null };
    const state = this.setupClosed(cfg) ? "bound" : cfg.source === "qr" ? "awaiting_webhook" : "awaiting_owner";
    return { state, appId: cfg.appId, ownerOpenId: cfg.ownerOpenId, source: cfg.source, brand: cfg.brand, webhookStatus: cfg.webhookStatus };
  }

  // ---- QR onboarding state machine (issue #24, steward.md §9.0, research §1/§8.1–§8.2) ----

  /**
   * Starts (or restarts — links are single-use) a device-flow scan. `create` prefills a
   * deployment-distinguishing name and locks the flow to a fresh app; `addons` targets the
   * created app (`clientID`) and carries the `application:application:patch` scope top-up.
   */
  private async beginQrFlow(kind: "create" | "addons", origin: string): Promise<void> {
    const host = new URL(origin).hostname;
    // The name leads with the deployment label: app names get truncated (research §8.3 — a
    // prefilled "Shepherd Spike ({user})" landed as "Spike"), and the label is what tells
    // same-named bots apart across deployments.
    const hostLabel = (host.split(".")[0] ?? host).slice(0, 16);
    let clientId: string | undefined;
    let brand: Brand = "feishu";
    if (kind === "addons") {
      const cfg = await this.loadFeishuConfig();
      if (!cfg) throw new Error("应用凭据缺失");
      clientId = cfg.appId;
      brand = cfg.brand; // a lark-created app scans its second code on the lark domain too
    }
    const res = await beginDeviceFlow({
      fetcher: this.feishuFetcher(),
      brand,
      preset: kind === "create" ? { name: `${hostLabel}·Shepherd`, desc: `Shepherd 部署：${origin}` } : undefined,
      createOnly: kind === "create",
      clientId,
      addons: kind === "addons" ? { scopes: { tenant: [APP_CONFIG_PATCH_SCOPE] } } : undefined,
    });
    const phase = kind === "create" ? "awaiting_scan" : "awaiting_scope_scan";
    this.sql`
      INSERT INTO sh_qr_setup (id, phase, flow, deviceCode, brand, intervalS, expiresAt, qrUrl, userCode, origin, lastError, updatedAt)
      VALUES (1, ${phase}, ${kind}, ${res.deviceCode}, ${brand}, ${res.intervalS}, ${res.expiresAt}, ${res.qrUrl}, ${res.userCode}, ${origin}, NULL, ${Date.now()})
      ON CONFLICT (id) DO UPDATE SET
        phase = excluded.phase, flow = excluded.flow, deviceCode = excluded.deviceCode, brand = excluded.brand,
        intervalS = excluded.intervalS, expiresAt = excluded.expiresAt, qrUrl = excluded.qrUrl,
        userCode = excluded.userCode, origin = excluded.origin, lastError = NULL, updatedAt = excluded.updatedAt
    `;
    void this.schedule(Math.max(1, res.intervalS), "pollDeviceFlow");
  }

  private armQrPoll(intervalS: number): void {
    void this.schedule(Math.max(1, intervalS), "pollDeviceFlow");
  }

  private qrFail(message: string): void {
    // A create-flow failure leaves nothing configured (restart offered); an addons-flow
    // failure keeps the created app and offers the scan-2 retry.
    const row = this.qrRow();
    const phase = row?.flow === "create" ? "failed" : "created";
    this.sql`UPDATE sh_qr_setup SET phase = ${phase}, lastError = ${message}, updatedAt = ${Date.now()} WHERE id = 1`;
    this.logChannel("qr_error", message);
  }

  /**
   * Alarm-driven device-flow poll (the DO hibernates between polls). Respects the returned
   * `interval` (backing off +5s on `slow_down`, RFC 8628) and switches to the Lark accounts
   * domain the moment a poll reveals `tenant_brand: lark` (research §1). Stale polls (a flow
   * was restarted, or the phase moved on) no-op via the deviceCode+phase re-checks.
   */
  async pollDeviceFlow(): Promise<void> {
    for (let hop = 0; hop < 3; hop++) {
      const row = this.qrRow();
      if (!row || (row.phase !== "awaiting_scan" && row.phase !== "awaiting_scope_scan")) return;
      if (row.expiresAt <= Date.now()) {
        this.qrFail("二维码已过期（expired_token），请重新生成。");
        return;
      }
      let outcome: Awaited<ReturnType<typeof pollDeviceFlowOnce>>;
      try {
        outcome = await pollDeviceFlowOnce({ fetcher: this.feishuFetcher(), deviceCode: row.deviceCode, brand: row.brand === "lark" ? "lark" : "feishu" });
      } catch (err) {
        // Transient network error: keep polling at the current interval (OpenClaw parity).
        this.logChannel("qr_poll_error", errorText(err));
        this.armQrPoll(row.intervalS);
        return;
      }
      // Lark switch (SDK parity): the moment any poll reveals tenant_brand=lark — even one
      // that also carries success or slow_down — persist the brand and immediately re-poll
      // on the lark domain; only the re-polled response is processed. `hop` bounds the loop.
      if (outcome.brand === "lark" && row.brand !== "lark") {
        this.sql`UPDATE sh_qr_setup SET brand = 'lark', updatedAt = ${Date.now()} WHERE id = 1 AND deviceCode = ${row.deviceCode}`;
        continue;
      }
      switch (outcome.status) {
        case "pending":
          this.armQrPoll(row.intervalS);
          return;
        case "slow_down":
          this.sql`UPDATE sh_qr_setup SET intervalS = intervalS + ${SLOW_DOWN_EXTRA_S} WHERE id = 1 AND deviceCode = ${row.deviceCode}`;
          this.armQrPoll(row.intervalS + SLOW_DOWN_EXTRA_S);
          return;
        case "denied":
          this.qrFail("扫码被拒绝（access_denied），请重新生成二维码再试。");
          return;
        case "expired":
          this.qrFail("二维码已过期（expired_token），请重新生成。");
          return;
        case "failed":
          this.qrFail(`扫码流程失败：${outcome.message}`);
          return;
        case "success":
          await this.onQrSuccess(row, outcome);
          return;
      }
    }
  }

  private async onQrSuccess(
    row: ShQrSetupRow,
    outcome: Extract<Awaited<ReturnType<typeof pollDeviceFlowOnce>>, { status: "success" }>,
  ): Promise<void> {
    if (row.flow === "create") {
      if (!outcome.appSecret) {
        this.qrFail("创建成功但飞书未返回 App Secret；请改用下方手动凭据完成配置。");
        return;
      }
      // The verification token is ours from the start: generated now, sealed, and PATCHed
      // into the app's encrypt strategy during the switch (a QR-created app's console token
      // is unknowable via API — research §1: sensitive config goes through the config PATCH).
      const verificationToken = crypto.randomUUID().replace(/-/g, "");
      const [primary] = await this.serverKeys();
      const [appSecretEnc, verificationTokenEnc] = await Promise.all([
        sealSecret(primary!, outcome.appSecret),
        sealSecret(primary!, verificationToken),
      ]);
      if (!this.qrFlowStillLive(row, "awaiting_scan")) return;
      this.sql`
        INSERT INTO sh_channel (channel, appId, appSecretEnc, verificationTokenEnc, ownerOpenId, configuredAt, boundAt, source, brand)
        VALUES ('feishu', ${outcome.appId}, ${appSecretEnc}, ${verificationTokenEnc}, ${outcome.openId ?? null}, ${Date.now()}, ${outcome.openId ? Date.now() : null}, 'qr', ${outcome.brand ?? "feishu"})
        ON CONFLICT (channel) DO UPDATE SET
          appId = excluded.appId, appSecretEnc = excluded.appSecretEnc,
          verificationTokenEnc = excluded.verificationTokenEnc, configuredAt = excluded.configuredAt,
          ownerOpenId = excluded.ownerOpenId, boundAt = excluded.boundAt, source = 'qr', brand = excluded.brand
      `;
      // The cached token (if any) belongs to a previous app; never reuse it.
      this.sql`DELETE FROM sh_channel_token WHERE channel = 'feishu'`;
      this.logChannel("qr_created", `${outcome.appId} brand=${outcome.brand} owner=${outcome.openId ?? "?"}`);
      // Park on `created` before chaining scan #2, so a failed begin lands in the right state.
      this.sql`UPDATE sh_qr_setup SET phase = 'created', updatedAt = ${Date.now()} WHERE id = 1`;
      // Chain scan #2: the scope top-up (research §8.1 — the addons update flow).
      try {
        await this.beginQrFlow("addons", row.origin ?? "https://example.com");
      } catch (err) {
        const message = `第二步扫码发起失败：${errorText(err)}`;
        this.sql`UPDATE sh_qr_setup SET lastError = ${message}, updatedAt = ${Date.now()} WHERE id = 1`;
        this.logChannel("qr_error", message);
      }
      return;
    }

    // Addons flow: the secret is normally NOT rotated (research §8.1); store a rotation only
    // if Feishu actually returned a different one for the same app.
    const cfg = await this.loadFeishuConfig();
    if (cfg && outcome.appId === cfg.appId && outcome.appSecret && outcome.appSecret !== cfg.appSecret) {
      const [primary] = await this.serverKeys();
      const appSecretEnc = await sealSecret(primary!, outcome.appSecret);
      this.sql`UPDATE sh_channel SET appSecretEnc = ${appSecretEnc} WHERE channel = 'feishu'`;
      this.sql`DELETE FROM sh_channel_token WHERE channel = 'feishu'`;
      this.logChannel("qr_secret_rotated", outcome.appId);
    }
    if (!this.qrFlowStillLive(row, "awaiting_scope_scan")) return;
    this.sql`UPDATE sh_qr_setup SET phase = 'scope_added', lastError = NULL, updatedAt = ${Date.now()} WHERE id = 1`;
    this.logChannel("qr_scope_added", `${outcome.appId} (+${APP_CONFIG_PATCH_SCOPE})`);
    // Auto-attempt the switch; a failure parks the flow on scope_added with the error shown.
    await this.patchWebhookConfig();
  }

  /** True when the row still describes the same in-flight flow (guards stale concurrent polls). */
  private qrFlowStillLive(row: ShQrSetupRow, phase: string): boolean {
    const fresh = this.qrRow();
    return fresh !== null && fresh.deviceCode === row.deviceCode && fresh.flow === row.flow && fresh.phase === phase;
  }

  /**
   * The config PATCH (research §2.1/§8.2): events + callbacks to the webhook URL, encrypt
   * strategy pinned to our stored verification token. Accepting the PATCH does NOT mean
   * delivery switched — that takes the console republish and is proven by event arrival.
   */
  private async patchWebhookConfig(): Promise<{ ok: true } | { ok: false; error: string }> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg || !cfg.verificationToken) return { ok: false, error: "尚未配置应用凭据。" };
    const origin = this.qrRow()?.origin;
    if (!origin) return { ok: false, error: "缺少部署地址，请先打开一次设置页面。" };
    const webhookUrl = `${origin}/channels/feishu/events`;
    const body: ApplicationConfigPatch = {
      event: { subscription_type: "webhook", request_url: webhookUrl, add_events: WEBHOOK_EVENTS },
      callback: { callback_type: "webhook", add_callbacks: WEBHOOK_CALLBACKS },
      event_and_callback_encrypt_strategy: { verification_token: cfg.verificationToken },
    };
    try {
      await this.newFeishuAdapter(cfg).applicationConfigPatch(cfg.appId, body);
    } catch (err) {
      const error = errorText(err);
      this.sql`UPDATE sh_qr_setup SET lastError = ${`切换失败：${error}`}, updatedAt = ${Date.now()} WHERE id = 1`;
      this.logChannel("webhook_patch_failed", error);
      return { ok: false, error };
    }
    this.sql`UPDATE sh_channel SET webhookStatus = 'patched', webhookPatchedAt = ${Date.now()} WHERE channel = 'feishu'`;
    this.sql`UPDATE sh_qr_setup SET phase = 'webhook_patched', lastError = NULL, updatedAt = ${Date.now()} WHERE id = 1`;
    this.logChannel("webhook_patched", webhookUrl);
    return { ok: true };
  }

  // ---- Model credentials (spec §12.2 "model keys stored encrypted", issue #27) ---------------
  // The provider API key is AES-GCM sealed under SERVER_KEY exactly like the Feishu secrets
  // (sh_model.apiKeyEnc); the plaintext exists only in transit and in memory. The LLM wiring
  // (M2) reads it back through modelConfig(). Not reachable over HTTP — RPC on the stub only,
  // which the routes-audit test pins down.

  // ADR-0001 decision 11: the default provider for keys collected at deploy time (the model
  // itself is deepseek-flash); M2's setup/chat step can reconfigure via setModelConfig.
  static readonly DEFAULT_MODEL_PROVIDER = "deepseek";

  async setModelConfig(provider: string, apiKey: string): Promise<void> {
    if (!provider.trim() || !apiKey.trim()) throw new Error("provider and apiKey are required");
    const [primary] = await this.serverKeys();
    const apiKeyEnc = await sealSecret(primary!, apiKey);
    this.sql`
      INSERT INTO sh_model (id, provider, apiKeyEnc, updatedAt) VALUES (0, ${provider}, ${apiKeyEnc}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, apiKeyEnc = excluded.apiKeyEnc, updatedAt = excluded.updatedAt
    `;
    // The LLM wiring (issue #6) installs the sealed selection lazily (ensureRootModel, before
    // the next submit) — resetting the memo is enough; the models collection handed to pi at
    // open stays the same object and is re-keyed in place. The faux provider's scripted state
    // is per-isolate and never rebuilt.
    this.appliedRootModel = undefined;
  }

  async modelConfig(): Promise<{ provider: string; apiKey: string } | null> {
    // One-click-deploy glue (issue #25, spec §12.1 step 1): MODEL_KEY — the secret the
    // Deploy-to-Cloudflare form collects — seeds the sealed config on first read, so the key
    // never lives anywhere outside the user's own account. Seeding only fills an empty
    // sh_model: an explicit setModelConfig (M2's setup/chat step) always wins, and the env
    // secret is dead weight once the sealed row exists (delete it if you like).
    if (this.sql`SELECT 1 AS one FROM sh_model WHERE id = 0`.length === 0 && this.env.MODEL_KEY?.trim()) {
      await this.setModelConfig(Steward.DEFAULT_MODEL_PROVIDER, this.env.MODEL_KEY.trim());
    }
    const row = this.sql<{ provider: string; apiKeyEnc: string }>`SELECT provider, apiKeyEnc FROM sh_model WHERE id = 0`[0];
    if (!row) return null;
    const opened = await openSecret(await this.serverKeys(), row.apiKeyEnc);
    // Sealed under a dropped key: report unconfigured rather than failing calls forever.
    if (!opened) return null;
    return { provider: row.provider, apiKey: opened.text };
  }

  /**
   * Read-only diagnostics for the merged model selection (issue #6 × #25/#27): what the
   * deploy config and the sealed row resolve to, and whether a usable key exists. The
   * optional `varsRaw` override exists so tests can exercise the unset-vars precedence
   * without rebinding the environment.
   */
  async llmSelection(varsRaw?: unknown): Promise<{
    provider: string;
    modelId: string;
    baseUrl: string | null;
    explicitVars: boolean;
    sealedProvider: string | null;
    apiKey: boolean;
    /** False when the selected provider's catalog has no such model — runs would settle
     *  `unanswered` with `no_model` (review #10); ensureRootModel logs model_config_error. */
    modelKnown: boolean;
  }> {
    const sealed = await this.modelConfig();
    // `varsRaw: null` models an unset deploy config; `undefined` (the production call) reads env.
    const vars = resolveModelConfig(varsRaw === undefined ? this.env.STEWARD_MODEL : varsRaw);
    const config = sealed && !vars.explicit ? { ...vars, provider: sealed.provider } : vars;
    return {
      provider: config.provider,
      modelId: config.modelId,
      baseUrl: config.baseUrl ?? null,
      explicitVars: vars.explicit,
      sealedProvider: sealed?.provider ?? null,
      apiKey: Boolean(sealed && sealed.provider === config.provider),
      modelKnown: config.provider === "faux" || builtinProviders().some((p) => p.id === config.provider && p.getModels().some((m) => m.id === config.modelId)),
    };
  }

  private async handleFeishuWebhook(request: Request): Promise<Response> {
    const cfg = await this.loadFeishuConfig();
    if (!cfg) return new Response("not found", { status: 404 });
    // Loose handshake inside the QR-switch window (see FeishuAdapterOptions.looseHandshake):
    // the PATCH's URL check may be signed with the app's previous console token.
    const parsed = await this.newFeishuAdapter(cfg, { looseHandshake: cfg.source === "qr" && cfg.webhookStatus !== "verified" }).verifyAndParse(request);
    if (parsed instanceof Response) return parsed;

    // Persist before 200 (steward.md §9.1): the dedup insert below is the durable record, and
    // the dispatch that follows only touches SQLite synchronously (its sole await, enqueue,
    // is sync SQL plus a void-fired delivery) — so the 200 goes out only after the event's
    // effects are on disk. The Feishu send itself settles later through the durable queue.
    const dup = this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${parsed.msgId}`;
    if (dup.length > 0) return Response.json({ code: 0 }); // Feishu redelivery: ack and drop
    this.sql`
      INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt)
      VALUES ('feishu', ${parsed.msgId}, ${parsed.eventId}, ${parsed.eventType}, ${Date.now()})
    `;

    // Delivery verification (issue #24): a QR-created app keeps delivering over its websocket
    // transport until the console republish lands, no matter what the config PATCH reported —
    // so the first event that actually reaches this endpoint is the only real proof the
    // switch happened (research §8.2). Sync check-then-set: atomic within the DO.
    if (cfg.source === "qr" && cfg.webhookStatus !== "verified") {
      const prior = this.sql<{ ws: string | null }>`SELECT webhookStatus AS ws FROM sh_channel WHERE channel = 'feishu'`[0]!.ws;
      if (prior !== "verified") {
        this.sql`UPDATE sh_channel SET webhookStatus = 'verified', webhookVerifiedAt = ${Date.now()} WHERE channel = 'feishu'`;
        this.sql`UPDATE sh_qr_setup SET phase = 'done', updatedAt = ${Date.now()} WHERE id = 1`;
        this.logChannel("webhook_verified", `${parsed.eventType} ${parsed.eventId}`);
        if (cfg.ownerOpenId) {
          await this.enqueueOutbound({ kind: "text", to: cfg.ownerOpenId, text: QR_SETUP_DONE_REPLY, urgency: "push" });
        }
      }
    }

    if (parsed.kind === "message") {
      await this.dispatchInboundMessage(parsed, cfg.ownerOpenId);
    } else if (parsed.kind === "card_action") {
      await this.dispatchCardAction(parsed, cfg.ownerOpenId);
    } else {
      this.logChannel("event_ignored_other", `${parsed.eventType} ${parsed.eventId}`);
    }
    return Response.json({ code: 0 });
  }

  private async dispatchInboundMessage(ev: InboundEvent, ownerOpenId: string | null): Promise<void> {
    if (ev.chatType !== "p2p") {
      this.logChannel("ignored_group", `${ev.senderId ?? "?"} ${ev.msgId}`);
      return;
    }
    if (ownerOpenId === null) {
      // First p2p DM after credentials were saved binds the sender as owner (issue #4, spec
      // §12.1). Everything before this point was SETUP_TOKEN-guarded, and only someone who
      // can already reach this private bot can be here; first-DM-wins is the accepted design.
      this.sql`UPDATE sh_channel SET ownerOpenId = ${ev.senderId!}, boundAt = ${Date.now()} WHERE channel = 'feishu'`;
      this.logChannel("owner_bound", ev.senderId!);
      await this.enqueueOutbound({ kind: "text", to: ev.senderId!, text: OWNER_BOUND_REPLY, urgency: "push" });
      return;
    }
    if (ev.senderId !== ownerOpenId) {
      this.logChannel("ignored_not_owner", `${ev.senderId} ${ev.msgId}`);
      return;
    }
    if (ev.messageType !== "text") {
      // Attachments land via fetchAttachment once ingestion is wired (§9.1); for now they are
      // durably recorded in sh_inbound and logged.
      this.logChannel("ignored_message_type", `${ev.messageType} ${ev.msgId}`);
      return;
    }
    // Two exact phrases stay deterministic and never reach the model (issue #22): `/加机器`
    // mints a pairing code and `/网页` a one-time login link — security-sensitive, and they
    // must work without a model behind the bot.
    const command = parseOwnerCommand(ev.text ?? "");
    if (command) {
      this.logChannel("owner_command", `${ev.msgId} ${command.kind}`);
      await this.dispatcher.handleOwnerCommand(command);
      return;
    }
    // The owner's text goes to the steward LLM (issue #6): sh_run(user) + harness.submit with
    // operationId = user:<msgId> (steward.md §4.2/§6.3); the settled final text becomes the
    // reply. Quote-routing is resolved deterministically BEFORE the model ever sees the text
    // (§3.1 signal 1 never passes through LLM judgment).
    this.logChannel("owner_message", `${ev.msgId} parent=${ev.parentId ?? "-"} ${ev.text ?? ""}`.slice(0, 500));
    await this.submitUserMessage({ msgId: ev.msgId, text: ev.text ?? "", parentId: ev.parentId });
  }

  /** A user message becomes one steward input, idempotent on the msgId (steward.md §9.1/§11). */
  private async submitUserMessage(input: { msgId: string; text: string; parentId?: string }): Promise<void> {
    const operationId = `user:${input.msgId}`;
    // Signal 1 (§3.1): a quote of one of our messages routes to that Thread directly.
    const routed = input.parentId ? this.ledger.outbound.threadIdForProviderMsg(input.parentId) : null;
    const routedThread = routed ? this.ledger.threads.get(routed) : null;
    if (routedThread) {
      this.ledger.threads.markRead(routedThread.threadId); // a reply means the report was seen (§6.5)
      // Review #7: a reply routed to a Thread with an open question IS the answer — close it
      // (the deterministic path only closed on re-dispatch, leaving waiting_you stuck when
      // the user e.g. answered "算了"). The steward sees the closed state in the next brief.
      this.ledger.questions.closeOpen(routedThread.threadId, "用户回复了提问");
    }
    // Content markers (§4.2): user text is escaped so it can never mimic a ⟦…⟧ system input;
    // the routing note is prefixed as clearly-marked system metadata (never the ⟦ form, so
    // the input still reads as user-originated).
    const escaped = escapeMarkers(input.text);
    const note = routedThread
      ? `（系统注：这条消息是对 Thread「${routedThread.title}」（${routedThread.threadId}）消息的回复，已确定归属该 Thread。）\n`
      : "";
    const text = `${note}${escaped}`;
    if (!this.ledger.runs.open(operationId, "user", text, { replyTo: input.msgId, channel: "feishu", routedThreadId: routedThread?.threadId ?? null })) {
      return; // already submitted (sh_inbound dedup normally catches this first)
    }
    try {
      await this.ensureRootModel();
      await this.piHarness.submit(text, { operationId, whenBusy: "followUp" });
    } catch (err) {
      this.logChannel("submit_failed", `${operationId} ${errorText(err)}`);
      // The row stays open: the poll's not_found path resubmits until it sticks (§11).
    }
    void this.pollRuns();
  }

  /**
   * The alarm-driven run settler (steward.md §6.3): while sh_run rows are open, re-arm every
   * RUN_POLL_S seconds; on settlement a user run's final text is enqueued as the reply, and
   * every other kind's text is discarded — the structural half of "quiet by default" (§6.2).
   */
  async pollRuns(_payload?: unknown, schedule?: { id: string }): Promise<void> {
    const open = this.ledger.runs.openRows();
    if (open.length === 0) return;
    let stillOpen = false;
    try {
      const pending = new Set((await this.piHarness.pending()).map((p) => p.operationId));
      for (const run of open) {
        if (pending.has(run.operationId)) {
          stillOpen = true;
          continue;
        }
        const result = await this.piHarness.wait(run.operationId);
        if (result.status === "unanswered" && result.reason === "not_found") {
          // Crash between the sh_run write and submit (§11): resubmit — the operationId
          // guarantees the harness treats it as one input, never two.
          try {
            await this.ensureRootModel();
            await this.piHarness.submit(run.text, { operationId: run.operationId, whenBusy: "followUp" });
            stillOpen = true;
          } catch (err) {
            this.logChannel("submit_failed", `${run.operationId} ${errorText(err)}`);
            stillOpen = true;
          }
          continue;
        }
        this.settleRun(run, result);
      }
    } catch (err) {
      this.logChannel("poll_runs_failed", errorText(err));
      stillOpen = true;
    }
    if (!stillOpen) return;
    // Rearm (review #1): an idempotent schedule() called from inside the running job dedups
    // ONTO that job — which the JobDriver deletes when the handler returns — so the loop
    // would die after one alarm. The Scheduler hands the callback its own schedule: cancel
    // it first, then the idempotent insert is the only job left and always creates fresh.
    // Inline callers (submit, the test poller) have no `schedule` and only dedup onto whatever
    // is pending, which the job-context pass above keeps correcting.
    if (schedule !== undefined) await this.cancelSchedule(schedule.id).catch(() => {});
    await this.schedule(RUN_POLL_S, "pollRuns", undefined, { idempotent: true });
  }

  private settleRun(run: RunRow, result: { status: string; reason?: string; text?: string }): void {
    if (run.kind === "user") {
      const owner = this.ownerOpenIdSync();
      const hasText = Boolean(result.text && result.text.trim().length > 0);
      // Review #9: a `done` run with no final text is legitimate when the model already
      // produced user-facing output (ask_user terminates the turn right after its push;
      // notify_user cards went out mid-run). Only a silent empty answer is treated as a
      // failure the user must hear about.
      const alreadyNotified = Boolean(run.notified);
      if (owner && result.status === "done" && hasText) {
        // §6.2 source 3: the final text of a user-triggered run IS the reply. Carrying the
        // routed thread keeps quote-reply chains on the same Thread (§3.1) — either the
        // quote-route resolved at submit time or the run's own dispatch backfilled it.
        // The outbound id is keyed to the run (review #6): concurrent polls and interrupted
        // settle windows converge on one message.
        void this.enqueueOutbound({
          id: `reply:${run.operationId}`,
          kind: "text",
          to: owner,
          text: result.text!,
          threadId: run.routedThreadId,
          urgency: "push",
        }).then(({ id }) => this.ledger.runs.settle(run.operationId, result, id));
        return;
      }
      if (owner && result.status !== "done") {
        // No template exists for user replies; a one-line notice beats silence (the budget
        // cap and its degradation behavior are #28's to refine).
        void this.enqueueOutbound({
          id: `reply:${run.operationId}`,
          kind: "text",
          to: owner,
          text: "⚠️ 总管这轮没有跑成（模型调用失败或被中断），这条消息我没能处理；稍后再试或重发一次。",
          threadId: run.routedThreadId,
          urgency: "push",
        }).then(({ id }) => this.ledger.runs.settle(run.operationId, result, id));
        return;
      }
      if (owner && result.status === "done" && !hasText && !alreadyNotified) {
        // Review #9: done, empty, and nothing reached the user — say so instead of silence.
        void this.enqueueOutbound({
          id: `reply:${run.operationId}`,
          kind: "text",
          to: owner,
          text: "⚠️ 总管这轮没有给出回复（可能只调用了内部工具）；需要的话再说一次。",
          threadId: run.routedThreadId,
          urgency: "push",
        }).then(({ id }) => this.ledger.runs.settle(run.operationId, result, id));
        return;
      }
    }
    // Event/routine/follow-up runs, and user runs that already reached the user: the text is
    // kept for audit and nothing more is sent (§6.2).
    this.ledger.runs.settle(run.operationId, result);
  }

  /**
   * The wake scheduler (steward.md §5.1): due wake_requests become steward inputs with
   * `whenBusy: followUp`. Idempotent end to end — the wake's operationId is fixed at queue
   * time and harness.submit deduplicates by it, so replays and crash-restarts never produce a
   * second steward input.
   */
  async drainWakes(_payload?: unknown, schedule?: { id: string }): Promise<void> {
    let submitted = false;
    try {
      for (const wake of this.ledger.wakes.due(Date.now())) {
        this.ledger.runs.open(wake.operationId, wake.kind, wake.text);
        try {
          await this.ensureRootModel();
          await this.piHarness.submit(wake.text, { operationId: wake.operationId, whenBusy: "followUp" });
          this.ledger.wakes.markSubmitted(wake.id);
          submitted = true;
        } catch (err) {
          this.logChannel("wake_submit_failed", `${wake.operationId} ${errorText(err)}`);
          // Leave the row pending: the next drain retries it.
        }
      }
    } catch (err) {
      this.logChannel("drain_wakes_failed", errorText(err));
    }
    const next = this.ledger.wakes.earliestDue(Date.now());
    if (next !== null) {
      // Rearm (same reasoning as pollRuns, review #1): cancel the tracked pending job AND
      // our own running schedule (the tracked id can be stale after an eviction restarted
      // this isolate), then the idempotent insert always creates fresh — at the earliest
      // due moment, so a new wake can also pull the alarm in.
      const inS = Math.max(1, Math.ceil((next - Date.now()) / 1000));
      if (schedule !== undefined) await this.cancelSchedule(schedule.id).catch(() => {});
      if (this.drainWakeScheduleId !== undefined) {
        await this.cancelSchedule(this.drainWakeScheduleId).catch(() => {});
        this.drainWakeScheduleId = undefined;
      }
      const scheduled = await this.schedule(inS, "drainWakes", "due", { idempotent: true }).catch(() => undefined);
      this.drainWakeScheduleId = scheduled?.id;
    }
    if (submitted) void this.pollRuns();
  }

  // Card button callbacks (issue #5): the Thread is resolved from the card's providerMsgId —
  // never from data stuffed into the button (steward.md §3.1, spike bug list).
  private async dispatchCardAction(ev: InboundEvent, ownerOpenId: string | null): Promise<void> {
    if (ownerOpenId === null || !ev.operatorId || !ev.cardMsgId) {
      this.logChannel("ignored_card_no_owner", `${ev.eventId}`);
      return;
    }
    if (ev.operatorId !== ownerOpenId) {
      this.logChannel("ignored_card_not_owner", `${ev.operatorId} ${ev.eventId}`);
      return;
    }
    await this.dispatcher.handleCardAction({ operatorId: ev.operatorId, action: ev.action ?? "", cardMsgId: ev.cardMsgId });
  }

  private logChannel(reason: string, detail: string): void {
    this.sql`INSERT INTO sh_channel_log (ts, channel, reason, detail) VALUES (${Date.now()}, 'feishu', ${reason}, ${detail})`;
  }

  async channelLogEntries(limit = 50): Promise<{ ts: number; reason: string; detail: string | null }[]> {
    return this.sql<{ ts: number; reason: string; detail: string | null }>`
      SELECT ts, reason, detail FROM sh_channel_log ORDER BY seq DESC LIMIT ${limit}
    `;
  }

  async inboundSeen(msgId: string): Promise<boolean> {
    return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId}`.length > 0;
  }

  // ---- Outbound queue (steward.md §6.1) ----------------------------------------------------------
  // Row writes go through the memory module (ledger.outbound owns the sh_outbound table);
  // what stays here is delivery mechanics only: claims, pacing, backoff, the adapter call.

  async enqueueOutbound(input: {
    kind: "text" | "card";
    to: string;
    text?: string;
    card?: unknown;
    threadId?: string | null;
    urgency?: "push" | "quiet";
    /** Stable dedupe key (review #6): retries/replays of the same logical message converge on
     *  one row (INSERT OR IGNORE) — the id doubles as the provider-side uuid, so a repeated
     *  enqueue can never double-send. Omitted: a fresh one-of message. */
    id?: string;
  }): Promise<{ id: string }> {
    const id = this.ledger.outbound.enqueue(input);
    void this.deliverOutbound();
    return { id };
  }

  async outboundRow(id: string): Promise<ShOutboundRow | null> {
    return (this.ledger.outbound.row(id) as unknown as ShOutboundRow | undefined) ?? null;
  }

  async outboundRows(limit = 10): Promise<ShOutboundRow[]> {
    return this.ledger.outbound.rows(limit) as unknown as ShOutboundRow[];
  }

  /** Read-only ledger view for tests: threads, workers, reports, questions, timeline. */
  async debugSnapshot(): Promise<ReturnType<Steward["ledger"]["debug"]["snapshot"]>> {
    return this.ledger.debug.snapshot();
  }

  /** Test entry into the deterministic dispatch service the start_worker tool drives. */
  async dispatchForTest(
    input: Omit<import("./dispatch.ts").StartWorkerInput, "provenance" | "cmdId"> & { cmdId?: string },
  ): Promise<import("./dispatch.ts").StartWorkerOutcome> {
    return this.dispatcher.startWorker({
      ...input,
      provenance: "test",
      cmdId: input.cmdId ?? `test:${ulid()}`,
    });
  }

  // ---- Steward-LLM test surface (the `faux` provider is configured via STEWARD_MODEL) ----

  /** Queues scripted model replies (FIFO); each model request consumes one step. */
  async fauxScript(steps: AssistantMessage[]): Promise<void> {
    if (!this.llmModels.faux) throw new Error("STEWARD_MODEL is not the faux provider");
    this.llmModels.faux.setSteps(steps);
  }

  /** The captured model requests (after beforeRequest): input texts + injected briefs. */
  async fauxRequests(): Promise<FauxRequestRecord[]> {
    if (!this.llmModels.faux) throw new Error("STEWARD_MODEL is not the faux provider");
    return this.llmModels.faux.requests();
  }

  /** The steward conversation as compact rows: every submitted input and its outcome. */
  async llmState(): Promise<{
    runs: RunRow[];
    inputs: Array<{ operationId: string; kind: string; text: string }>;
    assistantTexts: string[];
    raw: unknown[];
  }> {
    const records = await this.piHarness.messages();
    const inputs: Array<{ operationId: string; kind: string; text: string }> = [];
    const assistantTexts: string[] = [];
    for (const record of records) {
      const entry = record as unknown as { kind?: string; model?: Array<{ content?: unknown }> };
      const content = entry.model?.[0]?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.flatMap((part) => ((part as { type?: string })?.type === "text" ? [(part as { text?: string }).text ?? ""] : [])).join("")
            : "";
      if (entry.kind === "pi.user") inputs.push({ operationId: "", kind: "user", text });
      if (entry.kind === "pi.assistant") assistantTexts.push(text);
    }
    return { runs: this.ledger.runs.rows(), inputs, assistantTexts, raw: records as unknown as unknown[] };
  }

  /** Test-only: wipes the pi conversation (dispose + drop pi_* tables) and the run/wake rows. */
  async resetLlmStateForTests(): Promise<void> {
    await this.piHarness.dispose();
    const tables = this.sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_%'
    `.map((r) => r.name);
    for (const table of tables) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS "${table}"`);
    this.ctx.storage.sql.exec("DELETE FROM sh_run");
    this.ctx.storage.sql.exec("DELETE FROM sh_wake");
    if (this.llmModels.faux) this.llmModels.faux.reset();
  }

  // Scheduled callback (also fired inline after each enqueue): claims due rows, sends them
  // through the adapter, and re-arms itself. Safe to run concurrently — passes serialize on
  // deliveryChain and the claim guard still makes every row the property of exactly one pass.
  deliverOutbound(): Promise<void> {
    const run = this.deliveryChain.then(() => this.deliverOutboundPass());
    this.deliveryChain = run.catch(() => {});
    return run;
  }

  private async deliverOutboundPass(): Promise<void> {
    // Reclaim rows whose delivery pass died mid-send (claim expired): back to queued.
    this.ledger.outbound.reclaimExpiredClaims(Date.now());
    for (const id of this.ledger.outbound.dueIds(Date.now(), OUTBOUND_BATCH)) {
      await this.deliverOneOutbound(id);
    }
    this.rearmDeliveryAlarm();
  }

  private async deliverOneOutbound(id: string): Promise<void> {
    // The claim (spike bug 1): only a queued row (or one whose claim has expired) can be
    // taken, so two concurrent passes never both send it.
    const row = this.ledger.outbound.claimForDelivery(id, Date.now(), OUTBOUND_CLAIM_MS);
    if (!row) return; // another pass owns this row

    const cfg = await this.loadFeishuConfig();
    if (!cfg) {
      this.ledger.outbound.settleFailure(id, row.claim, row.attempts + 1, "channel_not_configured", null, Date.now());
      return;
    }

    // 5 QPS per receiver (feishu-channel.md §4): space this send from the previous one.
    const pace = this.sql<{ lastSendAt: number }>`
      SELECT lastSendAt FROM sh_channel_pace WHERE channel = ${row.channel} AND receiveId = ${row.receiveId}
    `[0];
    const wait = pace ? pace.lastSendAt + OUTBOUND_SEND_SPACING_MS - Date.now() : 0;
    if (wait > 0) await sleep(wait);

    const payload = JSON.parse(row.payload) as { text?: string; card?: unknown };
    try {
      const { providerMsgId } = await this.newFeishuAdapter(cfg).send({
        id,
        to: row.receiveId,
        kind: row.kind === "card" ? "card" : "text",
        text: payload.text,
        card: payload.card,
        threadId: row.threadId,
      });
      this.touchPace(row.channel, row.receiveId);
      this.ledger.outbound.settleSent(id, row.claim, providerMsgId, Date.now());
    } catch (err) {
      // The attempt hit the wire (or timed out at 10s — spike bug 3), so it counts against
      // the receiver's rate budget either way.
      this.touchPace(row.channel, row.receiveId);
      if (!this.ledger.outbound.stillOwns(id, row.claim)) return; // a reclaim took over mid-send; its send settles
      const attempts = row.attempts + 1;
      const retriable = err instanceof RetriableChannelError;
      const permanent = !retriable || attempts >= OUTBOUND_MAX_ATTEMPTS;
      const delay = permanent
        ? null
        : Math.min(OUTBOUND_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOUND_BACKOFF_CAP_MS);
      this.ledger.outbound.settleFailure(
        id,
        row.claim,
        attempts,
        errorText(err),
        permanent ? null : Date.now() + (delay ?? 0),
        Date.now(),
      );
    }
  }

  private touchPace(channel: string, receiveId: string): void {
    this.sql`
      INSERT INTO sh_channel_pace (channel, receiveId, lastSendAt) VALUES (${channel}, ${receiveId}, ${Date.now()})
      ON CONFLICT (channel, receiveId) DO UPDATE SET lastSendAt = excluded.lastSendAt
    `;
  }

  private rearmDeliveryAlarm(): void {
    const at = this.ledger.outbound.nextWake(Date.now());
    if (at === null) return;
    void this.schedule(Math.max(1, Math.ceil((at - Date.now()) / 1000)), "deliverOutbound");
  }
}
