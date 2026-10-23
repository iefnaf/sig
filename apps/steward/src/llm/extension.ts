// The `sig-steward` pi-durable extension (issue #6, steward.md §4): system-prompt
// sections, the steward's tools, and its hooks. The extension is built inside the Durable
// Object over a StewardExtensionContext — everything the tools reach is the DO's ledger,
// dispatch service, and outbound queue; the extension itself holds no state that matters.
//
// Quiet by default is structural, not prompted (steward.md §0.3): in event/routine/follow-up
// runs the plain text output is discarded by the run settler (steward.ts pollRuns); only
// notify_user / ask_user ever enqueue user-facing outbound from those runs.
import { Type } from "@earendil-works/pi-ai";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  hook,
  section,
  GenerationTask,
  ToolTask,
  type Extension,
} from "@earendil-works/pi-durable";
import { MAX_THREAD_SUMMARY, type Ledger, type RouteCandidate } from "../ledger.ts";
import { LOW_TRUST_SOURCES, sameClaim, type NoteDraft, type NoteKind, type NoteSource } from "../notes.ts";
import {
  titleOf,
  type InterruptWorkerInput,
  type InterruptWorkerOutcome,
  type SendToWorkerInput,
  type SendToWorkerOutcome,
  type StartWorkerInput,
  type StartWorkerOutcome,
} from "../dispatch.ts";
import { describeSchedule, parseAtIso, type RoutineService, type RoutineSpecInput } from "../routines.ts";
import { MAX_CONCLUSION, MAX_DID_ITEM, MAX_DID_ITEMS, MAX_NEEDS_YOU, type Tone } from "../report-template.ts";

/** What the tools may reach. Implemented by the Steward DO; faked nowhere else. */
export interface StewardExtensionContext {
  ledger: Ledger;
  /** The situation brief (§4.1) — same text the beforeRequest hook injects. */
  buildBrief(): string;
  /** The run currently generating: the pi submission an active run owns (review #3), not
   *  merely the oldest unsettled sh_run — a queued followUp starts executing the moment the
   *  previous run answers, before the 2s poll settles its row. */
  currentRun(): Promise<{ operationId: string; kind: string; provenance: string; routedThreadId: string | null } | null>;
  /** The deterministic dispatch service (ADR-0001 decision 6). */
  startWorker(input: StartWorkerInput): Promise<StartWorkerOutcome>;
  /** In-chat intervention (issue #9, connector-pi.md §6.1): send/interrupt land in the same
   *  deterministic service — the outcomes tell the model how the message will be delivered. */
  sendToWorker(input: SendToWorkerInput): Promise<SendToWorkerOutcome>;
  interruptWorker(input: InterruptWorkerInput): Promise<InterruptWorkerOutcome>;
  /** Verify a model-claimed provenance reference (§7.2): `user:<msgId>` must be a message
   *  this deployment actually received; `routine:`/`followup:` ids must exist (issue #20). */
  checkProvenanceRef(ref: string): Promise<boolean>;
  /** When that message was received (ms), or null for unknown refs — lets the notes tools
   *  bind a confirmation to the note it confirms (received AFTER the note existed). */
  messageReceivedAt(ref: string): Promise<number | null>;
  /** notify_user / ask_user land in the outbound queue; only these reach the user.
   *  `dedupeId` (from the tool taskId) makes replayed calls converge on one message. */
  notifyUser(input: {
    conclusion: string;
    did: string[];
    needsYou?: string;
    tone: Tone;
    urgency: "push" | "quiet";
    threadId?: string;
    /** §5.3 (issue #10): the worker question this notification resolves (when it does). */
    questionId?: string;
    resolution?: "done" | "question";
    dedupeId?: string;
  }): Promise<void>;
  askUser(input: {
    question: string;
    options: string[];
    /** Routing candidates — each becomes a card button that routes back as user_reply_to. */
    candidates: Array<{ threadId: string; label: string }>;
    threadId?: string;
    /** §5.3 (issue #10): the worker question being forwarded to the user. */
    questionId?: string;
    dedupeId?: string;
  }): Promise<void>;
  /** answer_worker's deterministic half (§4.3, issue #10): close the question, relay to the
   *  worker, cancel the 90-second fallback. The evidence gate lives in the beforeTool hook. */
  answerWorker(input: { workerId: string; questionId: string; text: string; provenance: string; cmdId: string }): Promise<
    { kind: "answered"; delivery: string; threadId: string } | { kind: "refused"; reason: string }
  >;
  /** Whether the bound owner actually sent this message (answer_worker's user-message
   *  evidence, §4.3): a card click's eventId counts as the owner's action too. */
  isOwnerMessage(msgId: string): Promise<boolean>;
  /** Audit trail for no_action and other quiet outcomes (§8.6). */
  audit(kind: string, detail: string): void;
  /** The proactive-behavior service (issue #20, steward.md §8): routines and follow-ups. */
  routines: RoutineService;
  /** Records an explicit in-run outcome (no_action) on the firing routine/follow-up (§8.6). */
  recordProactiveOutcome(operationId: string, outcome: string): void;
}

const SITUATION_SECTION = "sig-situation";
/** §4.1: resident-layer notes render as one system-prompt section (delta-appended on change). */
const NOTES_SECTION = "sig-notes";

/** §3.3: attaching to a thread idle this long is "the earlier matter" — the reply must say
 *  so (spec §5.2). The tool result reminds the model; the prompt carries the rule. */
export const IDLE_ATTACH_NOTE_MS = 3 * 24 * 3600_000;

/** The reminder appended to a start_worker result that attached to a long-idle thread. */
export function idleAttachNote(thread: { title: string; lastActivityAt: number }, now = Date.now()): string | null {
  const idleFor = now - thread.lastActivityAt;
  if (idleFor < IDLE_ATTACH_NOTE_MS) return null;
  const days = Math.floor(idleFor / 86_400_000);
  return `这条 Thread 已沉寂约 ${days} 天：回复里要说明是接续早前的「${thread.title}」（如「已挂到之前那件 xx 上」）。`;
}

/** One candidate as the model sees it in find_threads' result. */
const candidateLine = (c: RouteCandidate): string =>
  `- ${c.threadId}「${c.title}」${c.state === "running" ? "进行中" : c.state === "waiting_you" ? "等你拍板" : "空闲"}${c.weak ? "（弱匹配）" : ""} — ${c.matchReason}${c.summary ? `；${c.summary}` : ""}`;

const ok = (text: string) => ({ output: [{ type: "text" as const, text }] });
const err = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });

/** Default option buttons when the steward forwards a worker's question without inventing
 *  options (issue #10): the two answers a blocked worker most often needs. The user's click —
 *  or a free-text quote-reply — is relayed to the worker either way. */
const deriveWorkerOptions = (question: { text: string }): string[] => ["同意/按你说的办", "先别，等我细说"];

/** Length rules for notify_user (steward.md §6.4) — over-length is rejected, demanding a rewrite. */
export function validateNotifyArgs(args: { conclusion: string; did: string[]; needsYou?: string }): string | null {
  if (args.conclusion.trim().length === 0) return "conclusion 不能为空。";
  if (args.conclusion.length > MAX_CONCLUSION) return `conclusion 超长（${args.conclusion.length} > ${MAX_CONCLUSION} 字）。请压缩成一句话。`;
  if (args.did.length > MAX_DID_ITEMS) return `did 最多 ${MAX_DID_ITEMS} 条（收到 ${args.did.length} 条）。`;
  const longItem = args.did.find((item) => item.length > MAX_DID_ITEM);
  if (longItem) return `did 里有超过 ${MAX_DID_ITEM} 字的条目：「${longItem.slice(0, 30)}…」。请拆短。`;
  if (args.needsYou && args.needsYou.length > MAX_NEEDS_YOU) {
    return `needsYou 超长（${args.needsYou.length} > ${MAX_NEEDS_YOU} 字）。请压缩。`;
  }
  return null;
}

export function buildStewardExtension(ctx: StewardExtensionContext): Extension {
  const situation = defineTool({
    name: "situation",
    description: "当前的态势简报：机器在线状态、每个 Thread 的状态与摘要、未决问题。通常已注入系统提示，用这个做刷新。",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => ok(ctx.buildBrief()),
  });

  // find_threads (steward.md §3, issue #7): the candidate set the model picks from. Signals
  // 1–2 (reply/button routing, an explicit title/id mention) come back as confidence
  // "explicit" — the one thread, attachable without further justification. Everything else
  // is the §3.2 assembly (active + FTS-recalled + recent, weak-flagged), and attaching to it
  // needs the routing confidence the policy gate demands.
  //
  // Run-scoped routing memo (review #48 finding 1): the confidence gate exempts an attach
  // when the run was routed to that thread (signal 1) OR find_threads just answered
  // confidence=explicit for it (signal 2 — a deterministic title/id/hint hit, exactly as
  // decisive as the quote-route). All three reset together when the run's provenance
  // changes (spike bug 9's guard-reset rule); findThreads and the gate both sync through
  // syncRunScope so the order of tool calls cannot matter.
  let explicitFindThreadId: string | undefined;
  let guardProvenance: string | undefined;
  let dispatchedTarget: string | undefined;
  const syncRunScope = (run: { provenance: string } | null): void => {
    if (run && run.provenance !== guardProvenance) {
      guardProvenance = run.provenance;
      dispatchedTarget = undefined;
      explicitFindThreadId = undefined;
    }
  };

  const findThreads = defineTool({
    name: "find_threads",
    description:
      "找这条话语可能归属的 Thread。返回显式命中（confidence=explicit，直接接续它）或候选列表（≤12，带状态/摘要/匹配原因，弱匹配有标记）。" +
      "接续派发前先调它；如果输入带了系统注说已确定归属，就无需再调。",
    parameters: Type.Object({
      query: Type.String({ description: "用户的原话或任务描述" }),
      hints: Type.Optional(Type.Array(Type.String(), { maxItems: 4, description: "用户点名的仓库/机器名（如有）" })),
    }),
    replay: "safe",
    execute: async (args) => {
      const run = await ctx.currentRun();
      syncRunScope(run);
      const result = ctx.ledger.threads.findCandidates({
        text: args.query,
        ...(args.hints !== undefined ? { hints: args.hints } : {}),
        explicitThreadId: run?.routedThreadId ?? null,
      });
      explicitFindThreadId = undefined; // a new answer supersedes an earlier explicit hit
      if (result.confidence === "explicit" && result.explicitThread) {
        explicitFindThreadId = result.explicitThread.threadId;
        return ok(
          JSON.stringify({
            confidence: "explicit",
            reason: result.explicitThread.matchReason,
            thread: result.explicitThread,
          }),
        );
      }
      return ok(
        JSON.stringify({
          confidence: "candidates",
          candidates: result.candidates.map((c) => ({
            threadId: c.threadId,
            title: c.title,
            state: c.state,
            summary: c.summary,
            matchReason: c.matchReason,
            weak: c.weak,
          })),
          hint: result.candidates.length === 0 ? "没有候选：新需求该新开，不要反问。" : undefined,
        }),
      );
    },
  });

  const getThread = defineTool({
    name: "get_thread",
    description: "一个 Thread 的详情：目标、摘要、worker、最新汇报、未决问题、涉及仓库的项目层记忆、最近时间线。接续或回答状态问题前先看它。",
    parameters: Type.Object({ threadId: Type.String({ description: "如 t_8f2…" }) }),
    replay: "safe",
    execute: async (args) => {
      const thread = ctx.ledger.threads.get(args.threadId);
      if (!thread) return err(`Thread ${args.threadId} 不存在。`);
      const workers = ctx.ledger.workers.listByThread(thread.threadId);
      const latest = workers.at(-1) ?? null;
      const report = latest ? ctx.ledger.workers.reportsForWorker(latest.workerId).at(-1) ?? null : null;
      const question = ctx.ledger.questions.openForThread(thread.threadId);
      const timeline = ctx.ledger.timeline.list(thread.threadId).slice(-8);
      // §2.6 (issue #8): the summary's cumulative update count, and whether the NEXT update
      // is the every-10th from-scratch rewrite — when it is, the model must rebuild from
      // timeline + reports (get_thread already returns both), not edit the old summary.
      const summaryStatus = ctx.ledger.threads.summaryStatus(thread.threadId);
      // §4.1: the project-layer notes of every repo this Thread involves ride along with the
      // fetch (assembly counts as use — notes.forRepos bumps lastUsedAt).
      const repoIds = ctx.ledger.threads.repoIds(thread.threadId);
      const projectNotes = ctx.ledger.notes.forRepos(repoIds);
      return ok(
        JSON.stringify({
          threadId: thread.threadId,
          title: thread.title,
          goal: thread.goal,
          summary: thread.summary,
          state: thread.state,
          unread: thread.unread,
          repos: repoIds,
          createdFromMsg: thread.createdFromMsg,
          workers: workers.map((w) => ({
            workerId: w.workerId, state: w.state, agent: w.agent, mode: w.mode,
            branch: w.branch, parentWorker: w.parentWorker, contextPercent: w.contextPercent, lastOutcome: w.lastOutcome,
          })),
          summaryUpdates: summaryStatus.updates,
          summaryRewriteDue: summaryStatus.rewriteDue,
          latestReport: report && { status: report.status, summary: report.summary, question: report.question, git: report.git },
          openQuestion: question?.text ?? null,
          projectNotes: projectNotes.map((n) => ({
            noteId: n.noteId, repoId: n.scopeRepoId, kind: n.kind, text: n.text,
            source: n.source, confirmed: n.confirmed, pinned: n.pinned,
          })),
          followups: ctx.ledger.followups.listByThread(thread.threadId).map((f) => ({
            followupId: f.followupId, status: f.status, dueAt: f.dueAt, reason: f.reason,
          })),
          timeline: timeline.map((e) => `${e.kind}: ${e.text}`),
        }),
      );
    },
  });

  const updateThread = defineTool({
    name: "update_thread",
    description: "更新 Thread 的标题 / 目标 / 滚动摘要。事件记账时更新摘要（≤600 字，重写而非追加）。",
    parameters: Type.Object({
      threadId: Type.String(),
      title: Type.Optional(Type.String()),
      goal: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String({ description: `重写整个摘要，≤${MAX_THREAD_SUMMARY} 字` })),
    }),
    replay: "safe",
    execute: async (args) => {
      if (args.summary !== undefined && args.summary.length > MAX_THREAD_SUMMARY) {
        return err(`summary 超长（${args.summary.length} > ${MAX_THREAD_SUMMARY} 字）。请重写得更紧凑，而不是截断。`);
      }
      if (args.summary !== undefined && args.summary.trim().length === 0) {
        return err("summary 不能为空白。要清空请用一句「暂无摘要」之类的实文。");
      }
      const done = ctx.ledger.threads.update(args.threadId, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
      });
      if (!done) return err(`Thread ${args.threadId} 不存在。`);
      // §2.6 (issue #8): report the cumulative count and — when the NEXT update lands on the
      // every-10th boundary — demand the from-scratch rewrite (from timeline + reports, not
      // an edit of the current summary). Blank/unchanged summaries never reached this point,
      // so the count only moves on real rewrites.
      const status = ctx.ledger.threads.summaryStatus(args.threadId);
      return ok(
        `updated（摘要累计第 ${status.updates} 版；系统保留最近 5 版）` +
          (status.rewriteDue
            ? `。⚠️ 下一次更新是第 ${status.updates + 1} 版＝整十版：必须【从头重写】——按 get_thread 的时间线与汇报重建，不要在旧摘要上缝补（防漂移）。`
            : ""),
      );
    },
  });

  const startWorker = defineTool({
    name: "start_worker",
    description:
      "派发一个编码任务到用户的机器。要么接续（threadId，来自 find_threads / get_thread），要么新开（newTitle + 可选 goal）。" +
      "只有显式路由的接续可免 routing：系统注已定归属（回复/按钮指向它），或本轮 find_threads 对它返回了 confidence=explicit；" +
      "其余接续必须带 routing: {confidence: 'high', reason}（政策硬性要求，把握不足改用 ask_user）。" +
      "机器由确定性规则挑选；工具会让你知道结果（已派发 / 已用按钮问用户 / 需要你转问用户）。接续时系统会自动决定续用原会话（同 agent 同机器）或开新会话（换机器/换 agent/上下文过大/用户要全新视角时）并附交接简报——工具结果会说明，prompt 里写本棒任务本身即可。basis 是你派发的依据。" +
      "mode 按任务性质选：纯研究/答疑/代码评审不改代码的用 readonly（在原仓库只读运行，无 worktree）；" +
      "会改代码的、或不确定的，用 write（默认，独享 worktree）。事件触发的运行里（⟦…⟧ 输入）必须另外给 " +
      "provenanceRef：一条真实存在的用户消息 id（user:<om_…>，来自时间线/汇报的 refs），" +
      "否则会被拒绝——系统输入自身不构成派发授权（设计 §7.2）。",
    parameters: Type.Object({
      prompt: Type.String({ description: "自包含的任务描述：worker 只看这段话" }),
      repoRef: Type.String({ description: "仓库名或 repoId（如 repo-a / /srv/repo-a）" }),
      threadId: Type.Optional(Type.String({ description: "接续到这个 Thread（接续指令必须用它）" })),
      newTitle: Type.Optional(Type.String({ description: "新 Thread 的标题（用户原话短语，≤24 字）" })),
      goal: Type.Optional(Type.String()),
      machineHint: Type.Optional(Type.String({ description: "用户点名的机器名（没点名就别填）" })),
      /** §3.3 (issue #7): a non-explicit attach must state its confidence and reason; the
       *  policy hook enforces high-or-ask. Omit when the run is already routed to this thread
       *  (system note / card click) or find_threads just answered confidence=explicit for
       *  it — those are the two explicit signals; everything else needs it. */
      routing: Type.Optional(
        Type.Object({
          confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
          reason: Type.String({ description: "为什么是它：引用 find_threads 的匹配或接续措辞" }),
        }),
      ),
      /** §11 (issue #16): the steward tells read-only and change-making tasks apart at
       * dispatch; when unsure it must treat the task as "will make changes" → write. */
      mode: Type.Optional(
        Type.Union([Type.Literal("write"), Type.Literal("readonly")], {
          description: "readonly=只读运行（研究/答疑/评审，无 worktree）；write=会改代码（默认；拿不准就 write）",
        }),
      ),
      /** §7.2 (review #4): in event/routine/follow-up runs the system input itself is not
       * authorization — the model must point at the user message (later also routine/
       * followup/watch id) that asked for this. */
      provenanceRef: Type.Optional(Type.String({ description: "授权来源：user:<msgId>（仅事件触发的运行里必填）" })),
      /** Issue #8 (spec §5.3 case 2): the user asked for a fresh, unbiased look (「换个视角重新
       *  评审」「不要受之前结论影响」) — always a new session with a handoff brief, never a
       *  resume. Leave it out for ordinary continuations; the system resumes automatically. */
      freshReview: Type.Optional(
        Type.Boolean({ description: "用户明确要求全新视角/独立评审时 true；普通接续不要填（系统会自动续用原会话）" }),
      ),
      /** Issue #17: the user names the agent (「用 Claude Code 跑」) — hello.agents is the
       *  menu; the dispatcher refuses honestly when no machine has it installed. */
      agent: Type.Optional(
        Type.String({ description: "agent 种类，如 claude-code（机器上报过才行）；用户没点名就别填（默认 pi）" }),
      ),
      basis: Type.Union([
        Type.Literal("user_explicit"),
        Type.Literal("user_reply_to"),
        Type.Literal("memory"),
        Type.Literal("routine"),
        Type.Literal("followup"),
        Type.Literal("watch"),
      ]),
    }),
    // §4.3: a replay after a crash must not re-run the dispatch; the model sees "interrupted".
    // Idempotency for the connector is cmdId = "tool:" + api.taskId (protocol §7.1).
    replay: "unsafe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      // §3.3 (issue #7): read the attach target's idleness BEFORE dispatching — the dispatch
      // itself refreshes lastActivityAt.
      const attachBefore = args.threadId !== undefined ? ctx.ledger.threads.get(args.threadId) : null;
      const idleNote = attachBefore !== null && !args.newTitle ? idleAttachNote(attachBefore) : null;
      // Review #4: user runs carry their own authorization (the message that started them);
      // every other kind needs an explicit, verifiable provenanceRef. A verify run (#7) is
      // user-authorized transitively — its replyTo is the original user message.
      const userAuthorized = run !== null && (run.kind === "user" || (run.kind === "verify" && run.provenance.startsWith("user:")));
      let provenance = run?.provenance ?? "unknown";
      if (run && !userAuthorized) {
        if (args.provenanceRef === undefined) {
          return err("refused: 事件触发的运行不能自行派发（设计 §7.2）。给出 provenanceRef=user:<msgId>（用户真正说过这条话的消息 id），或改用 ask_user。");
        }
        if (!(await ctx.checkProvenanceRef(args.provenanceRef))) {
          return err(`refused: provenanceRef ${args.provenanceRef} 不存在（必须是本部署真实收到的用户消息 id）。`);
        }
        provenance = args.provenanceRef;
      }
      const outcome = await ctx.startWorker({
        prompt: args.prompt,
        repoRef: args.repoRef,
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        ...(args.newTitle !== undefined ? { newTitle: titleOf(args.newTitle) } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.machineHint !== undefined ? { machineHint: args.machineHint } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(args.freshReview !== undefined ? { freshReview: args.freshReview } : {}),
        ...(args.agent !== undefined ? { agent: args.agent } : {}),
        provenance,
        cmdId: `tool:${api.taskId}`,
        createdFromMsg: provenance.startsWith("user:") ? provenance.slice("user:".length) : null,
      });
      if (outcome.kind === "refused") return err(`refused: ${outcome.reason}`);
      if (outcome.kind === "asked_offline") {
        return ok(
          `已用按钮卡片问用户（${outcome.machineName} 不在线：等它上线、换台机器，还是算了——命令先扣住，等用户点按钮）。本轮不要再派发或追问。`,
        );
      }
      // Issue #8: the deterministic continuation — tell the model exactly what happened, so
      // its reply to the user states it (resumed session / new session with brief) and it
      // never claims a fresh session for a resume or vice versa.
      const cont = outcome.continuation;
      const continuationNote =
        cont === undefined
          ? ""
          : cont.action === "resume"
            ? "\n这是续用原会话（同 agent 同机器）：任务作为新输入进入原 session，未附交接简报。回复里据实说明。"
            : `\n这是新会话接续${cont.parentWorker ? `：从 ${cont.parentWorker} 的分支${cont.base ? `（${cont.base}）` : ""}起跑，已自动附上交接简报（目标/现状/决定/遗留/git 指针），prompt 只需写本棒任务本身` : "（首棒，无前序分支）"}。` +
              (cont.crossMachine
                ? "注意：接力分支在另一台机器上——需先 push/存量 fetch，否则 start 会在那台机器上失败（worktree_failed）；回复里提醒用户。"
                : "");
      const tail = outcome.queued
        ? `${outcome.machineName} 当前不在线，已排队，上线后自动开始。`
        : `已派给 ${outcome.machineName}，完成后我会汇报。`;
      return ok(
        `${outcome.created ? `已创建「${outcome.threadId}」并派发` : `已续派到 ${outcome.threadId}`}：${tail}${continuationNote}${idleNote ? `\n${idleNote}` : ""}`,
      );
    },
  });

  const sendToWorker = defineTool({
    name: "send_to_worker",
    description:
      "给一个正在运行/空闲的 worker 追加或转向指令（「改用 pnpm」「做完后顺便补测试」）。" +
      "workerId 从 get_thread /态势简报对应 Thread 的 workers 里拿。intent：now=立即转向（不打断当前工具，当前批次结束后生效）；" +
      "after=本轮跑完再处理；auto=按 worker 状态决定。事件触发的运行里必须另外给 provenanceRef（user:<msgId>）。",
    parameters: Type.Object({
      workerId: Type.String({ description: "如 w_01J…" }),
      text: Type.String({ description: "自包含的追加/转向指令：worker 只看这段话" }),
      intent: Type.Optional(
        Type.Union([Type.Literal("now"), Type.Literal("after"), Type.Literal("auto")], {
          description: "默认 auto",
        }),
      ),
      provenanceRef: Type.Optional(Type.String({ description: "授权来源：user:<msgId>（仅事件触发的运行里必填）" })),
      basis: Type.Union([
        Type.Literal("user_explicit"),
        Type.Literal("user_reply_to"),
        Type.Literal("memory"),
        Type.Literal("routine"),
        Type.Literal("followup"),
        Type.Literal("watch"),
      ]),
    }),
    // §4.3: a replay after a crash must not re-send; cmdId = "tool:" + api.taskId (§7.1).
    replay: "unsafe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      let provenance = run?.provenance ?? "unknown";
      if (run && run.kind !== "user") {
        if (args.provenanceRef === undefined) {
          return err("refused: 事件触发的运行不能自行向 worker 发送（设计 §7.2）。给出 provenanceRef=user:<msgId>，或改用 ask_user。");
        }
        if (!(await ctx.checkProvenanceRef(args.provenanceRef))) {
          return err(`refused: provenanceRef ${args.provenanceRef} 不存在（必须是本部署真实收到的用户消息 id）。`);
        }
        provenance = args.provenanceRef;
      }
      const outcome = await ctx.sendToWorker({
        workerId: args.workerId,
        text: args.text,
        intent: args.intent ?? "auto",
        provenance,
        cmdId: `tool:${api.taskId}`,
      });
      if (outcome.kind === "refused") return err(`refused: ${outcome.reason}`);
      // §6.2: steer takes effect after the current tool batch — say so in the reply so the
      // model can tell the user exactly when the redirect lands.
      const tail =
        outcome.delivery === "steer"
          ? "已进入转向队列，after_current_tools：不打断正在执行的工具，当前工具批次结束后生效。"
          : outcome.delivery === "follow_up"
            ? "已排队，本轮运行结束后生效。"
            : outcome.delivery === "queued"
              ? "worker 正在启动/恢复中，指令已排队，就绪后送达。"
              : "worker 当前空闲，指令已送达，会立即开始处理。";
      const offline = outcome.machineOffline ? "（机器当前离线，上线后会送达。）" : "";
      return ok(`已发送给 ${args.workerId}：${tail}${offline}`);
    },
  });

  const interruptWorker = defineTool({
    name: "interrupt_worker",
    description:
      "中断一个正在运行的 worker（停下它手头的事）。仅当用户明确要求停下时才用（basis 必须是 user_explicit 或 user_reply_to，" +
      "否则用 ask_user 先问）。事件触发的运行里（⟦…⟧ 输入）必须另外给 provenanceRef：一条真实存在的用户消息 id（user:<om_…>，来自时间线/汇报的 refs），" +
      "否则会被拒绝——停下运行中的任务必须用户明示，系统输入自身不构成授权（设计 §7.2）。" +
      "可选 then：「停，然后改用 pnpm」这类停后跟进的新指令。转向（不停下）用 send_to_worker。",
    parameters: Type.Object({
      workerId: Type.String({ description: "如 w_01J…" }),
      then: Type.Optional(Type.String({ description: "停下后紧接着交给 worker 的新指令（可省）" })),
      provenanceRef: Type.Optional(Type.String({ description: "授权来源：user:<msgId>（仅事件触发的运行里必填）" })),
      basis: Type.Union([
        Type.Literal("user_explicit"),
        Type.Literal("user_reply_to"),
        Type.Literal("memory"),
        Type.Literal("routine"),
        Type.Literal("followup"),
        Type.Literal("watch"),
      ]),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      // PR #45 review #4: an abort is at least as destructive as a steer, and `basis` labels
      // are model-claimed — event-triggered runs need a verifiable reference to the user
      // message that said stop, exactly like send_to_worker (§7.2).
      let provenance = run?.provenance ?? "unknown";
      if (run && run.kind !== "user") {
        if (args.provenanceRef === undefined) {
          return err("refused: 事件触发的运行不能自行中断 worker（设计 §7.2）。停下运行中的任务必须用户明示：给出 provenanceRef=user:<msgId>（用户真正说过这条话的消息 id），或改用 ask_user。");
        }
        if (!(await ctx.checkProvenanceRef(args.provenanceRef))) {
          return err(`refused: provenanceRef ${args.provenanceRef} 不存在（必须是本部署真实收到的用户消息 id）。`);
        }
        provenance = args.provenanceRef;
      }
      const outcome = await ctx.interruptWorker({
        workerId: args.workerId,
        ...(args.then !== undefined ? { then: args.then } : {}),
        provenance,
        cmdId: `tool:${api.taskId}`,
      });
      if (outcome.kind === "refused") return err(`refused: ${outcome.reason}`);
      const offline = outcome.machineOffline ? "（机器当前离线，中断指令在它上线后送达。）" : "";
      return ok(
        `已发出中断${args.then !== undefined ? "（停后会带上你的后续指令）" : ""}：worker 会尽快停下；` +
          `它队列里未送达的排队消息会被取回并记录，需要的话我会告诉你取回了什么。${offline}`,
      );
    },
  });

  const notifyUser = defineTool({
    name: "notify_user",
    description:
      "主动通知用户，三段式：结论（≤80 字）、做了什么（≤4 条、每条 ≤100 字）、需要你（≤120 字，可省）。" +
      "事件触发的运行里，用户看不到你的普通文字输出——要让他知道什么必须走这里。用户提问的运行里通常直接回复即可，不必调用。",
    parameters: Type.Object({
      conclusion: Type.String(),
      did: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_DID_ITEMS })),
      needsYou: Type.Optional(Type.String()),
      tone: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("attention"), Type.Literal("failure")])),
      urgency: Type.Optional(Type.Union([Type.Literal("push"), Type.Literal("quiet")])),
      threadId: Type.Optional(Type.String()),
      questionId: Type.Optional(Type.String({ description: "本通知处置的 worker 问题 id（q_…）：带上即视为已转告用户，取消 90 秒兜底" })),
      resolution: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("question")], { description: "处置结果：done=如实汇报了完成（unreported 分类用）；question=已向用户提问" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const did = args.did ?? [];
      const violation = validateNotifyArgs({ conclusion: args.conclusion, did, needsYou: args.needsYou });
      if (violation) return err(`refused: ${violation}`);
      // §5.3 (issue #10, review finding 7): a stale/mistyped questionId must FAIL the call —
      // silently swallowing it ("notified" with nothing sent, question open, no fallback)
      // tells the model a lie it cannot correct. Same refusal ask_user already has.
      const notifyQuestion = args.questionId !== undefined ? ctx.ledger.questions.get(args.questionId) : null;
      if (args.questionId !== undefined && (notifyQuestion === null || notifyQuestion.status !== "open" || notifyQuestion.workerId === null)) {
        return err(`refused: questionId ${args.questionId} 不存在、已回答或不是 worker 的问题。`);
      }
      const tone: Tone = args.tone === "failure" ? "failure" : args.tone === "info" ? "success" : "attention";
      await ctx.notifyUser({
        conclusion: args.conclusion,
        did,
        ...(args.needsYou !== undefined ? { needsYou: args.needsYou } : {}),
        tone,
        urgency: args.urgency === "push" ? "push" : "quiet",
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        ...(args.questionId !== undefined ? { questionId: args.questionId } : {}),
        ...(args.resolution !== undefined ? { resolution: args.resolution } : {}),
        dedupeId: `notify:${api.taskId}`,
      });
      return ok("notified");
    },
  });

  const askUser = defineTool({
    name: "ask_user",
    description:
      "向用户提问并结束本轮（路由不明、意图存疑、必须用户拍板时用它，不要在文字里反问后结束）。最多 3 个简短选项。" +
      "路由不明时给 candidates（≤3 个 Thread，用 find_threads 的结果，label 用标题短语）：用户点按钮即确定归属。" +
      "带 threadId 的问题会把这个 Thread 置为「等你」。用户的回答会作为新消息回来。" +
      "转问 worker 的问题时必带 questionId（⟦event⟧ 输入里有）——用户点按钮或引用回复会把答案直接转回给 worker。",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
      candidates: Type.Optional(
        Type.Array(Type.Object({ threadId: Type.String(), label: Type.String() }), { maxItems: 3 }),
      ),
      threadId: Type.Optional(Type.String()),
      questionId: Type.Optional(Type.String({ description: "转问的 worker 问题 id（q_…，⟦event⟧ 输入里有）" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      if ((args.options?.length ?? 0) > 3 || (args.candidates?.length ?? 0) > 3) {
        return err("refused: 选项最多 3 个。");
      }
      // §5.3 (issue #10): forwarding a worker's question must name it — the card binds THAT
      // question (its buttons and the quote-route resolve to the worker), and the fallback
      // for it is cancelled. No candidates on a forwarded worker question (those are for
      // routing ambiguity); options default to two clickable answers when the model gives none.
      const question = args.questionId !== undefined ? ctx.ledger.questions.get(args.questionId) : null;
      if (args.questionId !== undefined && (question === null || question.status !== "open" || question.workerId === null)) {
        return err(`refused: questionId ${args.questionId} 不存在、已回答或不是 worker 的问题。`);
      }
      if (question !== null && (args.candidates?.length ?? 0) > 0) {
        return err("refused: 转问 worker 的问题不要带 candidates（那是路由歧义专用的）。");
      }
      const options = question !== null ? (args.options !== undefined && args.options.length > 0 ? args.options : deriveWorkerOptions(question)) : (args.options ?? []);
      await ctx.askUser({
        question: args.question,
        options,
        candidates: args.candidates ?? [],
        ...(args.threadId !== undefined && question === null ? { threadId: args.threadId } : {}),
        ...(question !== null ? { questionId: question.qid } : {}),
        dedupeId: `ask:${api.taskId}`,
      });
      return { output: [{ type: "text" as const, text: "asked" }], control: { terminate: true } };
    },
  });

  // ---- answer_worker (steward.md §4.3, issue #10) ----------------------------------------------

  const answerWorker = defineTool({
    name: "answer_worker",
    description:
      "总管自己回答 worker 的纯事实性问题（「目标分支是哪个」「跑测试用什么命令」）。答案会作为指令转给 worker，问题关闭，不再打扰用户。" +
      "只能回答「不知道它就会派错/说错」且证据在手的事实问题；需要用户拍板/取舍/授权的改用 ask_user（带 questionId）。" +
      "evidence 必填：note:<笔记id>（notes_search/notes_list 可查）或 user:<消息id>（⟦event⟧ 输入 refs 里的用户消息）；没有证据会被拒。",
    parameters: Type.Object({
      workerId: Type.String({ description: "提问的 worker，如 w_01J…" }),
      questionId: Type.String({ description: "要回答的问题 id（q_…，⟦event⟧ 输入里有 questionId=）" }),
      text: Type.String({ description: "给 worker 的回答：自包含、直接可用" }),
      // Optional at the schema on purpose: the §7.2 HOOK must be what blocks an evidence-less
      // answer (the block reason teaches the model the ask_user alternative) — a required
      // field would surface a bare schema error instead.
      evidence: Type.Optional(Type.String({ description: "依据：note:<笔记id> 或 user:<消息id>" })),
      basis: Type.Union([Type.Literal("memory"), Type.Literal("user_explicit")]),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      const outcome = await ctx.answerWorker({
        workerId: args.workerId,
        questionId: args.questionId,
        text: args.text,
        provenance: run?.provenance ?? "unknown",
        cmdId: `tool:${api.taskId}`,
      });
      if (outcome.kind === "refused") return err(`refused: ${outcome.reason}`);
      const tail =
        outcome.delivery === "steer"
          ? "不打断它手头的工具，当前批次结束后送达。"
          : outcome.delivery === "queued"
            ? "worker 正在启动/恢复，回答已排队。"
            : "已送达。";
      return ok(`已回答问题 ${args.questionId} 并转给 ${args.workerId}：${tail}问题关闭，无需再通知用户。`);
    },
  });

  const noAction = defineTool({
    name: "no_action",
    description: "记录「这轮醒来无事可做」并结束。事件触发运行里，没有用户必须知道的新信息时的默认收尾。",
    parameters: Type.Object({ reason: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      ctx.audit("no_action", args.reason);
      // §8.6: a routine/follow-up fire's default outcome — visible in lastResult, not just the log.
      const run = await ctx.currentRun();
      if (run && (run.kind === "routine" || run.kind === "followup")) {
        ctx.recordProactiveOutcome(run.operationId, `no_action: ${args.reason}`);
      }
      return { output: [{ type: "text" as const, text: "ok" }], control: { terminate: true } };
    },
  });

  // ---- Notes: the two-phase layered write (issue #18, steward.md §2.3-§2.5, §4.3) ----------
  // The module (ledger.notes) is deterministic and enforces caps + trust; the tools add the
  // one check the module cannot make itself: that a promotion/confirmation of a low-trust
  // source rests on a message the owner actually sent (the same provenance pattern as
  // start_worker, §7.2). Resident notes render as a prompt section (below); project notes
  // ride on get_thread; every change reaches the user with the next reply (drainPendingForReply
  // in steward.ts) — the model never needs to restate the bookkeeping itself.

  const noteDraftSchema = Type.Object({
    text: Type.String({ description: "要记住的内容，一句话（不知道它就会派错/多问/说错的事才值得记）" }),
    kind: Type.Union([
      Type.Literal("preference"),
      Type.Literal("convention"),
      Type.Literal("environment"),
      Type.Literal("fact"),
    ]),
    source: Type.Union([
      Type.Literal("user_said"),
      Type.Literal("connector"),
      Type.Literal("worker_reported"),
      Type.Literal("inferred"),
    ]),
    layer: Type.Union([Type.Literal("resident"), Type.Literal("project")]),
    repoId: Type.Optional(Type.String({ description: "项目层笔记必填：所属仓库" })),
    evidence: Type.Optional(Type.String({ description: "来源引用：user:<om_…> 消息 id 或 worker/report 引用" })),
  });

  const draftOf = (args: { text: string; kind: string; source: string; layer: string; repoId?: string; evidence?: string }): NoteDraft | string => {
    if (args.layer !== "resident" && args.layer !== "project") return "layer 只能是 resident 或 project。";
    if (!["preference", "convention", "environment", "fact"].includes(args.kind)) return "kind 不合法。";
    if (!["user_said", "connector", "worker_reported", "inferred"].includes(args.source)) return "source 不合法。";
    return {
      text: args.text,
      kind: args.kind as NoteKind,
      source: args.source as NoteSource,
      layer: args.layer,
      ...(args.repoId !== undefined ? { scopeRepoId: args.repoId } : {}),
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
    };
  };

  const notesPropose = defineTool({
    name: "notes_propose",
    description:
      "写入记忆的第一步（不落库）：归一化并查重。返回 duplicate（已存在，commit 只会累加使用次数）、similar（语义相近的旧条目，同义的在 commit 里用 replaces 取代）、needsEviction（写满时按保留分排序的腾挪候选，置顶豁免）。",
    parameters: noteDraftSchema,
    replay: "safe",
    execute: async (args) => {
      const draft = draftOf(args);
      if (typeof draft === "string") return err(draft);
      const result = ctx.ledger.notes.propose(draft);
      if (result.rejected) return err(`refused: ${result.rejected.message}`);
      return ok(
        JSON.stringify({
          duplicate: result.duplicate && { noteId: result.duplicate.noteId, text: result.duplicate.text },
          similar: result.similar.map((n) => ({ noteId: n.noteId, text: n.text, layer: n.layer, source: n.source })),
          needsEviction: result.needsEviction.map((n) => ({ noteId: n.noteId, text: n.text, bytes: n.bytes })),
        }),
      );
    },
  });

  const notesCommit = defineTool({
    name: "notes_commit",
    description:
      "写入记忆的第二步（唯一写入路径）。replaces：被取代/被腾挪的旧条目 id（旧条目进档案，可追溯）。常驻层的门是硬性的：evidence 必须指向用户真正说过的那条消息（user:<om_…>；用户消息触发的轮次里可省略，系统会用当轮消息）；worker_reported / inferred 要进常驻层必须先在项目层经 notes_confirm 确认（replaces 指向它），或当轮就是用户的确认消息（confirmEvidence=user:<om_…>）；connector 来源只能进项目层。写入会记入下一条回复的「记账」，无需在正文里复述。",
    // Type.Object merge, not Type.Intersect: an intersect serializes as bare `allOf` with no
    // top-level `type: "object"`, which DeepSeek's tool-schema validation rejects with 400
    // (`schema must be a JSON Schema of 'type: "object"', got 'type: null'`) — found by the
    // first real-model eval run (issue #7 baseline).
    parameters: Type.Object({
      ...noteDraftSchema.properties,
      replaces: Type.Optional(Type.Array(Type.String(), { description: "notes_propose 给出的旧条目 id（同义取代或腾挪）" })),
      confirmEvidence: Type.Optional(Type.String({ description: "用户确认消息：user:<om_…>（直接提升低信任来源时必填，须是当轮用户消息）" })),
    }),
    // §4.3: commit is replay-safe — an exact-text duplicate absorbs the replay (bump only).
    replay: "safe",
    execute: async (args) => {
      const draft = draftOf(args);
      if (typeof draft === "string") return err(draft);
      // The anti-poisoning checks the module cannot do (§2.3 + §7.2's pattern). A resident
      // write always rests on the owner's own words; a low-trust promotion additionally
      // rests on a confirmation that is bound to something: either a project note this
      // deployment already marked confirmed (notes_confirm verified its evidence), or the
      // user message that triggered THIS run (event runs have neither and must park first).
      if (args.layer === "resident" && draft.source === "user_said") {
        const run = await ctx.currentRun();
        const claimed = args.evidence ?? (run?.kind === "user" ? run.provenance : undefined);
        if (!claimed || !(await ctx.checkProvenanceRef(claimed))) {
          return err(
            "refused: 常驻层记忆必须挂在用户真正说过的消息上（evidence=user:<om_…>）。用户消息触发的轮次可省略 evidence；系统输入的轮次必须指明用户原话所在的消息。",
          );
        }
        draft.evidence = claimed;
      }
      if (args.layer === "resident" && LOW_TRUST_SOURCES.includes(draft.source)) {
        // A confirmed LOW-TRUST predecessor is the parked-then-promoted path: notes_confirm
        // already bound the owner's message to it (temporally), so the promotion inherits
        // that proof — for THE SAME CLAIM only (review R1): a confirmation must not be
        // spendable on unrelated text, and the promoted note carries the predecessor's
        // evidence so the "who confirmed this" trail survives on the row itself.
        const basis = (args.replaces ?? [])
          .map((id) => ctx.ledger.notes.get(id))
          .find(
            (n): n is NonNullable<typeof n> =>
              n !== null &&
              n.status === "active" &&
              n.confirmed &&
              LOW_TRUST_SOURCES.includes(n.source) &&
              sameClaim(draft.text, n.text),
          );
        if (basis !== undefined) {
          // Parked → confirmed (notes_confirm bound the owner's message to it) → promoted.
          // Prefer the predecessor's confirmation ref so the row says who confirmed it;
          // fall back to its origin evidence when the confirmation carried none.
          draft.confirmed = true;
          draft.evidence = draft.evidence ?? basis.confirmedBy ?? basis.evidence ?? undefined;
        } else if (
          (args.replaces ?? []).some((id) => {
            const n = ctx.ledger.notes.get(id);
            return n !== null && n.status === "active" && n.confirmed && LOW_TRUST_SOURCES.includes(n.source);
          })
        ) {
          // A confirmed low-trust note is present but matches no claim in the draft: that is
          // the laundering shape (review R1) — fail closed; a confirmed user_said note in
          // replaces is an ordinary supersession and does not trip this.
          return err(
            "refused: replaces 里有已确认的条目，但内容和要写入的不是同一件事——确认不能挪用。先在项目层记录这条新内容，等用户确认后再提升。",
          );
        } else {
          const run = await ctx.currentRun();
          if (!args.confirmEvidence || !(await ctx.checkProvenanceRef(args.confirmEvidence))) {
            return err("refused: 低信任来源进常驻层需要先在项目层记录并经 notes_confirm 确认（replaces 指向它），或给出 confirmEvidence=user:<消息id>。");
          }
          if (run && run.kind !== "user") {
            return err("refused: 事件触发的轮次不能直接提升低信任记忆：先写项目层，等用户确认（notes_confirm）后再提升。");
          }
          if (run && args.confirmEvidence !== run.provenance) {
            return err("refused: confirmEvidence 必须是触发本轮的那条用户消息（确认必须发生在对话里，不能引用旧消息）。");
          }
          draft.confirmed = true;
          draft.evidence = draft.evidence ?? args.confirmEvidence;
        }
      }
      const result = ctx.ledger.notes.commit(draft, { replaces: args.replaces });
      if (!result.ok) {
        return err(
          `refused: ${result.message}` +
            (result.needsEviction.length > 0
              ? ` 可腾挪候选：${JSON.stringify(result.needsEviction.map((n) => ({ noteId: n.noteId, text: n.text })))}`
              : ""),
        );
      }
      if (result.bumped) return ok(`已存在同文笔记（${result.note.noteId}），累加使用次数，未新建。`);
      return ok(
        `已记住（${result.note.noteId}，${result.note.layer}）：${result.note.text}` +
          (result.changes.length > 1 ? `；另有变更：${result.changes.slice(1).map((c) => c.op).join("、")}（会随下一条回复告知用户）` : "（会随下一条回复告知用户）"),
      );
    },
  });

  const notesConfirm = defineTool({
    name: "notes_confirm",
    description:
      "用户确认了某条待确认记忆（worker 汇报/推断来源）。evidenceRef 必须是用户说确认的那条消息（user:<om_…>），且必须晚于笔记创建（「记账」先告知、用户再确认——引用更早的消息不算确认）。确认后方可提升常驻层（notes_commit + replaces）。",
    parameters: Type.Object({
      noteId: Type.String(),
      evidenceRef: Type.String({ description: "用户确认消息：user:<om_…>" }),
    }),
    replay: "safe",
    execute: async (args) => {
      const note = ctx.ledger.notes.get(args.noteId);
      if (!note) return err(`笔记 ${args.noteId} 不存在。`);
      if (note.status === "removed") return err(`笔记 ${args.noteId} 已被删除。`);
      if (note.confirmed) return ok("已是确认状态。");
      const receivedAt = await ctx.messageReceivedAt(args.evidenceRef);
      if (receivedAt === null) {
        return err("refused: evidenceRef 必须是本部署真实收到的用户消息（user:<om_…>）。");
      }
      // The announcement rides the first reply AFTER the note exists, so a genuine
      // confirmation always postdates createdAt — anything earlier is a citation, not a
      // confirmation (review finding 3b).
      if (receivedAt <= note.createdAt) {
        return err("refused: 确认消息必须晚于笔记创建（用户先看到「记账」才能确认）。");
      }
      ctx.ledger.notes.confirm(args.noteId, args.evidenceRef);
      return ok("已确认。现在可以用 notes_commit（replaces 指向它）提升到常驻层。");
    },
  });

  const notesPin = defineTool({
    name: "notes_pin",
    description: "置顶/取消置顶一条记忆：置顶条目永不被自动腾挪。用户说「这条别忘」时用。",
    parameters: Type.Object({ noteId: Type.String(), pinned: Type.Boolean() }),
    replay: "safe",
    execute: async (args) => {
      const note = ctx.ledger.notes.get(args.noteId);
      if (!note) return err(`笔记 ${args.noteId} 不存在。`);
      if (note.status === "removed") return err(`笔记 ${args.noteId} 已被删除。`);
      if (note.pinned === args.pinned) return ok(args.pinned ? "已是置顶状态。" : "本就未置顶。");
      ctx.ledger.notes.pin(args.noteId, args.pinned);
      return ok(args.pinned ? "已置顶。" : "已取消置顶。");
    },
  });

  const notesRemove = defineTool({
    name: "notes_remove",
    description: "删除一条记忆（用户明确要求时）。条目转入档案墓碑，不再出现在任何层。",
    parameters: Type.Object({ noteId: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      const note = ctx.ledger.notes.get(args.noteId);
      if (!note) return err(`笔记 ${args.noteId} 不存在。`);
      ctx.ledger.notes.remove(args.noteId);
      return ok("已删除。");
    },
  });

  const notesList = defineTool({
    name: "notes_list",
    description: "列出记忆（用户问「你记住了什么」或整理记忆时用）。默认列出常驻层+项目层；includeArchive 连档案（被取代/归档的历史）一起列。",
    parameters: Type.Object({
      layer: Type.Optional(Type.Union([Type.Literal("resident"), Type.Literal("project"), Type.Literal("archive")])),
      repoId: Type.Optional(Type.String()),
      includeArchive: Type.Optional(Type.Boolean()),
    }),
    replay: "safe",
    execute: async (args) => {
      const notes = ctx.ledger.notes.list({
        // includeArchive without an explicit layer widens to every layer (history included).
        layer: args.layer ?? (args.includeArchive ? "all" : undefined),
        ...(args.repoId !== undefined ? { scopeRepoId: args.repoId } : {}),
        ...(args.includeArchive !== undefined ? { includeRemoved: args.includeArchive } : {}),
      });
      if (notes.length === 0) return ok("（无记忆条目）");
      return ok(
        notes
          .map((n) => `${n.noteId} [${n.layer}${n.scopeRepoId ? `:${n.scopeRepoId}` : ""}]${n.pinned ? "📌" : ""}${n.confirmed ? "" : "（待确认）"} ${n.text}`)
          .join("\n"),
      );
    },
  });

  const notesSearch = defineTool({
    description: "按子串搜记忆（含档案层：被取代/腾挪/归档的历史版本）。",
    name: "notes_search",
    parameters: Type.Object({ q: Type.String({ description: "搜索词（≥3 字效果最好）" }) }),
    replay: "safe",
    execute: async (args) => {
      const notes = ctx.ledger.notes.search(args.q);
      if (notes.length === 0) return ok("（无匹配）");
      return ok(
        notes
          .map((n) => `${n.noteId} [${n.layer}${n.scopeRepoId ? `:${n.scopeRepoId}` : ""}]${n.status === "superseded" ? "（已被取代）" : ""} ${n.text}`)
          .join("\n"),
      );
    },
  });

  // ---- proactive behavior (issue #20, steward.md §8) ------------------------------------------------

  /** Shared spec parameters for create_routine / suggest_routine. */
  const routineSpecParams = {
    instruction: Type.String({ description: "自包含的做什么（digest 类可写「汇总当前进展」）" }),
    kind: Type.Union([Type.Literal("digest"), Type.Literal("instruction")], {
      description: "digest=系统确定性汇总（不耗模型）；instruction=按指令执行（以 ⟦routine⟧ 唤醒你）",
    }),
    cron: Type.Optional(Type.String({ description: '5 段 cron（UTC），如 "0 9 * * 1-5"＝每个工作日 09:00' })),
    atIso: Type.Optional(Type.String({ description: "一次性任务的触发时刻（ISO 8601，未来时间）" })),
    threadId: Type.Optional(Type.String({ description: "归属的 Thread（回看/派发类建议带上）" })),
    repoRef: Type.Optional(Type.String({ description: "涉及的仓库（可选）" })),
  };

  /** Resolves the spec args into the service input; null error text on bad input. */
  const specInput = (args: { instruction: string; kind: "digest" | "instruction"; cron?: string; atIso?: string; threadId?: string; repoRef?: string }): { ok: true; input: RoutineSpecInput } | { ok: false; error: string } => {
    let onceAt: number | undefined;
    if (args.atIso !== undefined) {
      const parsed = parseAtIso(args.atIso);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      onceAt = parsed.onceAt;
    }
    return {
      ok: true,
      input: {
        instruction: args.instruction,
        kind: args.kind,
        ...(args.cron !== undefined && args.cron.length > 0 ? { cron: args.cron.trim() } : {}),
        ...(onceAt !== undefined ? { onceAt } : {}),
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        ...(args.repoRef !== undefined ? { repoId: args.repoRef } : {}),
      },
    };
  };

  const createRoutine = defineTool({
    name: "create_routine",
    description:
      "创建例行任务（spec §8.3）。只能在你和用户的对话运行里调用：先把触发条件和要做的事复述给用户确认，确认后立即调用（当前这条用户消息就是授权来源）。" +
      "绝对不要用它在用户没答应时建任务——那种情况用 suggest_routine 发按钮。",
    parameters: Type.Object({
      ...routineSpecParams,
      basis: Type.Literal("user_explicit", { description: "创建例行任务必须来自用户的明确要求（§7.2）" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      if (!run || run.kind !== "user" || !run.provenance.startsWith("user:")) {
        return err("refused: create_routine 只能在用户消息的运行里、用户明确要求后调用（§7.2/§8.3）。要主动提议请用 suggest_routine。 ");
      }
      const spec = specInput(args);
      if (!spec.ok) return err(`refused: ${spec.error}`);
      const outcome = await ctx.routines.create({
        ...spec.input,
        routineId: `r_${api.taskId}`,
        createdFromMsg: run.provenance.slice("user:".length),
      });
      if (!outcome.ok) return err(`refused: ${outcome.reason}`);
      return ok(`已创建例行任务 ${outcome.routine.routineId}（${describeSchedule(outcome.routine)}），会按计划触发。`);
    },
  });

  const suggestRoutine = defineTool({
    name: "suggest_routine",
    description:
      "建议用户把某件事变成例行任务：只发送一张带「创建/先不用」按钮的卡片，绝不直接创建（spec §8.3：创建需要用户同意）。" +
      "用户点「创建」后系统才会保存。用户已经明说要时不要用这个，直接复述确认后 create_routine。",
    parameters: Type.Object(routineSpecParams),
    replay: "safe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      if (!run || run.kind !== "user" || !run.provenance.startsWith("user:")) {
        return err("refused: suggest_routine 只能在用户消息的运行里调用。");
      }
      const spec = specInput(args);
      if (!spec.ok) return err(`refused: ${spec.error}`);
      const outcome = await ctx.routines.suggest({
        ...spec.input,
        offerId: String(api.taskId),
        sourceMsg: run.provenance.slice("user:".length),
      });
      if (!outcome.ok) return err(`refused: ${outcome.reason}`);
      return ok("已发送建议卡片（带按钮）。用户点「创建」后才会真正保存；本轮不要再调用 create_routine。");
    },
  });

  const setFollowup = defineTool({
    name: "set_followup",
    description:
      "给一个 Thread 设定时回看（「两小时后再看一眼那个任务」）。用户运行里直接设；在事件/例行运行里你自己发起的回看必须给 sourceRef" +
      "（该 Thread 的来源用户消息 user:<om_…>，get_thread 的 createdFromMsg 可查；或 routine:<r_…>），否则拒绝（§8.3）。",
    parameters: Type.Object({
      threadId: Type.String(),
      afterMinutes: Type.Number({ description: "多少分钟后回看（>0）" }),
      reason: Type.String({ description: "到时候为什么要看（自包含）" }),
      sourceRef: Type.Optional(Type.String({ description: "事件/例行运行里必填：user:<msgId> 或 routine:<id>" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const thread = ctx.ledger.threads.get(args.threadId);
      if (!thread) return err(`Thread ${args.threadId} 不存在。`);
      const run = await ctx.currentRun();
      // An EXPLICIT sourceRef is the model claiming a specific authorization — a false claim
      // is refused outright (§7.2), never silently substituted with the fallback.
      if (args.sourceRef !== undefined && !(await ctx.checkProvenanceRef(args.sourceRef))) {
        return err(`refused: sourceRef ${args.sourceRef} 无法验证（必须是真实收到的 user:<msgId> 或 routine:<id>）。`);
      }
      // The source ref: explicit > the user run's own message > the Thread's origin message —
      // every path resolves to something the owner actually said/authorized (§8.3).
      const candidates = [
        args.sourceRef,
        run && run.kind === "user" && run.provenance.startsWith("user:") ? run.provenance : undefined,
        thread.createdFromMsg ? `user:${thread.createdFromMsg}` : undefined,
      ].filter((v): v is string => v !== undefined);
      let sourceRef: string | undefined;
      for (const candidate of candidates) {
        if (await ctx.checkProvenanceRef(candidate)) {
          sourceRef = candidate;
          break;
        }
      }
      if (sourceRef === undefined) {
        return err("refused: 找不到可验证的来源（sourceRef 必须是真实收到的 user:<msgId> 或 routine:<id>；该 Thread 的 createdFromMsg 也可）。 ");
      }
      const outcome = await ctx.routines.setFollowup({
        followupId: `f_${api.taskId}`,
        threadId: args.threadId,
        afterMinutes: args.afterMinutes,
        reason: args.reason,
        createdBy: run?.kind === "user" ? "user" : "steward",
        sourceRef,
      });
      if (!outcome.ok) return err(`refused: ${outcome.reason}`);
      const when = new Date(outcome.followup.dueAt).toISOString().slice(0, 16).replace("T", " ");
      return ok(`已设定回看 ${outcome.followup.followupId}：${when} UTC 时以 ⟦followup⟧ 唤醒。`);
    },
  });

  const listSchedules = defineTool({
    name: "list_schedules",
    description: "列出所有例行任务与未触发的定时回看（编号、触发条件、状态、上次结果）。用户问「我有哪些例行任务」或你要取消/暂停前先查它。",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const routines = ctx.ledger.routines.list();
      const followups = ctx.ledger.followups.list();
      if (routines.length === 0 && followups.length === 0) return ok("还没有任何例行任务或定时回看。 ");
      return ok(
        JSON.stringify({
          routines: routines.map((r) => ({
            id: r.routineId,
            kind: r.kind,
            status: r.status,
            schedule: describeSchedule(r),
            instruction: r.instruction,
            threadId: r.threadId,
            lastRunAt: r.lastRunAt,
            lastResult: r.lastResult,
          })),
          followups: followups
            .filter((f) => f.status !== "cancelled")
            .map((f) => ({ id: f.followupId, status: f.status, threadId: f.threadId, dueAt: f.dueAt, reason: f.reason, lastResult: f.lastResult })),
        }),
      );
    },
  });

  const cancelSchedule = defineTool({
    name: "cancel_schedule",
    description: "取消一个例行任务或定时回看（传 list_schedules 里的编号）。用户说「取消那个每天九点的」时用；管理动作只在用户运行里可调。",
    parameters: Type.Object({ scheduleId: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      const run = await ctx.currentRun();
      if (!run || run.kind !== "user") return err("refused: 取消只能由用户发起（对话里说取消）。 ");
      const outcome = await ctx.routines.cancel(args.scheduleId);
      return outcome.ok ? ok(outcome.what) : err(`refused: ${outcome.reason}`);
    },
  });

  const pauseSchedule = defineTool({
    name: "pause_schedule",
    description: "暂停/恢复一个例行任务（paused=true 暂停，false 恢复）。定时回看是一次性的，直接 cancel_schedule。",
    parameters: Type.Object({
      scheduleId: Type.String(),
      paused: Type.Boolean(),
    }),
    replay: "safe",
    execute: async (args) => {
      const run = await ctx.currentRun();
      if (!run || run.kind !== "user") return err("refused: 暂停/恢复只能由用户发起（对话里说暂停）。 ");
      const outcome = await ctx.routines.pause(args.scheduleId, args.paused);
      return outcome.ok ? ok(outcome.what) : err(`refused: ${outcome.reason}`);
    },
  });

  // Policy hook (§7.2 + §3.3, issue #7): dispatches need a real basis — never `inferred` —
  // and exactly one per run (a second start_worker for another target means the model is
  // second-guessing itself; observed live in the spike). The guard resets when the run's
  // provenance changes, never mid-run (spike bug 9). An interrupt additionally requires the
  // user's own hand (spec §6: interrupting a running task must follow an explicit user
  // instruction). New in #7: a NON-EXPLICIT attach (the run was routed neither to this
  // thread by a reply/button nor deterministically by find_threads' explicit short-circuit —
  // review #48 finding 1 made signal 2 count) requires routing.confidence "high"; anything
  // less is blocked with the demand to ask_user — a deterministic gate in front of the
  // model's self-assessed certainty, so a guess can never become a dispatch.
  const guard = hook(ToolTask, {
    beforeTool: async (call) => {
      const args = (call as { arguments?: Record<string, unknown> }).arguments ?? {};
      if (call.name === "start_worker") {
        if ((args.basis as string) === "inferred") {
          return { block: "Autonomy rule: 禁止凭推断派发。用 ask_user 与用户确认，或给出用户给过的依据。" };
        }
        if (!args.threadId && !args.newTitle) {
          return { block: "派发需要 threadId（接续）或 newTitle（新开）。先 find_threads / 读态势简报。" };
        }
        const run = await ctx.currentRun();
        syncRunScope(run);
        if (typeof args.threadId === "string" && args.threadId.length > 0) {
          const explicitlyRouted = run?.routedThreadId === args.threadId || explicitFindThreadId === args.threadId;
          if (!explicitlyRouted) {
            const routing = args.routing as { confidence?: unknown; reason?: unknown } | undefined;
            if (routing === undefined || typeof routing.confidence !== "string") {
              return {
                block:
                  `接续到 ${args.threadId} 不是显式路由（这条消息不是对它的回复/按钮，本轮 find_threads 也没给出它的显式命中），必须给出 routing: {confidence, reason}。` +
                  "确信唯一就给 high；把握不足不要硬给——改用 ask_user（带 candidates）让用户点。",
              };
            }
            if (routing.confidence !== "high") {
              return {
                block:
                  `接续到 ${args.threadId} 的把握只有 ${routing.confidence}——这不是显式路由，政策不允许非 high 的接续。` +
                  "改用 ask_user（带 candidates，≤3 个 Thread + 系统会加「新开一件事」按钮）让用户点。",
              };
            }
          }
        }
        const target = String(args.threadId ?? `new:${String(args.newTitle)}`);
        if (dispatchedTarget !== undefined && dispatchedTarget !== target) {
          return { block: `本轮已经派发过（${dispatchedTarget}）。不要在同一回合改派；有疑问用 ask_user。` };
        }
        dispatchedTarget = target;
      }
      // §7.2 (issue #10): answer_worker answers only with evidence — a note id the ledger
      // actually holds (and can quote back), or a user message this deployment received from
      // the bound owner. Anything else is the model's own assertion; the only path left is
      // ask_user. Evidence-less answers never reach the worker.
      if (call.name === "answer_worker") {
        const evidence = args.evidence;
        if (typeof evidence !== "string" || evidence.trim().length === 0) {
          return { block: "Autonomy rule: answer_worker 需要 evidence（note:<笔记id> 或 user:<消息id>）；没有证据就改用 ask_user（带 questionId）。" };
        }
        const trimmed = evidence.trim();
        if (trimmed.startsWith("note:")) {
          const note = ctx.ledger.notes.get(trimmed.slice("note:".length));
          if (!note || note.status === "removed") {
            return { block: `Autonomy rule: evidence 笔记 ${trimmed} 不存在。用 notes_search / notes_list 找到真实笔记 id，或改用 ask_user。` };
          }
        } else if (trimmed.startsWith("user:")) {
          if (!(await ctx.isOwnerMessage(trimmed.slice("user:".length)))) {
            return { block: `Autonomy rule: evidence 消息 ${trimmed} 不是本部署收到过的用户消息。改用 ask_user（带 questionId）。` };
          }
        } else {
          return { block: "Autonomy rule: evidence 只能是 note:<笔记id> 或 user:<消息id>。没有证据就改用 ask_user（带 questionId）。" };
        }
        if (typeof args.questionId !== "string" || args.questionId.length === 0) {
          return { block: "answer_worker 需要 questionId（⟦event⟧ 输入里有 questionId=）。" };
        }
      }
      if (call.name === "interrupt_worker") {
        const basis = args.basis;
        if (basis !== "user_explicit" && basis !== "user_reply_to") {
          return {
            block:
              "Autonomy rule: 中断运行中的任务必须用户明示（spec §6）。basis 只能是 user_explicit 或 user_reply_to；" +
              "拿不准就用 ask_user 先问用户。",
          };
        }
        if (typeof args.workerId !== "string" || args.workerId.length === 0) {
          return { block: "interrupt_worker 需要 workerId（先 get_thread 查看）。" };
        }
      }
      return undefined;
    },
  });

  // The situation brief, per request, into the single request only (§4.1): the hook replaces
  // the outgoing message list for that request; pi commits the *view's* messages, so nothing
  // of this lands in the transcript. Fallback (input prefix) stays unused — see steward.md
  // §4.1/§15.1 for the verification record.
  const briefHook = hook(GenerationTask, {
    beforeRequest: (request) => {
      const brief = ctx.buildBrief();
      const messages = [...request.messages];
      const index = messages.findIndex((m) => m.role === "system");
      const current: SystemMessage =
        index >= 0
          ? (messages[index] as SystemMessage)
          : { role: "system", content: "", timestamp: Date.now() };
      const sections = { ...(current.sections ?? {}), [SITUATION_SECTION]: brief };
      const replaced: SystemMessage = { ...current, sections };
      if (index >= 0) messages[index] = replaced;
      else messages.unshift(replaced);
      return { messages: messages as readonly Message[] };
    },
  });

  return defineExtension({
    name: "sig-steward",
    tools: [
      situation, findThreads, getThread, updateThread, startWorker, sendToWorker, interruptWorker,
      notifyUser, askUser, answerWorker, noAction,
      createRoutine, suggestRoutine, setFollowup, listSchedules, cancelSchedule, pauseSchedule,
      notesPropose, notesCommit, notesConfirm, notesPin, notesRemove, notesList, notesSearch,
    ],
    hooks: [guard, briefHook],
    sections: [
      section("sig-role", () => ROLE_PROMPT, { tag: false }),
      // §4.1: resident notes are one system-prompt section — rendered from the ledger at
      // every generation, so a change appends only the delta (pi's section planner) and the
      // conversation never re-reads the whole layer. Empty layer ⇒ section omitted.
      section(NOTES_SECTION, () => ctx.ledger.notes.renderResidentSection() || undefined),
    ],
  });
}

// The system prompt essentials (steward.md §4.4). The actual text is written here, at
// implementation time, per the design doc's instruction.
const ROLE_PROMPT = `你是 Sig，用户的个人助手，负责调度用户机器上的编码 agent。对用户始终自称 Sig，不使用「总管」作为称呼。你自己不写代码；你的职责是理解用户、派发任务、记账（维护每个 Thread 的摘要）、并在必要时通知用户。

输入的来源（重要）：
- 普通文本是用户通过 owner API 发来的原话。
- 以 ⟦ 开头的输入不是用户说的话，是系统输入：⟦event⟧ 是 worker 事件、⟦routine⟧ 是例行任务、⟦followup⟧ 是定时回看、⟦verify⟧ 是派发声明的核查。这类运行里你的普通文字输出会被系统丢弃、用户看不到；要让用户知道什么必须调 notify_user，无事可做就调 no_action 结束。
- 「（系统注：…）」开头的行是系统附加的路由信息，可信，不是用户原话。

规则：
1. 派发用 start_worker：需要仓库（repoRef，用户提过的或 get_thread 里看到的）和一段自包含的 prompt。机器选择是确定性规则，工具替你完成；它返回「已用按钮问用户」或 refusal 时，把情况如实转告用户（refusal 里已写明原因和选项），不要换个说法再派一次。派发时按任务性质选 mode：纯研究/答疑/评审用 readonly，会改代码或拿不准用 write（默认）。用户点名 agent（如「用 Claude Code 跑」）时才填 agent（机器上报过的种类，如 claude-code）；没点名不填（默认 pi）。接续已有 Thread 时，续用原会话还是开新会话由系统按同一 agent/机器、上下文占用等规则自动决定并附交接简报，prompt 只写本棒任务本身；仅当用户明确要「全新视角/独立评审/不受之前结论影响」时才给 freshReview: true。
2. 路由——接错比多问一次严重得多，拿不准就问：
   - 接续指令先调 find_threads。返回 confidence=explicit 时直接接续那个 Thread（threadId，无需 routing）。否则从候选里判断：只有一个明确匹配且话语点名了它的要点 → 接续它，并给 routing: {confidence: "high", reason}（这是政策硬性要求，非显式接续没带 high 会被拦下）。
   - 两个及以上候选同样匹配、或话语完全没有指代对象 → 必须用 ask_user 问（带 candidates=≤3 个 Thread，用户点按钮即定归属；系统会自动加「新开一件事」按钮）。不要在文字里反问后结束。
   - 症状与调查类话语（「有点慢，帮我看看」「为什么超时」「查查报错」）描述的是现象，不是某条任务本身：现象可能来自同一主题的多条 Thread（同一服务的几个任务都可能是源头）时，就是上条的「多个候选同样匹配」——ask_user 问清指向，readonly 诊断也不豁免：挂错 Thread 会把调查结论记进错误的上下文。现有任务都解释不了这个现象，或用户要的是全面排查 → 新开。
   - 总称式说法把多个 Thread 概括在一起（「那边」「都」「几件事」「老任务」这类），而不止一个候选说得通时，同样是歧义：让用户圈定范围，不要自选子集或另开排查。
   - 没有候选、或候选都弱且话语没有点名它 → 新需求，新开（newTitle 用用户原话短语），不要问。
   - 接续措辞是同一件事：「按 X 方案/计划实施」「接着 X 继续」「在 X 基础上做」，而 X 正是某个 Thread 的产出（方案、调研、分支）→ 接续那个 Thread，不要新建（worker 接力依赖同线程，另开线程会丢掉接力基础）。反例：X 是外部产物（产品发的交互稿、网上文档）、没有对应 Thread → 新开。
   - 给已有 Thread 追加后续要求（「跑完让它把迁移 SQL 也生成」「做完把截图发我」）同样是接续：用 start_worker 挂到那个 Thread（新 worker 会接续前一棒的分支），不要只在回复里答应记着。
   - 挂靠的依据是**同一件事的延续**，不是「领域相近」：新功能、新需求即使和现有 Thread 话题相关也是新事件，该新建就新建。
   - 挂靠已沉寂多日（工具结果会提醒）的 Thread 时，回复里要说明是接续早前的那件事（「已挂到之前那个 xx 上」）。
3. 每次行动前先看态势简报（系统提示里的 sig-situation 段落）；需要细节再 get_thread。状态/进度类问题（「修好了吗」「方案出来了吗」）不派发，直接根据汇报与状态回答。
4. worker 汇报到达（⟦event⟧）后做记账：用 update_thread 重写该 Thread 的摘要；若工具结果或唤醒文本提示「整十版」，这次必须按 get_thread 的时间线与汇报【从头重写】，不要在旧摘要上缝补。除非卡片之外还有用户必须知道的新信息（风险、需要拍板、明确失败），否则不要再通知用户——通知卡片已经发过了。⟦verify⟧ 输入意味着上一条回复声称派发过但没有：要么现在真调 start_worker，要么用 notify_user 向用户更正。
5. 给用户的回复要短：先结论，再要点，几行以内。严禁声称派发过而实际没有调用工具；只有看到 dispatched 结果才算派发过。
6. 派发的依据（basis）：用户明说要干什么用 user_explicit；回复某条汇报用 user_reply_to；来自例行任务用 routine。凭空的推断禁止派发，改用 ask_user。
7. 运行中的任务可以干预（workerId 从 get_thread 拿）：转向/追加用 send_to_worker —— 用户要「立刻改」用 intent=now（不打断当前工具，当前批次结束就转向，回复里说明 after_current_tools），「做完这个再顺便…」用 intent=after；停下/停止用 interrupt_worker，且仅限用户明示（basis=user_explicit 或 user_reply_to），「停，然后改用 X」把 X 放进 then。转向不是停下：想停就说停。
7b. worker 的提问（⟦event⟧ 里 blocked/needs_decision，带 questionId=）：90 秒内由你处置——纯事实问题（目标分支、命令、约定）且证据在手（笔记或用户原话）用 answer_worker（evidence 必填，否则被拦）；需要用户拍板/授权/没有证据的用 ask_user 转问，必带 questionId，选项给「同意/按你说的办」这类可点项；unreported（没有产出汇报）按最后的原话分类：像完成就 notify_user（questionId + resolution=done）如实汇报，在提问或拿不准就 ask_user 带 questionId 转问，不要凭空当作失败。没有任何处置时核心会在 90 秒后把问题原文转给用户（兜底不丢）。notify_user 带 questionId 时同样取消兜底。
8. notify_user 的三段有硬性长度限制（结论 ≤80 字；做了什么 ≤4 条、每条 ≤100 字；需要你 ≤120 字），超长会被拒绝——压缩重写，不要截断。
9. 永远不要替用户宣布「这件事完成了」；完成与否由汇报与事实说话。
10. 例行任务与定时回看（spec §8）：用户表达周期性需求（「每个工作日 9 点汇总昨晚进展」）时，先把触发条件和要做的事复述给他确认，确认后用 create_routine（basis=user_explicit；digest=确定性汇总，instruction=按指令执行；cron 用 UTC）。你只是「察觉到重复模式」时，用 suggest_routine 发一张带按钮的建议卡——点按钮才会创建，绝不绕过按钮。给某个 Thread 设闹钟用 set_followup；管理用 list_schedules / pause_schedule / cancel_schedule（「暂停那个每天九点的」）。
11. ⟦routine R⟧ 输入到达时按指令执行：要派发必须带 provenanceRef=routine:R（或指令里引用的真实用户消息），无事可做用 no_action 收尾——那是默认结局，不要为了「显得有用」而制造通知。⟦followup F⟧ 到期时同理：先看那个 Thread 的现状再决定。
12. 记忆（notes_* 工具）：值得记的是「不知道它就会派错/多问/说错」的事——用户偏好与项目约定，不是闲聊内容。写入分两步：先 notes_propose 看查重/相似/腾挪候选，再 notes_commit（replaces 带上被取代或被腾挪的旧条目 id）。信任规则是硬性的：常驻层永远要有 evidence=用户真正说过的消息 id（用户消息触发的轮次可省略，系统自动挂当轮消息；事件触发的轮次必须指明）；worker_reported / inferred 来源先写项目层（待确认），用户在对话里确认后（notes_confirm，evidenceRef=确认那条消息）才能提升常驻层；connector 来源永远只进项目层。每次写入系统会自动在下一条回复后附「记账」，正文不必复述。用户要看/置顶/删除记忆时用 notes_list / notes_pin / notes_remove。`
