// Deterministic wake-up texts (issue #6, steward.md §5.4): the core — never the LLM — writes
// what a wake is about, from sh_report rows and git facts. Event/routine/follow-up inputs all
// carry the ⟦…⟧ content markers; the system prompt tells the model that anything starting
// with ⟦ is not something the user said (§4.2). The marker characters are escaped out of
// inbound user text (see escapeMarkers), so the two input classes can never be forged into
// each other.
import type { GitFacts, MachineRow, ThreadRow, WorkerRow } from "./ledger.ts";

/** The content marker characters; ⟦ at an input's start means "system, not user". */
export const MARK_OPEN = "⟦";
export const MARK_CLOSE = "⟧";
/** What user text uses instead after escaping — visually close, never a marker. */
const ESCAPE_OPEN = "〔";
const ESCAPE_CLOSE = "〕";

/** Inbound user text: strip the marker characters so it can never mimic a system input. */
export function escapeMarkers(text: string): string {
  return text.replaceAll(MARK_OPEN, ESCAPE_OPEN).replaceAll(MARK_CLOSE, ESCAPE_CLOSE);
}

/** True when an input text is a marked system input (event/routine/follow-up). */
export function isMarkedInput(text: string): boolean {
  return text.startsWith(MARK_OPEN);
}

export interface EventWakeInput {
  thread: ThreadRow | null;
  worker: WorkerRow;
  machine: MachineRow | null;
  /** The report row when the wake is a `report` event; null for failure-class settles. */
  report: {
    status: "done" | "blocked" | "needs_decision";
    summary: string;
    changes: string[] | null;
    decisions: string[] | null;
    leftovers: string[] | null;
    tests: { ran: boolean; passed?: boolean; note?: string } | null;
    question: string | null;
    git: GitFacts | null;
  } | null;
  /** The settled outcome when the wake is a failure-class `settled` event. */
  settled?: { outcome: string; errorClass: string | null; text: string };
  /** Whether the deterministic core already pushed a card to the user for this event. */
  notified: boolean;
  /** §2.6 (issue #8): the next summary update lands on the every-10th boundary — the wake
   *  asks for a from-scratch rewrite instead of an edit. */
  summaryRewriteDue?: boolean;
  /** Issue #10: the question this report/settle opened — answer_worker / ask_user /
   *  notify_user must carry it, and the core's fallback forwards verbatim if unhandled. */
  questionId?: string;
}

/**
 * The ⟦event⟧ wake-up text (steward.md §5.4): compact, factual, and explicit about what has
 * already been sent to the user, so the steward knows bookkeeping is its only remaining job.
 */
export function eventWakeText(input: EventWakeInput): string {
  const { thread, worker, machine } = input;
  const head = `${MARK_OPEN}event${MARK_CLOSE} thread=${thread?.threadId ?? "?"} 「${thread?.title ?? "已归档"}」`;
  const who = `worker ${worker.workerId}（${worker.agent}@${machine?.name ?? worker.deviceId}，${worker.mode === "write" ? "写任务" : worker.mode}）`;

  if (input.report) {
    const r = input.report;
    const lines = [head, `- ${who} 汇报 ${r.status}：${r.summary}`];
    if (input.questionId) lines.push(`questionId=${input.questionId}`);
    if (r.changes?.length) lines.push(`  改动：${r.changes.join("；")}`);
    if (r.tests?.ran) lines.push(`  测试：${r.tests.passed === false ? "未通过" : "通过"}${r.tests.note ? `（${r.tests.note}）` : ""}`);
    if (r.git) {
      lines.push(`  分支 ${r.git.branch}${r.git.pushed ? "（已推送）" : `（未推送，领先 ${r.git.ahead} 个提交）`}`);
    }
    if (r.decisions?.length) lines.push(`  决定：${r.decisions.join("；")}`);
    if (r.leftovers?.length) lines.push(`  遗留：${r.leftovers.join("；")}`);
    if (r.question) lines.push(`  问题：${r.question}`);
    lines.push(`已发送给用户的通知：${input.notified ? "是（核心模板卡片）" : "否"}`);
    lines.push(
      r.status === "done"
        ? "请做记账：用 update_thread 更新摘要。" +
            (input.summaryRewriteDue
              ? "⚠️ 这次的摘要更新落在整十版：必须【从头重写】（按 get_thread 的时间线与汇报重建，不要在旧摘要上缝补）。"
              : "") +
            "除非有用户必须知道的新信息，不要再通知用户；无事可做用 no_action 结束。"
        : "问题尚未转给用户。90 秒内可用 answer_worker 回答纯事实问题（必须有笔记或用户消息 evidence）；需要决定或没有证据时，用 ask_user 转问，带 questionId。notify_user 也须带 questionId。没有处理则核心原文转发。",
    );
    return lines.join("\n");
  }

  const s = input.settled!;
  return [
    head,
    `- ${who} 结束（${s.outcome}${s.errorClass ? `，${s.errorClass}` : ""}）：${s.text}`,
    `已发送给用户的通知：${input.notified ? "是（核心模板卡片）" : "否"}`,
    ...(input.questionId ? [`questionId=${input.questionId}`] : []),
    s.outcome === 'unreported'
      ? "请根据最后原话分类：若已完成，用 notify_user 汇报并带 questionId、resolution=done；若在提问或无法确定，用 ask_user 带 questionId 转问用户。不要凭空当作失败。"
      : "请做记账与分类；除非有用户必须知道的新信息，不要再通知用户；无事可做用 no_action 结束。", 
  ].join("\n");
}

/** ⟦routine R⟧ inputs (steward.md §4.2/§8.2); queued when a routine fire reaches the LLM. */
export function routineWakeText(
  routineId: string,
  instruction: string,
  ctx?: { schedule?: string; createdFromMsg?: string | null; thread?: { threadId: string; title: string } | null },
): string {
  const meta: string[] = [];
  if (ctx?.schedule) meta.push(`触发：${ctx.schedule}`);
  if (ctx?.createdFromMsg) meta.push(`由用户消息 ${ctx.createdFromMsg} 设立`);
  if (ctx?.thread) meta.push(`归属 Thread：${ctx.thread.threadId}「${ctx.thread.title}」`);
  return [
    `${MARK_OPEN}routine ${routineId}${MARK_CLOSE} ${instruction}`,
    ...(meta.length > 0 ? [`（${meta.join("；")}）`] : []),
    `按指令执行；要派发必须带 provenanceRef=routine:${routineId}（或指令里引用的真实用户消息 user:<om_…>）；无事可做用 no_action 结束。`,
  ].join("\n");
}

/** ⟦followup F⟧ inputs (steward.md §4.2/§8.3); queued when a follow-up comes due. */
export function followupWakeText(
  followupId: string,
  reason: string,
  ctx?: { thread?: { threadId: string; title: string } | null; sourceRef?: string | null; createdBy?: string },
): string {
  const meta: string[] = [];
  if (ctx?.thread) meta.push(`Thread：${ctx.thread.threadId}「${ctx.thread.title}」`);
  if (ctx?.createdBy) meta.push(ctx.createdBy === "user" ? "用户设定的回看" : "总管自己设定的回看");
  if (ctx?.sourceRef) meta.push(`来源：${ctx.sourceRef}`);
  return [
    `${MARK_OPEN}followup ${followupId}${MARK_CLOSE} ${reason}`,
    ...(meta.length > 0 ? [`（${meta.join("；")}）`] : []),
    "再看一眼这个 Thread 的状况，决定是否需要行动（派发需带 provenanceRef，或引用真实用户消息）；无事可做用 no_action 结束。",
  ].join("\n");
}

/** The ⟦event⟧ wake for a `queue_returned` (connector-pi.md §6.2/§11.1): texts pi handed
 *  back at interrupt time never reached the worker — the steward decides their fate. */
export function queueReturnedWakeText(input: {
  thread: ThreadRow | null;
  worker: WorkerRow;
  machine: MachineRow | null;
  texts: string[];
}): string {
  const { thread, worker, machine } = input;
  return [
    `${MARK_OPEN}event${MARK_CLOSE} thread=${thread?.threadId ?? "?"} 「${thread?.title ?? "已归档"}」`,
    `- worker ${worker.workerId}（${worker.agent}@${machine?.name ?? worker.deviceId}）被中断时，有 ${input.texts.length} 条排队消息未送达就被取回：`,
    ...input.texts.slice(0, 5).map((text) => `  · ${text.slice(0, 120)}`),
    "这些消息没有送到 worker。请决定：重发（send_to_worker，需用户授权或用户消息佐证）、告知用户，或确认作废；无事可做用 no_action 结束。",
  ].join("\n");
}

/** The ⟦event⟧ wake for an `external_activity` (connector-pi.md §10): the owner used the
 *  worker's session at the keyboard; the steward folds a coarse account of it into the
 *  Thread summary. Low priority by design (steward.md §5.3) — nothing is blocked on it. */
export function externalActivityWakeText(input: {
  thread: ThreadRow | null;
  worker: WorkerRow;
  machine: MachineRow | null;
  count: number;
  window: string | null;
  changedFiles: string[];
  summary: string;
}): string {
  const { thread, worker, machine } = input;
  const lines = [
    `${MARK_OPEN}event${MARK_CLOSE} thread=${thread?.threadId ?? "?"} 「${thread?.title ?? "已归档"}」`,
    `- worker ${worker.workerId}（${worker.agent}@${machine?.name ?? worker.deviceId}）的会话在机器上被直接使用过：重连前新增 ${input.count} 条记录${input.window ? `（${input.window}）` : ""}。`,
  ];
  if (input.changedFiles.length > 0) lines.push(`  改动文件：${input.changedFiles.map(escapeMarkers).join("、")}`);
  if (input.summary) lines.push(`  概要：${escapeMarkers(input.summary)}`);
  lines.push("请把这段外部进展并入该 Thread 的摘要（update_thread），避免下次派发时丢失这段上下文；不要通知用户，也不要据此派发；无事可做用 no_action 结束。");
  return lines.join("\n");
}

/** The ⟦event⟧ wake for a delivery-class failure the user must hear about (issue #15):
 *  `session_in_use` (the owner is using the session at the keyboard) or `not_delivered`
 *  (the connector provably never delivered it). `instruction` arrives pre-escaped. */
export function commandAttentionWakeText(input: {
  threadId: string;
  workerId: string;
  kind: string;
  instruction: string;
  code: string;
  detail: string;
}): string {
  const sessionInUse = input.code === "session_in_use";
  return [
    `${MARK_OPEN}event${MARK_CLOSE} thread=${input.threadId}`,
    `- 指向 worker ${input.workerId} 的命令（${input.kind}：「${input.instruction}」）失败：${input.detail}`,
    sessionInUse
      ? "请告知用户：那台机器上的这个会话正被他本人使用，稍后再试即可；需要时用 ask_user 问是否稍后重试。"
      : "请告知用户这条指令没有送达（用户可能以为已发出）；要重发必须以用户的确认或回复为依据（basis=user_reply_to），不要自行重发。",
  ].join("\n");
}

/** The ⟦event⟧ wake for a command the connector could only report `ambiguous` (issue #15,
 *  connector-pi.md §6.3): delivery is unknowable — the connector crashed mid-`sending` — and
 *  by design it will never re-send. Only the user can decide whether to re-issue it. */
export function ambiguousWakeText(input: {
  thread: ThreadRow | null;
  worker: WorkerRow;
  cmdId: string;
  kind: string;
  instruction: string;
}): string {
  const { thread, worker, kind, instruction } = input;
  return [
    `${MARK_OPEN}event${MARK_CLOSE} thread=${thread?.threadId ?? "?"} 「${thread?.title ?? "已归档"}」`,
    `- 指向 worker ${worker.workerId} 的命令（${kind}：「${instruction}」）结果不确定：连接器在投递中崩溃，无法判断 worker 是否已收到，且按设计不会自动重发。`,
    "请用 ask_user 问用户是否重新下达（附「重发」/「不用了」选项）；用户确认重发后，以其回复为依据（basis=user_reply_to）再调用对应工具。绝不自行重发。",
  ].join("\n");
}

/** ⟦verify⟧ inputs (issue #7, spike-conclusions §2 “post-dispatch settle-time verification”):
 * the corrective follow-up when a user run claimed a dispatch that never happened. The
 * original user message's provenance rides on the run (replyTo), so the steward may still
 * dispatch — or must correct itself to the user via notify_user. The claimed phrase is
 * marker-escaped (review #48 finding 5): the model wrote it, so it may itself contain ⟦…⟧,
 * and an unescaped embed would smuggle a fake system wake into this input. The routing
 * hint (finding 2): only an explicitly-routed attach skips routing — the same §3.3 policy
 * holds inside a verify run, or the corrective dispatch just hits the same gate.
 */
export function verifyWakeText(claim: string): string {
  return [
    `${MARK_OPEN}verify${MARK_CLOSE} 你上一条回复声称已派发任务（“${escapeMarkers(claim).slice(0, 80)}”），但这次运行中没有发生任何 start_worker 调用。`,
    "请现在真正调用 start_worker 完成派发（接续非显式路由的 Thread 时同样要带 routing: {confidence: 'high', reason}；系统注已定归属或 find_threads 给了 explicit 的除外）；如果其实不该派发，用 notify_user 向用户发一句更正。",
  ].join("\n");
}
