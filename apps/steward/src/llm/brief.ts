// The situation brief (issue #6, steward.md §4.1): per-Thread state, machine online status,
// and open questions — the freshest-every-turn view injected into the single request by the
// `beforeRequest` hook (never written into the conversation). Built from the ledger only;
// deterministic, character-budgeted (steward.md §12).
import type { Ledger } from "../ledger.ts";

/** §12 "use fewer tokens": the brief stays inside this budget. */
export const SITUATION_BUDGET = 1_200;
/** §3.2: at personal scale a dozen threads covers everything; the rest are a line away. */
const MAX_THREADS = 12;

const STATE_LABEL: Record<string, string> = { running: "进行中", waiting_you: "等你", idle: "空闲" };

/** Renders the compact current-situation brief shown to the model on every request. */
export function buildSituationBrief(ledger: Ledger, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push(`当前时间：${new Date(now).toISOString().slice(0, 16).replace("T", " ")} UTC`);

  const machines = ledger.machines.list();
  if (machines.length === 0) {
    lines.push("机器：没有任何机器连接过。派发前需要先在机器上安装并连接 connector。");
  } else {
    lines.push(
      `机器：${machines
        .map((m) => {
          const free = Math.max(0, m.maxWorkers - ledger.machines.runningCount(m.deviceId));
          return `${m.online ? "🟢" : "⚫️"} ${m.name}${m.online ? `（${free}/${m.maxWorkers} 空闲）` : "（离线）"}`;
        })
        .join("，")}`,
    );
  }

  const threads = ledger.threads.list();
  if (threads.length === 0) {
    lines.push("Thread：还没有任何一件事。");
  } else {
    lines.push("Thread（按活跃排序）：");
    for (const t of threads.slice(0, MAX_THREADS)) {
      const flag = t.unread ? "（有未读汇报）" : "";
      lines.push(`- ${t.threadId}「${t.title}」${STATE_LABEL[t.state] ?? t.state}${flag}`);
      if (t.summary) lines.push(`  摘要：${t.summary.slice(0, 120)}`);
    }
    if (threads.length > MAX_THREADS) lines.push(`（另有 ${threads.length - MAX_THREADS} 件更早的）`);
  }

  const openQuestions = collectOpenQuestions(ledger);
  if (openQuestions.length > 0) {
    lines.push("未决问题：");
    lines.push(...openQuestions.slice(0, 5).map((q) => `- ${q.threadId ? `${q.threadId}：` : ""}${q.text}`));
  }

  const brief = lines.join("\n");
  return brief.length <= SITUATION_BUDGET ? brief : `${brief.slice(0, SITUATION_BUDGET - 1)}…`;
}

function collectOpenQuestions(ledger: Ledger): Array<{ threadId: string | null; text: string }> {
  const out: Array<{ threadId: string | null; text: string }> = [];
  for (const thread of ledger.threads.list()) {
    const q = ledger.questions.openForThread(thread.threadId);
    if (q) out.push({ threadId: thread.threadId, text: q.text });
  }
  return out;
}
