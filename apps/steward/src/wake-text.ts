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
    if (r.changes?.length) lines.push(`  改动：${r.changes.join("；")}`);
    if (r.tests?.ran) lines.push(`  测试：${r.tests.passed === false ? "未通过" : "通过"}${r.tests.note ? `（${r.tests.note}）` : ""}`);
    if (r.git) {
      lines.push(`  分支 ${r.git.branch}${r.git.pushed ? "（已推送）" : `（未推送，领先 ${r.git.ahead} 个提交）`}`);
    }
    if (r.decisions?.length) lines.push(`  决定：${r.decisions.join("；")}`);
    if (r.leftovers?.length) lines.push(`  遗留：${r.leftovers.join("；")}`);
    if (r.question) lines.push(`  问题：${r.question}`);
    lines.push(`已发送给用户的通知：${input.notified ? "是（核心模板卡片）" : "否"}`);
    lines.push("请做记账：用 update_thread 更新摘要。除非有用户必须知道的新信息，不要再通知用户；无事可做用 no_action 结束。");
    return lines.join("\n");
  }

  const s = input.settled!;
  return [
    head,
    `- ${who} 结束（${s.outcome}${s.errorClass ? `，${s.errorClass}` : ""}）：${s.text}`,
    `已发送给用户的通知：${input.notified ? "是（核心模板卡片）" : "否"}`,
    "请做记账与分类；除非有用户必须知道的新信息，不要再通知用户；无事可做用 no_action 结束。",
  ].join("\n");
}

/** ⟦routine R⟧ inputs (steward.md §4.2); queued by the routines ticket (#20). */
export function routineWakeText(routineId: string, instruction: string): string {
  return `${MARK_OPEN}routine ${routineId}${MARK_CLOSE} ${instruction}`;
}

/** ⟦followup F⟧ inputs (steward.md §4.2); queued by the follow-up ticket (#20). */
export function followupWakeText(followupId: string, reason: string): string {
  return `${MARK_OPEN}followup ${followupId}${MARK_CLOSE} ${reason}`;
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
