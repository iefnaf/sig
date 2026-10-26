// The steward Durable Object: device pairing, auth, the hello/welcome handshake, the command
// outbox, the event inbox, and the bidirectional heartbeat. See docs/design/connector-do-protocol.md
// §4 (envelope and reliability), §6.2-6.4 (commands/events), ADR-0001 (heartbeat + redelivery
// corrections), and docs/spike-conclusions.md bugs 5 and 10.
//
// Owner channel (ADR-0003, browser authority in ADR-0010): the Feishu integration is gone for
// now. The owner uses the password/passkey web workspace; explicit-key deployments also retain
// the SERVER_KEY-gated /api/* routes. The outbound queue renders rows locally.
//
// Ledger core (issue #5, steward.md §2/§5/§6): machines/repositories from hello, online state
// from connections, the deterministic event reducer (one transaction, derived Thread state),
// and core-template done reports with no LLM. Every sh_ledger table is reached through the
// memory module (ledger.ts); this class only wires it to the transports.
//
// The steward LLM (issue #6, steward.md §4-§6): a PiHarness root session with the
// `sig-steward` extension — user messages get their reply from the model (sh_run + alarm
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
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CloseCode,
  CmdAckMessageSchema,
  CmdResultMessageSchema,
  DIRECTORY_BROWSE_TIMEOUT_MS,
  DirectoryListingMessageSchema,
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
  RegisterRepoResultSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
  WorkerCmdMessageSchema,
  generatePairingCode,
  mintToken,
  parseToken,
  ulid,
  type CmdMessage,
  type CmdResult,
  type DirectoryBrowseResult,
  type DirectoryListing,
  type DirectoryListMessage,
  type ErrorMessage,
  type EventsAckMessage,
  type HistoryReqMessage,
  type MachineOfflineMessage,
  type PongMessage,
  type ResyncMessage,
  type ServerKey,
  type WelcomeMessage,
} from "@alexlikevibe/protocol";
import { bearer, resolveKeySecrets } from "./auth.ts";
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
import { testModelConnection } from "./llm/connection-test.ts";
import {
  buildStewardModels,
  installModel,
  mergeModelSelection,
  providerCatalog,
  stewardProviders,
  resolveModelConfig,
  resolveModelThinking,
  type ComposerModelInput,
  type FauxRequestRecord,
  type StewardModels,
} from "./llm/models.ts";
import { createLedger, QUIET_MERGE_MS, type Ledger, type LedgerSql, type NotifyRow, type OutboundDeliveryRow, type QuestionRow, type RunRow, type WakeRow } from "./ledger.ts";
import { DeploymentAuth, deploymentSecrets, ownerAuthorized } from "./deployment-auth.ts";
import { loginPage } from "./login-page.ts";
import { renderChangeReports } from "./notes.ts";
import { FAILED_RUN_NOTICE, failedRunNotice } from "./owner-notices.ts";
import { RoutineService } from "./routines.ts";
import {
  type LocalMessage,
  failureCard,
  notifyCard,
  askUserCard,
  reportCardFor,
  noteDecisionCard,
  stallCard,
  workerQuestionCard,
  didBullets,
  needsYouOf,
  toneOfReport,
  mergeQuietOutbound,
  mergedSendUuid,
  sectionFromPayload,
  machineOfflineCard,
  machineOnlineCard,
  waitedStartCard,
  prConsentFor,
  prCreatedCard,
  prFailureNeedsYou,
  prCommandArgs,
  type AskCardButton,
  type QuietSection,
} from "./report-template.ts";
import { MIGRATIONS, runMigrations } from "./schema.ts";
import { openSecret, sealSecret } from "./secretbox.ts";
import { ambiguousWakeText, commandAttentionWakeText, escapeMarkers, verifyWakeText } from "./wake-text.ts";
import { WorkspaceError, cardOpen, cardView, type WorkspaceActionInput, type WorkspaceInput } from "./workspace.ts";
import type { MachineDirectoryBrowseInput, MachineDirectoryInput, MachineDirectoryResult } from "./workspace-api.ts";
import { WorkspaceStream } from "./workspace-stream.ts";
import { WebApp, linkTargetForThread, loginLinkPolicyFromEnv, parseSessionCookie, verifyLinkToken } from "./web.ts";

/** Messages the workspace will queue before telling the owner to wait for the steward to catch up. */
const MAX_OPEN_USER_RUNS = 10;
/** Connection tag of browsers that opened the workspace (`?role=web&view=workspace`). */
const WORKSPACE_TAG = "workspace";
/** How long a burst of ledger writes is coalesced into one `workspace_changed` frame. */
const WORKSPACE_NUDGE_MS = 150;

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function rateLimited(retryAfterSec: number): Response {
  return Response.json({ error: "rate_limited" }, {
    status: 429,
    headers: { "retry-after": String(Math.max(1, retryAfterSec)), "cache-control": "no-store" },
  });
}

export async function readJsonObject(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing body");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

interface ConnState {
  /** Set on browser connections (the L3 stream and workspace consumers); connector connections carry deviceId. */
  role?: "web";
  /** Set on workspace connections: the session that opened them (signing out closes them). */
  sid?: string;
  expiresAt?: number;
  deviceId: string;
  epoch: number;
  /** Key that authenticated the connection (issue #27): ≠ primary ⇒ welcome rekeys. */
  keyId: string;
  connEpoch?: number;
  directoryBrowse?: boolean;
  /** Set on a browser connection by `subscribe` (issue #84, §6.8): the one worker session
   *  view it currently has open, and the only `workerId` it may send `worker_cmd` to. */
  viewingWorkerId?: string;
}

type DirectoryReadResult = DirectoryBrowseResult | { ok: false; code: "machine_offline" | "browse_timeout" };

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

// ---- Owner outbound queue (ADR-0003): rows render locally, read back via GET /api/messages ----
// The claim stays the double-settle guard: the conditional UPDATE hands a row to exactly one
// delivery pass, so the inline fire and the alarm pass can never both settle it.
const OUTBOUND_CLAIM_MS = 30_000;
const OUTBOUND_BATCH = 20;
/** The single local-channel recipient; browser authority is defined by ADR-0010. */
const OWNER_ID = "owner";
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

/** The connector's pr_worker error codes (worker-manager.ts) → the failure card's stages
 *  (review finding 3): lets the failed-cmd_result path keep the stage-specific fix text
 *  even when it wins the race against the classified pr_failed event. */
const PR_ERROR_CODE_TO_STAGE: Readonly<Record<string, string>> = {
  gh_missing: "gh_missing",
  gh_auth: "auth",
  push_rejected: "push",
  pr_create_failed: "create",
};

/** The pr notify intents' render inputs (issue #21): JSON written by the reducer, read here;
 *  malformed/absent payload degrades to empty strings, never a thrown render. */
function parseNotifyPayload(payload: string | null): { url?: string; branch?: string; stage?: string; message?: string } {
  if (payload === null) return {};
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return {
      ...(typeof parsed.url === "string" ? { url: parsed.url } : {}),
      ...(typeof parsed.branch === "string" ? { branch: parsed.branch } : {}),
      ...(typeof parsed.stage === "string" ? { stage: parsed.stage } : {}),
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
    };
  } catch {
    return {};
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A short, human-readable phrase for what a command asked the worker to do — used in the
 *  ambiguous/not-delivered/in-use notices (issue #15). Reads the stored args defensively. */
function commandInstruction(kind: string, payload: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // unparsable payload: fall through to the generic label
  }
  if (kind === "send" || kind === "interrupt") {
    const thenText = (args.then as { text?: unknown } | undefined)?.text;
    const text = typeof args.text === "string" ? args.text : typeof thenText === "string" ? thenText : "";
    if (text) return text.slice(0, 60);
  }
  if (kind === "start_worker" && typeof args.prompt === "string") return args.prompt.slice(0, 60);
  if (kind === "resume") return "恢复运行";
  return kind;
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
  private directoryBrowseTimeoutMs = DIRECTORY_BROWSE_TIMEOUT_MS;
  private readonly directoryReads = new Map<string, {
    deviceId: string;
    connectionId: string;
    finish(result: DirectoryReadResult): void;
  }>();

  onStart(): void {
    // Each migration commits atomically WITH its ledger row (reviews #47-2 + #48 finding 3):
    // a multi-statement rebuild can never persist half of itself, and the ledger write
    // cannot lag the commit (the copy-drop-rename migrations are not re-runnable).
    runMigrations(this.sql.bind(this), MIGRATIONS, (fn) => this.ctx.storage.transactionSync(fn));
    // Fail before any credential is minted if this deployment cannot establish its durable key.
    this.deploymentKeySecrets();
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
    // Issue #11: a quiet row waiting out its merge window (or a backoff between retries)
    // must not depend on the enqueue-time pass having survived — re-arm from storage.
    void this.deliverOutbound();
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
    void this.recoverWorkspaceInputs();
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.piHarness);
  }

  // ---- The steward LLM (issue #6, steward.md §4) -------------------------------------------------
  // Cache fields must be declared before `piHarness`: its initializer reads the vars config
  // eagerly (defaults.model), and with class-field semantics a later `undefined` initializer
  // would clobber what the getter wrote.

  private testingModel = false;
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
   * Applies the merged model selection (mergeModelSelection, issue #70) to the live
   * collection and the root session, before the first submit of an isolate (and after any
   * setModelConfig). The API key is always the sealed row's (never an env var, spike bug 7),
   * and only when its provider matches the selection — a key sealed for another provider is
   * not silently sent elsewhere.
   */
  private async ensureRootModel(): Promise<void> {
    const sealed = await this.modelConfig();
    const vars = this.modelVarsConfig;
    const config = mergeModelSelection(sealed, vars);
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
    const { thinkingLevel } = resolveModelThinking(config);
    const signature = JSON.stringify([config.provider, config.modelId, config.baseUrl, Boolean(apiKey), thinkingLevel]);
    if (this.appliedRootModel === signature) return;
    const root = await (await this.piHarness.pi()).root(BACKGROUND_CONTEXT);
    await root.configure({ model: { provider: config.provider, modelId: config.modelId }, thinkingLevel }, BACKGROUND_CONTEXT);
    this.appliedRootModel = signature;
  }

  private appliedRootModel: string | undefined;

  /** Durable key authority. Fresh deployments generate this key; explicit-key deployments keep
   *  the operator's SERVER_KEY and SERVER_KEY_PREVIOUS rotation window. */
  protected deploymentKeySecrets(): [string, ...string[]] {
    return deploymentSecrets(this.sql.bind(this) as unknown as import("./schema.ts").SqlExecutor, this.env);
  }

  // The signing/sealing key set (primary first). Overridable so tests can simulate rotation.
  protected async serverKeys(): Promise<ServerKey[]> {
    return resolveKeySecrets(this.deploymentKeySecrets());
  }

  // Tests shrink the /pair lockout (see feishuSendTimeoutMs for the same pattern).
  protected pairLockMs = PAIR_LOCK_MS;

  // Tests shrink the history relay TTL to exercise the alarm-driven sweep quickly.
  protected historyRelayTtlMs = HISTORY_RELAY_TTL_DEFAULT_MS;
  /** When the pending relay sweep fires (0: none known). Live viewers open a stream every few
   *  seconds; one sweep per open would pile up schedule rows, and one pending sweep is enough —
   *  it re-arms itself for the next expiry. */
  private relaySweepAt = 0;

  private armRelaySweep(): void {
    const delayS = Math.max(1, Math.ceil(this.historyRelayTtlMs / 1000));
    const fireAt = Date.now() + delayS * 1000;
    if (this.relaySweepAt !== 0 && this.relaySweepAt <= fireAt) return; // an earlier sweep is already coming
    this.relaySweepAt = fireAt;
    void this.schedule(delayS, "sweepHistoryRelays");
  }

  // Tests shrink the quiet merge window (issue #11) — 0 makes quiet rows due immediately,
  // keeping the content-path tests deterministic while the window itself has its own suite.
  protected quietMergeMs = QUIET_MERGE_MS;

  // The memory module (steward.md §2): all sh_* ledger SQL lives behind this handle. Bound
  // lazily because `sql`/`ctx` only mean something once the DO is live.
  private ledger_?: Ledger;
  private get ledger(): Ledger {
    return (this.ledger_ ??= createLedger({
      sql: this.watchedSql(),
      tx: (fn) => this.ctx.storage.transactionSync(fn),
      quietWindowMs: () => this.quietMergeMs,
    }));
  }

  /** The ledger's SQL, with one addition: any write tells the connected workspaces that
   *  something changed (ADR-0004). The ledger owns every table the workspace shows, so this
   *  one seam covers messages, decisions, Thread state and machines without a hook at each
   *  writer. */
  private watchedSql(): LedgerSql {
    const sql = this.sql.bind(this) as unknown as LedgerSql;
    return ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => {
      const rows = sql(strings, ...values);
      if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(strings[0] ?? "")) this.notifyWorkspaces();
      return rows;
    }) as LedgerSql;
  }

  private workspaceNudge: ReturnType<typeof setTimeout> | undefined;

  /** Live reply text for the open workspaces (workspace-stream.ts): held only while one is connected. */
  private workspaceStream_?: WorkspaceStream;
  private get workspaceStream(): WorkspaceStream {
    return (this.workspaceStream_ ??= new WorkspaceStream({
      open: () => this.piHarness.session().events(),
      audience: () => [...this.getConnections(WORKSPACE_TAG)].length,
      // Only the owner's own conversation is shown live; event and routine runs write bookkeeping nobody is sent.
      forOwner: async () => {
        const run = await this.currentRunBinding();
        return run !== null && (run.kind === "user" || run.kind === "verify") ? { threadId: run.routedThreadId } : null;
      },
      onRunEnd: () => { void this.pollRuns(); },
      send: (frame) => { for (const connection of this.getConnections(WORKSPACE_TAG)) if (this.webConnectionAlive(connection)) connection.send(frame); },
      log: (reason, detail) => this.logChannel(reason, detail),
    }));
  }

  /** Tells every open workspace to refetch. Bursts of writes (one event touches many rows)
   *  collapse into a single frame; a workspace that missed one catches up on reconnect. */
  private notifyWorkspaces(): void {
    if (this.workspaceNudge !== undefined) return;
    this.workspaceNudge = setTimeout(() => {
      this.workspaceNudge = undefined;
      const frame = JSON.stringify({ t: "workspace_changed" });
      for (const connection of this.getConnections(WORKSPACE_TAG)) if (this.webConnectionAlive(connection)) connection.send(frame);
      this.workspaceStream.ensure(); // a Durable Object that woke after hibernation re-subscribes here
    }, WORKSPACE_NUDGE_MS);
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
      sendText: async (text, threadId, opts) => {
        const owner = this.ownerOpenIdSync();
        if (!owner) return;
        await this.enqueueOutbound({ kind: "text", to: owner, text, threadId: threadId ?? null, urgency: "push", ...(opts?.private ? { private: true } : {}) });
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

  // The browser web app (issue #22, ADR-0010): password/passkey and legacy-link sessions,
  // Thread timeline, machine management. Same lazy-bind pattern as the ledger.
  private web_?: WebApp;
  private get web(): WebApp {
    return (this.web_ ??= new WebApp({
      sql: this.sql.bind(this) as unknown as import("./schema.ts").SqlExecutor,
      secrets: this.deploymentKeySecrets(),
      loginLinkPolicy: loginLinkPolicyFromEnv(this.env.LOGIN_LINK_TTL_MS, this.env.LOGIN_LINK_REUSABLE),
      ledger: this.ledger,
      listDevices: () =>
        this.sql<{ deviceId: string; name: string | null; revoked: number }>`
          SELECT deviceId, name, revoked FROM device ORDER BY createdAt, deviceId
        `.map((d) => ({ deviceId: d.deviceId, name: d.name, revoked: !!d.revoked })),
      revokeDevice: (deviceId) => void this.revoke(deviceId),
      machineConnected: (deviceId) => this.connFor(deviceId) !== undefined,
      audit: (reason, detail) => this.logChannel(reason, detail),
      workspace: {
        budget: () => this.budgetState(),
        submitMessage: (input) => this.submitWorkspaceMessage(input),
        submitAction: (input) => this.submitWorkspaceAction(input),
        settings: async () => ({
          model: await this.llmSelection(),
          passkeys: this.web.listPasskeys(),
          providers: providerCatalog(),
          keyedProviders: await this.keyedProviders(),
        }),
        testModel: async (input) => {
          if (this.testingModel) return { ok: false, error: "busy" };
          this.testingModel = true;
          try {
            const apiKey = input.apiKey ?? await this.sealedKeyFor(input.provider) ?? undefined;
            return await testModelConnection({ ...input, explicit: true }, apiKey);
          } finally {
            this.testingModel = false;
          }
        },
        saveModel: async (input) => { await this.setModelConfig(input.provider, input.apiKey, input.modelId, input.baseUrl, input.thinkingLevel); },
        selectModel: (input) => this.selectComposerModel(input),
        pairing: (id: string) => this.webPairing(id),
        revoke: (id: string) => { this.logChannel("web_machine_revoked", id); void this.revoke(id); },
        addDirectory: (input) => this.addMachineDirectory(input),
        browseDirectory: (input, signal) => this.browseMachineDirectory(input, signal),
        webauthnRegisterOptions: (sid: string, rpId: string) => this.web.webauthnRegisterOptions(sid, rpId),
        webauthnRegisterVerify: (sid: string, rpId: string, origin: string, label: string, attestation: unknown) =>
          this.web.webauthnRegisterVerify(sid, rpId, origin, label, attestation),
        webauthnRemove: (credentialId: string) => this.web.removePasskey(credentialId),
      },
      sessionEnded: (sid) => this.closeWebSession({ sid }),
    }));
  }

  private deploymentAuth_?: DeploymentAuth;
  private get deploymentAuth(): DeploymentAuth {
    return (this.deploymentAuth_ ??= new DeploymentAuth({
      sql: this.sql.bind(this) as unknown as import("./schema.ts").SqlExecutor,
      env: this.env,
      transaction: (operation) => this.ctx.storage.transactionSync(operation),
      sessionsRevoked: () => this.closeAllBrowserSessions(),
      audit: (reason, detail) => this.logChannel(reason, detail),
    }));
  }

  /** Dedicated workerd auth tests install a verifier without calling the external screen. */
  async configureBrowserPasswordForTests(password: string): Promise<void> {
    await this.deploymentAuth.provisionForTests(password);
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
          return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'local' AND msgId = ${msgId}`.length > 0;
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
            SELECT receivedAt FROM sh_inbound WHERE channel = 'local' AND msgId = ${msgId}
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
        // Issue #11 (spec §7.6): push only what the model marks important — everything else
        // is quiet and merges over the 60-second window. Anything tied to `waiting_you` is
        // ALWAYS push: an open question binding, or a Thread sitting in waiting_you.
        const urgency: "push" | "quiet" =
          input.urgency === "push" || question !== null || thread?.state === "waiting_you" ? "push" : "quiet";
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
          urgency,
          ...(urgency === "quiet"
            ? {
                part: {
                  kind: "report",
                  tone: input.tone,
                  conclusion: input.conclusion,
                  did: input.did,
                  ...(input.needsYou !== undefined ? { needsYou: input.needsYou } : {}),
                  threadTitle: thread?.title ?? "",
                  ...(detailsUrl ? { detailsUrl } : {}),
                } satisfies QuietSection,
              }
            : {}),
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

  /** The local channel has one recipient; it is not a chat-platform identity. */
  private ownerOpenIdSync(): string | null {
    return OWNER_ID;
  }

  /** The owner's message that authorizes answering a worker (§4.3/§7.2): null when the
   *  message never existed here or did not come from the bound owner. */
  private ownerMessageRef(msgId: string): string | null {
    return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'local' AND msgId = ${msgId} AND ownerAuthorized = 1`.length > 0
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
          // A direct ack of the owner's own action (issue #11): push, never merged away.
          urgency: "push",
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

  // Plain-HTTP surface reached only through the Worker's exact-route forwards. Credentials are
  // rechecked here because this method also owns the generated-key surface the Worker cannot see.
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Every request the DO serves reveals the deployment's public origin — the source for the
    // pairing command's URL and the absolute one-time card links (web.ts owns the value).
    if (url.protocol === "https:" || url.protocol === "http:") this.web.recordOrigin(url.origin);
    if (url.pathname.startsWith("/api/")) {
      if (!ownerAuthorized(request, this.env)) return new Response("unauthorized", { status: 401 });
      if (url.pathname === "/api/messages" && (request.method === "POST" || request.method === "GET")) {
        return request.method === "POST" ? this.handleApiMessage(request) : this.handleApiListMessages(url);
      }
      if (url.pathname === "/api/actions" && request.method === "POST") return this.handleApiActions(request);
      if (url.pathname === "/api/pairing" && request.method === "POST") return this.handleApiPairing();
      if (url.pathname === "/api/login-link" && request.method === "POST") return this.handleApiLoginLink();
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/auth/password" && request.method === "POST") return this.handlePasswordLogin(request, url);
    if (url.pathname.startsWith("/link/") && request.method === "GET") {
      await this.deploymentAuth.ready();
      const token = url.pathname.slice("/link/".length);
      if (!(await verifyLinkToken(this.deploymentKeySecrets(), token))) {
        return loginPage("This sign-in link is invalid or expired. / 登录链接无效或已过期。", 410);
      }
      const secure = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
      return this.web.openLink(token, secure);
    }
    if (url.pathname === "/webauthn/login/options" && request.method === "POST") {
      await this.deploymentAuth.ready();
      return Response.json(await this.web.webauthnLoginOptions(url.hostname), { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/webauthn/login/verify" && request.method === "POST") {
      await this.deploymentAuth.ready();
      const admission = this.deploymentAuth.admit("passkey", clientIp(request));
      if (!admission.allowed) {
        this.logChannel("browser_auth_throttled", "passkey");
        return rateLimited(admission.retryAfterSec);
      }
      let body: unknown;
      try {
        body = await readJsonObject(request, 8 * 1024);
      } catch {
        return Response.json({ error: "bad_request" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const wire = body as Record<string, unknown>;
      const keys = ["challengeToken", "credentialId", "clientDataJSON", "authenticatorData", "signature"];
      if (!keys.every((key) => typeof wire[key] === "string" && (wire[key] as string).length > 0)) {
        return Response.json({ error: "bad_request" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      const secure = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
      return this.web.webauthnLoginVerify(url.hostname, url.origin, secure, body);
    }
    if ((url.pathname === "/app" || url.pathname.startsWith("/app/")) && (request.method === "GET" || request.method === "POST")) {
      await this.deploymentAuth.ready();
      return this.web.handle(request);
    }
    return new Response("not found", { status: 404 });
  }

  private async handlePasswordLogin(request: Request, url: URL): Promise<Response> {
    await this.deploymentAuth.ready();
    const ip = clientIp(request);
    const admission = this.deploymentAuth.admit("password", ip);
    if (!admission.allowed) {
      this.logChannel("browser_auth_throttled", "password");
      return rateLimited(admission.retryAfterSec);
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request, 8 * 1024);
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const password = typeof body.password === "string" ? body.password.normalize("NFC") : null;
    if (!password || [...password].length > 128 || new TextEncoder().encode(password).byteLength > 1024) {
      return Response.json({ error: "bad_request" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const result = await this.deploymentAuth.verifyPassword(password, ip);
    if (result !== "valid" && result !== "invalid") {
      this.logChannel("browser_password_unavailable", result);
      return Response.json({ error: result }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    if (result === "invalid") {
      this.logChannel("browser_password_failed", "invalid_credential");
      return Response.json({ error: "invalid_password" }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    const secure = url.protocol === "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1";
    const { cookie } = await this.web.openSession(secure);
    this.logChannel("browser_password_verified", "session_opened");
    return Response.json({ ok: true }, { headers: { "set-cookie": cookie, "cache-control": "no-store" } });
  }

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  async getConnectionTags(_connection: Connection, ctx: ConnectionContext): Promise<string[]> {
    // §5.3: the role query param routes/tags the connection; legitimacy is decided by the
    // credential — device token for connectors (onConnect), session cookie for browsers.
    const params = new URL(ctx.request.url).searchParams;
    if (params.get("role") === "web") {
      const raw = (ctx.request.headers.get("cookie") ?? "")
        .split(/;\s*/)
        .find((part) => part.startsWith("sig_session="))
        ?.slice("sig_session=".length) ?? null;
      const sid = await parseSessionCookie(this.deploymentKeySecrets(), raw);
      if (!sid || !this.web.sessionAlive(sid)) return [];
      return params.get("view") === "workspace" ? ["web", WORKSPACE_TAG] : ["web"];
    }
    const parsed = await parseToken(await this.serverKeys(), bearer(ctx.request));
    return parsed ? [`dev:${parsed.deviceId}`] : [];
  }

  private sendError(connection: Connection, code: ErrorMessage["code"], message: string, re?: string): void {
    connection.send(JSON.stringify({ t: "error", re, code, message, retriable: false }));
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    // Browser connections (§5.3 `web` role): both the HMAC and liveness are checked here.
    if (new URL(ctx.request.url).searchParams.get("role") === "web") {
      // Reconcile a changed deployment password before validating the cookie. Otherwise a
      // browser could reconnect a pre-reset cookie without touching an HTTP route that does so.
      await this.deploymentAuth.ready();
      const raw = (ctx.request.headers.get("cookie") ?? "")
        .split(/;\s*/)
        .find((part) => part.startsWith("sig_session="))
        ?.slice("sig_session=".length) ?? null;
      const sid = await parseSessionCookie(this.deploymentKeySecrets(), raw);
      if (!sid || !this.web.sessionAlive(sid)) {
        connection.close(CloseCode.UNAUTHORIZED, "unauthorized");
        return;
      }
      connection.setState({ role: "web", sid, expiresAt: Date.now() + 24 * 3600_000, deviceId: "", epoch: 0, keyId: "" } satisfies ConnState);
      if (new URL(ctx.request.url).searchParams.get("view") === "workspace") this.workspaceStream.ensure();
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
      // §6.8: any web-direct command still waiting on this connection's cmd_ack/cmd_result
      // loses its relay target — the outbox row itself is untouched, only the bookkeeping
      // that would have forwarded the answer to this now-gone browser.
      this.sql`DELETE FROM web_cmd_relay WHERE webConnId = ${connection.id}`;
      // Nobody left watching a workspace: let go of pi's event stream (the close may still list this socket).
      if ([...this.getConnections(WORKSPACE_TAG)].every((other) => other.id === connection.id)) void this.workspaceStream_?.stop();
      return;
    }
    if (!state.deviceId) return;
    for (const pending of this.directoryReads.values()) {
      if (pending.connectionId === connection.id) pending.finish({ ok: false, code: "machine_offline" });
    }
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
    this.rearmNoticeDrain(); // a recovery intent may now be counting down its debounce
  }

  /** Signing out ends every browser connection that session opened. */
  closeWebSession(input: { sid: string }): void {
    for (const connection of this.getConnections<ConnState>("web")) {
      if (connection.state?.sid === input.sid) connection.close(CloseCode.UNAUTHORIZED, "sign in again");
    }
  }

  /** A password change revokes every browser socket, not just database-backed sessions. */
  private closeAllBrowserSessions(): void {
    for (const connection of this.getConnections<ConnState>("web")) {
      connection.close(CloseCode.UNAUTHORIZED, "sign in again");
    }
  }

  /** A workspace socket is alive only while its session is: an expired or signed-out session
   *  loses its live updates and stream with an explicit close. */
  private webConnectionAlive(connection: Connection): boolean {
    const state = connection.state as ConnState | null;
    if (state?.role !== "web" || !state.sid || !this.web.sessionAlive(state.sid)) {
      connection.close(CloseCode.UNAUTHORIZED, "sign in again");
      return false;
    }
    return true;
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
      if (!this.webConnectionAlive(connection)) return;
      switch (t) {
        case "history_open":
          this.handleHistoryOpen(connection, message);
          return;
        case "history_ack":
          this.handleHistoryAck(connection, message);
          return;
        case "subscribe":
          this.handleSubscribe(connection, message);
          return;
        case "unsubscribe":
          this.handleUnsubscribe(connection);
          return;
        case "worker_cmd":
          this.handleWorkerCmd(connection, message);
          return;
        default:
          this.sendError(connection, "forbidden", `message type ${JSON.stringify(t)} is not allowed on a web connection`);
          return;
      }
    }
    if (t === "history_open" || t === "history_ack" || t === "subscribe" || t === "unsubscribe" || t === "worker_cmd") {
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
        this.handleCmdAck(state?.deviceId, message);
        return;
      case "cmd_result":
        this.handleCmdResult(state?.deviceId, message);
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
      case "directory_listing":
        this.handleDirectoryListing(connection, message);
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
    this.armRelaySweep();
    const req: HistoryReqMessage = {
      t: "history_req",
      id: reqId,
      workerId: open.workerId,
      maxBytes,
      ...(open.since ? { since: open.since } : {}),
      ...(open.format ? { format: open.format } : {}),
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
    if (!webConn || !this.webConnectionAlive(webConn)) {
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

  // ---- Direct worker chat from an open session view (issue #84, ADR-0011, protocol §6.8) ----
  // Mechanical only (send/interrupt): the DO calls the same Dispatcher methods a steward tool
  // call would, with no LLM step in between. Targeting is server-verified (subscribe state on
  // the connection itself), never trusted from the message.

  /** browser → DO: this connection is now watching `workerId`'s session view. */
  private handleSubscribe(connection: Connection, raw: unknown): void {
    const parsed = SubscribeMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(connection, "bad_request", "invalid subscribe");
      return;
    }
    if (!this.ledger.workers.get(parsed.data.workerId)) {
      this.sendError(connection, "not_found", `worker ${parsed.data.workerId} is unknown`);
      return;
    }
    const state = connection.state as unknown as ConnState | null;
    connection.setState({
      role: "web",
      sid: state?.sid,
      expiresAt: state?.expiresAt,
      deviceId: state?.deviceId ?? "",
      epoch: state?.epoch ?? 0,
      keyId: state?.keyId ?? "",
      connEpoch: state?.connEpoch,
      viewingWorkerId: parsed.data.workerId,
    } satisfies ConnState);
  }

  /** browser → DO: the session view closed, or is about to subscribe to a different worker. */
  private handleUnsubscribe(connection: Connection): void {
    const state = connection.state as unknown as ConnState | null;
    if (!state) return;
    const { viewingWorkerId: _drop, ...rest } = state;
    connection.setState(rest as ConnState);
  }

  /** browser → DO → connector: §6.8. Dispatches through the ordinary Dispatcher path (same
   *  outbox write, same Thread timeline entry a steward tool call would produce) and registers
   *  a relay row so the real cmd_ack/cmd_result — never fabricated — finds its way back. */
  private async handleWorkerCmd(connection: Connection, raw: unknown): Promise<void> {
    const parsed = WorkerCmdMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.sendError(connection, "bad_request", "invalid worker_cmd");
      return;
    }
    const cmd = parsed.data;
    const state = connection.state as unknown as ConnState | null;
    if (state?.viewingWorkerId !== cmd.workerId) {
      this.sendError(connection, "forbidden", `subscribe to ${cmd.workerId} before sending worker_cmd`, cmd.id);
      return;
    }
    this.sql`INSERT OR REPLACE INTO web_cmd_relay (cmdId, webConnId, createdAt) VALUES (${cmd.id}, ${connection.id}, ${Date.now()})`;
    const outcome =
      cmd.kind === "send"
        ? await this.dispatcher.sendToWorker({
            workerId: cmd.workerId,
            text: cmd.args?.text ?? "",
            intent: cmd.args?.intent ?? "auto",
            provenance: "web_direct",
            cmdId: cmd.id,
          })
        : await this.dispatcher.interruptWorker({
            workerId: cmd.workerId,
            ...(cmd.args?.then !== undefined ? { then: cmd.args.then } : {}),
            provenance: "web_direct",
            cmdId: cmd.id,
          });
    if (outcome.kind === "refused") {
      // Never reached `outbox` (unknown/broken worker, empty text): no cmd_ack is ever
      // coming, so answer directly instead of leaving the browser waiting.
      this.sql`DELETE FROM web_cmd_relay WHERE cmdId = ${cmd.id}`;
      this.sendError(connection, "bad_request", outcome.reason, cmd.id);
    }
  }

  /** Forwards a real cmd_ack/cmd_result to the browser that issued a web-direct worker_cmd, if
   *  any is waiting; `terminal` clears the relay row (the command will not answer again). */
  private relayWebCmd(cmdId: string, payload: unknown, terminal: boolean): void {
    const relay = this.sql<{ webConnId: string }>`SELECT webConnId FROM web_cmd_relay WHERE cmdId = ${cmdId}`[0];
    if (!relay) return;
    this.getConnection(relay.webConnId)?.send(JSON.stringify(payload));
    if (terminal) this.sql`DELETE FROM web_cmd_relay WHERE cmdId = ${cmdId}`;
  }

  /** Alarm-driven §6.6 termination: relays older than the TTL disappear, browser or not. */
  async sweepHistoryRelays(): Promise<void> {
    this.relaySweepAt = 0;
    this.sql`DELETE FROM history_relay WHERE expiresAt <= ${Date.now()}`;
    const next = this.sql<{ m: number | null }>`SELECT MIN(expiresAt) AS m FROM history_relay`[0]?.m;
    if (typeof next === "number") {
      const delayS = Math.max(1, Math.ceil((next - Date.now()) / 1000));
      this.relaySweepAt = Date.now() + delayS * 1000;
      void this.schedule(delayS, "sweepHistoryRelays");
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
      for (const pending of this.directoryReads.values()) {
        if (pending.connectionId === other.id) pending.finish({ ok: false, code: "machine_offline" });
      }
    }
    connection.setState({ deviceId: auth.deviceId, epoch: auth.epoch, keyId: auth.keyId, connEpoch: hello.connEpoch, directoryBrowse: hello.capabilities?.directoryBrowse === true } satisfies ConnState);
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
    // ambiguous rows are never re-delivered (§4.2) — the steward is woken to ask (issue #15).
    for (const pending of hello.pendingAcks) {
      const command = this.sql<{ deviceId: string }>`SELECT deviceId FROM outbox WHERE cmdId = ${pending.cmdId}`[0];
      if (command?.deviceId !== auth.deviceId) continue;
      if (pending.state === "ambiguous") {
        // pr_worker rows route to the consent gate's own deterministic answer inside
        // (issue #21); every other kind gets #15's wake-to-ask.
        this.markCommandAmbiguous(pending.cmdId, "hello.pendingAcks");
      } else if (pending.state === "done" || pending.state === "failed") {
        // The connector resolved the command from session-tail evidence before connecting:
        // settle the row from the snapshot (its stored result rode hello as a duplicate-ack
        // payload; here the state is what matters). A recovered not_delivered surfaces like
        // any delivery failure — except start_worker, whose worker-break event (emitted by
        // the connector's own §9.1 reconciliation) already tells the user.
        this.sql`
          UPDATE outbox SET state = ${pending.state}
          WHERE cmdId = ${pending.cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
        `;
        const changed = this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
        if (changed && pending.state === "failed" && pending.code === "not_delivered") {
          const row = this.sql<{ workerId: string | null; kind: string }>`
            SELECT workerId, kind FROM outbox WHERE cmdId = ${pending.cmdId}
          `[0];
          if (row?.workerId && row.kind !== "start_worker") {
            this.noteCommandAttention(pending.cmdId, "not_delivered", "connector restarted before the command reached the agent");
          }
        }
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

  private handleCmdAck(deviceId: string | undefined, raw: unknown): void {
    const parsed = CmdAckMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const ack = parsed.data;
    const row = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${ack.re}`[0];
    if (!row || row.deviceId !== deviceId) return;
    if (ack.status === "accepted") {
      this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
      this.relayWebCmd(ack.re, ack, false);
    } else if (ack.status === "duplicate") {
      if (ack.result) {
        if (row.kind === "register_repo") return this.settleDirectoryRegistration(row, ack.result);
        this.sql`
          UPDATE outbox SET state = ${ack.result.ok ? "done" : "failed"}, result = ${JSON.stringify(ack.result)}
          WHERE cmdId = ${ack.re}
        `;
        this.relayWebCmd(ack.re, ack, true);
      } else {
        this.sql`UPDATE outbox SET state = 'accepted' WHERE cmdId = ${ack.re} AND state IN ('sent', 'queued')`;
        this.relayWebCmd(ack.re, ack, false);
      }
    } else if (ack.status === "rejected") {
      if (row.kind === "register_repo") return this.settleDirectoryRegistration(row, { ok: false, error: { code: ack.code ?? "registration_failed" } });
      this.sql`
        UPDATE outbox SET state = 'failed', failReason = 'rejected', result = ${JSON.stringify({ code: ack.code ?? null })}
        WHERE cmdId = ${ack.re}
      `;
      this.noteCommandFailure(ack.re, `连接器拒绝（${ack.code ?? "未知原因"}）`);
      this.relayWebCmd(ack.re, ack, true);
    } else if (ack.status === "ambiguous") {
      // protocol §4.2: a crash during `sending`, undecidable — no automatic re-send. The row
      // is marked ambiguous; #15 wakes the steward to ask, except pr_worker rows, which the
      // consent gate answers deterministically (issue #21).
      this.markCommandAmbiguous(ack.re, "cmd_ack");
      this.relayWebCmd(ack.re, ack, true);
    }
  }

  private handleCmdResult(deviceId: string | undefined, raw: unknown): void {
    const parsed = CmdResultMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const result = parsed.data;
    const command = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${result.re}`[0];
    if (!command || command.deviceId !== deviceId) return;
    if (command.kind === "register_repo") return this.settleDirectoryRegistration(command, result);
    const wasFailed = this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${result.re}`[0]?.state === "failed";
    this.sql`
      UPDATE outbox SET state = ${result.ok ? "done" : "failed"}, result = ${JSON.stringify(result.ok ? result.data ?? null : result.error ?? null)}
      WHERE cmdId = ${result.re}
    `;
    this.relayWebCmd(result.re, result, true);
    if (result.ok) {
      // Review finding 4 (#57): a pr_worker settles with the URL even when its pr_created
      // event was lost (the connector's emit raced a shutdown). This backstop delivers the
      // card from the command result; idempotent against the event path — whichever lands
      // first wins, the other no-ops on the already-set url (so redeliveries are free).
      const row = this.sql<{ workerId: string | null; kind: string }>`
        SELECT workerId, kind FROM outbox WHERE cmdId = ${result.re}
      `[0];
      const data = (result.data ?? {}) as { url?: unknown; branch?: unknown };
      if (row?.kind === "pr_worker" && row.workerId && typeof data.url === "string" && data.url !== "") {
        if (this.ledger.prConsent.settleFromCommand(result.re, data.url, typeof data.branch === "string" ? data.branch : "")) {
          void this.drainNotifications();
        }
      }
      return;
    }
    if (!wasFailed) {
      const error = (result.error ?? {}) as { code?: unknown; message?: unknown };
      const reason = [typeof error.code === "string" ? error.code : null, typeof error.message === "string" ? error.message : null]
        .filter((part): part is string => part !== null)
        .join("：") || "未知原因";
      this.noteCommandFailure(result.re, reason);
      // Issue #15: two failure classes carry their own user-facing story — a session the
      // owner is using at the keyboard (§10), and an instruction the connector provably
      // never delivered (§6.3 recovery). Both land on the timeline and wake the steward;
      // the ordinary tool says the delivery happened, so silence would mislead.
      const code = typeof error.code === "string" ? error.code : null;
      if (code === "session_in_use" || code === "not_delivered") {
        this.noteCommandAttention(result.re, code, typeof error.message === "string" ? error.message : "");
      }
    }
  }

  private settleDirectoryRegistration(row: OutboxRow, result: CmdResult): void {
    if (row.state === "done" || row.state === "expired" || row.state === "ambiguous" || (row.state === "failed" && row.failReason !== "ack_timeout")) return;
    const parsed = RegisterRepoResultSchema.safeParse(result.data);
    if (result.ok && parsed.success) {
      this.ledger.repos.recordRegistration(row.deviceId, parsed.data.repo);
      this.sql`UPDATE outbox SET state = 'done', result = ${JSON.stringify(parsed.data)}, failReason = NULL WHERE cmdId = ${row.cmdId}`;
    } else {
      const error = result.error;
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "registration_failed";
      this.sql`UPDATE outbox SET state = 'failed', result = ${JSON.stringify({ code })}, failReason = 'registration_failed' WHERE cmdId = ${row.cmdId}`;
    }
  }

  /** A delivery-class failure the user should hear about even without the LLM's help: a
   *  deterministic timeline note plus a wake (the steward relays/asks). Idempotent on the
   *  cmdId through the wake's dedupeKey. */
  private noteCommandAttention(cmdId: string, code: string, message: string): void {
    const row = this.sql<{ workerId: string | null; kind: string; payload: string }>`
      SELECT workerId, kind, payload FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || !row.workerId) return;
    const worker = this.ledger.workers.get(row.workerId);
    if (!worker) return;
    const instruction = commandInstruction(row.kind, row.payload);
    // The instruction is model- or user-authored text: marker-escape it everywhere it is
    // embedded (the ⟦…⟧ policy every wake builder follows — review #48 finding 5).
    const safe = escapeMarkers(instruction);
    const text =
      code === "session_in_use"
        ? `「${safe}」没有送达：这个会话此刻正被机器上的另一个 pi 进程使用（可能是本人在键盘上继续）。`
        : `「${safe}」没有送达：连接器在投递前重启了，worker 从未收到这条指令。`;
    this.ledger.timeline.add(worker.threadId, "note", text, { cmdId, workerId: row.workerId, code });
    this.ledger.wakes.queue(
      "event",
      `attention:${cmdId}`,
      commandAttentionWakeText({
        threadId: worker.threadId,
        workerId: worker.workerId,
        kind: row.kind,
        instruction: safe,
        code,
        detail: text,
      }),
      { priority: "high" },
    );
    void this.drainWakes();
  }

  // A start_worker the connector could not run: the worker lands `broken`, the failure reaches
  // the timeline + the user deterministically (there is no LLM to relay it in M1). Idempotent
  // on the cmdId — cmd_result redeliveries re-run this handler. `stageHint` (issue #21) lets
  // callers without a settled result pick the pr_failed card's stage (the idle sweep's
  // timeout is a *delivery* failure, not an execution one).
  private noteCommandFailure(cmdId: string, reason: string, stageHint?: string): void {
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
    // A pr_worker that never succeeded (issue #21): the connector's own failures arrive as
    // pr_failed events (which call the same sink — the first one wins, no double card); this
    // path covers rejections at the door and results the event stream already reported.
    if (row.kind === "pr_worker") {
      // Review finding 3: the result's error code carries the connector's classification —
      // map it back so the card keeps the stage-specific fix even when this path wins the
      // race against the pr_failed event (fail() dedupes whichever lands second).
      const resultRaw = this.sql<{ result: string | null }>`SELECT result FROM outbox WHERE cmdId = ${cmdId}`[0]?.result;
      let code: string | null = null;
      let message: string | null = null;
      try {
        const parsed = resultRaw ? (JSON.parse(resultRaw) as { code?: unknown; message?: unknown }) : null;
        if (typeof parsed?.code === "string") code = parsed.code;
        if (typeof parsed?.message === "string" && parsed.message !== "") message = parsed.message;
      } catch {
        // result unreadable — the generic reason stands
      }
      const stage = stageHint ?? PR_ERROR_CODE_TO_STAGE[code ?? ""] ?? "command";
      if (this.ledger.prConsent.fail({ workerId: row.workerId, cmdId, stage, message: message ?? reason })) {
        void this.drainNotifications();
      }
      return;
    }
    if (row.kind !== "start_worker") return;
    if (this.ledger.workers.markStartFailed(row.workerId, cmdId, reason)) {
      void this.drainNotifications();
    }
  }

  /** Issue #15 / protocol §4.2: the connector reported a command `ambiguous` (a crash during
   *  `sending` — delivery unknowable). Mark the outbox row ambiguous (never re-sent) and wake
   *  the steward to ask the user; idempotent on the cmdId via the wake's dedupeKey.
   *  Exception: a pr_worker routes to the consent gate's own deterministic answer (issue #21,
   *  review finding 2) — an "ask the user" wake would only second-guess the card that already
   *  tells them exactly what to do (check the repo, re-tap to retry). */
  private markCommandAmbiguous(cmdId: string, via: string): void {
    // Idempotency gate: the wake/note fire only when this call actually transitioned the
    // row (duplicate cmd_acks and repeated hellos find it already ambiguous).
    this.sql`
      UPDATE outbox SET state = 'ambiguous' WHERE cmdId = ${cmdId} AND state NOT IN ('done', 'failed', 'expired', 'ambiguous')
    `;
    const changed = this.sql<{ changes: number }>`SELECT changes() AS changes`[0]!.changes > 0;
    if (!changed) return;
    const row = this.sql<{ workerId: string | null; kind: string; payload: string }>`
      SELECT workerId, kind, payload FROM outbox WHERE cmdId = ${cmdId}
    `[0];
    if (!row || !row.workerId) return;
    if (row.kind === "pr_worker") {
      this.markPrWorkerAmbiguous(row.workerId, cmdId);
      return;
    }
    const worker = this.ledger.workers.get(row.workerId);
    if (!worker) return;
    const instruction = escapeMarkers(commandInstruction(row.kind, row.payload));
    this.ledger.timeline.add(
      worker.threadId,
      "note",
      `命令结果不确定（${via}）：连接器在投递「${instruction}」时崩溃，无法判断 worker 是否已收到。不会自动重发。`,
      { cmdId, workerId: row.workerId, ambiguous: true },
    );
    this.ledger.wakes.queue(
      "event",
      `ambiguous:${cmdId}`,
      ambiguousWakeText({ thread: this.ledger.threads.get(worker.threadId), worker, cmdId, kind: row.kind, instruction }),
      { priority: "high" },
    );
    void this.drainWakes();
  }

  /**
   * The consent gate's ambiguous answer (issue #21, review finding 2 of #57): an ambiguous
   * pr_worker must not wedge the consent row in "in flight" forever. The outcome is
   * undecidable — the PR may or may not exist — which is itself an answer the owner needs;
   * a later replayed pr_created (persist-first §11.3) heals the row with the URL. fail() is
   * idempotent, so the duplicate hello/pendingAck redeliveries are free.
   */
  private markPrWorkerAmbiguous(workerId: string, cmdId: string): void {
    if (
      this.ledger.prConsent.fail({
        workerId,
        cmdId,
        stage: "ambiguous",
        message: "连接器在执行中途失联，PR 是否已创建无法确定",
      })
    ) {
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
    for (const intent of this.ledger.notifications.pending()) {
      try {
        const rendered = await this.renderNotification(intent);
        if (rendered === null) {
          // Its data is gone (thread archived / worker pruned), or the news evaporated (a
          // drop that healed inside the debounce window): remove the intent rather than
          // retry forever — and never count it as "the owner was told".
          this.ledger.notifications.drop(intent.id);
          continue;
        }
        const question = intent.questionId !== null ? this.ledger.questions.get(intent.questionId) : null;
        const questionTied = question !== null && question.status === "open";
        const thread = this.ledger.threads.get(intent.threadId);
        // Issue #11 (spec §7.6): an ordinary done report is QUIET — it merges over the
        // 60-second window instead of buzzing the phone. Everything the reducer queues for
        // the user's attention (question-bound reports, stalls, failures) pushes at once,
        // and a done report on a Thread already waiting on the user pushes too. Issue #21:
        // a done report carrying the consent ask is waiting_you in card form — [同意]/[先不
        // 要] cannot ride a merged card (sections carry no buttons, and one merged message
        // settles N member rows' providerMsgIds, which would break the tap's §3.1 routing) —
        // so it pushes on its own, buttons intact.
        const quiet =
          intent.kind === "done_report" &&
          !questionTied &&
          thread?.state !== "waiting_you" &&
          rendered.holdsConsentAsk !== true;
        await this.enqueueOutbound({
          kind: "card",
          to: OWNER_ID,
          // Stable id (issue #21): the done card's [同意]/[先不要] resolves through this id
          // (`notify:report:<workerId>:<seq>`) on callback — the §3.1 rule applied to consent.
          id: `notify:${intent.dedupeKey}`,
          threadId: intent.threadId,
          questionId: questionTied && question!.threadId !== null ? question!.qid : null,
          card: rendered.card,
          urgency: quiet ? "quiet" : "push",
          ...(quiet && rendered.section !== undefined ? { part: rendered.section } : {}),
        });
        this.ledger.notifications.markSent(intent.id);
      } catch (err) {
        this.logChannel("notify_drain_failed", `${intent.id} ${errorText(err)}`);
      }
    }
    this.rearmNoticeDrain(); // a still-debounced intent needs its own wake
  }

  /** Deterministic core templates (steward.md §6.2 source 1): data in, card out, no LLM.
   *  Done reports also carry their merge section (issue #11) so a quiet window folds several
   *  threads into one card that keeps each one's three parts. */
  private async renderNotification(intent: NotifyRow): Promise<
    { card: unknown; section?: QuietSection; holdsConsentAsk?: boolean } | null
  > {
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
      return { card: machineOfflineCard(machineName, thread.title, footer) };
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
      return { card: machineOnlineCard(machineName, thread.title, outcome, footer) };
    }
    if (intent.kind === "waited_started") {
      return { card: waitedStartCard(machineName, thread.title, footer, detailsUrl ?? undefined) };
    }

    if (intent.kind === "done_report") {
      // The intent's own seq (its dedupeKey is `report:<workerId>:<seq>`), so the consent
      // gate binds to the report this card rendered — not to a newer one that arrived in
      // between (issue #21: the [同意] tap must key on exactly what the user saw).
      const seqMatch = /^report:([^:]+):(\d+)$/.exec(intent.dedupeKey);
      const report = seqMatch
        ? (this.ledger.workers.reportsForWorker(seqMatch[1]!)?.find((r) => r.seq === Number(seqMatch[2])) ??
          this.ledger.workers.reportsForWorker(worker.workerId).at(-1))
        : this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      if (!report) return null;
      const needsYou = needsYouOf(report);
      // Issue #21 × #11: a consent-carrying done report asks the user ([同意]/[先不要]) — it
      // pushes as its own card (see drainNotifyPass) and never contributes a merge section
      // (sections carry no buttons). Ordinary completions keep #11's quiet merge.
      const consent = prConsentFor(report, worker);
      return {
        card: reportCardFor(report, worker, machineName, thread.title, detailsUrl ?? undefined),
        ...(consent
          ? { holdsConsentAsk: true }
          : {
              // The merge section (issue #11): the same three parts the single card renders,
              // kept per Thread when several done reports share one quiet window.
              section: {
                kind: "report",
                tone: toneOfReport(report.status),
                conclusion: report.summary,
                did: didBullets(report),
                ...(needsYou !== undefined ? { needsYou } : {}),
                threadTitle: thread.title,
                ...(detailsUrl ? { detailsUrl } : {}),
              } satisfies QuietSection,
            }),
      };
    }

    // The consent gate's async answers (issue #21): the PR URL, or the classified failure —
    // both deterministic, both from the payload the reducer attached to the intent. Both are
    // the user's awaited answer to their own tap: push, never a merge section.
    if (intent.kind === "pr_created") {
      const payload = parseNotifyPayload(intent.payload);
      return {
        card: prCreatedCard({
          url: payload.url ?? "",
          branch: payload.branch ?? "",
          threadTitle: thread.title,
          footer,
          detailsUrl: detailsUrl ?? undefined,
        }),
      };
    }
    if (intent.kind === "pr_failed") {
      const payload = parseNotifyPayload(intent.payload);
      return {
        card: failureCard(
          "推送 / 创建 PR 失败",
          prFailureNeedsYou(String(payload.stage ?? ""), String(payload.message ?? "")),
          thread.title,
          footer,
          detailsUrl ?? undefined,
        ),
      };
    }

    // §5.3 (issue #10): a blocked/needs_decision question that nothing handled within the
    // window — the worker's question reaches the user verbatim, from data, with no LLM.
    // settle:transient never gets here (it queues no question and no intent); error/unreported
    // classes have their own failure_push rendering below.
    if (intent.kind === "attention_report" && intent.questionId !== null) {
      const question = this.ledger.questions.get(intent.questionId);
      if (!question) return null;
      const report = this.ledger.workers.reportsForWorker(worker.workerId).at(-1);
      return {
        card: workerQuestionCard({
          question: question.text,
          ...(report?.summary ? { summary: report.summary } : {}),
          ...(report?.changes?.length ? { did: didBullets(report) } : {}),
          threadTitle: thread.title,
          footer,
          detailsUrl: detailsUrl ?? undefined,
        }),
      };
    }

    // stall_notice (§8.4): attention, not failure — the run may still be a very long tool
    // call. The minutes are recomputed at render time (no event has arrived since the stall,
    // or the intent would have been for a different, newer stall).
    if (intent.kind === "stall_notice") {
      const minutes = Math.max(1, Math.round((Date.now() - (worker.lastEventAt ?? worker.createdAt)) / 60_000));
      return { card: stallCard(minutes, worker, machineName, thread.title, footer, detailsUrl ?? undefined) };
    }

    // failure_push: either the start never happened or the run ended in a failure class that
    // needs a human (steward.md §5.3); the matching open question carries the specifics.
    if (worker.lastOutcome?.startsWith("resume_failed:")) {
      return {
        card: failureCard(
          `接续原会话失败`,
          `${worker.lastOutcome.slice("resume_failed:".length)}。原会话未受影响，重新说一次要做什么即可。`,
          thread.title,
          footer,
          detailsUrl ?? undefined,
        ),
      };
    }
    const needsYou =
      boundQuestion?.status === "open" && boundQuestion.text.trim().length > 0
        ? boundQuestion.text
        : "查看 Thread 时间线了解详情。";
    if (worker.lastOutcome?.startsWith("start_failed:")) {
      return {
        card: failureCard(
          `派发失败：任务没有开始`,
          `${worker.lastOutcome.slice("start_failed:".length)}。重新说一次要做什么即可。`,
          thread.title,
          footer,
          detailsUrl ?? undefined,
        ),
      };
    }
    return {
      card: failureCard(
        worker.lastOutcome === "unreported" ? "运行结束但没有汇报" : "运行出错，需要你决定下一步",
        needsYou,
        thread.title,
        footer,
        detailsUrl ?? undefined,
      ),
    };
  }

  // `/加机器` in chat and `POST /api/pairing` are the triggers (issue #22); `/pair` is the
  // only HTTP consumer of the code. The workspace's own mint is idempotent on the client's
  // request id (sh_web_pairing): a retried "add machine" gets the same code back, not a
  // second one.
  private async webPairing(id: string): Promise<{ code: string; expiresAt: number }> {
    const now = Date.now();
    this.sql`DELETE FROM sh_web_pairing WHERE expiresAt <= ${now}`;
    const existing = this.sql<{ code: string; expiresAt: number }>`SELECT code, expiresAt FROM sh_web_pairing WHERE id = ${id}`[0];
    if (existing) return existing;
    const result = { code: generatePairingCode(), expiresAt: now + 10 * 60_000 };
    this.ctx.storage.transactionSync(() => {
      this.sql`INSERT INTO pairing (code, expiresAt) VALUES (${result.code}, ${result.expiresAt})`;
      this.sql`INSERT INTO sh_web_pairing (id, code, expiresAt) VALUES (${id}, ${result.code}, ${result.expiresAt})`;
    });
    return result;
  }

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
    for (const pending of this.directoryReads.values()) {
      if (pending.deviceId === deviceId) pending.finish({ ok: false, code: "not_found" });
    }
    for (const connection of this.getConnections<ConnState>(`dev:${deviceId}`)) {
      connection.close(CloseCode.REVOKED, "revoked");
    }
  }

  private browseMachineDirectory(input: MachineDirectoryBrowseInput, signal: AbortSignal): Promise<DirectoryListing> {
    const device = this.sql<{ revoked: number }>`SELECT revoked FROM device WHERE deviceId = ${input.deviceId}`[0];
    if (!device || device.revoked) throw new WorkspaceError("not_found", 404);
    const connection = this.connFor(input.deviceId);
    if (!connection) throw new WorkspaceError("machine_offline", 409);
    const connectionState = connection.state as ConnState | null;
    if (!connectionState?.directoryBrowse) throw new WorkspaceError("unsupported", 409);
    if (this.directoryReads.size >= 32) throw new WorkspaceError("busy", 429);
    const id = ulid();
    return new Promise((resolve, reject) => {
      const finish = (result: DirectoryReadResult) => {
        if (!this.directoryReads.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (result.ok) resolve(result.listing);
        else {
          const status = { not_found: 404, forbidden: 403, invalid_directory: 400, unsupported: 409, machine_offline: 409, busy: 429, browse_timeout: 504, browse_failed: 502 }[result.code];
          reject(new WorkspaceError(result.code, status));
        }
      };
      const abort = () => finish({ ok: false, code: "browse_failed" });
      const timer = setTimeout(() => finish({ ok: false, code: "browse_timeout" }), this.directoryBrowseTimeoutMs);
      this.directoryReads.set(id, { deviceId: input.deviceId, connectionId: connection.id, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      const { deviceId: _, ...args } = input;
      try {
        connection.send(JSON.stringify({ t: "directory_list", id, ...args } satisfies DirectoryListMessage));
      } catch {
        finish({ ok: false, code: "machine_offline" });
      }
    });
  }

  private handleDirectoryListing(connection: Connection, raw: unknown): void {
    if (raw === null || typeof raw !== "object" || !("re" in raw) || typeof raw.re !== "string") return;
    const pending = this.directoryReads.get(raw.re);
    const state = connection.state as ConnState | null;
    if (!pending || pending.connectionId !== connection.id || pending.deviceId !== state?.deviceId) return;
    const parsed = DirectoryListingMessageSchema.safeParse(raw);
    pending.finish(parsed.success ? parsed.data : { ok: false, code: "browse_failed" });
  }

  private async addMachineDirectory(input: MachineDirectoryInput): Promise<MachineDirectoryResult> {
    const cmdId = `web-directory:${input.id}`;
    const payload = JSON.stringify({ path: input.path });
    const previous = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0];
    if (previous && (previous.deviceId !== input.deviceId || previous.kind !== "register_repo" || previous.payload !== payload)) {
      throw new WorkspaceError("id_conflict", 409);
    }
    const device = this.sql<{ revoked: number }>`SELECT revoked FROM device WHERE deviceId = ${input.deviceId}`[0];
    if (!device || device.revoked) throw new WorkspaceError("not_found", 404);
    if (!previous) {
      if (!this.connFor(input.deviceId)) throw new WorkspaceError("machine_offline", 409);
      await this.enqueue(input.deviceId, "register_repo", { path: input.path }, { cmdId, notAfter: Date.now() + 120_000 });
      this.logChannel("web_directory_requested", input.deviceId);
    }
    const row = this.sql<OutboxRow>`SELECT * FROM outbox WHERE cmdId = ${cmdId}`[0]!;
    const stored: unknown = row.result ? JSON.parse(row.result) : null;
    if (row.state === "done") {
      const parsed = RegisterRepoResultSchema.safeParse(stored);
      return parsed.success ? { state: "done", id: input.id, repo: parsed.data.repo } : { state: "failed", id: input.id, code: "registration_failed" };
    }
    if (row.failReason === "not_after") return { state: "failed", id: input.id, code: "outcome_unknown" };
    if (row.state === "failed" && row.failReason !== "ack_timeout") {
      const code = stored !== null && typeof stored === "object" && "code" in stored && typeof stored.code === "string" ? stored.code : "registration_failed";
      return { state: "failed", id: input.id, code };
    }
    if (row.state === "ambiguous" || row.state === "expired" || (row.notAfter !== null && row.notAfter <= Date.now())) {
      return { state: "failed", id: input.id, code: "outcome_unknown" };
    }
    return { state: "pending", id: input.id };
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
        // §6.8: a web-direct command that never got an ack at all — the browser would
        // otherwise wait forever with no feedback.
        this.relayWebCmd(row.cmdId, { t: "cmd_result", re: row.cmdId, ok: false, error: { code: "ack_timeout" } }, true);
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
    const lapsed = this.sql<{ cmdId: string; kind: string }>`
      SELECT cmdId, kind FROM outbox
      WHERE state = 'queued' AND notAfter IS NOT NULL AND notAfter <= ${nowMs}
    `;
    for (const row of lapsed) {
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'not_after' WHERE cmdId = ${row.cmdId} AND state = 'queued'`;
    }
    const cutoff = nowMs - IDLE_FAIL_MS;
    const stale = this.sql<{ cmdId: string; kind: string }>`SELECT cmdId, kind FROM outbox WHERE state = 'queued' AND createdAt <= ${cutoff} AND held = 0`;
    for (const row of stale) {
      this.sql`UPDATE outbox SET state = 'failed', failReason = 'idle' WHERE cmdId = ${row.cmdId}`;
      // Issue #21: a pr_worker the machine never came back for must not vanish silently —
      // the consent click promised an answer, so the failure reaches the owner as a card
      // (the `delivery` stage fits: the instruction never reached the machine).
      // (start_worker rows keep their existing quiet path: the worker sweep owns those.)
      if (row.kind === "pr_worker") this.noteCommandFailure(row.cmdId, "机器长时间未上线，指令超时未送达", "delivery");
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
  // Owner channel (ADR-0003): /api/* inbound + actions, locally-rendered outbound queue
  // =================================================================================================

  // Single-flight delivery: concurrent passes (inline enqueue fire + alarm + explicit calls)
  // chain here instead of racing. Without this, two passes could interleave around the
  // per-receiver pacing sleep and burst past the 5 QPS cap; the claim token still guards the
  // row itself, this keeps the *wire* quiet too.
  private deliveryChain: Promise<void> = Promise.resolve();

  // ---- Model credentials (spec §12.2 "model keys stored encrypted", issues #27/#74) ---------------
  // Provider API keys are AES-GCM sealed under the deployment key exactly like Feishu secrets
  // (sh_provider_key.apiKeyEnc, one row per provider); the plaintext exists only in transit
  // and in memory. sh_model id=0 is the active selection and mirrors the selected provider's
  // key for pre-#74 readers. Not reachable over HTTP — RPC on the stub only, which the
  // routes-audit test pins down.

  // ADR-0001 decision 11: the default provider for keys collected at deploy time (the model
  // itself is deepseek-flash); M2's setup/chat step can reconfigure via setModelConfig.
  static readonly DEFAULT_MODEL_PROVIDER = "deepseek";

  /**
   * `apiKey` omitted (issue #74) means "keep the key already sealed for this provider" —
   * switching provider or model no longer re-asks for a saved key. `modelId`/`baseUrl` are
   * present for an owner-driven runtime switch (issue #70, the Settings page): once set,
   * they win over vars.STEWARD_MODEL entirely (ensureRootModel). Omitting them (the
   * MODEL_KEY seed path, and the pre-#70 provider-only form) keeps the legacy behavior —
   * vars still supply modelId/baseUrl.
   */
  async setModelConfig(provider: string, apiKey?: string, modelId?: string, baseUrl?: string, thinkingLevel?: ModelThinkingLevel): Promise<void> {
    if (!provider.trim()) throw new Error("provider is required");
    const providerId = provider.trim();
    const [primary] = await this.serverKeys();
    const key = apiKey?.trim() || "";
    // No key given: the selection moves to a provider whose key was sealed earlier, so mirror
    // that stored key — a pre-#74 reader of sh_model keeps seeing a matching provider+key.
    const sealedKey = key || (await this.sealedKeyFor(providerId)) || "";
    const apiKeyEnc = sealedKey ? await sealSecret(primary!, sealedKey) : "";
    if (key) {
      this.sql`
        INSERT INTO sh_provider_key (provider, apiKeyEnc, updatedAt)
        VALUES (${providerId}, ${await sealSecret(primary!, key)}, ${Date.now()})
        ON CONFLICT(provider) DO UPDATE SET
          apiKeyEnc = excluded.apiKeyEnc, updatedAt = excluded.updatedAt
      `;
    }
    const modelIdValue = modelId?.trim() || null;
    const baseUrlValue = baseUrl?.trim() || null;
    const previous = this.sql<{ provider: string; modelId: string | null; thinkingLevel: ModelThinkingLevel | null }>`SELECT provider, modelId, thinkingLevel FROM sh_model WHERE id = 0`[0];
    const thinkingValue = thinkingLevel ?? (previous?.provider === providerId && previous.modelId === modelIdValue ? previous.thinkingLevel : null);
    this.sql`
      INSERT INTO sh_model (id, provider, apiKeyEnc, modelId, baseUrl, thinkingLevel, updatedAt)
      VALUES (0, ${providerId}, ${apiKeyEnc}, ${modelIdValue}, ${baseUrlValue}, ${thinkingValue}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider, apiKeyEnc = excluded.apiKeyEnc,
        modelId = excluded.modelId, baseUrl = excluded.baseUrl, thinkingLevel = excluded.thinkingLevel, updatedAt = excluded.updatedAt
    `;
    // The LLM wiring (issue #6) installs the sealed selection lazily (ensureRootModel, before
    // the next submit) — resetting the memo is enough; the models collection handed to pi at
    // open stays the same object and is re-keyed in place. The faux provider's scripted state
    // is per-isolate and never rebuilt.
    this.appliedRootModel = undefined;
    const frame = JSON.stringify({ t: "model_changed" });
    for (const connection of this.getConnections(WORKSPACE_TAG)) if (this.webConnectionAlive(connection)) connection.send(frame);
  }

  private async selectComposerModel(input: ComposerModelInput) {
    const model = providerCatalog().find((provider) => provider.id === input.provider)?.models.find((entry) => entry.id === input.modelId);
    if (!model || !(await this.sealedKeyFor(input.provider))) throw new WorkspaceError("model_not_available");
    if (!model.thinkingLevels.includes(input.thinkingLevel)) throw new WorkspaceError("thinking_not_supported");
    if (await this.piHarness.session().busy()) throw new WorkspaceError("model_busy", 409);
    await this.setModelConfig(input.provider, undefined, input.modelId, undefined, input.thinkingLevel);
    await this.ensureRootModel();
    return this.llmSelection();
  }

  private async sealedKeyFor(provider: string): Promise<string | null> {
    const row = this.sql<{ apiKeyEnc: string }>`SELECT apiKeyEnc FROM sh_provider_key WHERE provider = ${provider}`[0];
    if (!row) return null;
    const opened = await openSecret(await this.serverKeys(), row.apiKeyEnc);
    return opened?.text ?? null;
  }

  async modelConfig(): Promise<{ provider: string; modelId: string | null; baseUrl: string | null; apiKey: string; thinkingLevel?: ModelThinkingLevel } | null> {
    // One-click-deploy glue (issue #25, spec §12.1 step 1): MODEL_KEY — the secret the
    // Deploy-to-Cloudflare form collects — seeds the sealed config on first read, so the key
    // never lives anywhere outside the user's own account. Seeding fills an empty deployment
    // only: an explicit setModelConfig (any provider's saved key counts, issue #74) always
    // wins, and the env secret is dead weight once a sealed row exists (delete it if you like).
    if (
      this.env.MODEL_KEY?.trim() &&
      this.sql`SELECT 1 AS one FROM sh_model WHERE id = 0`.length === 0 &&
      !this.sql`SELECT 1 AS one FROM sh_provider_key WHERE provider = ${Steward.DEFAULT_MODEL_PROVIDER}`.length
    ) {
      await this.setModelConfig(Steward.DEFAULT_MODEL_PROVIDER, this.env.MODEL_KEY.trim());
    }
    const row = this.sql<{ provider: string; modelId: string | null; baseUrl: string | null; thinkingLevel: ModelThinkingLevel | null }>`
      SELECT provider, modelId, baseUrl, thinkingLevel FROM sh_model WHERE id = 0
    `[0];
    if (!row) return null;
    // The key lives with the provider now (issue #74): a selection whose provider has no
    // sealed key still resolves, keyless — apiKey: "" — and fails visibly at run time.
    return { provider: row.provider, modelId: row.modelId, baseUrl: row.baseUrl, ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}), apiKey: (await this.sealedKeyFor(row.provider)) ?? "" };
  }

  /** Providers with a sealed key (issue #74): what the Settings page marks as ready to switch to. */
  async keyedProviders(): Promise<string[]> {
    return this.sql<{ provider: string }>`SELECT provider FROM sh_provider_key ORDER BY provider`.map((row) => row.provider);
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
    thinkingLevel: ModelThinkingLevel;
    thinkingLevels: ModelThinkingLevel[];
  }> {
    const sealed = await this.modelConfig();
    // `varsRaw: null` models an unset deploy config; `undefined` (the production call) reads env.
    const vars = resolveModelConfig(varsRaw === undefined ? this.env.STEWARD_MODEL : varsRaw);
    const config = mergeModelSelection(sealed, vars);
    return {
      provider: config.provider,
      modelId: config.modelId,
      ...resolveModelThinking(config),
      baseUrl: config.baseUrl ?? null,
      explicitVars: vars.explicit,
      sealedProvider: sealed?.provider ?? null,
      apiKey: Boolean(sealed && sealed.provider === config.provider && sealed.apiKey),
      modelKnown: config.provider === "faux" || stewardProviders().some((p) => p.id === config.provider && p.getModels().some((m) => m.id === config.modelId)),
    };
  }

  // ---- Owner HTTP API (ADR-0003): the Worker pre-checked SERVER_KEY; these run in the DO ----

  /** POST /api/messages — the owner's text. `replyTo` quotes one of our sent messages (the
   *  outbound row id / merged group id), which routes deterministically before the model ever
   *  sees the text (§3.1 signal 1). Idempotent on the client-chosen `id`. */
  private async handleApiMessage(request: Request): Promise<Response> {
    let body: { text?: unknown; id?: unknown; replyTo?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const id = typeof body.id === "string" && body.id.length > 0 ? body.id : ulid();
    const replyTo = typeof body.replyTo === "string" && body.replyTo.length > 0 ? body.replyTo : undefined;
    // Persist before 200 (the old webhook path's rule, kept): the dedup insert is the durable
    // record; everything after it is sync SQL or a void-fired chain.
    if (this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'local' AND msgId = ${id}`.length > 0) {
      return Response.json({ id, deduped: true });
    }
    this.sql`
      INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized, text)
      VALUES ('local', ${id}, NULL, 'api', ${Date.now()}, 1, ${body.text})
    `;
    // The spend readout stays deterministic (issue #28): it must answer with the model gone.
    const command = parseOwnerCommand(body.text);
    if (command) {
      this.logChannel("owner_command", `${id} ${command.kind}`);
      await this.dispatcher.handleOwnerCommand(command);
      return Response.json({ id });
    }
    this.logChannel("owner_message", `${id} replyTo=${replyTo ?? "-"} ${body.text}`.slice(0, 500));
    await this.submitUserMessage({ msgId: id, text: body.text, parentId: replyTo });
    return Response.json({ id });
  }

  /** GET /api/messages?after=<sentAt-ms>&limit=N — the owner's read side: sent rows grouped
   *  by providerMsgId (a quiet-merged group shares one id and re-renders as one message). */
  private handleApiListMessages(url: URL): Response {
    const after = Number(url.searchParams.get("after") ?? 0) || 0;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    type SentRow = { id: string; providerMsgId: string | null; kind: string; payload: string; threadId: string | null; questionId: string | null; sentAt: number };
    const rows = this.sql<SentRow>`
      SELECT id, providerMsgId, kind, payload, threadId, questionId, sentAt FROM sh_outbound
      WHERE status = 'sent' AND sentAt > ${after} ORDER BY sentAt, id LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    // A merged quiet group shares one providerMsgId across text AND card members — the group
    // is one message (the old wire behavior: texts ride along inside the merged card).
    const groups = new Map<string, SentRow[]>();
    for (const row of page) {
      const key = row.providerMsgId ?? row.id;
      const members = groups.get(key);
      if (members) members.push(row);
      else groups.set(key, [row]);
    }
    const messages = [...groups.entries()].map(([id, members]) => {
      if (members.length > 1) {
        const sections = members
          .map((row) => sectionFromPayload(JSON.parse(row.payload) as { text?: string; card?: unknown; part?: QuietSection }))
          .filter((section): section is QuietSection => section !== null);
        return { id, text: mergeQuietOutbound(sections).text, threadId: null, questionId: null, buttons: [], sentAt: members[0]!.sentAt };
      }
      const row = members[0]!;
      const payload = JSON.parse(row.payload) as { text?: string; card?: LocalMessage };
      if (row.kind === "card" && payload.card) {
        return { id, text: payload.card.text ?? "", buttons: payload.card.buttons ?? [], threadId: row.threadId, questionId: row.questionId, sentAt: row.sentAt };
      }
      return { id, text: payload.text ?? "", buttons: [], threadId: row.threadId, questionId: row.questionId, sentAt: row.sentAt };
    });
    return Response.json({ messages, cursor: page.length > 0 ? page[page.length - 1]!.sentAt : after, hasMore });
  }

  /** POST /api/actions — a button callback on one of our messages (ask options, PR consent,
   *  note decisions, offline asks). Idempotent on (message, action). */
  private async handleApiActions(request: Request): Promise<Response> {
    let body: { cardMsgId?: unknown; action?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body.cardMsgId !== "string" || typeof body.action !== "string" || body.action.length === 0) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    // No request-level dedup on purpose: the handlers are idempotent (an answered question
    // gets its polite "already answered" reply; a consent re-tap retries), and Feishu-style
    // redelivery no longer exists. The sh_inbound row carries the provenance for answer relay.
    const msgId = `act:${body.cardMsgId}:${body.action}:${ulid()}`;
    this.sql`
      INSERT INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized)
      VALUES ('local', ${msgId}, NULL, 'action', ${Date.now()}, 1)
    `;
    this.logChannel("owner_action", `${body.cardMsgId} ${body.action}`);
    await this.dispatchCardAction({ msgId, action: body.action, cardMsgId: body.cardMsgId });
    return Response.json({ ok: true });
  }

  /** POST /api/pairing — the machine-add flow (was the chat /加机器 command): mints a
   *  one-time code and returns the exact connect command to run on the new machine. */
  private async handleApiPairing(): Promise<Response> {
    const origin = this.web.origin();
    if (!origin) return Response.json({ error: "origin_unknown" }, { status: 409 });
    const { code } = await this.createPairing();
    this.logChannel("pairing_minted", "api");
    return Response.json({ code, command: `npx @alexlikevibe/sig connect ${origin} ${code}` });
  }

  /** POST /api/login-link — a fresh one-time web login link (was the chat /网页 command). */
  private async handleApiLoginLink(): Promise<Response> {
    const url = await this.web.linkUrl("home");
    if (!url) return Response.json({ error: "origin_unknown" }, { status: 409 });
    return Response.json({ url });
  }

  /** A user message becomes one steward input, idempotent on the msgId (steward.md §9.1/§11).
   * `prefilledNote`/`routedThreadId` serve the ask-card clicks (#7): the click's choice is
   * submitted as a system-noted user action already routed to the picked Thread. */
  private async submitUserMessage(
    input: { msgId: string; text: string; parentId?: string; prefilledNote?: string; routedThreadId?: string | null },
  ): Promise<void> {
    const operationId = `user:${input.msgId}`;
    // Signal 1 (§3.1): a quote of one of our messages routes to that Thread directly.
    // A MERGED card (issue #11) spans several Threads — no single owner — so the reply
    // routes to the conversation (the steward decides which matter it belongs to) while
    // clearing unread on every Thread the card reported (§6.5: the reply means they were
    // all seen).
    const quotedThreadIds = input.parentId ? this.ledger.outbound.threadIdsForProviderMsg(input.parentId) : [];
    for (const quotedThreadId of quotedThreadIds) this.ledger.threads.markRead(quotedThreadId);
    const routed = input.routedThreadId ?? (quotedThreadIds.length === 1 ? quotedThreadIds[0]! : null);
    const routedRow = input.parentId ? this.ledger.outbound.rowForProviderMsg(input.parentId) : null;
    const routedThread = routed ? this.ledger.threads.get(routed) : null;
    // What the owner said belongs to the conversation the workspace shows (ADR-0004): a
    // typed message, a card choice, or an answer to a worker, with the Thread it landed on.
    // Idempotent on (channel, msgId); the COALESCE keeps a row already inserted without text.
    this.ledger.ownerInputs.record("local", input.msgId, input.text, routedThread?.threadId ?? null);
    if (routedThread && input.parentId) {
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
          : quotedThreadIds.length > 1
            ? `（系统注：这条消息是对一张合并汇报卡片的回复，覆盖 ${quotedThreadIds.length} 个 Thread；由你判断它属于哪件事。）\n`
            : "";
    const text = `${note}${escaped}`;
    const routedId = input.routedThreadId ?? routedThread?.threadId ?? null;
    if (!this.ledger.runs.open(operationId, "user", text, { replyTo: input.msgId, channel: "local", routedThreadId: routedId })) {
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

  /** In-flight workspace requests by key, so a retry that arrives while the first attempt is
   *  still running waits for it instead of racing it. */
  private readonly webInputs = new Map<string, Promise<void>>();

  /**
   * An owner message typed in the workspace (ADR-0004). The client's request id is the
   * idempotency key: the same id and payload is one effect no matter how many times it is
   * retried, and the same id with different content is refused rather than silently ignored.
   * The message enters the same local-channel conversation the API serves — one conversation,
   * two views.
   */
  private async submitWorkspaceMessage(input: WorkspaceInput): Promise<void> {
    const payload = JSON.stringify(input);
    const previous = this.ledger.webRequests.get(input.id);
    if (previous && previous.payload !== payload) throw new WorkspaceError("id_conflict", 409);
    if (previous?.status === "done") return;
    const pending = this.webInputs.get(input.id);
    if (pending) return pending;
    const thread = input.threadId ? this.ledger.threads.get(input.threadId) : null;
    if (input.threadId && !thread) throw new WorkspaceError("thread_not_found", 404);
    // Answering a card or message quotes it, exactly like an API `replyTo`: the card's
    // Thread (and a worker question bound to it) decide where the answer goes.
    const quoted = input.replyTo ? this.ledger.outbound.row(input.replyTo) : null;
    if (input.replyTo && !quoted) throw new WorkspaceError("reply_target_not_found", 404);
    const parentId = typeof quoted?.providerMsgId === "string" ? quoted.providerMsgId : undefined;
    if (!previous && this.ledger.runs.openRows().filter((r) => r.kind === "user").length >= MAX_OPEN_USER_RUNS) {
      throw new WorkspaceError("queue_full", 429);
    }
    const msgId = `web:${input.id}`;
    this.ctx.storage.transactionSync(() => {
      this.ledger.webRequests.start(input.id, payload);
    });
    const work = this.submitUserMessage({
      msgId, text: input.text, ...(parentId ? { parentId } : {}),
      routedThreadId: thread?.threadId ?? null,
      ...(thread ? { prefilledNote: `（系统注：用户指定这条消息归属 Thread「${escapeMarkers(thread.title)}」（${thread.threadId}）。）\n` } : {}),
    }).then(() => { this.ledger.webRequests.complete(input.id); }).finally(() => { this.webInputs.delete(input.id); });
    this.webInputs.set(input.id, work);
    return work;
  }

  /**
   * A button pressed on a card in the workspace. It enters the same handlers an API action
   * does — the outbound row behind the card, not the browser, decides what the button means.
   * The button must be one the card really carries, and the decision must still be open:
   * forged and stale taps are refused.
   */
  private async submitWorkspaceAction(input: WorkspaceActionInput): Promise<void> {
    const key = `action:${input.id}`;
    const payload = JSON.stringify(input);
    const previous = this.ledger.webRequests.get(key);
    if (previous && previous.payload !== payload) throw new WorkspaceError("id_conflict", 409);
    if (previous?.status === "done") return;
    const pending = this.webInputs.get(key);
    if (pending) return pending;
    const row = this.ledger.outbound.row(input.cardId);
    if (!row || row.kind !== "card") throw new WorkspaceError("card_not_found", 404);
    const view = cardView((JSON.parse(String(row.payload)) as { card?: unknown }).card);
    if (!view.buttons.some((button) => button.action === input.action)) throw new WorkspaceError("bad_action", 400);
    const questionId = typeof row.questionId === "string" ? row.questionId : null;
    if (!previous && !cardOpen(this.ledger, { id: input.cardId, questionId }, view)) throw new WorkspaceError("already_handled", 409);
    // Handlers find the card again through its provider message id; a local-channel card
    // always has one once settled.
    const cardMsgId = typeof row.providerMsgId === "string" ? row.providerMsgId : null;
    if (cardMsgId === null) throw new WorkspaceError("card_pending", 409);
    const owner = this.ownerOpenIdSync();
    if (owner === null) throw new WorkspaceError("not_ready", 409);
    const eventId = `web:${input.id}`;
    this.ctx.storage.transactionSync(() => {
      this.ledger.webRequests.start(key, payload);
      this.sql`
        INSERT OR IGNORE INTO sh_inbound (channel, msgId, eventId, eventType, receivedAt, ownerAuthorized)
        VALUES ('local', ${eventId}, NULL, 'action', ${Date.now()}, 1)
      `;
    });
    const work = this.dispatchCardAction({ msgId: eventId, action: input.action, cardMsgId })
      .then(() => { this.ledger.webRequests.complete(key); }).finally(() => { this.webInputs.delete(key); });
    this.webInputs.set(key, work);
    return work;
  }

  /** A boot-time replay of workspace message requests the crash interrupted mid-way (the
   *  sh_web_request row is the durable intent); card taps are not replayed — the card is
   *  still open if it never landed, and the owner can press again with a fresh request id. */
  private async recoverWorkspaceInputs(): Promise<void> {
    for (const row of this.ledger.webRequests.pending()) {
      if (row.id.startsWith("action:")) continue;
      try { await this.submitWorkspaceMessage(JSON.parse(row.payload) as WorkspaceInput); }
      catch (error) { this.logChannel("web_recovery_failed", `${row.id} ${errorText(error)}`); }
    }
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
        // The provider's own error text (401 invalid key, rate limit, …) is the one thing
        // that makes a model_error diagnosable from the outside; `wait()` drops it, so it is
        // recovered from the transcript tail and pinned in the channel log.
        const modelErrorDetail = result.status === "unanswered" && result.reason === "model_error" ? ((await this.modelErrorDetail()) ?? undefined) : undefined;
        if (modelErrorDetail) this.logChannel("model_call_error", modelErrorDetail.slice(0, 300));
        // Issue #28: bring the counter current before the over-budget note reads it — the
        // run that just settled is the spend that may tip today over the cap.
        await this.syncUsageQuietly();
        const failedNotice = run.kind === "user" && result.status !== "done" ? await this.noticeForFailedRun(modelErrorDetail, result.status === "unanswered" ? result.reason : result.status) : undefined;
        this.settleRun(run, result, failedNotice);
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

  /** What the owner is told when a user-triggered run did not complete. "Try again" is wrong
   *  advice for a deployment that has no model key yet (owner-notices.ts); resolved here, in the
   *  async poll, so settleRun stays synchronous. */
  private async noticeForFailedRun(modelErrorDetail?: string, reason?: string): Promise<string> {
    try {
      // The workspace is always part of the deployment now (ADR-0004): its Settings page is
      // where a rejected or missing model key gets fixed.
      return failedRunNotice(await this.llmSelection(), true, modelErrorDetail, reason);
    } catch {
      return FAILED_RUN_NOTICE;
    }
  }

  /** The provider-facing error text of the most recent failed model call, from the
   *  transcript tail (pi drops it from the settle summary — `wait()` reports only
   *  `model_error`). Null when the tail has no errored assistant message. */
  private async modelErrorDetail(): Promise<string | null> {
    const records = (await this.piHarness.messages()) as unknown as Array<{
      model?: Array<{ role?: string; errorMessage?: string; stopReason?: string }>;
    }>;
    for (let i = records.length - 1; i >= 0; i--) {
      const msg = records[i]!.model?.[0];
      if (msg?.role === "assistant" && msg.errorMessage) return msg.errorMessage;
    }
    return null;
  }

  private settleRun(run: RunRow, result: { status: string; reason?: string; text?: string }, failedNotice: string = FAILED_RUN_NOTICE): void {
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
        void reply(withRelay(failedNotice));
        return;
      }
      if (owner && result.status === "done" && !hasText && !alreadyNotified) {
        // Review #9: done, empty, and nothing reached the user — say so instead of silence.
        void reply(withRelay("⚠️ 模型没有给出回复。请重新发送这条消息；如果仍没有回复，请在「设置 → 模型服务」中测试连接或切换模型。"));
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
  /** A button callback (ADR-0003: POST /api/actions), already deduped; the Thread comes from
   *  the card's providerMsgId — in the local channel, the outbound row / merged-group id. */
  private async dispatchCardAction(input: { msgId: string; action: string; cardMsgId: string }): Promise<void> {
    const action = input.action;
    if (action.startsWith("ask:") || action.startsWith("asknew:")) {
      await this.handleAskCardAction(input.msgId, action, input.cardMsgId);
      return;
    }
    if (action === "note_archive" || action === "note_keep") {
      await this.handleNoteDecisionCard(action, input.cardMsgId);
      return;
    }
    if (action === "pr_approve" || action === "pr_decline") {
      await this.handlePrConsentCard(action, input.cardMsgId);
      return;
    }
    await this.dispatcher.handleCardAction({ operatorId: OWNER_ID, action, cardMsgId: input.cardMsgId });
  }

  /**
   * A resident-note suggestion card's button (issue #19, spec §10.2): the outbound row id
   * is `noteask:<noteId>:<logId>` — resolved via providerMsgId, never button data (the
   * §3.1 rule). The tap is the owner's own decision; the module keeps its invariants
   * (archive is refused on a pinned note; the state settles the ask either way).
   */
  private async handleNoteDecisionCard(action: string, cardMsgId: string): Promise<void> {
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
    // The tap's ack is a direct response to the owner's action (issue #11): push.
    await this.enqueueOutbound({ kind: "text", to: OWNER_ID, text: reply, urgency: "push" });
  }

  /**
   * The consent gate's chat half (issue #21, spike-conclusions §2): the done card's
   * [同意] / [先不要]. The tap resolves through the card's providerMsgId → outbound row id
   * `notify:report:<workerId>:<seq>` — identity never rides in the button (§3.1).
   *
   * - [同意] sends the `pr_worker` command (push + `gh pr create` on the machine); the
   *   result lands back asynchronously as a pr_created / pr_failed card. A re-tap after a
   *   failure is a retry: a fresh command id, the failure marker cleared.
   * - [先不要] records the decision and does nothing else — the commits stay on the machine.
   */
  private async handlePrConsentCard(action: string, cardMsgId: string): Promise<void> {
    const row = this.ledger.outbound.rowForProviderMsg(cardMsgId);
    const parsed = row !== null && row.id.startsWith("notify:report:") ? /^notify:report:([^:]+):(\d+)$/.exec(row.id) : null;
    const reply = async (text: string): Promise<void> => {
      await this.enqueueOutbound({ kind: "text", to: OWNER_ID, text, threadId: row?.threadId ?? null, urgency: "push" });
    };
    if (!parsed || !row?.threadId) {
      await reply("这张汇报卡片已经失效（找不到对应的汇报）；直接回复文字说明想做什么即可。");
      return;
    }
    const workerId = parsed[1]!;
    const seq = Number(parsed[2]);
    const worker = this.ledger.workers.get(workerId);
    if (!worker) {
      await reply("这个 worker 已经不在了；重新描述一下要做什么即可。");
      return;
    }
    this.ledger.threads.markRead(worker.threadId); // a click is both read and a reply (§6.5)
    const consent = this.ledger.prConsent.get(workerId, seq);
    // Cross-card truth (review finding 5): rows are per report, the PR is per worker/branch —
    // any of this worker's cards' outcomes answers for this tap, so two done cards can never
    // race two pr_worker commands onto one branch.
    const branch = this.ledger.prConsent.branchState(workerId);

    if (action === "pr_decline") {
      if (branch.url) {
        await reply(`PR 已经创建过了：${branch.url}；这次就不再动了。`);
        return;
      }
      if (branch.pending && this.commandInFlight(branch.pendingCmdId)) {
        // An approve is already in flight; the honest answer is that it cannot be recalled.
        await reply("已经在推送并创建 PR 了，停不下来；结果稍后回到这里。不想要的话可以去仓库关掉它。");
        return;
      }
      this.ledger.prConsent.record({ workerId, seq, threadId: worker.threadId, decision: "declined" });
      this.ledger.timeline.add(worker.threadId, "note", "用户选择先不推送/创建 PR（consent gate）", { workerId, seq });
      await reply("好的，先不推送；提交都还在机器上。想创建 PR 时回到这张卡片点「同意」，或直接跟我说。");
      return;
    }

    // pr_approve
    if (branch.url) {
      await reply(`PR 已经创建过了：${branch.url}`);
      return;
    }
    if (branch.pending && this.commandInFlight(branch.pendingCmdId)) {
      await reply("正在推送并创建 PR，稍等结果回到这里。");
      return;
    }
    // A pending row whose command is provably dead (crash between the consent record and the
    // enqueue, or an ambiguous that never reached us) is a wedge, not an in-flight run — fall
    // through: this tap becomes the retry, and the attempt counter keeps the history honest.
    if (!worker.branch) {
      await reply("这个 worker 没有分支（可能是只读任务），无法创建 PR；重新描述一下需求即可。");
      return;
    }
    if (!this.ledger.machines.get(worker.deviceId)) {
      await reply("找不到当初那台机器；等它上线后回到这张卡片再点一次「同意」即可。");
      return;
    }
    const attempt = (consent?.attempts ?? 0) + 1;
    const cmdId = `pr:${workerId}:${seq}:${attempt}`;
    const report = (this.ledger.workers.reportsForWorker(workerId) ?? []).find((r) => r.seq === seq) ?? null;
    const thread = this.ledger.threads.get(worker.threadId);
    const { title, body } = prCommandArgs({ report, threadTitle: thread?.title ?? worker.threadId, branch: worker.branch });
    // notAfter null: an offline machine gets the command at its next hello — the user's tap
    // is the same "queue until online" consent as the offline-ask card's 排队等上线.
    // Record BEFORE enqueueing: the consent row is the event handlers' anchor (pr_created /
    // pr_failed resolve through cmdId), and no async gap may precede its existence.
    this.ledger.prConsent.record({ workerId, seq, threadId: worker.threadId, decision: "approved", cmdId, attempts: attempt });
    await this.enqueue(worker.deviceId, "pr_worker", { workerId, title, body }, { workerId, notAfter: null, cmdId });
    const retryNote = attempt > 1 ? `（第 ${attempt} 次尝试）` : "";
    this.ledger.timeline.add(worker.threadId, "note", `用户同意推送 ${worker.branch} 并创建 PR${retryNote}`, {
      workerId,
      seq,
      cmdId,
    });
    await this.enqueueOutbound({
      kind: "text",
      to: OWNER_ID,
      text: `好的，正在推送 ${worker.branch} 并创建 PR${retryNote}；结果稍后回到这里。`,
      threadId: worker.threadId,
      urgency: "push",
    });
  }

  /** Whether a consent-pending command is still deliverable (review finding 2): queued,
   *  sent, or accepted. Terminal states (done/failed/ambiguous/expired) and rows that never
   *  came to exist (the record-then-enqueue crash window) are "dead" — the pending consent
   *  row they left behind is a wedge this tap is allowed to break by retrying.
   *  done-with-url rows never read as pending (branchState saw the url), so a done row here
   *  means its result carried no url — dead for our purposes. */
  private commandInFlight(cmdId: string | null): boolean {
    if (cmdId === null) return false;
    const state = this.sql<{ state: string }>`SELECT state FROM outbox WHERE cmdId = ${cmdId}`[0]?.state;
    return state === "queued" || state === "sent" || state === "accepted";
  }

  /**
   * An ask-card button click (#7, steward.md §9.1): the action string is `ask:<qid>:<idx>`
   * (a candidate or plain option) or `asknew:<qid>`. The click closes the question, then
   * becomes one steward input — a routing candidate submits already-routed to that Thread
   * (basis=user_reply_to; start_worker attaches without further confidence), 「新开一件事」
   * submits unrouted, and a plain option submits the chosen text as the answer. The steward
   * conversation remembers its own question; the note gives it everything else.
   */
  private async handleAskCardAction(msgId: string, action: string, cardMsgId: string): Promise<void> {
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
      const ref = this.ownerMessageRef(msgId);
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
        eventId: msgId,
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
      msgId: msgId,
      text: label,
      prefilledNote: note,
      routedThreadId,
    });
  }

  private logChannel(reason: string, detail: string): void {
    this.sql`INSERT INTO sh_channel_log (ts, channel, reason, detail) VALUES (${Date.now()}, 'local', ${reason}, ${detail})`;
  }

  async channelLogEntries(limit = 50): Promise<{ ts: number; reason: string; detail: string | null }[]> {
    return this.sql<{ ts: number; reason: string; detail: string | null }>`
      SELECT ts, reason, detail FROM sh_channel_log ORDER BY seq DESC LIMIT ${limit}
    `;
  }

  async inboundSeen(msgId: string): Promise<boolean> {
    return this.sql`SELECT 1 AS one FROM sh_inbound WHERE channel = 'local' AND msgId = ${msgId}`.length > 0;
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
    /** Structured merge section (issue #11) — carried in the payload for quiet rows. */
    part?: QuietSection;
    /** Credential or channel-setup text (a login link, a pairing command): delivered to the
     *  owner, but never shown in the workspace's conversation. */
    private?: boolean;
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

  /** Test-only: swaps the quiet merge window (issue #11) — 0 makes quiet rows due
   *  immediately, so content-path suites stay deterministic; the window itself has its
   *  own suite that keeps the production 60 s. */
  async setQuietMergeForTest(ms: number): Promise<void> {
    this.quietMergeMs = ms;
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

  /** Makes scripted replies arrive word by word (tokens per second), so a live view can watch one being written. */
  async fauxStreamAt(tokensPerSecond: number | undefined): Promise<void> {
    if (!this.llmModels.faux) throw new Error("STEWARD_MODEL is not the faux provider");
    this.llmModels.faux.streamAt(tokensPerSecond);
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
    await this.workspaceStream_?.stop();
    this.workspaceStream_ = undefined;
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
    // Issue #11: due QUIET rows for one channel+receiver fold into a single merged message —
    // everything else (push) goes out on its own, in arrival order.
    const due = this.ledger.outbound.dueRows(Date.now(), OUTBOUND_BATCH);
    const grouped = new Set<string>();
    for (const row of due) {
      if (grouped.has(row.id)) continue;
      if (row.urgency !== "quiet") {
        await this.deliverOneOutbound(row.id);
        continue;
      }
      const group = due.filter(
        (r) => r.urgency === "quiet" && r.channel === row.channel && r.receiveId === row.receiveId && !grouped.has(r.id),
      );
      for (const member of group) grouped.add(member.id);
      if (group.length === 1) await this.deliverOneOutbound(row.id);
      else await this.deliverMergedGroup(group.map((r) => r.id));
    }
    this.rearmDeliveryAlarm();
  }

  /** The merged settle (issue #11, ADR-0003): claim every sibling row, render ONE text message
   *  from their sections, and settle all rows against the same providerMsgId — so a quote
   *  reply marks every bound thread read while routing to the conversation (the steward
   *  decides which matter the reply belongs to). GET /api/messages groups on that shared id
   *  and re-renders the same merged text for the group. */
  private async deliverMergedGroup(ids: string[]): Promise<void> {
    const claimed: Array<{ row: OutboundDeliveryRow }> = [];
    for (const id of ids) {
      const row = this.ledger.outbound.claimForDelivery(id, Date.now(), OUTBOUND_CLAIM_MS);
      if (row) claimed.push({ row });
    }
    if (claimed.length === 0) return;
    if (claimed.length === 1) return this.deliverClaimed(claimed[0]!.row); // siblings got stolen mid-claim

    const sections = claimed
      .map(({ row }) => sectionFromPayload(JSON.parse(row.payload) as { text?: string; card?: unknown; part?: QuietSection }))
      .filter((section): section is QuietSection => section !== null);
    if (sections.length === 0) {
      // Nothing mergeable (unreachable with today's producers, but merging must never emit
      // an empty message on their behalf): fail the rows loudly and permanently.
      for (const { row } of claimed) {
        this.ledger.outbound.settleFailure(row.id, row.claim, row.attempts + 1, "no_mergeable_sections", null, Date.now());
      }
      return;
    }
    mergeQuietOutbound(sections); // validates the budget path; the read side re-renders it
    const providerMsgId = mergedSendUuid(claimed.map(({ row }) => row.id));
    for (const { row } of claimed) this.ledger.outbound.settleSent(row.id, row.claim, providerMsgId, Date.now());
  }

  private async deliverOneOutbound(id: string): Promise<void> {
    // The claim: only a queued row (or one whose claim has expired) can be taken, so two
    // concurrent passes never both settle it.
    const row = this.ledger.outbound.claimForDelivery(id, Date.now(), OUTBOUND_CLAIM_MS);
    if (!row) return; // another pass owns this row
    await this.deliverClaimed(row);
  }

  /** ADR-0003: "delivery" is local — the row IS the message (providerMsgId = row id), read
   *  back through GET /api/messages. Malformed payloads fail loudly instead of "sending". */
  private async deliverClaimed(row: OutboundDeliveryRow): Promise<void> {
    JSON.parse(row.payload);
    this.ledger.outbound.settleSent(row.id, row.claim, row.id, Date.now());
  }

    private rearmDeliveryAlarm(): void {
    const at = this.ledger.outbound.nextWake(Date.now());
    if (at === null) return;
    void this.schedule(Math.max(1, Math.ceil((at - Date.now()) / 1000)), "deliverOutbound");
  }
}
