// The situation brief (issue #6, steward.md §4.1): per-Thread state, machine online status,
// and open questions — the freshest-every-turn view injected into the single request by the
// `beforeRequest` hook (never written into the conversation). Built from the ledger only;
// deterministic, character-budgeted (steward.md §12).
//
// Review #5 (round 2): the budget is spent in priority order — open questions and the Threads
// they belong to first, then running, then idle with their summaries dropped first. The
// invariant is that NO omission is ever silent: dropped questions are counted wherever they
// are dropped (partially or entirely), question texts are clipped like summaries (worker
// questions have no length cap of their own), and the last-resort fallback keeps a one-line
// questions count even when the block itself had to go.
import type { Ledger } from "../ledger.ts";

/** §12 "use fewer tokens": the brief stays inside this budget. */
export const SITUATION_BUDGET = 1_200;
/** §3.2: at personal scale a dozen threads covers everything; the rest are a line away. */
const MAX_THREADS = 12;
/** Question texts arrive uncapped (worker questions); the brief clips them like summaries. */
const QUESTION_TEXT_MAX = 120;

const STATE_ORDER: Record<string, number> = { waiting_you: 0, running: 1, idle: 2 };
const STATE_LABEL: Record<string, string> = { running: "进行中", waiting_you: "等你", idle: "空闲" };

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

interface BriefThread {
  threadId: string;
  title: string;
  state: string;
  unread: boolean;
  summary: string | null;
}

/** Renders the compact current-situation brief shown to the model on every request. */
export function buildSituationBrief(ledger: Ledger, now: number = Date.now()): string {
  const header = `当前时间：${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const machines = ledger.machines.list();
  const machineLine =
    machines.length === 0
      ? "机器：没有任何机器连接过。派发前需要先在机器上安装并连接 connector。"
      : `机器：${machines
          .map((m) => {
            const free = Math.max(0, m.maxWorkers - ledger.machines.runningCount(m.deviceId));
            return `${m.online ? "🟢" : "⚫️"} ${m.name}${m.online ? `（${free}/${m.maxWorkers} 空闲）` : "（离线）"}`;
          })
          .join("，")}`;

  // The repos the machines reported (issue #7): dispatching needs a repoRef, and a named
  // repo is a routing clue (§3.1 signal 2) — the brief must show what exists.
  const repoRows = ledger.repos.list();
  const repoLine =
    repoRows.length === 0
      ? "仓库：机器上还没有登记任何仓库。"
      : `仓库：${repoRows
          .slice(0, 8)
          .map((r) => `${r.name}（${machines.find((m) => m.deviceId === r.deviceId)?.name ?? r.deviceId}${r.online ? "" : "，离线"}）`)
          .join("、")}${repoRows.length > 8 ? ` 等 ${repoRows.length} 个` : ""}`;

  // Open questions lead: they are the brief's most action-relevant content and must survive
  // any budget pressure (review #5).
  const questions: Array<{ threadId: string; text: string }> = [];
  for (const thread of ledger.threads.list()) {
    const q = ledger.questions.openForThread(thread.threadId);
    if (q) questions.push({ threadId: thread.threadId, text: q.text });
  }

  // Threads sorted waiting_you > running > idle; summaries show for non-idle only.
  const threads: BriefThread[] = ledger.threads
    .list()
    .slice(0, MAX_THREADS)
    .map((t) => ({ threadId: t.threadId, title: t.title, state: t.state, unread: t.unread, summary: t.summary }))
    .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3));
  const olderThreadCount = Math.max(0, ledger.threads.list().length - MAX_THREADS);

  // Question lines keep the first `keep` questions (clipped) and ALWAYS count the dropped
  // ones — partial drops included (review round 2, finding B).
  const questionLines = (keep: number): string[] => {
    if (questions.length === 0) return [];
    const lines = ["未决问题（优先处理）："];
    for (const q of questions.slice(0, keep)) lines.push(`- ${q.threadId}：${clip(q.text, QUESTION_TEXT_MAX)}`);
    const dropped = questions.length - Math.min(keep, questions.length);
    if (dropped > 0) lines.push(`（另有 ${dropped} 个未决问题未列出，用 get_thread 逐条查看）`);
    return lines;
  };

  const threadLines = (withSummaries: boolean): string[] => {
    if (threads.length === 0) return ["Thread：还没有任何一件事。"];
    const lines = threads.map((t) => {
      const flag = t.unread ? "（有未读汇报）" : "";
      const summary = withSummaries && t.summary && t.state !== "idle" ? `\n  摘要：${t.summary.slice(0, 120)}` : "";
      return `- ${t.threadId}「${t.title}」${STATE_LABEL[t.state] ?? t.state}${flag}${summary}`;
    });
    if (olderThreadCount > 0) lines.push(`（另有 ${olderThreadCount} 件更早的 Thread 未列出）`);
    return ["Thread（等你 > 进行中 > 空闲）：", ...lines];
  };

  const assemble = (keepQuestions: number, withSummaries: boolean): string =>
    [header, machineLine, repoLine, ...questionLines(keepQuestions), ...threadLines(withSummaries)].join("\n");

  // Spend the budget in priority order: all questions with summaries, all questions without,
  // then progressively fewer questions — every partial drop carries its count line.
  for (let keep = questions.length; keep >= 0; keep--) {
    const withSummariesOptions = keep === questions.length ? [true, false] : [false];
    for (const withSummaries of withSummariesOptions) {
      const brief = assemble(keep, withSummaries);
      if (brief.length <= SITUATION_BUDGET) return brief;
    }
  }
  // Last resort: even without summaries and with every question dropped, the omission is
  // stated — never a silent disappearance (review round 2, finding B.2/B.3). The count line
  // goes right after the header so no later clipping can cut it off, and the truncation
  // suffix itself is counted against the budget.
  const SUFFIX = "…（已截断，用 get_thread 看细节）";
  const countLine =
    questions.length > 0 ? [`（另有 ${questions.length} 个未决问题未列出，用 get_thread 逐条查看）`] : [];
  const body = [header, ...countLine, machineLine, repoLine, ...threadLines(false)].join("\n");
  return body.length + SUFFIX.length <= SITUATION_BUDGET
    ? `${body}${SUFFIX}`
    : `${body.slice(0, SITUATION_BUDGET - SUFFIX.length)}${SUFFIX}`;
}
