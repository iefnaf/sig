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

export interface ReportCardInput {
  tone: Tone;
  conclusion: string;
  did: string[];
  needsYou?: string;
  threadTitle: string;
  footer: string;
  /** One-time signed timeline URL appended by the system (steward.md §6.4), never by the LLM. */
  detailsUrl?: string;
  /** Skip the needsYou length cap and whitespace collapse (issue #10 review finding 6): the
   *  §5.3 fallback card forwards the worker's question VERBATIM — a clip would silently drop
   *  the clause the owner must answer on the no-LLM path of last resort. */
  rawNeedsYou?: boolean;
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
    const needsYouText = input.rawNeedsYou ? input.needsYou.trim() : clip(input.needsYou, MAX_NEEDS_YOU + 6);
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**需要你**：${needsYouText}` } });
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
    needsYou: `${machineName} 上的 ${worker.agent} 无输出已 ${minutes} 分钟。可能是超长的工具调用，也可能卡住了；若确实卡住，连接器会尝试自动重启，持续无动静会被回收为失联。`,
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

/** The three-part card the steward's `notify_user` renders (steward.md §6.4 source 2). */
export function notifyCard(input: {
  tone: Tone;
  conclusion: string;
  did: string[];
  needsYou?: string;
  threadTitle?: string;
  detailsUrl?: string;
}) {
  return renderReportCard({
    tone: input.tone,
    conclusion: input.conclusion,
    did: input.did,
    needsYou: input.needsYou,
    threadTitle: input.threadTitle ?? "",
    detailsUrl: input.detailsUrl,
    footer: input.threadTitle
      ? `Thread「${input.threadTitle}」 · 来自总管的主动通知 · 引用回复可继续这个 Thread`
      : "来自总管的主动通知",
  });
}

/**
 * The §5.3 fallback card (issue #10): a blocked/needs_decision question nothing handled in
 * the window. The worker's question is forwarded VERBATIM — `needsYou` carries it unchanged
 * (a fixed cap would violate "verbatim"), the summary/did lines stay what the worker
 * reported. No LLM anywhere on this path.
 */
export function workerQuestionCard(input: {
  question: string;
  summary?: string;
  did?: string[];
  threadTitle: string;
  footer: string;
  detailsUrl?: string;
}) {
  return renderReportCard({
    tone: "attention",
    conclusion: `❓ ${input.threadTitle}：worker 需要你的回答`,
    did: input.did ?? [],
    needsYou: input.question,
    rawNeedsYou: true, // VERBATIM — uncapped, whitespace preserved (review finding 6)
    threadTitle: input.threadTitle,
    footer: input.footer,
    detailsUrl: input.detailsUrl,
  });
}

/** The `ask_user` push (steward.md §4.3): plain text — answering flows back as a quote-reply. */
export function askUserText(question: string, options: string[], threadTitle?: string): string {
  const head = threadTitle ? `【${threadTitle}】` : "";
  const body = options.length > 0 ? `${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : question;
  return `${head}❓ ${body}\n（直接回复这句话即可；回复会带上所属 Thread。）`;
}

/** One button of the ask card: `action` is what the card-action handler parses. */
export interface AskCardButton {
  label: string;
  /** The full action string carried in the button's value ({action}). */
  action: string;
  primary?: boolean;
}

/**
 * The ask_user card (issue #7, steward.md §3.3/§9.2): the question plus ≤3 candidate buttons
 * and a “新开一件事” button for routing asks. Button values carry only an opaque action
 * string (`ask:<qid>:<idx>` / `asknew:<qid>`) — Thread identity is resolved server-side from
 * the question row and the card's providerMsgId, never stuffed into the card (§3.1).
 */
export function askUserCard(input: { question: string; threadTitle?: string; buttons: AskCardButton[] }): {
  config: unknown;
  header: unknown;
  elements: unknown[];
} {
  const elements: unknown[] = [{ tag: "div", text: { tag: "lark_md", content: clip(input.question, 600) } }];
  if (input.buttons.length > 0) {
    elements.push({
      tag: "action",
      actions: input.buttons.map((button) => ({
        tag: "button",
        text: { tag: "plain_text", content: clip(button.label, 24) },
        type: button.primary ? "primary" : "default",
        value: { action: button.action },
      })),
    });
  }
  const note = input.buttons.length > 0 ? "点按钮即可回答；也可以直接回复这张卡片。" : "直接回复这张卡片即可回答。";
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: input.threadTitle ? `❓ ${input.threadTitle} · ${note}` : `❓ ${note}` }],
  });
  return { config: { wide_screen_mode: true }, header: { template: "orange", title: { tag: "plain_text", content: "❓ 需要你拍板" } }, elements };
}

// ---- proactive behavior (issue #20, steward.md §8; spike-conclusions §2 "digest routines") ----

/** What a digest renders from — collected deterministically from the ledger, no LLM. */
export interface DigestData {
  running: Array<{ threadId: string; title: string; machineName: string; agent: string }>;
  waiting: Array<{ threadId: string; title: string; question: string }>;
  unreadIdle: Array<{ threadId: string; title: string; summary: string | null }>;
}

export const digestIsEmpty = (d: DigestData): boolean =>
  d.running.length === 0 && d.waiting.length === 0 && d.unreadIdle.length === 0;

/**
 * The deterministic digest card (steward.md §8.2 × spike-conclusions §2): running / waiting /
 * unread become one three-part card; the tone follows whether anything waits on the owner.
 * Nothing to say → the caller stays silent, this is never called.
 */
export function digestCard(data: DigestData, footer: string) {
  const parts: string[] = [];
  if (data.running.length > 0) parts.push(`${data.running.length} 个在跑`);
  if (data.waiting.length > 0) parts.push(`${data.waiting.length} 个等你`);
  if (data.unreadIdle.length > 0) parts.push(`${data.unreadIdle.length} 个未读汇报`);
  const lines = [
    ...data.running.map((r) => `「${r.title}」在 ${r.machineName} 上跑（${r.agent}）`),
    ...data.waiting.map((w) => `「${w.title}」等你：${w.question}`),
    ...data.unreadIdle.map((u) => `「${u.title}」有未读汇报${u.summary ? `：${u.summary}` : ""}`),
  ];
  // renderReportCard caps did at 4 — so the overflow count rides the FOOTER, never a fifth
  // did line that the cap would silently swallow (review #47-1): no omission is ever silent.
  const shown = lines.slice(0, MAX_DID_ITEMS).map((line) => clip(line, MAX_DID_ITEM));
  const overflow = lines.length - shown.length;
  return renderReportCard({
    tone: data.waiting.length > 0 ? "attention" : "success",
    conclusion: `例行汇总：${parts.join("、")}`,
    did: shown,
    threadTitle: "",
    footer: overflow > 0 ? `${footer}（另有 ${overflow} 件未列出，问我要详情）` : footer,
  });
}

/**
 * The routine-suggestion card (steward.md §8.5): repeats the spec back and offers buttons —
 * the ONLY thing a suggestion may do. Creation happens on the tap (spec §8.3 consent); the
 * button value carries just the action, the offer resolves via the card's providerMsgId.
 */
export function routineOfferCard(input: { schedule: string; instruction: string }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "azure",
      title: { tag: "plain_text", content: "💡 要把这个变成例行任务吗？" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `**触发**：${input.schedule}\n**做什么**：${clip(input.instruction, 200)}` },
      },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "创建" }, type: "primary", value: { action: "routine_accept" } },
          { tag: "button", text: { tag: "plain_text", content: "先不用" }, type: "default", value: { action: "routine_decline" } },
        ],
      },
      { tag: "note", elements: [{ tag: "plain_text", content: "点「创建」后才会保存；随时可以让我暂停或取消。" }] },
    ],
  };
}
