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
//
// Proactive behavior (issue #20, steward.md §8): routines and follow-ups schedule through
// the Agents SDK (`fireRoutine`/`fireFollowup`); digest routines render deterministically
// with no LLM, instruction fires submit ⟦routine⟧ inputs whose operationId
// (routine:<id>:<fireTime>) dedups duplicate fires; every row traces back to a user message.
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
  HISTORY_MAX_BYTES,
  HISTORY_RELAY_TTL_MS,
  HistoryAckMessageSchema,
  HistoryChunkMessageSchema,
  HistoryOpenMessageSchema,
  PingMessageSchema,
  PROTOCOL_VERSION,
  generatePairingCode,
  mintToken,
  parseToken,
  ulid,
  type CmdMessage,
  type ErrorMessage,
  type EventsAckMessage,
  type HistoryReqMessage,
  type MachineOfflineMessage,
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
import {
  formatUsd,
  renderOverBudgetNote,
  renderSpendStatus,
  resolveBudgetConfig,
  sumUsage,
  type BudgetConfig,
  type BudgetState,
} from "./budget.ts";
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
import { createLedger, type Ledger, type LedgerSql, type NotifyRow, type QuestionRow, type RunRow, type WakeRow } from "./ledger.ts";
import { renderChangeReports } from "./notes.ts";
import { RoutineService } from "./routines.ts";
import {
  failureCard,
  notifyCard,
  askUserCard,
  reportCardFor,
  noteDecisionCard,
  stallCard,
  workerQuestionCard,
  didBullets,
  machineOfflineCard,
  machineOnlineCard,
  waitedStartCard,
  type AskCardButton,
} from "./report-template.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { renderSetupPage, type SetupView } from "./setup-page.ts";
import { escapeMarkers, verifyWakeText } from "./wake-text.ts";
import { WebApp, linkTargetForThread, parseSessionCookie } from "./web.ts";

interface ConnState {
  /** Set on browser connections (the L3 stream consumers); connector connections carry deviceId. */
  role?: "web";
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

// History relay (protocol §6.6, issue #23): a relay row older than this is dropped; the
// browser's stream JS treats silence past its own deadline as the end. Shrunk in tests.
const HISTORY_RELAY_TTL_DEFAULT_MS = HISTORY_RELAY_TTL_MS;

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
/** Settle-time verification (issue #7, spike-conclusions §2): reply phrases that claim a
 *  dispatch. Zero false positives observed live in the spike; keep the set tight — an
 *  over-broad pattern would spam corrective runs. */
const DISPATCH_CLAIM_RE = /已派活|已重派|已派出|已派发|派给了|已经派出|新 worker|worker 会|worker 将/;
export const claimsDispatch = (text: string): boolean => DISPATCH_CLAIM_RE.test(text);
// §7.2 (review #47-5): a fired once-routine / follow-up authorizes the run its fire spawned
// — bounded in time, so a long-dead fire is not a standing authorization. Generous enough
// for a wake queued behind a busy harness (whenBusy: followUp), short enough to revoke.
const PROVENANCE_FIRE_FRESHNESS_MS = 10 * 60_000;
// The steward's daily notes lifecycle pass (issue #19, steward.md §2.5) runs at 02:00 UTC:
// one cron, idempotent by expression — armNotesMaintenance/notesMaintenance both use it.
const NOTES_MAINTENANCE_CRON = "0 2 * * *";
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
  /** The worker question this message asks/answers (issue #10); null when unbound. */
  questionId?: string | null;
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

/** pi-durable's invocation Context is structural (an abort signal, keyed values, a name), and
 *  chord's own BACKGROUND_CONTEXT lives in a dev-only dependency of this package — so, like
 *  agents/harness/pi, we carry the same never-cancelled value rather than import it. */
const BACKGROUND_CONTEXT: Parameters<Harness["usage"]>[0] = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context steward background]",
});

/** UTF-8 size of a serialized relay message — the byte meter is numbers only, never content. */
function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

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
    // Each migration commits atomically WITH its ledger row (reviews #47-2 + #48 finding 3):
    // a multi-statement rebuild can never persist half of itself, and the ledger write
    // cannot lag the commit (the copy-drop-rename migrations are not re-runnable).
    runMigrations(this.sql.bind(this), MIGRATIONS, (fn) => this.ctx.storage.transactionSync(fn));
    // Notes maintenance is daily (steward.md §2.5, issue #19): a 02:00 UTC cron, idempotent
    // by expression — re-arming at boot dedups onto the same row and never postpones it,
    // so the chain cannot die (or drift) with an evicted isolate.
    this.armNotesMaintenance();
    // Issue #28: the usage cursor is seeded FIRST — queued ahead of everything below that can
    // start a model call — so the first reading is the boot baseline (pi's history ≠ today's
    // spend, budget.ts observe()). Void: onStart must not gate startup on pi.
    void this.syncUsageQuietly("budget_baseline_failed");
    // §5.3 (issue #10): a blocked report's question is durably deadlined — the fallback
    // forwards it even if this isolate never saw the report arrive.
    void this.armQuestionFallback();
    // Review finding 3 (issue #10): a crash between queueFallbacks and the delivery pass
    // strands the intent with its question already handled — the sweep would not re-arm (no
    // unhandled question left). Draining pending intents at boot closes that window; the
    // rows are idempotent, so an extra pass on a clean boot is free.
    void this.drainNotifications();
    // A DO restart clears the in-memory arm-dedupe while storage alarms keep their own
    // clock: re-arm maintenance so a restart never strands active workers unwatched.
    this.armWorkerSweeps();
    // Crash-window machine-status intents (created, never drained) get their due-date wake.
    this.rearmNoticeDrain();
    // Wakes queued by past reducers (crash between queue and submit, §11) drain now.
    void this.drainWakes();
    void this.pollRuns();
    // Routine/follow-up rows and their SDK schedules live in different stores — a crash
    // between INSERT and schedule() must not silently kill a routine (issue #20, §11).
    void this.reconcileRoutineSchedules();
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

  // Issue #28 (steward.md §12): the resolved daily budget. Tests swap it on the live DO
  // instance (setBudgetForTest) to sit right under/over the cap without page-scale token
  // counts; production reads it from vars.DAILY_BUDGET_USD once per isolate.
  private budgetConfig_?: BudgetConfig;

  private get budgetConfig(): BudgetConfig {
    if (this.budgetConfig_ === undefined) {
      const config = resolveBudgetConfig(this.env.DAILY_BUDGET_USD);
      if (config.error !== undefined) this.logChannel("budget_config_error", config.error);
      this.budgetConfig_ = config;
    }
    return this.budgetConfig_;
  }

  /** Today's counter against the cap; the one read every gate and readout uses. */
  private budgetState(): BudgetState {
    return this.ledger.budget.state(this.budgetConfig);
  }

  // Usage syncs serialize here (budget.ts observe() demands it: a stale pi.usage read
  // landing after a newer one must never be folded twice). Same chain shape as
  // notifyChain/deliveryChain.
  private usageSyncChain: Promise<void> = Promise.resolve();

  /**
   * Folds pi's cumulative session usage into today's counter; resolves once the write landed.
   *
   * Nothing feeds the counter in the background, on purpose. A pi commit listener has to be
   * attached from `conversationCreated`, which pi runs only when it CREATES the root — an
   * isolate that restarts onto an existing root (every Durable Object eviction) never gets
   * one, and a second writer next to this sweep double-charges the same spend. So the
   * counter is brought current exactly where a decision reads it: the wake drain (before the
   * gate), run settlement (before the over-budget note), and the spend readout.
   */
  private syncUsage(): Promise<void> {
    const run = this.usageSyncChain.then(async () => {
      const pi = await this.piHarness.pi();
      this.ledger.budget.observe(sumUsage(await pi.usage(BACKGROUND_CONTEXT)));
    });
    this.usageSyncChain = run.catch(() => {});
    return run;
  }

  /** syncUsage for decision points: a failed read must not take the decision down with it —
   *  the persisted counter is stale-but-honest and the failure is on the channel log. */
  private async syncUsageQuietly(reason = "budget_sync_failed"): Promise<void> {
    try {
      await this.syncUsage();
    } catch (err) {
      this.logChannel(reason, errorText(err));
    }
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

  // Tests shrink the history relay TTL to exercise the alarm-driven sweep quickly.
  protected historyRelayTtlMs = HISTORY_RELAY_TTL_DEFAULT_MS;

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
        this.sql`UPDATE outbox SET state = 'expired', held = 0 WHERE cmdId = ${cmdId} AND state = 'queued'`;
        return this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
      },
      // "wait" (protocol §7.3): the command loses its deadline entirely — held AND notAfter —
      // and tries to deliver right away (a machine that reconnected while the card sat
      // unread starts immediately).
      waitForCommand: (cmdId) => {
        try {
          this.ctx.storage.transactionSync(() => {
            this.sql`UPDATE outbox SET held = 0, notAfter = NULL WHERE cmdId = ${cmdId} AND state = 'queued' AND held = 1`;
          });
          const changed = this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
          if (changed) void this.deliver(cmdId);
          return changed;
        } catch (err) {
          this.logChannel("wait_command_failed", `${cmdId} ${errorText(err)}`);
          return false;
        }
      },
      commandExists: (cmdId) => this.sql`SELECT 1 AS one FROM outbox WHERE cmdId = ${cmdId}`.length > 0,
      sendText: async (text, threadId) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "text", to: owner, text, threadId: threadId ?? null, urgency: "push" });
      },
      sendCard: async (card, threadId, id) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "card", to: owner, card, threadId, urgency: "push", ...(id !== undefined ? { id } : {}) });
      },
      createPairing: () => this.createPairing(),
      deployOrigin: () => this.web.origin(),
      webLinkUrl: (target) => this.web.linkUrl(target),
      // Routine suggestion cards (`offer:` outbound ids) route their taps here (§8.5).
      onOfferTap: (offerId, action) => this.routineService.handleOfferTap(offerId, action),
      // Issue #28: the deterministic spend readout ("how much today?") — counter, no LLM.
      spendStatusText: async () => {
        await this.syncUsageQuietly();
        const state = this.budgetState();
        // Asking is hearing: the explicit readout carries the same information the daily
        // note would, so it satisfies "noted once" for today too (no double notice).
        if (state.over && state.overNotedAt === null) this.ledger.budget.markNoted(state.day);
        return renderSpendStatus(state);
      },
    }));
  }

  // The proactive-behavior service (issue #20, steward.md §8): routines, follow-ups, offers.
  // Same lazy-bind pattern as the ledger/dispatcher.
  private routineService_?: RoutineService;
  protected get routineService(): RoutineService {
    return (this.routineService_ ??= new RoutineService({
      ledger: this.ledger,
      schedule: (when, callback, payload, opts) => this.schedule(when, callback, payload, opts),
      cancelSchedule: (id) => this.cancelSchedule(id),
      enqueueOutbound: (input) => this.enqueueOutbound(input),
      ownerOpenId: () => this.ownerOpenIdSync(),
      onWakeQueued: () => {
        void this.drainWakes();
        void this.pollRuns();
      },
      audit: (kind, detail) => this.logChannel(kind, detail),
    }));
  }

  /** Agents SDK callback (this.schedule(cron, "fireRoutine", { routineId }), §8.2). */
  async fireRoutine(payload?: { routineId?: string }, schedule?: { id?: string; time?: number }): Promise<void> {
    if (!payload?.routineId) return;
    try {
      await this.routineService.fire(payload.routineId, schedule);
    } catch (err) {
      this.logChannel("routine_fire_failed", `${payload.routineId} ${errorText(err)}`);
    }
  }

  /** Agents SDK callback for a due follow-up (§8.3): submits ⟦followup F⟧. */
  async fireFollowup(payload?: { followupId?: string }): Promise<void> {
    if (!payload?.followupId) return;
    try {
      await this.routineService.fireFollowup(payload.followupId);
    } catch (err) {
      this.logChannel("followup_fire_failed", `${payload.followupId} ${errorText(err)}`);
    }
  }

  /** onStart reconciliation driver (§11): rows ↔ SDK schedules must agree after any crash. */
  async reconcileRoutineSchedules(): Promise<void> {
    try {
      const schedules = await this.listSchedules();
      await this.routineService.reconcile(
        schedules.map((s) => ({ id: s.id, callback: s.callback, type: s.type, time: s.time, payload: s.payload })),
      );
    } catch (err) {
      this.logChannel("routine_reconcile_failed", errorText(err));
    }
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
      machineConnected: (deviceId) => this.connFor(deviceId) !== undefined,
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
        // §7.2 (review #4 + #47-5): a provenance reference is valid only if this deployment
        // actually holds — and has not revoked — what it points at. Routine/follow-up ids
        // authorize while their fire is live: an `active` routine, a `done` once-routine
        // whose fire may still be executing (bounded by PROVENANCE_FIRE_FRESHNESS), a
        // freshly `fired` follow-up. Paused/cancelled are the owner's revocation.
        if (ref.startsWith("user:")) {
          const msgId = ref.slice("user:".length);
          if (msgId.length === 0) return false;
          return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId}`.length > 0;
        }
        if (ref.startsWith("routine:")) {
          const routineId = ref.slice("routine:".length);
          if (routineId.length === 0) return false;
          const routine = this.ledger.routines.get(routineId);
          if (!routine) return false;
          if (routine.status === "active") return true;
          return routine.status === "done" && (routine.lastRunAt ?? 0) > Date.now() - PROVENANCE_FIRE_FRESHNESS_MS;
        }
        if (ref.startsWith("followup:")) {
          const followupId = ref.slice("followup:".length);
          if (followupId.length === 0) return false;
          const followup = this.ledger.followups.get(followupId);
          // `open` has not happened yet and authorizes nothing; `fired` is live only while fresh.
          return followup?.status === "fired" && (followup.firedAt ?? 0) > Date.now() - PROVENANCE_FIRE_FRESHNESS_MS;
        }
        return false;
      },
      messageReceivedAt: async (ref) => {
        // Notes' temporal binding (PR #44 review finding 3b): when the owner's message
        // arrived, so a confirmation can be required to postdate the note it confirms.
        if (!ref.startsWith("user:")) return null;
        const msgId = ref.slice("user:".length);
        if (msgId.length === 0) return null;
        return (
          this.sql<{ receivedAt: number }>`
            SELECT receivedAt FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId}
          `[0]?.receivedAt ?? null
        );
      },
      startWorker: async (input) => {
        const run = await this.currentRunBinding();
        const outcome = await this.dispatcher.startWorker(input);
        // Review #8: a dispatch in this run picks/creates the Thread the conversation is now
        // about — backfill it onto the run so the run's reply (and quote-replies to it)
        // route to that Thread, exactly like an explicit quote-route does.
        if (outcome.kind === "dispatched" || outcome.kind === "asked_offline") {
          if (run && run.routedThreadId === null) {
            this.sql`UPDATE sh_run SET routedThreadId = ${outcome.threadId} WHERE operationId = ${run.operationId} AND routedThreadId IS NULL`;
          }
          // Issue #7: count the real dispatch for the settle-time verification — a reply
          // claiming "dispatched" with dispatchCount 0 gets the corrective follow-up.
          if (run) this.ledger.runs.countDispatch(run.operationId);
        }
        return outcome;
      },
      sendToWorker: async (input) => {
        const outcome = await this.dispatcher.sendToWorker(input);
        if (outcome.kind === "sent") await this.backfillRunThread(outcome.threadId);
        return outcome;
      },
      interruptWorker: async (input) => {
        const outcome = await this.dispatcher.interruptWorker(input);
        if (outcome.kind === "interrupted") await this.backfillRunThread(outcome.threadId);
        return outcome;
      },
      notifyUser: async (input) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        const thread = input.threadId ? this.ledger.threads.get(input.threadId) : null;
        const question = input.questionId !== undefined ? this.ledger.questions.get(input.questionId) : null;
        if (input.questionId !== undefined && (question === null || question.status !== "open" || question.workerId === null)) {
          this.logChannel("notify_question_invalid", input.questionId);
          return;
        }
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
          questionId: question !== null && question.status === "open" && question.workerId !== null ? question.qid : null,
          urgency: input.urgency,
        });
        if (question !== null && question.status === "open" && question.workerId !== null) {
          // §5.3 (issue #10, review finding 5): reaching the user always cancels the fallback
          // (markHandled), but only a TERMINAL resolution closes the question — "done" (an
          // unreported run the steward verified) or an explained failure. resolution:"question"
          // is the steward ASKING the user something in prose: the question stays open, the
          // card keeps its binding, and the owner's quote-reply still resolves it.
          this.ledger.questions.markHandled(question.qid);
          if (input.resolution !== "question") {
            this.ledger.questions.close(question.qid, input.resolution === "done" ? "总管核实：已完成并汇报" : "总管已向用户说明");
          }
        }
        if (thread) this.sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${thread.threadId}`;
        await this.markRunNotified();
      },
      askUser: async (input) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        // §5.3 (issue #10): forwarding a worker's question BINDS that question — no second
        // row is created; the card's buttons and the quote-route resolve to the worker's qid,
        // and the 90-second fallback for it is cancelled (it reached the user).
        const forwarded = input.questionId !== undefined ? this.ledger.questions.get(input.questionId) : null;
        if (input.questionId !== undefined && (forwarded === null || forwarded.status !== "open" || forwarded.workerId === null)) {
          this.logChannel("ask_question_invalid", input.questionId);
          return;
        }
        const thread = input.threadId ? this.ledger.threads.get(input.threadId) : forwarded?.threadId ? this.ledger.threads.get(forwarded.threadId) : null;
        // §4.3 (issue #7): ask_user creates the sh_question — thread-scoped when it belongs
        // to one Thread (flipping it to waiting_you), threadless for routing asks, where the
        // candidates column carries the button mapping a click resolves against. One
        // question per call: a unique id (review #3 — a per-run id collided and INSERT OR
        // IGNORE silently swallowed repeats).
        const qid = forwarded?.qid ?? `q_steward_${ulid()}`;
        if (forwarded === null) {
          this.ledger.questions.insert({
            qid,
            threadId: thread?.threadId ?? null,
            workerId: null,
            text: input.question,
            options: input.options,
            candidates: input.candidates,
          });
        } else {
          this.ledger.questions.setOptions(qid, input.options);
          this.ledger.questions.markHandled(qid); // reached the user; cancel the fallback
        }
        if (thread) {
          this.ledger.recomputeThreadState(thread.threadId);
          this.sql`UPDATE sh_thread SET unread = 1 WHERE threadId = ${thread.threadId}`; // news landed (§5.2)
        }
        // The card (issue #7): ≤3 candidate buttons + 「新开一件事」 for routing asks; plain
        // option buttons otherwise; no buttons for open questions (answer via quote-reply,
        // which the outbound row's threadId routes). Button values carry only the opaque
        // action string — Thread identity resolves server-side (§3.1, spike bug list).
        const buttons: AskCardButton[] =
          input.candidates.length > 0
            ? [
                ...input.candidates.map((candidate, index) => ({
                  label: candidate.label,
                  action: `ask:${qid}:${index}`,
                })),
                { label: "新开一件事", action: `asknew:${qid}`, primary: true },
              ]
            : input.options.map((option, index) => ({ label: option, action: `ask:${qid}:${index}` }));
        await this.enqueueOutbound({
          id: input.dedupeId,
          kind: "card",
          to: owner,
          card: askUserCard({
            question: input.question,
            ...(thread ? { threadTitle: thread.title } : {}),
            buttons,
          }),
          threadId: thread?.threadId ?? null,
          questionId: forwarded !== null ? forwarded.qid : null,
          urgency: "push",
        });
        await this.markRunNotified();
      },
      audit: (kind, detail) => {
        this.logChannel(kind, detail);
      },
      routines: this.routineService,
      /** §4.3/§7.2 (issue #10): whether a user-message evidence ref is one the bound owner
       *  actually sent — the one check answer_worker's hook cannot do for itself. */
      isOwnerMessage: (msgId) => this.isOwnerMessage(msgId),
      // §4.3 (issue #10): answer_worker's deterministic landing — close the question, relay
      // to the worker, cancel the fallback. The evidence gate is the extension's hook.
      answerWorker: (input) => this.answerWorker(input),
      recordProactiveOutcome: (operationId, outcome) => {
        const followup = /^followup:(f_.+)$/.exec(operationId);
        if (followup) {
          this.ledger.followups.recordOutcome(followup[1]!, outcome);
          return;
        }
        const routine = /^routine:(r_.+):\d+$/.exec(operationId);
        if (routine) this.ledger.routines.recordOutcome(routine[1]!, outcome);
      },
    };
  }

  /**
   * The run that is *executing* right now (review #3): pi marks a submission `placed` while
   * an active run owns it, and PiHarness.pending() surfaces those as `running` — that, not
   * the oldest unsettled sh_run, is what tools are executing inside (a queued followUp starts
   * the moment the previous run answers, while sh_run only settles at the next 2s poll).
   * Falls back to the oldest open run between runs (passive entry writes, wake drains).
   *
   * The provenance (§7.1): a user run is its own message id; a verify run (#7) is authorized
   * by the user message it corrects (replyTo), so its provenance is `user:<msgId>` too.
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
      if (row) return this.runBindingOf(row);
    }
    const open = this.ledger.runs.openRows()[0];
    if (!open) return null;
    return this.runBindingOf(open);
  }

  private runBindingOf(row: RunRow): {
    operationId: string;
    kind: string;
    provenance: string;
    routedThreadId: string | null;
  } {
    const provenance = row.kind === "verify" && row.replyTo !== null ? `user:${row.replyTo}` : row.operationId;
    return { operationId: row.operationId, kind: row.kind, provenance, routedThreadId: row.routedThreadId };
  }

  /** Records that the *executing* run already produced user-facing output (review #9). */
  private async markRunNotified(): Promise<void> {
    const run = await this.currentRunBinding();
    if (run) this.sql`UPDATE sh_run SET notified = 1 WHERE operationId = ${run.operationId}`;
  }

  /** Issue #9: an intervention resolves the Thread this run's reply belongs to (same
   *  rationale as a dispatch, review #8) — the tool resolved the worker; the routing
   *  backfill never passes through model judgment (§3.1). */
  private async backfillRunThread(threadId: string): Promise<void> {
    const run = await this.currentRunBinding();
    if (run && run.routedThreadId === null) {
      this.sql`UPDATE sh_run SET routedThreadId = ${threadId} WHERE operationId = ${run.operationId} AND routedThreadId IS NULL`;
    }
  }

  private ownerOpenIdSync(): string | null {
    return this.sql<{ ownerOpenId: string | null }>`
      SELECT ownerOpenId FROM sh_channel WHERE channel = 'feishu'
    `[0]?.ownerOpenId ?? null;
  }

  /** The owner's message that authorizes answering a worker (§4.3/§7.2): null when the
   *  message never existed here or did not come from the bound owner. */
  private ownerMessageRef(msgId: string): string | null {
    return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'feishu' AND msgId = ${msgId} AND ownerAuthorized = 1`.length > 0
      ? `user:${msgId}`
      : null;
  }

  /** Whether the bound owner actually sent this message (answer_worker evidence, §4.3). */
  private async isOwnerMessage(msgId: string): Promise<boolean> {
    return this.ownerMessageRef(msgId) !== null;
  }

  /**
   * A user action that resolves a worker's open question (issue #10): a quote-reply to the
   * question's message or an option-button click on it. Atomically resolves ONE question —
   * never guessing between several workers on the same Thread — closes it, relays the answer
   * to the worker (`send`, after_current_tools semantics), and says so in chat. Returns null
   * when this action answers no worker question (the normal conversational path continues).
   * Throwing (caught by the callers) means: this WAS a worker-question answer, but it could
   * not be delivered — the user is told, the question stays open.
   */
  private async answerWorkerQuestion(input: { question: QuestionRow; answer: string; ref: string }): Promise<{
    workerId: string;
    delivery: string;
  } | null> {
    const { question, answer } = input;
    // Review finding 1, defense in depth: only the WORKER's own question (kind 'report') is
    // answered deterministically. Failure/unreported questions are the system asking the
    // user to decide — their replies belong to the steward, never to a broken/idle worker.
    if (question.kind !== "report") return null;
    const worker = question.workerId !== null ? this.ledger.workers.get(question.workerId) : null;
    if (worker === null) return null; // steward's own question: no worker to relay to
    const thread = question.threadId !== null ? this.ledger.threads.get(question.threadId) : null;
    // The owner's answer IS newsworthy on the Thread it belongs to.
    if (thread) this.ledger.timeline.add(thread.threadId, "user_instruction", `用户回答 worker 的问题：${answer}`, { qid: question.qid, workerId: worker.workerId, ref: input.ref });
    try {
      const outcome = await this.dispatcher.sendToWorker({
        workerId: worker.workerId,
        text: `（用户对你问题的回答）${answer}`,
        intent: "now",
        provenance: input.ref,
        cmdId: `answer:${question.qid}:${ulid()}`,
      });
      if (outcome.kind === "refused") throw new Error(outcome.reason);
      if (!this.ledger.questions.close(question.qid, answer)) {
        // Lost the race to ask-side handling: don't relay a second time.
        this.logChannel("question_answer_race", question.qid);
        return null;
      }
      const owner = this.ownerOpenIdSync();
      if (owner && thread) {
        await this.enqueueOutbound({
          id: `answer:${question.qid}`,
          kind: "text",
          to: owner,
          threadId: thread.threadId,
          text: `✅ 已把你的回答转给 ${worker.workerId}（${outcome.delivery === "steer" ? "不打断手头工具，当前批次结束后生效" : "按其状态尽快送达"}）。`,
        });
      }
      return { workerId: worker.workerId, delivery: outcome.delivery };
    } catch (err) {
      this.logChannel("answer_relay_failed", `${question.qid} ${errorText(err)}`);
      const owner = this.ownerOpenIdSync();
      if (owner && thread) {
        await this.enqueueOutbound({
          kind: "text",
          to: owner,
          threadId: thread.threadId,
          text: `⚠️ 回答没有送达 ${worker.workerId}（${errorText(err)}）。问题保持打开，稍后再试一次。`,
          urgency: "push",
        });
      }
      throw err;
    }
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
    // §5.3: the role query param routes/tags the connection; legitimacy is decided by the
    // credential — device token for connectors (onConnect), session cookie for browsers.
    if (new URL(ctx.request.url).searchParams.get("role") === "web") return ["web"];
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    return parsed ? [`dev:${parsed.deviceId}`] : [];
  }

  private sendError(connection: Connection, code: ErrorMessage["code"], message: string, re?: string): void {
    connection.send(JSON.stringify({ t: "error", re, code, message, retriable: false }));
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // Browser connections (§5.3 `web` role): authenticated by the session cookie the Worker
    // layer already HMAC-verified (index.ts onBeforeConnect); liveness stays a DB fact here.
    if (new URL(ctx.request.url).searchParams.get("role") === "web") {
      const raw = (ctx.request.headers.get("cookie") ?? "")
        .split(/;\s*/)
        .find((part) => part.startsWith("shepherd_session="))
        ?.slice("shepherd_session=".length) ?? null;
      const sid = await parseSessionCookie(
        [this.env.SERVER_KEY, this.env.SERVER_KEY_PREVIOUS].filter((k): k is string => typeof k === "string" && k.length > 0),
        raw,
      );
      if (!sid || !this.web.sessionAlive(sid)) {
        connection.close(CloseCode.UNAUTHORIZED, "unauthorized");
        return;
      }
      connection.setState({ role: "web", deviceId: "", epoch: 0, keyId: "" } satisfies ConnState);
      return;
    }
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
    this.rearmNoticeDrain(); // a recovery intent may now be counting down its debounce
  }

  onClose(connection: Connection): void {
    const state = connection.state as unknown as ConnState | null;
    if (!state) return;
    if (state.role === "web") {
      // §6.6 termination: the browser closing its connection ends every stream it opened.
      this.sql`DELETE FROM history_relay WHERE webConnId = ${connection.id}`;
      return;
    }
    if (!state.deviceId) return;
    // A superseded old connection closes after its replacement is live: only the last
    // connection for the device takes the machine offline.
    const remaining = [...this.getConnections<ConnState>(`dev:${state.deviceId}`)].filter((c) => c.id !== connection.id);
    if (remaining.length > 0) return; // superseded, not offline — its relays die with the
    // connector-side reset; the browser's silence watchdog ends the view.
    // The machine really went offline: every relay through it dies with the connection, and
    // each browser hears why (§6.6 machine_offline) instead of waiting out its own timeout.
    const orphaned = this.sql<{ reqId: string; webConnId: string }>`
      SELECT reqId, webConnId FROM history_relay WHERE deviceId = ${state.deviceId}
    `;
    for (const relay of orphaned) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${relay.reqId}`;
      this.getConnection(relay.webConnId)?.send(JSON.stringify({ t: "machine_offline", re: relay.reqId } satisfies MachineOfflineMessage));
    }
    this.ledger.machines.setOnline(state.deviceId, false);
    this.rearmNoticeDrain(); // the offline intents' 2-minute window starts here
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
    // §5.3 role fence: browsers only stream history; connectors do everything else. A
    // cross-role message is answered with forbidden and never reaches a handler.
    const state = connection.state as unknown as ConnState | null;
    const t = (message as { t?: unknown }).t;
    if (state?.role === "web") {
      switch (t) {
        case "history_open":
          this.handleHistoryOpen(connection, message);
          return;
        case "history_ack":
          this.handleHistoryAck(connection, message);
          return;
        default:
          this.sendError(connection, "forbidden", `message type ${JSON.stringify(t)} is not allowed on a web connection`);
          return;
      }
    }
    if (t === "history_open" || t === "history_ack") {
      // §5.3: browser-type messages on a connector connection.
      const id = (message as { id?: unknown }).id;
      this.sendError(
        connection,
        "forbidden",
        `message type ${JSON.stringify(t)} is not allowed on a connector connection`,
        typeof id === "string" ? id : undefined,
      );
      return;
    }
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
      case "history_chunk":
        this.handleHistoryChunk(connection, message);
        return;
      case "error":
        // A connector reply to something the DO itself sent. The only DO-originated requests
        // are history pulls (§6.6): relay a failure to the waiting browser and end its stream.
        this.relayHistoryError(connection, message);
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

  // ---- History relay (protocol §6.6, issue #23) ---------------------------------------------------
  // The DO is a pure pipe: ids and byte meters in SQLite, content only ever in memory
  // between the two sockets. Nothing here logs or persists entry text.

  /** browser → DO: resolve the worker, refuse offline machines, then ask the connector. */
  private handleHistoryOpen(connection: Connection, raw: unknown): void {
    const parsed = HistoryOpenMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(connection, "bad_request", "invalid history_open");
      return;
    }
    const open = parsed.data;
    const worker = this.ledger.workers.get(open.workerId);
    if (!worker) {
      this.sendError(connection, "not_found", `worker ${open.workerId} is unknown`, open.id);
      return;
    }
    const deviceConn = this.connFor(worker.deviceId);
    if (!deviceConn) {
      // §6.6: offline is answered directly — the transcript lives on that machine only.
      connection.send(JSON.stringify({ t: "machine_offline", re: open.id } satisfies MachineOfflineMessage));
      return;
    }
    const reqId = ulid();
    const maxBytes = Math.min(open.maxBytes ?? HISTORY_MAX_BYTES, HISTORY_MAX_BYTES);
    const now = Date.now();
    // One live stream per browser connection — a re-open supersedes the previous one.
    this.sql`DELETE FROM history_relay WHERE webConnId = ${connection.id}`;
    this.sql`
      INSERT INTO history_relay (reqId, webConnId, workerId, deviceId, maxBytes, sentBytes, expiresAt, createdAt)
      VALUES (${reqId}, ${connection.id}, ${open.workerId}, ${worker.deviceId}, ${maxBytes}, 0, ${now + this.historyRelayTtlMs}, ${now})
    `;
    void this.schedule(Math.max(1, Math.ceil(this.historyRelayTtlMs / 1000)), "sweepHistoryRelays");
    const req: HistoryReqMessage = {
      t: "history_req",
      id: reqId,
      workerId: open.workerId,
      maxBytes,
      ...(open.since ? { since: open.since } : {}),
    };
    deviceConn.send(JSON.stringify(req));
  }

  /** browser → DO → connector: the ack that slides the connector's window (§6.6 step 4). */
  private handleHistoryAck(connection: Connection, raw: unknown): void {
    const parsed = HistoryAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const relay = this.sql<{ webConnId: string; deviceId: string }>`
      SELECT webConnId, deviceId FROM history_relay WHERE reqId = ${parsed.data.re}
    `[0];
    // Unknown reqId (stream already finished) or another connection's stream: drop.
    if (!relay || relay.webConnId !== connection.id) return;
    this.connFor(relay.deviceId)?.send(JSON.stringify(parsed.data));
  }

  /** connector → DO → browser: forward one chunk, meter the bytes, end finished streams. */
  private handleHistoryChunk(connection: Connection, raw: unknown): void {
    const parsed = HistoryChunkMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const chunk = parsed.data;
    const relay = this.sql<{ webConnId: string; deviceId: string; maxBytes: number; sentBytes: number; cursor: string | null; expiresAt: number }>`
      SELECT webConnId, deviceId, maxBytes, sentBytes, cursor, expiresAt FROM history_relay WHERE reqId = ${chunk.re}
    `[0];
    if (!relay) return; // swept/timed out/done: nothing is waiting for this chunk
    // The relay belongs to one machine: only its connection's chunks travel on. reqIds are
    // unguessable ULIDs, so this is defense in depth against a confused connector, not auth.
    if ((connection.state as unknown as ConnState | null)?.deviceId !== relay.deviceId) return;
    if (relay.expiresAt <= Date.now()) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    const webConn = this.getConnection(relay.webConnId);
    if (!webConn) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    const bytes = jsonByteLength(raw);
    if (relay.sentBytes + bytes > relay.maxBytes) {
      // Defense in depth (the connector budgets maxBytes first): cut the stream here rather
      // than forward past the cap, and tell the browser it ended — continuing from the last
      // FORWARDED cursor, never the dropped chunk's (the browser never saw its entries).
      webConn.send(
        JSON.stringify({ t: "history_chunk", re: chunk.re, n: chunk.n, entries: [], cursor: relay.cursor, done: true, truncated: true }),
      );
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
      return;
    }
    webConn.send(JSON.stringify(chunk));
    if (chunk.done) {
      this.sql`DELETE FROM history_relay WHERE reqId = ${chunk.re}`;
    } else {
      this.sql`
        UPDATE history_relay SET sentBytes = ${relay.sentBytes + bytes}, cursor = ${chunk.cursor ?? null}
        WHERE reqId = ${chunk.re}
      `;
    }
  }

  /** A connector `error` replying to a history_req: forward the reason, end the stream. */
  private relayHistoryError(connection: Connection, raw: unknown): void {
    const re = (raw as { re?: unknown }).re;
    if (typeof re !== "string") return;
    const relay = this.sql<{ webConnId: string; deviceId: string }>`
      SELECT webConnId, deviceId FROM history_relay WHERE reqId = ${re}
    `[0];
    if (!relay) return; // not a history reply; nothing else to do with connector errors today
    if ((connection.state as unknown as ConnState | null)?.deviceId !== relay.deviceId) return;
    this.sql`DELETE FROM history_relay WHERE reqId = ${re}`;
    this.getConnection(relay.webConnId)?.send(JSON.stringify(raw));
  }

  /** Alarm-driven §6.6 termination: relays older than the TTL disappear, browser or not. */
  async sweepHistoryRelays(): Promise<void> {
    this.sql`DELETE FROM history_relay WHERE expiresAt <= ${Date.now()}`;
    const next = this.sql<{ m: number | null }>`SELECT MIN(expiresAt) AS m FROM history_relay`[0]?.m;
    if (typeof next === "number") {
      void this.schedule(Math.max(1, Math.ceil((next - Date.now()) / 1000)), "sweepHistoryRelays");
    }
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
    this.rearmNoticeDrain();
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
    // protocol §6.1: hello re-delivers every queued/sent command; "waited" start_workers
    // (their notAfter cleared by the owner's wait) are queued for exactly this moment.
    const before = new Set(
      this.sql<{ cmdId: string }>`
        SELECT cmdId FROM outbox WHERE deviceId = ${auth.deviceId} AND state = 'queued' AND kind = 'start_worker' AND held = 0 AND notAfter IS NULL
      `.map((r) => r.cmdId),
    );
    this.redeliverOutbox(auth.deviceId);
    this.queueWaitedStartNotices(auth.deviceId, before);
    // A reconnect is also the natural catch-up point for events persisted but not yet reduced
    // (crash between the events_ack and the reducer, protocol §4.3): drain, then notify.
    this.applyLedgerEvents();
    // Reconciliation against hello.workers (issue #12, connector-pi.md §9.1 step 4): with the
    // pending events drained first, the gate inside (lastSeq <= processedUpTo) means this only
    // fires for workers whose event stream cannot tell the story anymore. Timeline, no push.
    this.ledger.workers.reconcileFromSnapshot(auth.deviceId, hello.workers);
    // Review finding 4 (issue #10): a snapshot-only broken verdict (a caught-up inbox — the
    // exact case reconciliation exists for) queues a failure push and a wake that the
    // applied>0-gated drains above never see. Reconcile-side effects drain unconditionally.
    void this.drainNotifications();
    void this.drainWakes();
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

  /** The "runs on reconnect with a notice" half of protocol §7.3: a start_worker whose
   *  notAfter the owner's wait cleared was queued only for the machine's return — its
   *  delivery at this hello is exactly the promised moment, so the notice follows it out. */
  private queueWaitedStartNotices(deviceId: string, before: Set<string>): void {
    const delivered = this.sql<{ cmdId: string; workerId: string }>`
      SELECT cmdId, workerId FROM outbox WHERE deviceId = ${deviceId} AND state = 'sent' AND kind = 'start_worker' AND held = 0
    `;
    for (const row of delivered) {
      if (!before.has(row.cmdId)) continue;
      const worker = this.ledger.workers.get(row.workerId);
      if (!worker || worker.state !== "starting") continue;
      this.ledger.notifications.queue(`waited:${row.cmdId}`, "waited_started", worker.threadId, worker.workerId);
    }
    void this.drainNotifications();
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
    if (!row || !row.workerId) return;
    // A failed resume send (issue #8): revert the resume-pending `starting` back to idle —
    // the session itself is intact — and push the failure to the user.
    if (row.kind === "send" && this.ledger.workers.markResumeFailed(row.workerId, cmdId, reason)) {
      void this.drainNotifications();
      return;
    }
    if (row.kind !== "start_worker") return;
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
        // And a question window may have opened (§5.3, issue #10): the fallback alarm
        // follows the deadlines the reducer just wrote.
        void this.armQuestionFallback();
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

  /** F4 (PR #51 review): the debounce is a due date, not a timer promise — something must
   *  wake the DO at it, or an offline notice sits pending through the very outage it exists
   *  to report (and the reconnect then deletes it as healed). */
  private rearmNoticeDrain(): void {
    const at = this.sql<{ at: number | null }>`
      SELECT MIN(dueAt) AS at FROM sh_notify WHERE sentAt IS NULL AND dueAt IS NOT NULL
    `[0]?.at ?? null;
    if (at === null) return;
    void this.schedule(Math.max(1, Math.ceil((at - Date.now()) / 1000)), "drainNotifications");
  }

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
          // Its data is gone (thread archived / worker pruned), or the news evaporated (a
          // drop that healed inside the debounce window): remove the intent rather than
          // retry forever — and never count it as "the owner was told".
          this.ledger.notifications.drop(intent.id);
          continue;
        }
        const question = intent.questionId !== null ? this.ledger.questions.get(intent.questionId) : null;
        await this.enqueueOutbound({
          kind: "card",
          to: cfg.ownerOpenId,
          threadId: intent.threadId,
          questionId: question?.status === "open" && question.threadId !== null ? question.qid : null,
          card,
          urgency: "push",
        });
        this.ledger.notifications.markSent(intent.id);
      } catch (err) {
        this.logChannel("notify_drain_failed", `${intent.id} ${errorText(err)}`);
      }
    }
    this.rearmNoticeDrain(); // a still-debounced intent needs its own wake
  }

  /** Deterministic core templates (steward.md §6.2 source 1): data in, card out, no LLM. */
  private async renderNotification(intent: NotifyRow): Promise<unknown | null> {
    const worker = intent.workerId ? this.ledger.workers.get(intent.workerId) : null;
    const thread = this.ledger.threads.get(intent.threadId);
    if (!worker || !thread) return null;
    const machine = this.ledger.machines.get(worker.deviceId);
    const machineName = machine?.name ?? worker.deviceId;
    // Review note (c): only cards bound to an open REPORT-kind question teach the answer
    // path (that is the deterministic relay); failure/unreported replies go to the steward,
    // and a done report keeps the plain continuation footer (there is nothing to answer).
    const boundQuestion = intent.questionId !== null ? this.ledger.questions.get(intent.questionId) : null;
    const asksQuestion = boundQuestion !== null && boundQuestion.kind === "report" && boundQuestion.status === "open" && boundQuestion.threadId !== null;
    const footer = asksQuestion
      ? `Thread「${thread.title}」 · ${worker.agent} @ ${machineName} · 引用回复这个卡片即可回答它`
      : `Thread「${thread.title}」 · ${worker.agent} @ ${machineName} · 引用回复可继续这个 Thread`;
    // steward.md §6.4: the timeline link is appended by the system — a fresh one-time link
    // per card, never by the (M2) LLM.
    const detailsUrl = await this.web.linkUrl(linkTargetForThread(thread.threadId));

    // Machine status (issue #14, steward.md §5.3): only when in-flight work is affected,
    // debounced two minutes — and the drop only counts if the worker is still unreachable
    // when the window closes (a blip that healed produces no notice at all).
    if (intent.kind === "machine_offline") {
      if (!worker.unreachable) return null;
      return machineOfflineCard(machineName, thread.title, footer);
    }
    if (intent.kind === "machine_online") {
      // "X is back" only when the owner heard about THIS outage: the offline intent paired
      // to this transition (dedupeKey machine:<dev>:<T>:on:<worker> ← machine:<dev>:<T-1>:off:<worker>)
      // must have actually been sent. A sub-debounce blip's offline intent was dropped as
      // healed, so its recovery stays quiet too — and a later blip cannot ride an earlier
      // outage's notice (PR #51 review finding 7).
      const paired = /^machine:([^:]+):(\d+):on:(.+)$/.exec(intent.dedupeKey);
      const offlineKey = paired ? `machine:${paired[1]}:${Number(paired[2]) - 1}:off:${paired[3]}` : null;
      const announced =
        offlineKey === null
          ? 0
          : this.sql<{ n: number }>`
              SELECT COUNT(*) AS n FROM sh_notify WHERE dedupeKey = ${offlineKey} AND sentAt IS NOT NULL
            `[0]!.n;
      if (announced === 0) return null;
      const outcome =
        worker.state === "running" || worker.state === "recovering"
          ? "已恢复运行"
          : worker.state === "starting" || worker.state === "queued"
            ? "仍在排队/启动中"
            : worker.state === "lost" || worker.state === "broken"
              ? "未恢复（见时间线）"
              : "已结束，结果已对账";
      return machineOnlineCard(machineName, thread.title, outcome, footer);
    }
    if (intent.kind === "waited_started") {
      return waitedStartCard(machineName, thread.title, footer, detailsUrl ?? undefined);
    }

    if (intent.kind === "done_report") {
      const report = this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      if (!report) return null;
      return reportCardFor(report, worker, machineName, thread.title, detailsUrl ?? undefined);
    }

    // §5.3 (issue #10): a blocked/needs_decision question that nothing handled within the
    // window — the worker's question reaches the user verbatim, from data, with no LLM.
    // settle:transient never gets here (it queues no question and no intent); error/unreported
    // classes have their own failure_push rendering below.
    if (intent.kind === "attention_report" && intent.questionId !== null) {
      const question = this.ledger.questions.get(intent.questionId);
      if (!question) return null;
      const report = this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      return workerQuestionCard({
        question: question.text,
        ...(report?.summary ? { summary: report.summary } : {}),
        ...(report?.changes?.length ? { did: didBullets(report) } : {}),
        threadTitle: thread.title,
        footer,
        detailsUrl: detailsUrl ?? undefined,
      });
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
    if (worker.lastOutcome?.startsWith("resume_failed:")) {
      return failureCard(
        `接续原会话失败`,
        `${worker.lastOutcome.slice("resume_failed:".length)}。原会话未受影响，重新说一次要做什么即可。`,
        thread.title,
        footer,
        detailsUrl ?? undefined,
      );
    }
    const needsYou =
      boundQuestion?.status === "open" && boundQuestion.text.trim().length > 0
        ? boundQuestion.text
        : "查看 Thread 时间线了解详情。";
    if (worker.lastOutcome?.startsWith("start_failed:")) {
      return failureCard(`派发失败：任务没有开始`, `${worker.lastOutcome.slice("start_failed:".length)}。重新说一次要做什么即可。`, thread.title, footer, detailsUrl ?? undefined);
    }
    return failureCard(worker.lastOutcome === "unreported" ? "运行结束但没有汇报" : "运行出错，需要你决定下一步", needsYou, thread.title, footer, detailsUrl ?? undefined);
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
    opts: { workerId?: string; notAfter?: number | null; ackTimeoutMs?: number; cmdId?: string; held?: boolean } = {},
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
      INSERT INTO outbox (cmdId, deviceId, workerId, cseq, kind, payload, notAfter, held, state, createdAt)
      VALUES (${cmdId}, ${deviceId}, ${opts.workerId ?? null}, ${cseq}, ${kind}, ${JSON.stringify(args ?? {})}, ${notAfter}, ${opts.held ? 1 : 0}, 'queued', ${Date.now()})
    `;
    // A dispatch registers the worker before enqueueing: the moment the row exists, the
    // maintenance alarm (stall notice + reap) must be armed (issue #13).
    this.armWorkerSweeps();
    if (opts.held && notAfter !== null) {
      // Nothing will ever try to deliver a held row while the machine is away, so its own
      // notAfter lapse needs the alarm armed here (PR #51 review finding 2): sweepIdle
      // marks the row failed/not_after at the deadline, and sweepWorkers (armed by the
      // enqueue above, the worker is `starting`) closes the worker with a push.
      void this.schedule(Math.max(1, Math.ceil((notAfter - Date.now()) / 1000)) + 1, "sweepIdle");
    }
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
      held: number;
      state: string;
    }>`
      SELECT deviceId, workerId, cseq, kind, payload, notAfter, held, state FROM outbox WHERE cmdId = ${cmdId}
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
    // An offline ask is still open (protocol §7.3): the command must not slip out at a
    // reconnect before the owner answers. Lapsed rows were already marked above — the hold
    // never outlives its own delivery window.
    if (row.held) return false;
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
    const nowMs = Date.now();
    // notAfter enforcement while offline (protocol §4.2, PR #51 review finding 2): deliver()
    // marks lapsed rows when something attempts them, but a HELD row is never attempted
    // while the machine is away — this pass is the only writer it will see. It writes the
    // same terminal `failed/not_after` deliver() would (never `expired`: that is the
    // user's withdrawal state); sweepWorkers then closes the `starting` worker with a push.
    const lapsed = this.sql<{ cmdId: string }>`
      SELECT cmdId FROM outbox
      WHERE state = 'queued' AND notAfter IS NOT NULL AND notAfter <= ${nowMs}
    `;
    for (const row of lapsed) {
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'not_after' WHERE cmdId = ${row.cmdId} AND state = 'queued'`;
    }
    const cutoff = nowMs - IDLE_FAIL_MS;
    const stale = this.sql<{ cmdId: string }>`SELECT cmdId FROM outbox WHERE state = 'queued' AND createdAt <= ${cutoff} AND held = 0`;
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
   * sweepWorkers re-arms itself and lets the alarm lapse once nothing is active. `queued`
   * counts as active (PR #46 review round 3, finding 1): a queued worker's ONLY closure is
   * the sweep's measured-offline reap, so an arming count that skips it would let the chain
   * die and wedge exactly the shape the sweep exists to close. */
  private armWorkerSweeps(): void {
    const active = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sh_worker WHERE state IN ('queued', 'starting', 'running', 'recovering')
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
        if (worker.state === "queued") {
          // A serial-queue park (issue #16): silent BY DESIGN while the slot is held — a long
          // task ahead may legitimately hold it for hours, so no silence clock (neither stall
          // notice nor the 45-min reap) may ever touch it. Only the machine measurably
          // disappearing closes it, with the same 10-min offline clock running workers use;
          // a reconnecting connector re-arms its queue and the `started` event resurrects.
          if (!worker.machineOnline && now - worker.machineLastSeen >= this.reapOfflineMs) {
            if (this.ledger.workers.reapWorker(worker.workerId, false)) reaped += 1;
          }
          continue;
        }
        if (worker.state === "starting") {
          const cmdId = worker.cmdId;
          const cmd = cmdId ? this.commandState(cmdId) : null;
          // A resume-pending worker (issue #8): its cmdId points at the resume SEND, not a
          // start_worker — markResumePending overwrote it. The session underneath is intact,
          // so a failed/expired send must revert the worker to idle (never `broken`, never a
          // "派发失败" push): the next dispatch can resume or re-dispatch freely. Without this
          // routing the sweep would treat every failed resume send as a failed start (PR #54
          // review, blocker 3) and break a healthy session.
          if (cmd?.kind === "send") {
            if (cmd.state === "failed") {
              if (this.ledger.workers.markResumeFailed(worker.workerId, cmdId!, this.startFailureText(cmd))) reaped += 1;
              continue;
            }
            if (cmd.state === "expired") {
              // The dispatcher's cancel normally settled it already; the sweep is the backstop.
              if (this.ledger.workers.markResumeCancelled(worker.workerId, cmdId!)) reaped += 1;
              continue;
            }
            if (cmd.state === "queued" || cmd.state === "sent") {
              // Still deliverable — the same wait-online rule as starts.
              continue;
            }
            // done/accepted/ambiguous: the send may have reached the machine without an
            // event ever landing — fall through to the horizon logic below, whose quiet
            // lost+reaped is safe for a session worker too (a live event resurrects).
          }
          if (cmd && cmd.kind !== "send" && (cmd.state === "failed" || cmd.state === "expired")) {
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
  private commandState(cmdId: string): { state: string; failReason: string | null; kind: string } | null {
    return this.sql<{ state: string; failReason: string | null; kind: string }>`
      SELECT state, failReason, kind FROM outbox WHERE cmdId = ${cmdId}
    `[0] ?? null;
  }

  // ---- Worker questions: the §5.3 window, its fallback, and answer_worker (issue #10) ----

  /** Arms the fallback alarm while any unhandled question is inside its window (§5.3).
   *  Cancel-then-schedule (the pollRuns/drainWakes pattern, review #1): an idempotent insert
   *  alone would dedup onto an already-pending LATER row, so a shrunken window (or a new,
   *  earlier deadline) could never pull the alarm in. */
  private questionFallbackScheduleId: string | undefined;

  private async armQuestionFallback(): Promise<void> {
    const next = this.ledger.questions.nextFallback();
    if (next === null) return;
    if (this.questionFallbackScheduleId !== undefined) {
      await this.cancelSchedule(this.questionFallbackScheduleId).catch(() => {});
      this.questionFallbackScheduleId = undefined;
    }
    const scheduled = await this.schedule(Math.max(1, Math.ceil((next - Date.now()) / 1000)), "sweepQuestionFallback", undefined, {
      idempotent: true,
    }).catch(() => undefined);
    this.questionFallbackScheduleId = scheduled?.id;
  }

  /**
   * The §5.3 fallback pass: questions whose window expired unhandled become a deterministic
   * attention_report intent — rendered and pushed by drainNotifications straight from the
   * ledger (worker's question verbatim), with no LLM anywhere on the path. Re-arms while any
   * question remains unhandled. Safe under DO resets and concurrent alarms: the deadline is
   * persisted on the question row and queueFallbacks is idempotent. The drain is
   * UNCONDITIONAL (review finding 3): a restart between queueFallbacks and the delivery pass
   * leaves the question handled — so `forwarded` alone can no longer be the trigger — and
   * with no unhandled questions left, armQuestionFallback would not even re-arm the sweep.
   * Pending intents are idempotent rows; an extra drain pass is always safe.
   */
  async sweepQuestionFallback(): Promise<{ forwarded: number }> {
    let forwarded = 0;
    try {
      const pending = this.ledger.questions.unhandled();
      this.ledger.questions.queueFallbacks();
      forwarded = this.ledger.notifications.pending().filter((n) => n.questionId !== null && pending.some((q) => q.qid === n.questionId)).length;
    } catch (err) {
      this.logChannel("question_fallback_failed", errorText(err));
    } finally {
      void this.drainNotifications();
      void this.armQuestionFallback();
    }
    return { forwarded };
  }

  /**
   * The steward's `answer_worker` landing (steward.md §4.3, issue #10): the steward answered a
   * worker's factual question itself. Deterministic here: close exactly the named question,
   * relay the text to the worker (`send`), and — only after a successful enqueue — cancel the
   * fallback (markHandled) so the core never also forwards the now-answered question to the
   * user. A refusal/failure is reported back as an error the model sees.
   */
  async answerWorker(input: {
    workerId: string;
    questionId: string;
    text: string;
    provenance: string;
    cmdId: string;
  }): Promise<{ kind: "answered"; delivery: string; threadId: string } | { kind: "refused"; reason: string }> {
    const worker = this.ledger.workers.get(input.workerId);
    if (!worker) return { kind: "refused", reason: `worker ${input.workerId} 不存在。` };
    const question = this.ledger.questions.get(input.questionId);
    if (!question || question.status !== "open" || question.workerId !== input.workerId) {
      return { kind: "refused", reason: `问题 ${input.questionId} 不存在、已回答或不属于 worker ${input.workerId}。` };
    }
    if (question.kind === "failure" || question.kind === "unreported") {
      return {
        kind: "refused",
        reason:
          question.kind === "unreported"
            ? "这个问题是「没有产出汇报」——需要你按最后的原话分类（notify_user 带 questionId）或转问用户，不能对 worker 回答。"
            : "这个问题是运行失败（凭据/上下文/损坏），不是 worker 的提问——请转问用户（ask_user 带 questionId）。",
      };
    }
    try {
      const outcome = await this.dispatcher.sendToWorker({
        workerId: worker.workerId,
        text: `（总管对你问题的回答，依据见下）${input.text}`,
        intent: "now",
        provenance: input.provenance,
        cmdId: input.cmdId,
      });
      if (outcome.kind === "refused") return { kind: "refused", reason: outcome.reason };
      if (!this.ledger.questions.close(question.qid, `总管代答：${input.text.slice(0, 160)}`)) {
        return { kind: "refused", reason: "问题刚刚被回答了（可能是用户）。不要重复发送。" };
      }
      return { kind: "answered", delivery: outcome.delivery, threadId: worker.threadId };
    } catch (err) {
      this.logChannel("answer_worker_failed", `${input.questionId} ${errorText(err)}`);
      return { kind: "refused", reason: `发送失败：${errorText(err)}` };
    }
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
    const owner = cfg.ownerOpenId;
    const ownerAuthorized =
      owner !== null &&
      ((parsed.kind === "message" && parsed.chatType === "p2p" && parsed.senderId === owner) ||
        (parsed.kind === "card_action" && parsed.operatorId === owner));
    this.sql`
      INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized)
      VALUES ('feishu', ${parsed.msgId}, ${parsed.eventId}, ${parsed.eventType}, ${Date.now()}, ${ownerAuthorized ? 1 : 0})
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

  /** A user message becomes one steward input, idempotent on the msgId (steward.md §9.1/§11).
   * `prefilledNote`/`routedThreadId` serve the ask-card clicks (#7): the click's choice is
   * submitted as a system-noted user action already routed to the picked Thread. */
  private async submitUserMessage(
    input: { msgId: string; text: string; parentId?: string; prefilledNote?: string; routedThreadId?: string | null },
  ): Promise<void> {
    const operationId = `user:${input.msgId}`;
    // Signal 1 (§3.1): a quote of one of our messages routes to that Thread directly.
    const routedRow = input.parentId ? this.ledger.outbound.rowForProviderMsg(input.parentId) : null;
    const routed = routedRow?.threadId ?? null;
    const routedThread = routed ? this.ledger.threads.get(routed) : null;
    if (routedThread) {
      this.ledger.threads.markRead(routedThread.threadId); // a reply means the report was seen (§6.5)
      // Review #7: a reply routed to a Thread with an open question IS the answer — close it
      // (the deterministic path only closed on re-dispatch, leaving waiting_you stuck when
      // the user e.g. answered "算了"). The steward sees the closed state in the next brief.
      // Issue #10 (review findings 1-2): the deterministic worker relay applies ONLY to the
      // quoted card's OWN bound question, and only when the WORKER asked it (kind 'report').
      // A failure/unreported question is the system asking the user to decide — the reply
      // must reach the steward (it can re-dispatch; relaying into a broken worker is refused,
      // and into an error:context worker would prompt the same overflowing session). And a
      // card whose question is already answered must never resolve a DIFFERENT, later open
      // question on the Thread — that guess is exactly what the binding exists to prevent.
      const quotedQuestion = routedRow?.questionId !== null && routedRow?.questionId !== undefined ? this.ledger.questions.get(routedRow.questionId) : null;
      if (quotedQuestion?.status === "open" && quotedQuestion.workerId !== null && quotedQuestion.kind === "report") {
        const ref = this.ownerMessageRef(input.msgId);
        if (ref !== null) {
          try {
            await this.answerWorkerQuestion({ question: quotedQuestion, answer: input.text, ref });
            return; // delivered to the worker; no LLM run for this message
          } catch {
            return; // the failure was already told to the user; the question stays open
          }
        }
        // Not a (recorded) owner message — e.g. a card click replayed as text: fall through
        // to the steward run, closing the question as before.
      }
      this.ledger.questions.closeOpen(routedThread.threadId, "用户回复了提问");
    }
    // Content markers (§4.2): user text is escaped so it can never mimic a ⟦…⟧ system input;
    // the routing note is prefixed as clearly-marked system metadata (never the ⟦ form, so
    // the input still reads as user-originated).
    const escaped = escapeMarkers(input.text);
    const note =
      input.prefilledNote !== undefined
        ? input.prefilledNote
        : routedThread
          ? `（系统注：这条消息是对 Thread「${escapeMarkers(routedThread.title)}」（${routedThread.threadId}）消息的回复，已确定归属该 Thread。）\n`
          : "";
    const text = `${note}${escaped}`;
    const routedId = input.routedThreadId ?? routedThread?.threadId ?? null;
    if (!this.ledger.runs.open(operationId, "user", text, { replyTo: input.msgId, channel: "feishu", routedThreadId: routedId })) {
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
        // Issue #28: bring the counter current before the over-budget note reads it — the
        // run that just settled is the spend that may tip today over the cap.
        await this.syncUsageQuietly();
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
    // §8.6: every fire leaves a result. An explicit in-run outcome (no_action) was recorded
    // during the run; the settle summary is the fallback for everything else.
    this.recordSettledProactiveOutcome(run, result);
    if (run.kind === "user") {
      const owner = this.ownerOpenIdSync();
      const hasText = Boolean(result.text && result.text.trim().length > 0);
      // spec §10.3 (issue #18): every memory ChangeReport rides on the next reply —
      // deterministic, so "remembered: …" reaches the user even if the model never says it.
      // Ordering (review finding 4): the relay is RENDERED here but marked reported only
      // after the reply row is durably enqueued — a crash in the remaining window costs at
      // most a duplicate announcement (the outbound queue owns delivery retries), never a
      // silent one. `upTo` bounds the marking: a change landing between render and mark
      // stays pending and rides the reply after it.
      const relay = this.ledger.notes.renderPendingForReply();
      // Issue #28 (steward.md §12 "with the budget state noted"): over the cap, a one-line
      // notice rides exactly ONE reply per day — same durability discipline as the relay
      // (rendered here, marked only after the reply row is durably enqueued; a crash in the
      // window costs a duplicate line at worst, never a lost one). Null when under budget or
      // already noted today, so normal days never see it.
      const budgetNote = this.pendingBudgetNote();
      const withRelay = (text: string): string =>
        [text, ...(relay.text === "" ? [] : [relay.text]), ...(budgetNote === null ? [] : [budgetNote.text])].join("\n");
      // Review #9: a `done` run with no final text is legitimate when the model already
      // produced user-facing output (ask_user terminates the turn right after its push;
      // notify_user cards went out mid-run). Only a silent empty answer is treated as a
      // failure the user must hear about.
      const alreadyNotified = Boolean(run.notified);
      const reply = async (text: string): Promise<void> => {
        // §6.2 source 3: the final text of a user-triggered run IS the reply. The outbound
        // id is keyed to the run (review #6): concurrent polls and interrupted settle windows
        // converge on one message. The enqueue's insert is synchronous inside the call, so
        // once it returns the announcement cannot be lost; only then is the relay marked.
        try {
          const { id } = await this.enqueueOutbound({
            id: `reply:${run.operationId}`,
            kind: "text",
            to: owner!,
            text,
            threadId: run.routedThreadId,
            urgency: "push",
          });
          this.ledger.notes.markPendingReported(relay.upTo);
          if (budgetNote !== null) this.ledger.budget.markNoted(budgetNote.day);
          this.ledger.runs.settle(run.operationId, result, id);
        } catch (err) {
          // Nothing durable went out: the run stays open and the next poll retries, with the
          // relay still pending — the announcement is never silently consumed.
          this.logChannel("reply_enqueue_failed", `${run.operationId} ${errorText(err)}`);
        }
      };
      if (owner && result.status === "done" && hasText) {
        // §6.2 source 3: the final text of a user-triggered run IS the reply; the notes
        // module's pending ChangeReport rides on it (spec §10.3), and the outbound id is
        // keyed to the run (review #6) so concurrent polls and interrupted settle windows
        // converge on one message.
        void reply(withRelay(result.text!));
        // Settle-time dispatch verification (issue #7, spike-conclusions §2): the reply
        // claims a dispatch but dispatchCount says none happened — a corrective follow-up
        // makes the steward actually dispatch or visibly correct itself. The claim phrase
        // set is the spike's (zero false positives observed there); it is tested on the
        // raw final text, not the notes-relay rendering appended to the reply.
        if (run.dispatchCount === 0 && claimsDispatch(result.text!)) {
          void this.queueVerifyRun(run, result.text!);
        }
        return;
      }
      if (owner && result.status !== "done") {
        // No template exists for user replies; a one-line notice beats silence (the budget
        // cap and its degradation behavior are #28's to refine).
        void reply(withRelay("⚠️ 总管这轮没有跑成（模型调用失败或被中断），这条消息我没能处理；稍后再试或重发一次。"));
        return;
      }
      if (owner && result.status === "done" && !hasText && !alreadyNotified) {
        // Review #9: done, empty, and nothing reached the user — say so instead of silence.
        void reply(withRelay("⚠️ 总管这轮没有给出回复（可能只调用了内部工具）；需要的话再说一次。"));
        return;
      }

    }
    // Event/routine/follow-up runs, and user runs that already reached the user: the text is
    // kept for audit and nothing more is sent (§6.2).
    this.ledger.runs.settle(run.operationId, result);
  }

  /** The over-budget notice when it has not ridden a reply yet today; null otherwise. */
  private pendingBudgetNote(): (BudgetState & { text: string }) | null {
    const state = this.budgetState();
    if (!state.over || state.overNotedAt !== null) return null;
    return { ...state, text: renderOverBudgetNote(state) };
  }

  /** The settle-time lastResult for routine/follow-up runs (§8.6), when none was recorded. */
  private recordSettledProactiveOutcome(run: RunRow, result: { status: string; reason?: string; text?: string }): void {
    const summary =
      `${result.status}${result.reason !== undefined && result.reason !== null ? `:${result.reason}` : ""}` +
      (result.text && result.text.trim().length > 0 ? ` — ${result.text.trim().slice(0, 140)}` : "");
    const followup = /^followup:(f_.+)$/.exec(run.operationId);
    if (followup) {
      this.ledger.followups.recordOutcome(followup[1]!, summary);
      return;
    }
    const routine = /^routine:(r_.+):\d+$/.exec(run.operationId);
    if (routine) this.ledger.routines.recordOutcome(routine[1]!, summary);
  }

  /**
   * The corrective ⟦verify⟧ follow-up (issue #7): submitted with whenBusy=followUp so it runs
   * right after the flawed reply; its kind carries the original user message as replyTo, so
   * start_worker inside it is authorized by that message (§7.1) without a provenanceRef.
   * routedThreadId rides along too (review #48 finding 2): a corrective attach to the
   * quote-routed thread is then explicit for the confidence gate — without the copy the
   * verify run would hit the very gate the original run passed, and the wake text's “现在
   * 真正调用 start_worker” could never succeed.
   */
  private async queueVerifyRun(run: RunRow, claimed: string): Promise<void> {
    const operationId = `verify:${run.operationId}`;
    const text = verifyWakeText(claimed);
    if (!this.ledger.runs.open(operationId, "verify", text, { replyTo: run.replyTo ?? undefined, channel: run.channel ?? undefined, routedThreadId: run.routedThreadId })) {
      return; // already queued by a racing poll
    }
    this.logChannel("verify_dispatch_claim", `${run.operationId} "${claimed.slice(0, 80)}"`);
    try {
      await this.ensureRootModel();
      await this.piHarness.submit(text, { operationId, whenBusy: "followUp" });
    } catch (err) {
      this.logChannel("submit_failed", `${operationId} ${errorText(err)}`);
      // Row stays open: the poll's not_found path resubmits (§11).
    }
    void this.pollRuns();
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
      // The budget gate (issue #28, steward.md §12): today's spend has reached the cap →
      // event/routine/follow-up wakes are skipped, not submitted — while their deterministic
      // halves (done cards, fallback pushes, digest routines) already ran and never depended
      // on the model. The counter syncs first (a failed read degrades to the last honest
      // number rather than skipping the drain) and a single check before the loop is the
      // boundary: wakes submitted in one drain may overshoot the cap by the batch's spend,
      // and the next drain stops — the soft cap bounds a runaway, it is not a prepaid meter.
      const due = this.ledger.wakes.due(Date.now());
      if (due.length > 0) await this.syncUsageQuietly();
      const budget = this.budgetState();
      for (const wake of due) {
        if (budget.over) {
          this.skipWake(wake, budget);
          continue;
        }
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

  /** One wake the cap kept from the model: skip it, count it, leave every audit trail (§8.6). */
  private skipWake(wake: WakeRow, budget: BudgetState): void {
    this.ledger.wakes.markSkipped(wake.id);
    this.ledger.budget.recordSkip();
    this.logChannel(
      "budget_skip_wake",
      `${wake.operationId} kind=${wake.kind} spent=${formatUsd(budget.costUsd)} cap=${formatUsd(budget.budgetUsd)}`,
    );
    const reason = `skipped:超出每日预算（${formatUsd(budget.costUsd)} / ${formatUsd(budget.budgetUsd)}，${budget.day} 00:00 UTC 重置）`;
    // A fire's row owns an outcome either way (§8.6): list_schedules shows the skip instead
    // of a stale "已交给总管执行", and the timeline says the fire never reached the model.
    const routine = /^routine:(r_.+):\d+$/.exec(wake.operationId);
    if (routine) {
      const row = this.ledger.routines.get(routine[1]!);
      this.ledger.routines.recordOutcome(routine[1]!, reason);
      this.ledger.timeline.add(row?.threadId ?? null, "routine", `例行任务 ${routine[1]!} 触发：超出每日预算，未唤醒总管`, {
        routineId: routine[1]!,
        operationId: wake.operationId,
      });
      return;
    }
    const followup = /^followup:(f_.+)$/.exec(wake.operationId);
    if (followup) {
      const row = this.ledger.followups.get(followup[1]!);
      this.ledger.followups.recordOutcome(followup[1]!, reason);
      this.ledger.timeline.add(row?.threadId ?? null, "followup", `定时回看 ${followup[1]!} 到期：超出每日预算，未唤醒总管`, {
        followupId: followup[1]!,
      });
    }
  }

  /**
   * The notes lifecycle pass (issues #18/#19, steward.md §2.5): 60-day project demotions,
   * 90-day resident demotion *suggestions* (never automatic — resident entries have broad
   *  impact), the capacity backstop, and the pressure record left by a commit that ignored
   * `needsEviction` (evict lowest-score first, then write — reported in both cases). All
   *  deterministic; every result lands in sh_note_log. Afterwards, this pass delivers what
   *  accumulated since the owner's last reply: one bookkeeping message, and an archive-or-
   *  keep card per open suggestion (spec §10.2/§10.3 — the ask must actually reach the
   *  owner, not wait silently for the next conversation).
   */
  async notesMaintenance(_payload?: unknown): Promise<void> {
    try {
      this.ledger.notes.maintenance(Date.now());
    } catch (err) {
      this.logChannel("notes_maintenance_failed", errorText(err));
      return;
    }
    await this.deliverNotesChanges().catch((err) => this.logChannel("notes_changes_failed", errorText(err)));
  }

  /** Delivers ONE bounded batch of the pending maintenance-classed note changes (PR #53
   *  review finding 7: the loop used to drain everything — 118 stale notes meant 118 push
   *  cards in a single invocation; same-vintage notes go stale together, so the burst is
   *  reachable without artificial seeding). One quiet bookkeeping text for the batch's
   *  informational rows plus one push card per still-open suggestion; the rest stays
   *  pending for the next pass or the next reply — never dropped, never a burst. Durable
   *  and idempotent: stable outbound ids, marked only in this delivery class. */
  private async deliverNotesChanges(): Promise<void> {
    const owner = this.ownerOpenIdSync();
    if (owner === null) return; // nobody to tell yet: rows stay pending for the first reply
    const batch = this.ledger.notes.pendingMaintenance();
    if (batch.length === 0) return;
    // Finding 8: a suggestion whose note sank since the pass (an eviction at commit time,
    // an owner archive on another card) gets no card — the ask settles as gone instead of
    // asking the owner to keep something that no longer exists.
    const actionable: typeof batch = [];
    for (const item of batch) {
      if (item.op !== "suggest_demote" || item.noteId === null) continue;
      const note = this.ledger.notes.get(item.noteId);
      if (note && note.status === "active" && note.layer === "resident") actionable.push(item);
      else this.ledger.notes.abandonAsk(item.id, item.noteId);
    }
    const bookkeeping = batch.filter((p) => p.op !== "suggest_demote");
    if (bookkeeping.length > 0) {
      await this.enqueueOutbound({
        id: `notechg:${bookkeeping[bookkeeping.length - 1]!.id}`,
        kind: "text",
        to: owner,
        urgency: "quiet",
        text: renderChangeReports(bookkeeping.map((p) => ({ op: p.op, noteId: p.noteId ?? "", text: p.text, reason: p.reason }))),
      });
    }
    for (const item of actionable) {
      await this.enqueueOutbound({
        id: `noteask:${item.noteId}:${item.id}`,
        kind: "card",
        to: owner,
        card: noteDecisionCard({ noteId: item.noteId!, text: item.text }),
        urgency: "push",
      });
    }
    this.ledger.notes.markPendingMaintenanceReported(batch[batch.length - 1]!.id);
  }

  // Card button callbacks (issue #5): the Thread is resolved from the card's providerMsgId —
  // never from data stuffed into the button (steward.md §3.1, spike bug list). The ask-card
  // buttons (#7) are answered here instead: the click closes its question and routes back
  // into the steward as a user action with basis=user_reply_to.
  private async dispatchCardAction(ev: InboundEvent, ownerOpenId: string | null): Promise<void> {
    if (ownerOpenId === null || !ev.operatorId || !ev.cardMsgId) {
      this.logChannel("ignored_card_no_owner", `${ev.eventId}`);
      return;
    }
    if (ev.operatorId !== ownerOpenId) {
      this.logChannel("ignored_card_not_owner", `${ev.operatorId} ${ev.eventId}`);
      return;
    }
    const action = ev.action ?? "";
    if (action.startsWith("ask:") || action.startsWith("asknew:")) {
      await this.handleAskCardAction(ev, action, ev.cardMsgId);
      return;
    }
    if (action === "note_archive" || action === "note_keep") {
      await this.handleNoteDecisionCard(action, ev.cardMsgId, ownerOpenId);
      return;
    }
    await this.dispatcher.handleCardAction({ operatorId: ev.operatorId, action, cardMsgId: ev.cardMsgId });
  }

  /**
   * A resident-note suggestion card's button (issue #19, spec §10.2): the outbound row id
   * is `noteask:<noteId>:<logId>` — resolved via providerMsgId, never button data (the
   * §3.1 rule). The tap is the owner's own decision; the module keeps its invariants
   * (archive is refused on a pinned note; the state settles the ask either way).
   */
  private async handleNoteDecisionCard(action: string, cardMsgId: string, ownerOpenId: string): Promise<void> {
    const row = this.ledger.outbound.rowForProviderMsg(cardMsgId);
    const ask = row !== null && row.id.startsWith("noteask:") ? /^noteask:(n_[^:]+):(\d+)$/.exec(row.id) : null;
    let reply: string;
    if (!ask) {
      reply = "这张记忆卡片已失效（没有待决定的建议）。";
    } else {
      const [, noteId, logIdRaw] = ask;
      if (action === "note_archive") {
        const note = this.ledger.notes.get(noteId!);
        if (!note || note.status !== "active" || note.layer !== "resident") {
          reply = "这条建议已处理过（或记忆已不在常驻层）。";
        } else if (note.pinned) {
          reply = "这条记忆已置顶，不会自动腾挪；先取消置顶才能归档。";
        } else {
          this.ledger.notes.demote(noteId!, Number(logIdRaw), "note_archive");
          reply = "已归档；需要时可随时搜索找回。";
        }
      } else {
        // note_keep: the 90-day clock restarts (a renewal, not a pin — the pin exemption is
        // the owner's explicit call); a later maintenance pass may re-ask after another 90d.
        // A note sunk since the card went out cannot be kept — say so instead of promising
        // a renewal that will never fire (PR #53 review finding 8); the ask settles either way.
        const kept = this.ledger.notes.renew(noteId!, Number(logIdRaw));
        reply = kept.ok
          ? "好的，保留这条记忆；90 天未再提及会再问你一次。"
          : "这条记忆已经不在常驻层了（可能已被归档或腾挪），无需保留。";
      }
    }
    await this.enqueueOutbound({ kind: "text", to: ownerOpenId, text: reply });
  }

  /**
   * An ask-card button click (#7, steward.md §9.1): the action string is `ask:<qid>:<idx>`
   * (a candidate or plain option) or `asknew:<qid>`. The click closes the question, then
   * becomes one steward input — a routing candidate submits already-routed to that Thread
   * (basis=user_reply_to; start_worker attaches without further confidence), 「新开一件事」
   * submits unrouted, and a plain option submits the chosen text as the answer. The steward
   * conversation remembers its own question; the note gives it everything else.
   */
  private async handleAskCardAction(ev: InboundEvent, action: string, cardMsgId: string): Promise<void> {
    const [verb, qid, idxRaw] = action.split(":");
    const question = this.ledger.questions.get(qid ?? "");
    if (!question) {
      await this.dispatcher.replyToCard(cardMsgId, "这张提问卡片关联的问题已不存在。");
      return;
    }
    const payload = this.ledger.questions.payload(question.qid);
    const isNew = verb === "asknew";
    const idx = Number(idxRaw);
    const candidate = !isNew && payload ? payload.candidates[idx] ?? null : null;
    const option = !isNew && !candidate && payload ? payload.options[idx] ?? null : null;
    if (!isNew && !candidate && !option) {
      await this.dispatcher.replyToCard(cardMsgId, "这个选项已经失效，直接回复文字说明即可。");
      return;
    }

    const chosenThread = candidate ? this.ledger.threads.get(candidate.threadId) : null;
    // Answered already (a racing click or a quote-reply got here first): say so, no second run.
    if (question.status === "answered") {
      await this.dispatcher.replyToCard(cardMsgId, "这个问题已经回答过了。", chosenThread?.threadId);
      return;
    }

    // An option click on a WORKER's own question (kind 'report', review finding 1) is that
    // worker's answer (issue #10): relay it before any steward run — a refusal/failure keeps
    // the question open and tells the user. Failure/unreported questions fall through to the
    // plain click flow: the decision goes to the steward, not into a broken/idle worker.
    if (!isNew && !candidate && question.workerId !== null && question.kind === "report") {
      if (option === null) {
        await this.dispatcher.replyToCard(cardMsgId, "这个选项已经失效，直接回复文字说明即可。", question.threadId);
        return;
      }
      const ref = this.ownerMessageRef(ev.eventId);
      if (ref === null) {
        await this.dispatcher.replyToCard(cardMsgId, "无法确认这次点击的来源，直接回复这张卡片即可。", question.threadId);
        return;
      }
      try {
        const relayed = await this.answerWorkerQuestion({ question, answer: option, ref });
        if (relayed !== null) return; // answered and relayed; no steward run for the click
      } catch {
        return; // the failure was already told to the user; the question stays open
      }
      // The race path (close() lost to a concurrent answer): fall through to the plain click
      // flow below — the question is answered, the run notes it.
    }

    this.ledger.questions.close(question.qid, candidate?.label ?? option ?? "新开一件事");

    if (candidate && chosenThread) {
      this.ledger.threads.markRead(chosenThread.threadId); // a click is both read and a reply (§6.5)
      this.ledger.timeline.add(chosenThread.threadId, "note", `用户在提问卡片上选择了它（${question.text.slice(0, 80)}）`, {
        qid: question.qid,
        eventId: ev.eventId,
      });
    }

    const label = candidate?.label ?? option ?? "新开一件事";
    // Review #48 finding 5: every model/user-authored fragment embedded in a system note is
    // marker-escaped (only input.text was before) — a question or option containing ⟦…⟧
    // must never smuggle a fake system wake into the input the model reads.
    const q = escapeMarkers(question.text.slice(0, 80));
    const picked = escapeMarkers(label);
    // Review #48 finding 4: an option click answers that Thread's question — route the run
    // there (question.threadId), symmetric with quote-replying the same card, which the
    // outbound row's threadId already routes. Candidate clicks route to the picked thread;
    // 「新开一件事」 stays unrouted.
    const routedThreadId = candidate ? (chosenThread?.threadId ?? null) : isNew ? null : question.threadId;
    const note = candidate
      ? chosenThread
        ? `（系统注：用户在提问卡片「${q}」上选择了「${picked}」——归属已定为 Thread「${escapeMarkers(chosenThread.title)}」（${chosenThread.threadId}），basis=user_reply_to，可直接接续派发。）\n`
        : `（系统注：用户在提问卡片上选择的 Thread 已不存在，请如实告知并用 ask_user 重新确认。）\n`
      : isNew
        ? `（系统注：用户在提问卡片「${q}」上选择了「新开一件事」——请按之前的话语新建 Thread 继续处理。）\n`
        : question.threadId
          ? `（系统注：用户在提问卡片「${q}」上选择了「${picked}」——这是对你提问的回答，已确定归属该 Thread（${question.threadId}）。）\n`
          : `（系统注：用户在提问卡片「${q}」上选择了「${picked}」——这是对你提问的回答。）\n`;
    await this.submitUserMessage({
      msgId: ev.eventId,
      text: label,
      prefilledNote: note,
      routedThreadId,
    });
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
    questionId?: string | null;
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

  /** Test-only: force a worker's recorded context usage percent (the connector reports it
   *  in settled.usage.contextUsage; issue #8's high-context rule reads it at dispatch). */
  async setWorkerContextForTest(workerId: string, percent: number | null): Promise<void> {
    this.sql`UPDATE sh_worker SET contextPercent = ${percent} WHERE workerId = ${workerId}`;
  }

  /** Test-only: set a worker's state + outcome directly (e.g. terminally broken). */
  async setWorkerStateForTest(workerId: string, state: string, lastOutcome: string): Promise<void> {
    this.sql`UPDATE sh_worker SET state = ${state}, lastOutcome = ${lastOutcome}, updatedAt = ${Date.now()} WHERE workerId = ${workerId}`;
  }

  /** Test-only: force a still-queued command into a terminal failure — the idle sweep's
   *  queue-timeout shape (`failed/idle`), without waiting out the real ~30 min. */
  async failQueuedForTest(cmdId: string, failReason: string): Promise<void> {
    this.sql`UPDATE outbox SET state = 'failed', failReason = ${failReason} WHERE cmdId = ${cmdId}`;
  }

  /** Test-only: backdates a worker's lastEventAt (the sweep's silence clock). */
  async backdateWorkerForTest(workerId: string, minutes: number): Promise<void> {
    this.sql`UPDATE sh_worker SET lastEventAt = ${Date.now() - minutes * 60_000} WHERE workerId = ${workerId}`;
  }

  /** Test read of the memory module's handoff brief (issue #8, steward.md §2.6). */
  async handoffForTest(
    threadId: string,
    fromWorker?: string,
  ): Promise<import("./handoff.ts").HandoffBrief | null> {
    return this.ledger.handoff.build(threadId, fromWorker);
  }

  /** Test read of the summary-version state (issue #8, steward.md §2.6). */
  async summaryStateForTest(
    threadId: string,
  ): Promise<{ versions: Array<{ version: number; summary: string }>; status: { updates: number; rewriteDue: boolean } }> {
    return {
      versions: this.ledger.threads.summaryVersions(threadId).map((v) => ({ version: v.version, summary: v.summary })),
      status: this.ledger.threads.summaryStatus(threadId),
    };
  }

  /** Test-only: writes through the ledger's threads.update (the update_thread tool's path). */
  async updateThreadForTest(threadId: string, patch: { title?: string; goal?: string; summary?: string }): Promise<boolean> {
    return this.ledger.threads.update(threadId, patch);
  }

  /** Test-only: pushes a thread's lastActivityAt back `days` — the idle-attach band (#7). */
  async ageThreadForTest(threadId: string, days: number): Promise<void> {
    this.sql`UPDATE sh_thread SET lastActivityAt = ${Date.now() - days * 86_400_000} WHERE threadId = ${threadId}`;
}

  // ---- Daily budget (issue #28): the RPC surface tests and future web pages read --------------

  /** Today's counter against the cap, synced to pi's usage ledger first. */
  async budgetStatus(): Promise<BudgetState & { text: string }> {
    await this.syncUsage();
    const state = this.budgetState();
    return { ...state, text: renderSpendStatus(state) };
  }

  /** Test-only: pi's own session-wide usage total — the number the counter must agree with. */
  async piUsageForTest(): Promise<{ costUsd: number; tokens: number }> {
    return sumUsage(await (await this.piHarness.pi()).usage(BACKGROUND_CONTEXT));
  }

  /** Test-only: swaps the cap (setBudgetForTest(0.5)); undefined restores the deploy config. */
  async setBudgetForTest(usd?: number): Promise<void> {
    this.budgetConfig_ = usd === undefined ? undefined : resolveBudgetConfig(usd);
  }

  /** Test-only: attributes spend to a day directly (faux's price is $0 — models.ts). */
  async spendForTest(usd: number, tokens = 0, at = Date.now()): Promise<void> {
    this.ledger.budget.add({ costUsd: usd, tokens }, at);
  }

  /** Test-only: the persisted days, newest first. */
  async usageDaysForTest(): Promise<Array<{ day: string; costUsd: number; tokens: number; skippedWakes: number; overNotedAt: number | null }>> {
    return this.sql<{
      day: string; costUsd: number; tokens: number; skippedWakes: number; overNotedAt: number | null;
    }>`SELECT day, costUsd, tokens, skippedWakes, overNotedAt FROM sh_usage_day ORDER BY day DESC`;
  }

  /** Test-only: wipes the cursors only — pi history stays, so the next sync must re-baseline. */
  async resetCursorsForTest(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM sh_usage_cursor");
    await this.syncUsage();
  }

  /** Test-only: every budget test starts virgin — no day rows, cursor parked at zero. One
   *  transaction on purpose: a cursor deleted-but-not-yet-reseeded reads as never-seen to a
   *  racing background sync, which then baseline-seeds it at pi's CURRENT total and swallows
   *  the run the test is about to measure. */
  async resetBudgetForTest(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM sh_usage_day");
      this.ctx.storage.sql.exec("DELETE FROM sh_usage_cursor");
      this.ctx.storage.sql.exec(`INSERT INTO sh_usage_cursor (id, costUsd, tokens, updatedAt) VALUES (1, 0, 0, ${now})`);
    });
  }

  /** Test-only: the never-seen state — the next observation baselines instead of charging. */
  async resetCursorForTest(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM sh_usage_cursor");
  }

  /** Test-only: marks a past day's over-budget note as sent. */
  async noteBudgetForTest(day: string): Promise<void> {
    this.ledger.budget.markNoted(day, Date.now());
  }

  /** Test entry into the intervention half of the dispatch service (send/interrupt). */
  async sendForTest(
    input: Omit<import("./dispatch.ts").SendToWorkerInput, "provenance" | "cmdId"> & { cmdId?: string },
  ): Promise<import("./dispatch.ts").SendToWorkerOutcome> {
    return this.dispatcher.sendToWorker({ ...input, provenance: "test", cmdId: input.cmdId ?? `test:${ulid()}` });
  }

  /** Test-only: shrinks every open worker question's fallback window to `ms` (issue #10)
   *  and re-arms the alarm at the new deadline — returns the affected qids. */
  async shrinkQuestionWindowForTest(ms: number): Promise<string[]> {
    const affected = this.ledger.questions.unhandled().map((q) => q.qid);
    for (const qid of affected) this.ledger.questions.setFallbackWindow(qid, ms);
    await this.armQuestionFallback();
    return affected;
  }

  /** Test-only: the alarm-driven §5.3 fallback pass, callable directly. */
  async sweepQuestionFallbackForTest(): Promise<{ forwarded: number }> {
    return this.sweepQuestionFallback();
  }

  /** Test entry into the intervention half of the dispatch service (send/interrupt). */
  async interruptForTest(
    input: Omit<import("./dispatch.ts").InterruptWorkerInput, "provenance" | "cmdId"> & { cmdId?: string },
  ): Promise<import("./dispatch.ts").InterruptWorkerOutcome> {
    return this.dispatcher.interruptWorker({ ...input, provenance: "test", cmdId: input.cmdId ?? `test:${ulid()}` });
  }

  /** Test entry into the proactive-behavior service (issue #20): create + arm a routine. */
  async createRoutineForTest(
    input: import("./routines.ts").RoutineSpecInput & { routineId?: string; createdFromMsg?: string },
  ): Promise<{ ok: true; routineId: string } | { ok: false; reason: string }> {
    const outcome = await this.routineService.create({
      ...input,
      routineId: input.routineId ?? `r_test_${ulid()}`,
      createdFromMsg: input.createdFromMsg ?? "om_test_source",
    });
    return outcome.ok ? { ok: true, routineId: outcome.routine.routineId } : { ok: false, reason: outcome.reason };
  }

  /** Test read: the alarm-driven maintenance callbacks currently scheduled (findings 2/4). */
  async maintenanceSchedulesForTest(): Promise<Array<{ id: string; callback: string; type: string; time: number }>> {
    return (await this.listSchedules())
      .filter((s) => ["sweepIdle", "sweepWorkers", "drainNotifications"].includes(s.callback))
      .map((s) => ({ id: s.id, callback: s.callback, type: s.type, time: s.time ?? 0 }));
  }

  /** Test read: the fireRoutine/fireFollowup schedule rows the Agents SDK currently holds. */
  async routineSchedulesForTest(): Promise<Array<{ id: string; callback: string; type: string; time: number; payload: unknown }>> {
    return (await this.listSchedules())
      .filter((s) => s.callback === "fireRoutine" || s.callback === "fireFollowup")
      .map((s) => ({ id: s.id, callback: s.callback, type: s.type, time: s.time, payload: s.payload }));
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
    // Issue #28: pi's usage tables are gone, so the next conversation starts from zero — the
    // counters must follow, and the cursor row must EXIST at zero: an absent row would make
    // the next sync treat the first run's spend as a never-seen baseline and swallow it.
    this.ctx.storage.sql.exec("DELETE FROM sh_usage_day");
    this.ctx.storage.sql.exec("DELETE FROM sh_usage_cursor");
    this.ctx.storage.sql.exec(
      "INSERT INTO sh_usage_cursor (id, costUsd, tokens, updatedAt) VALUES (1, 0, 0, " + Date.now() + ")",
    );
    if (this.llmModels.faux) this.llmModels.faux.reset();
  }

  /** Test-only: cancels every routine/follow-up schedule and clears the proactive tables. */
  async resetRoutineStateForTests(): Promise<void> {
    for (const s of await this.listSchedules()) {
      if (s.callback === "fireRoutine" || s.callback === "fireFollowup") await this.cancelSchedule(s.id).catch(() => {});
    }
    this.ctx.storage.sql.exec("DELETE FROM sh_routine");
    this.ctx.storage.sql.exec("DELETE FROM sh_followup");
    this.ctx.storage.sql.exec("DELETE FROM sh_routine_offer");
    this.routineService_ = undefined;
  }

  /** Queues the daily lifecycle pass (issue #19) to run at the next 02:00 UTC. Idempotent
   *  by expression, so a restart never postpones it. */
  private armNotesMaintenance(): void {
    void this.schedule(NOTES_MAINTENANCE_CRON, "notesMaintenance", undefined).catch((err) =>
      this.logChannel("notes_maintenance_arm_failed", errorText(err)),
    );
  }

  /** Test read: the notes-maintenance schedule row (empty before arming). */
  async notesMaintenanceSchedulesForTest(): Promise<Array<{ id: string; type: string; cron: string | null; time: number }>> {
    return (await this.listSchedules())
      .filter((s) => s.callback === "notesMaintenance")
      .map((s) => ({ id: s.id, type: s.type, cron: (s as { cron?: string }).cron ?? null, time: s.time }));
  }

  /** Test-only: clears the notes tables (the daily cron stays armed — a stray fire is
   *  idempotent and finds nothing pending; cancelling it would leave nothing to assert). */
  async resetNotesStateForTests(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM sh_note");
    this.ctx.storage.sql.exec("DELETE FROM sh_note_log");
    this.ctx.storage.sql.exec("DELETE FROM sh_note_pressure");
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
