// The `shepherd-steward` pi-durable extension (issue #6, steward.md §4): system-prompt
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
import { MAX_THREAD_SUMMARY, type Ledger } from "../ledger.ts";
import { titleOf, type StartWorkerInput, type StartWorkerOutcome } from "../dispatch.ts";
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
  /** Verify a model-claimed provenance reference (§7.2): `user:<msgId>` must be a message
   *  this deployment actually received. Routine/followup/watch ids land with #20. */
  checkProvenanceRef(ref: string): Promise<boolean>;
  /** notify_user / ask_user land in the outbound queue; only these reach the user.
   *  `dedupeId` (from the tool taskId) makes replayed calls converge on one message. */
  notifyUser(input: {
    conclusion: string;
    did: string[];
    needsYou?: string;
    tone: Tone;
    urgency: "push" | "quiet";
    threadId?: string;
    dedupeId?: string;
  }): Promise<void>;
  askUser(input: { question: string; options: string[]; threadId?: string; dedupeId?: string }): Promise<void>;
  /** Audit trail for no_action and other quiet outcomes (§8.6). */
  audit(kind: string, detail: string): void;
}

const SITUATION_SECTION = "shepherd-situation";

const ok = (text: string) => ({ output: [{ type: "text" as const, text }] });
const err = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });

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

  const getThread = defineTool({
    name: "get_thread",
    description: "一个 Thread 的详情：目标、摘要、worker、最新汇报、未决问题、最近时间线。接续或回答状态问题前先看它。",
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
      return ok(
        JSON.stringify({
          threadId: thread.threadId,
          title: thread.title,
          goal: thread.goal,
          summary: thread.summary,
          state: thread.state,
          unread: thread.unread,
          repos: ctx.ledger.threads.repoIds(thread.threadId),
          workers: workers.map((w) => ({
            workerId: w.workerId, state: w.state, agent: w.agent, mode: w.mode,
            branch: w.branch, lastOutcome: w.lastOutcome,
          })),
          latestReport: report && { status: report.status, summary: report.summary, question: report.question, git: report.git },
          openQuestion: question?.text ?? null,
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
      const done = ctx.ledger.threads.update(args.threadId, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
      });
      return done ? ok("updated") : err(`Thread ${args.threadId} 不存在。`);
    },
  });

  const startWorker = defineTool({
    name: "start_worker",
    description:
      "派发一个编码任务到用户的机器。要么接续（threadId，来自 get_thread /态势简报），要么新开（newTitle + 可选 goal）。" +
      "机器由确定性规则挑选；工具会让你知道结果（已派发 / 已用按钮问用户 / 需要你转问用户）。basis 是你派发的依据。" +
      "事件触发的运行里（⟦…⟧ 输入）必须另外给 provenanceRef：一条真实存在的用户消息 id（user:<om_…>，来自时间线/汇报的 refs），" +
      "否则会被拒绝——系统输入自身不构成派发授权（设计 §7.2）。",
    parameters: Type.Object({
      prompt: Type.String({ description: "自包含的任务描述：worker 只看这段话" }),
      repoRef: Type.String({ description: "仓库名或 repoId（如 repo-a / /srv/repo-a）" }),
      threadId: Type.Optional(Type.String({ description: "接续到这个 Thread（接续指令必须用它）" })),
      newTitle: Type.Optional(Type.String({ description: "新 Thread 的标题（用户原话短语，≤24 字）" })),
      goal: Type.Optional(Type.String()),
      machineHint: Type.Optional(Type.String({ description: "用户点名的机器名（没点名就别填）" })),
      /** §7.2 (review #4): in event/routine/follow-up runs the system input itself is not
       * authorization — the model must point at the user message (later also routine/
       * followup/watch id) that asked for this. */
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
    // §4.3: a replay after a crash must not re-run the dispatch; the model sees "interrupted".
    // Idempotency for the connector is cmdId = "tool:" + api.taskId (protocol §7.1).
    replay: "unsafe",
    execute: async (args, api) => {
      const run = await ctx.currentRun();
      // Review #4: user runs carry their own authorization (the message that started them);
      // every other kind needs an explicit, verifiable provenanceRef.
      let provenance = run?.provenance ?? "unknown";
      if (run && run.kind !== "user") {
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
        provenance,
        cmdId: `tool:${api.taskId}`,
        createdFromMsg: provenance.startsWith("user:") ? provenance.slice("user:".length) : null,
      });
      if (outcome.kind === "refused") return err(`refused: ${outcome.reason}`);
      if (outcome.kind === "asked_offline") {
        return ok(`已用按钮卡片问用户（${outcome.machineName} 不在线：排队等上线，还是取消）。本轮不要再派发或追问。`);
      }
      const tail = outcome.queued
        ? `${outcome.machineName} 当前不在线，已排队，上线后自动开始。`
        : `已派给 ${outcome.machineName}，完成后我会汇报。`;
      return ok(`${outcome.created ? `已创建「${outcome.threadId}」并派发` : `已续派到 ${outcome.threadId}`}：${tail}`);
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
    }),
    replay: "safe",
    execute: async (args, api) => {
      const did = args.did ?? [];
      const violation = validateNotifyArgs({ conclusion: args.conclusion, did, needsYou: args.needsYou });
      if (violation) return err(`refused: ${violation}`);
      const tone: Tone = args.tone === "failure" ? "failure" : args.tone === "info" ? "success" : "attention";
      await ctx.notifyUser({
        conclusion: args.conclusion,
        did,
        ...(args.needsYou !== undefined ? { needsYou: args.needsYou } : {}),
        tone,
        urgency: args.urgency === "push" ? "push" : "quiet",
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        dedupeId: `notify:${api.taskId}`,
      });
      return ok("notified");
    },
  });

  const askUser = defineTool({
    name: "ask_user",
    description:
      "向用户提问并结束本轮（路由不明、意图存疑、必须用户拍板时用它，不要在文字里反问后结束）。最多 3 个简短选项。" +
      "带 threadId 的问题会把这个 Thread 置为「等你」。用户的回答会作为新消息回来。",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
      threadId: Type.Optional(Type.String()),
    }),
    replay: "safe",
    execute: async (args, api) => {
      await ctx.askUser({
        question: args.question,
        options: args.options ?? [],
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        dedupeId: `ask:${api.taskId}`,
      });
      return { output: [{ type: "text" as const, text: "asked" }], control: { terminate: true } };
    },
  });

  const noAction = defineTool({
    name: "no_action",
    description: "记录「这轮醒来无事可做」并结束。事件触发运行里，没有用户必须知道的新信息时的默认收尾。",
    parameters: Type.Object({ reason: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      ctx.audit("no_action", args.reason);
      return { output: [{ type: "text" as const, text: "ok" }], control: { terminate: true } };
    },
  });

  // Policy hook (§7.2, the M2 subset): dispatches need a real basis — never `inferred` — and
  // exactly one per run (a second start_worker for another target means the model is
  // second-guessing itself; observed live in the spike). The guard resets when the run's
  // provenance changes, never mid-run.
  let dispatchedTarget: string | undefined;
  let guardProvenance: string | undefined;
  const guard = hook(ToolTask, {
    beforeTool: async (call) => {
      const args = (call as { arguments?: Record<string, unknown> }).arguments ?? {};
      if (call.name === "start_worker") {
        if ((args.basis as string) === "inferred") {
          return { block: "Autonomy rule: 禁止凭推断派发。用 ask_user 与用户确认，或给出用户给过的依据。" };
        }
        if (!args.threadId && !args.newTitle) {
          return { block: "派发需要 threadId（接续）或 newTitle（新开）。先 get_thread / 读态势简报。" };
        }
        const run = await ctx.currentRun();
        if (run && run.provenance !== guardProvenance) {
          guardProvenance = run.provenance;
          dispatchedTarget = undefined;
        }
        const target = String(args.threadId ?? `new:${String(args.newTitle)}`);
        if (dispatchedTarget !== undefined && dispatchedTarget !== target) {
          return { block: `本轮已经派发过（${dispatchedTarget}）。不要在同一回合改派；有疑问用 ask_user。` };
        }
        dispatchedTarget = target;
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
    name: "shepherd-steward",
    tools: [situation, getThread, updateThread, startWorker, notifyUser, askUser, noAction],
    hooks: [guard, briefHook],
    sections: [section("shepherd-role", () => ROLE_PROMPT, { tag: false })],
  });
}

// The system prompt essentials (steward.md §4.4). The actual text is written here, at
// implementation time, per the design doc's instruction.
const ROLE_PROMPT = `你是 Shepherd 的总管（steward）：替用户调度他机器上的编码 agent。你自己不写代码；你的职责是理解用户、派发任务、记账（维护每个 Thread 的摘要）、并在必要时通知用户。

输入的来源（重要）：
- 普通文本是用户在飞书里发来的原话。
- 以 ⟦ 开头的输入不是用户说的话，是系统输入：⟦event⟧ 是 worker 事件、⟦routine⟧ 是例行任务、⟦followup⟧ 是定时回看。这类运行里你的普通文字输出会被系统丢弃、用户看不到；要让用户知道什么必须调 notify_user，无事可做就调 no_action 结束。
- 「（系统注：…）」开头的行是系统附加的路由信息，可信，不是用户原话。

规则：
1. 派发用 start_worker：需要仓库（repoRef，用户提过的或 get_thread 里看到的）和一段自包含的 prompt。机器选择是确定性规则，工具替你完成；它返回「已用按钮问用户」或 refusal 时，把情况如实转告用户（refusal 里已写明原因和选项），不要换个说法再派一次。
2. 路由：接续指令（「按 X 方案做」「在 X 基础上继续」而 X 是某个 Thread 的产出）必须接续那个 Thread（threadId）；新需求即使话题相关也新开。不确定归属哪个 Thread、或完全不知道用户指什么时，用 ask_user 反问（最多 3 个选项，含「新开一件事」），永远不要猜。挂靠已沉寂多日的 Thread 时要在回复里说明。
3. 每次行动前先看态势简报（系统提示里的 shepherd-situation 段落）；需要细节再 get_thread。状态/进度类问题（「修好了吗」）不派发，直接根据汇报与状态回答。
4. worker 汇报到达（⟦event⟧）后做记账：用 update_thread 重写该 Thread 的摘要。除非卡片之外还有用户必须知道的新信息（风险、需要拍板、明确失败），否则不要再通知用户——通知卡片已经发过了。
5. 给用户的回复要短：先结论，再要点，几行以内。严禁声称派发过而实际没有调用工具；只有看到 dispatched 结果才算派发过。
6. 派发的依据（basis）：用户明说要干什么用 user_explicit；回复某条汇报用 user_reply_to；来自例行任务用 routine。凭空的推断禁止派发，改用 ask_user。
7. notify_user 的三段有硬性长度限制（结论 ≤80 字；做了什么 ≤4 条、每条 ≤100 字；需要你 ≤120 字），超长会被拒绝——压缩重写，不要截断。
8. 永远不要替用户宣布「这件事完成了」；完成与否由汇报与事实说话。`;
