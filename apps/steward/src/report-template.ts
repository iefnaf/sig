// Core report templates (issue #5, steward.md §6.4 / spec §7.5): done-class reports go to the
// user straight from data, deterministically, with no dependence on an LLM being up or on
// budget (steward.md §0.2 / §12). The tone is decided by the NATURE of the message — success /
// attention / failure — independent of whether a needsYou is attached: a completion that comes
// with minor caveats still reads success, so one glance at the color tells the user whether
// anything went wrong.
import type { GitFacts, ReportRow, WorkerRow } from "./ledger.ts";

/** Lengths from spec §7.5 / steward.md §6.4. */
export const MAX_CONCLUSION = 80;
export const MAX_DID_ITEM = 100;
export const MAX_DID_ITEMS = 4;
export const MAX_NEEDS_YOU = 120;

export type Tone = "success" | "attention" | "failure";

const TONE_BADGE = { success: "✅", attention: "⚠️", failure: "❌" } as const;
const TONE_TEMPLATE = { success: "green", attention: "orange", failure: "red" } as const;
const TONE_LABEL = { success: "成功", attention: "需要你", failure: "出错" } as const;

export interface ReportCardInput {
  tone: Tone;
  conclusion: string;
  did: string[];
  needsYou?: string;
  threadTitle: string;
  footer: string;
  /** One-time signed timeline URL appended by the system (steward.md §6.4), never by the LLM. */
  detailsUrl?: string;
}

function clip(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Renders the three-part report as a Feishu interactive card (im/v1 `interactive`). */
export function renderReportCard(input: ReportCardInput): { config: unknown; header: unknown; elements: unknown[] } {
  const elements: unknown[] = [];
  const did = input.did.filter((item) => item.trim().length > 0).slice(0, MAX_DID_ITEMS).map((item) => `- ${clip(item, MAX_DID_ITEM + 2)}`);
  if (did.length > 0) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**做了什么**\n${did.join("\n")}` } });
  }
  if (input.needsYou && input.needsYou.trim().length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**需要你**：${clip(input.needsYou, MAX_NEEDS_YOU + 6)}` } });
  }
  if (input.detailsUrl) {
    // "查看详情" logs the owner straight into the Thread timeline (spec §7.3; the URL is a
    // one-time signed link minted per card — the value carries no data, unlike §3.1's rule
    // for action buttons, because nothing needs resolving on click).
    elements.push({
      tag: "action",
      actions: [{ tag: "button", text: { tag: "plain_text", content: "查看详情" }, type: "default", url: input.detailsUrl }],
    });
  }
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: clip(input.footer, 200) }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: TONE_TEMPLATE[input.tone],
      title: { tag: "plain_text", content: `${TONE_BADGE[input.tone]} ${clip(input.conclusion, MAX_CONCLUSION + 2)}` },
    },
    elements,
  };
}

/** The did[] bullets built from a worker report: changes, tests, git facts (never invented). */
export function didBullets(report: ReportRow): string[] {
  const bullets: string[] = [];
  for (const change of report.changes ?? []) bullets.push(change);
  if (report.tests?.ran) {
    const verdict = report.tests.passed === false ? "未通过" : "通过";
    bullets.push(`测试${verdict}${report.tests.note ? `（${report.tests.note}）` : ""}`);
  }
  const git = report.git;
  if (git) {
    const parts = [`分支 ${git.branch}`];
    if (git.ahead > 0) parts.push(`${git.ahead} 个提交`);
    parts.push(git.pushed ? "已推送" : "未推送");
    if (git.dirty > 0) parts.push(`${git.dirty} 个文件未提交`);
    bullets.push(parts.join("，"));
  }
  return bullets;
}

/** Needs-you text from a report: the worker's question first, its next-suggestion as fallback. */
export function needsYouOf(report: ReportRow): string | undefined {
  if (report.status === "done") {
    // A completion with minor caveats stays success-toned; needs-you only when the worker
    // actually asked for something (steward.md §6.4).
    const leftovers = report.leftovers ?? [];
    if (report.next && report.next.trim().length > 0) return `建议下一步：${report.next}`;
    if (leftovers.length > 0) return `遗留：${leftovers.join("；")}`;
    return undefined;
  }
  return report.question ?? report.summary;
}

export function toneOfReport(status: ReportRow["status"]): Tone {
  // Tone by nature: done is a success even when it carries caveats; blocked/needs_decision
  // need the user; outright failures (settled error / start failure) are red.
  return status === "done" ? "success" : "attention";
}

/** Assembles the deterministic done-class card for a processed `report` event. */
export function reportCardFor(report: ReportRow, worker: WorkerRow, machineName: string, threadTitle: string, detailsUrl?: string) {
  return renderReportCard({
    tone: toneOfReport(report.status),
    conclusion: report.summary,
    did: didBullets(report),
    needsYou: needsYouOf(report),
    threadTitle,
    detailsUrl,
    footer: `Thread「${threadTitle}」 · ${worker.agent} @ ${machineName} · 引用回复可继续这个 Thread`,
  });
}

/** The deterministic failure card for settled error / start-failure pushes. */
export function failureCard(conclusion: string, needsYou: string, threadTitle: string, footer: string, detailsUrl?: string) {
  return renderReportCard({ tone: "failure", conclusion, did: [], needsYou, threadTitle, footer, detailsUrl });
}

/** The deterministic stall-reminder card (steward.md §8.4 / §6.2 source 1): attention, not
 * failure — 20 straight minutes of silence may still be one very long tool call. */
export function stallCard(
  minutes: number,
  worker: { agent: string },
  machineName: string,
  threadTitle: string,
  footer: string,
  detailsUrl?: string,
) {
  return renderReportCard({
    tone: "attention",
    conclusion: `⏸ ${threadTitle}：${minutes} 分钟没有任何动静`,
    did: [],
    needsYou: `${machineName} 上的 ${worker.agent} 无输出已 ${minutes} 分钟。可能是超长的工具调用，也可能卡住了；连接器会自动重启一次，仍无动静会被回收为失联。`,
    threadTitle,
    footer,
    detailsUrl,
  });
}

/** The offline-ask card (spec §9): dispatch found only an offline machine — never decide silently. */
export function offlineAskCard(repoName: string, machineName: string, threadTitle: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `⚠️ ${repoName} 只在 ${machineName} 上，它现在不在线` },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `已建好 Thread「${threadTitle}」。要排队等它上线后自动开始，还是取消？`,
        },
      },
      {
        tag: "action",
        // The values carry only the action — the Thread is resolved from the card's
        // providerMsgId on callback, never from data stuffed in here (spike bug, §3.1).
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "排队等上线" }, type: "primary", value: { action: "wait_online" } },
          { tag: "button", text: { tag: "plain_text", content: "算了" }, type: "default", value: { action: "cancel" } },
        ],
      },
      { tag: "note", elements: [{ tag: "plain_text", content: `Thread「${threadTitle}」 · ${machineName}` }] },
    ],
  };
}

export const HELP_TEXT = [
  "M1 固定指令（自然语言要等 M2 的总管）：",
  "/派发 <repo>[@<machine>] <要做的事> —— 派一个写任务并汇报",
  "/状态 —— 所有 Thread 与机器",
  "/加机器 —— 给新电脑发配对命令",
  "/网页 —— 取一次性登录链接，网页里看时间线、管机器",
].join("\n");

export function statusText(threads: Array<{ title: string; state: string; unread: boolean }>, machines: Array<{ name: string; online: boolean }>): string {
  const machineLines = machines.map((m) => `${m.online ? "🟢" : "⚫️"} ${m.name}`);
  const threadLines = threads.map((t) => {
    const mark = t.state === "running" ? "▶" : t.state === "waiting_you" ? "❓" : "·";
    return `${mark} ${t.title}（${t.state}${t.unread ? "，未读" : ""}）`;
  });
  return [
    machineLines.length > 0 ? `机器：\n${machineLines.join("\n")}` : null,
    threadLines.length > 0 ? `Thread：\n${threadLines.join("\n")}` : null,
    threadLines.length === 0 ? "还没有任何 Thread。发「/派发 <repo> <要做的事>」开始。" : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export const TONE_LABELS = TONE_LABEL;
