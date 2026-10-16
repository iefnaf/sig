// The situation brief (issue #6, steward.md §4.1): per-Thread state, machine online status,
// and open questions — the freshest-every-turn view injected into the single request by the
// `beforeRequest` hook (never written into the conversation). Built from the ledger only;
// deterministic, character-budgeted (steward.md §12).
//
// Review #5: the budget is spent in priority order — open questions and the Threads they
// belong to first, then running, then idle with their summaries dropped first — and any
// omission is stated, so truncation can never silently hide a "waiting for you".
import type { Ledger } from "../ledger.ts";

/** §12 "use fewer tokens": the brief stays inside this budget. */
export const SITUATION_BUDGET = 1_200;
/** §3.2: at personal scale a dozen threads covers everything; the rest are a line away. */
const MAX_THREADS = 12;

const STATE_ORDER: Record<string, number> = { waiting_you: 0, running: 1, idle: 2 };
const STATE_LABEL: Record<string, string> = { running: "进行中", waiting_you: "等你", idle: "空闲" };

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
            return `${m.online ? "🟢" : "⚫️"} ${m.name}${m.online ? `（${free}/${m.maxWorkers} 空闲）` : "（离线）`"}`;
          })
          .join("，")}`;

  // Open questions lead: they are the brief's most action-relevant content and must survive
  // any budget pressure (review #5).
  const questions: Array<{ threadId: string; text: string }> = [];
  for (const thread of ledger.threads.list()) {
    const q = ledger.questions.openForThread(thread.threadId);
    if (q) questions.push({ threadId: thread.threadId, text: q.text });
  }

  // Threads sorted waiting_you > running > idle; idle summaries are the first thing to go.
  const threads: BriefThread[] = ledger.threads
    .list()
    .slice(0, MAX_THREADS)
    .map((t) => ({ threadId: t.threadId, title: t.title, state: t.state, unread: t.unread, summary: t.summary }))
    .sort((a, b) => (STATE_ORDER[a.state] ?? 3) - (STATE_ORDER[b.state] ?? 3));
  const olderThreadCount = Math.max(0, ledger.threads.list().length - MAX_THREADS);

  const questionLines = (dropped: number) =>
    questions.length - dropped > 0
      ? ["未决问题（优先处理）：", ...questions.slice(0, questions.length - dropped).map((q) => `- ${q.threadId}：${q.text}`)]
      : [];

  const threadLines = (withIdleSummaries: boolean): string[] => {
    if (threads.length === 0) return ["Thread：还没有任何一件事。"];
    const lines = threads.map((t) => {
      const flag = t.unread ? "（有未读汇报）" : "";
      const summary = withIdleSummaries && t.summary && t.state !== "idle" ? `\n  摘要：${t.summary.slice(0, 120)}` : "";
      return `- ${t.threadId}「${t.title}」${STATE_LABEL[t.state] ?? t.state}${flag}${summary}`;
    });
    if (olderThreadCount > 0) lines.push(`（另有 ${olderThreadCount} 件更早的 Thread 未列出）`);
    return ["Thread（等你 > 进行中 > 空闲）：", ...lines];
  };

  // Assemble at decreasing fidelity until it fits: questions are never dropped before
  // everything else has already given up its summaries, and then only with a count.
  const attempts: Array<{ dropQuestions: number; idleSummaries: boolean }> = [
    { dropQuestions: 0, idleSummaries: true },
    { dropQuestions: 0, idleSummaries: false },
    { dropQuestions: 1, idleSummaries: false },
  ];
  for (const attempt of attempts) {
    const brief = [header, machineLine, ...questionLines(attempt.dropQuestions), ...threadLines(attempt.idleSummaries)].join("\n");
    if (brief.length <= SITUATION_BUDGET || attempt.dropQuestions >= questions.length) {
      const clipped =
        brief.length <= SITUATION_BUDGET ? brief : `${brief.slice(0, SITUATION_BUDGET - 1)}…（已截断，用 get_thread 看细节）`;
      const hiddenQuestions = questions.length > attempt.dropQuestions ? 0 : questions.length;
      return hiddenQuestions > 0 ? `${clipped}\n（另有 ${hiddenQuestions} 个未决问题未列出）` : clipped;
    }
  }
  return [header, machineLine, ...threadLines(false)].join("\n").slice(0, SITUATION_BUDGET - 1) + "…";
}
