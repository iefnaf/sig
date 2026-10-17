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

/** Feishu's serialized message cap is 30 KB (feishu-channel.md §4). Merged cards budget
 *  under it with margin so the adapter's transport guard never rejects a merge (issue #11). */
export const MERGED_CARD_BUDGET_BYTES = 26_000;
/** The same cap for a merged pure-text message (the adapter measures JSON.stringify({text})). */
export const MERGED_TEXT_BUDGET_BYTES = 28_000;
/** The verbatim question forward (§5.3) is the only uncapped text entering a card; this hard
 *  byte cap keeps even that card inside the 30 KB transport limit. */
export const MAX_RAW_NEEDS_YOU_BYTES = 24_000;

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Clips at a UTF-8 BYTE boundary (CJK is 3 bytes/char), not a character count. Never
 *  splits a surrogate pair: the char-descent backs off a dangling high surrogate so the
 *  clip cannot mint a U+FFFD. */
export function clipBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const room = maxBytes - 3; // leave room for the ellipsis
  let chars = Math.ceil(room / 3); // worst case: every char is 3 bytes
  while (chars > 0 && byteLength(text.slice(0, chars)) > room) chars -= 1;
  let slice = text.slice(0, Math.max(0, chars));
  const last = slice.charCodeAt(slice.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) slice = slice.slice(0, -1); // drop a dangling high surrogate
  return `${slice}…`;
}

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
    // rawNeedsYou forwards the worker's question VERBATIM (issue #10 review finding 6) — no
    // 120-character cap. The only limit left is the transport one (issue #11): cards must
    // stay under 30 KB, so a pathological question is clipped at a byte boundary instead of
    // being rejected at send time by the adapter's hard cap.
    const needsYouText = input.rawNeedsYou
      ? clipBytes(input.needsYou.trim(), MAX_RAW_NEEDS_YOU_BYTES)
      : clip(input.needsYou, MAX_NEEDS_YOU + 6);
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
export function offlineAskCard(repoName: string, machineName: string, threadTitle: string, alternatives: string[] = []) {
  // [换台机器] appears only when another machine actually has the repo (protocol §7.3
  // "switch to another machine that has the repo"); otherwise the choice is wait or cancel.
  // The title/body follow the button set (PR #51 review finding 11):「只在 X 上」is a lie
  // when alternatives exist, and the body must state the actual three-way choice.
  const actions = [
    { tag: "button", text: { tag: "plain_text", content: "等它上线" }, type: "primary", value: { action: "wait_online" } },
    ...(alternatives.length > 0
      ? [{ tag: "button", text: { tag: "plain_text", content: `换台机器（${alternatives.slice(0, 2).join("／")}${alternatives.length > 2 ? "等" : ""}）` }, type: "default", value: { action: "switch_machine" } }] 
      : []),
    { tag: "button", text: { tag: "plain_text", content: "算了" }, type: "default", value: { action: "cancel" } },
  ];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: alternatives.length > 0 ? `⚠️ ${machineName} 不在线（${repoName}）` : `⚠️ ${repoName} 只在 ${machineName} 上，它现在不在线`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            alternatives.length > 0
              ? `已建好 Thread「${threadTitle}」。等 ${machineName} 上线后自动开始，还是换台机器（${alternatives.slice(0, 2).join("、")}${alternatives.length > 2 ? " 等" : ""}）？`
              : `已建好 Thread「${threadTitle}」。要排队等它上线后自动开始，还是取消？`,
        },
      },
      {
        tag: "action",
        // The values carry only the action — the Thread is resolved from the card's
        // providerMsgId on callback, never from data stuffed in here (spike bug, §3.1).
        actions,
      },
      { tag: "note", elements: [{ tag: "plain_text", content: `Thread「${threadTitle}」 · ${machineName}` }] },
    ],
  };
}

export function machineOfflineCard(machineName: string, threadTitle: string, footer: string) {
  return renderReportCard({
    tone: "attention",
    conclusion: `${machineName} 暂时联系不上`,
    did: [`「${threadTitle}」正在它上面运行：已标记为暂时失联，未按失败处理`],
    needsYou: "无需操作；机器重新上线后会自动对账并告诉你结果。",
    threadTitle,
    footer,
  });
}

export function machineOnlineCard(machineName: string, threadTitle: string, outcome: string, footer: string) {
  return renderReportCard({
    tone: "success",
    conclusion: `${machineName} 回来了`,
    did: [`「${threadTitle}」${outcome}`],
    threadTitle,
    footer,
  });
}

export function waitedStartCard(machineName: string, threadTitle: string, footer: string, detailsUrl?: string) {
  return renderReportCard({
    tone: "success",
    conclusion: `${machineName} 上线了，等它的任务开始跑`,
    did: [`「${threadTitle}」已送达 ${machineName}，开始后照常汇报`],
    threadTitle,
    footer,
    detailsUrl,
  });
}
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

/**
 * The resident-note suggestion card (issue #19, steward.md §2.5 rule 3): a 90-day-unused
 * resident entry is proposed to the owner — archived or kept by their tap, never demoted
 * automatically. Button values carry only the action; the note is resolved server-side
 * from the card's providerMsgId (§3.1's rule).
 */
export function noteDecisionCard(input: { noteId: string; text: string }): {
  config: unknown;
  header: unknown;
  elements: unknown[];
} {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "🧠 一条记忆很久没用了" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `「${clip(input.text, 120)}」\n已经 90 天没有被用过（常驻层，影响所有对话）。要归档吗？` },
      },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "归档" }, type: "primary", value: { action: "note_archive" } },
          { tag: "button", text: { tag: "plain_text", content: "保留" }, type: "default", value: { action: "note_keep" } },
        ],
      },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: "归档不删除，随时可搜索找回；点「保留」会再等 90 天。" },
        ],
      },
    ],
  };
}

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
  const section = digestSection(data, footer);
  return renderReportCard({
    tone: section.tone,
    conclusion: section.conclusion,
    did: section.did,
    threadTitle: "",
    footer: section.footer ?? footer,
  });
}

/** The digest as a mergeable quiet section (issue #11): the same lines the card renders —
 *  a quiet digest rides along when a done report shares its merge window. */
export function digestSection(data: DigestData, footer: string): Extract<QuietSection, { kind: "report" }> {
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
  return {
    kind: "report",
    tone: data.waiting.length > 0 ? "attention" : "success",
    conclusion: `例行汇总：${parts.join("、")}`,
    did: shown,
    threadTitle: "",
    footer: overflow > 0 ? `${footer}（另有 ${overflow} 件未列出，问我要详情）` : footer,
  };
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

// ---- quiet merging (issue #11, spec §7.6 / steward.md §6.4 / §15 item 9) -------------------------
//
// Several completions close together arrive as ONE short report: `urgency: quiet` rows hold
// for the merge window (ledger.ts anchors it per channel+receiver), and the delivery pass
// folds everything due into a single message. A merged card keeps EVERY thread's three parts
// (conclusion / did / needs-you) as its own section — merging never flattens a matter away.

/** One mergeable quiet payload: a plain text, or a three-part report section. */
export type QuietSection =
  | { kind: "text"; text: string }
  | {
      kind: "report";
      tone: Tone;
      conclusion: string;
      did: string[];
      needsYou?: string;
      threadTitle: string;
      /** One-time signed timeline URL appended by the system, never by the LLM (§6.4). */
      detailsUrl?: string;
      footer?: string;
    };

type ReportSection = Extract<QuietSection, { kind: "report" }>;

/** The elements of one thread's section: heading (its conclusion), the did bullets, the
 *  needs-you line, and its own 查看详情 button. `separator` prefixes an hr when the section
 *  is not the card's first. */
function mergedSectionElements(section: ReportSection, separator: boolean): unknown[] {
  const out: unknown[] = [];
  if (separator) out.push({ tag: "hr" });
  const heading = clip(`${section.threadTitle ? `「${section.threadTitle}」` : ""}${section.conclusion}`.trim(), 120);
  out.push({ tag: "div", text: { tag: "lark_md", content: `**${TONE_BADGE[section.tone]} ${heading}**` } });
  const lines = section.did
    .filter((item) => item.trim().length > 0)
    .slice(0, MAX_DID_ITEMS)
    .map((item) => `- ${clip(item, MAX_DID_ITEM + 2)}`);
  if (section.needsYou && section.needsYou.trim().length > 0) {
    lines.push(`**需要你**：${clip(section.needsYou, MAX_NEEDS_YOU + 6)}`);
  }
  if (section.footer && section.footer.trim().length > 0) lines.push(clip(section.footer, 200));
  if (lines.length > 0) out.push({ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } });
  if (section.detailsUrl) {
    // Per-thread detail link: each section's button opens THAT thread's timeline (and the
    // web open clears its unread, §6.5).
    out.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: section.threadTitle ? `查看详情 · ${clip(section.threadTitle, 12)}` : "查看详情" },
          type: "default",
          url: section.detailsUrl,
        },
      ],
    });
  }
  return out;
}

/** Renders merged quiet sections as ONE interactive card. Tone is the WORST of the sections
 *  (one glance at the color still tells whether anything went wrong, §6.4); report sections
 *  keep their three parts each; EVERY section — text divs included — is counted against the
 *  byte budget, and anything past it is counted in the footer, never silently dropped (the
 *  digest-card rule; review finding on PR #58: texts rode outside the budget). */
export function renderMergedCard(sections: QuietSection[]): { config: unknown; header: unknown; elements: unknown[] } {
  const reports = sections.filter((s): s is ReportSection => s.kind === "report");
  const texts = sections.filter((s): s is Extract<QuietSection, { kind: "text" }> => s.kind === "text");
  const tone: Tone = reports.some((r) => r.tone === "failure")
    ? "failure"
    : reports.some((r) => r.tone === "attention")
      ? "attention"
      : "success";

  const elements: unknown[] = [];
  let used = 768; // header + footer allowance
  let overflow = 0;
  let first = true;
  for (const text of texts) {
    const element = { tag: "div", text: { tag: "lark_md", content: clip(text.text, 600) } };
    const add = byteLength(JSON.stringify(element));
    if (used + add > MERGED_CARD_BUDGET_BYTES) {
      overflow += 1; // counted in the footer, never silently dropped
      continue;
    }
    elements.push(element);
    used += add;
    first = false;
  }
  for (const report of reports) {
    const sectionElements = mergedSectionElements(report, !first);
    const add = byteLength(JSON.stringify(sectionElements));
    if (used + add > MERGED_CARD_BUDGET_BYTES) {
      overflow += 1; // kept out of the card, but counted — the footer says so
      continue;
    }
    elements.push(...sectionElements);
    used += add;
    first = false;
  }
  const note =
    overflow > 0
      ? `合并汇报（${reports.length} 件事） · 另有 ${overflow} 条放不进这张卡，问我要详情`
      : `合并汇报（${reports.length} 件事） · 点「查看详情」看对应时间线 · 引用回复可继续对应事项`;
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: note }] });
  return {
    config: { wide_screen_mode: true },
    header: { template: TONE_TEMPLATE[tone], title: { tag: "plain_text", content: `${TONE_BADGE[tone]} 合并汇报：${reports.length} 件事` } },
    elements,
  };
}

/** Folds the merge window's quiet sections into the ONE message that goes out: plain texts
 *  join into one text (budgeted — merging must never aggregate past the transport cap, PR
 *  #58 review); anything carrying a report section becomes one merged card (texts ride along
 *  as leading divs). */
export function mergeQuietOutbound(sections: QuietSection[]): { kind: "text"; text: string } | { kind: "card"; card: unknown } {
  const reports = sections.filter((s) => s.kind === "report");
  if (reports.length === 0) {
    const bodies = sections.map((s) => (s.kind === "text" ? s.text.trim() : "")).filter(Boolean);
    const kept: string[] = [];
    let used = 96; // JSON wrapper + the overflow note's own room
    for (const body of bodies) {
      const add = byteLength(body) + 2; // "\n\n" separator
      if (used + add > MERGED_TEXT_BUDGET_BYTES) break;
      kept.push(body);
      used += add;
    }
    const overflow = bodies.length - kept.length;
    const tail = overflow > 0 ? `\n\n（另有 ${overflow} 条未列入这条消息，问我要详情）` : "";
    return { kind: "text", text: `${kept.join("\n\n")}${tail}` };
  }
  return { kind: "card", card: renderMergedCard(sections) };
}

/** The merged group's provider dedupe uuid (PR #58 review): scoped to the group's EXACT
 *  membership, so a retry with unchanged members reuses the uuid (Feishu dedupes the
 *  ambiguous-timeout case, spike bug 3) while a late arrival joining between attempts gets
 *  a fresh uuid — its section can never be swallowed by the first attempt's message. */
export function mergedSendUuid(ids: string[]): string {
  const sorted = [...ids].sort();
  const digest = sorted.join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < digest.length; i++) {
    h1 ^= digest.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (h1 & 0xff), 0x85ebca6b) >>> 0;
  }
  return `${sorted[0] ?? "merge"}.${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Normalizes a queued row's stored payload into a mergeable section: the `part` written at
 *  enqueue time when known; a text row as-is; an unexpected quiet card degrades to its header
 *  title + markdown bodies (clipped) rather than blocking the merge. */
export function sectionFromPayload(payload: { text?: string; card?: unknown; part?: QuietSection }): QuietSection | null {
  if (payload.part && (payload.part.kind === "text" || payload.part.kind === "report")) return payload.part;
  if (typeof payload.text === "string" && payload.text.trim().length > 0 && payload.card === undefined) {
    return { kind: "text", text: payload.text };
  }
  if (payload.card && typeof payload.card === "object") {
    const card = payload.card as { header?: { title?: { content?: unknown } }; elements?: unknown };
    const title = typeof card.header?.title?.content === "string" ? card.header.title.content : "";
    const bodies: string[] = [];
    if (Array.isArray(card.elements)) {
      for (const element of card.elements) {
        const el = element as { tag?: unknown; text?: { tag?: unknown; content?: unknown } } | null;
        if (el?.tag === "div" && el.text?.tag === "lark_md" && typeof el.text.content === "string") bodies.push(el.text.content);
      }
    }
    const text = [title, ...bodies].filter((part) => part.length > 0).join("\n");
    if (text.trim().length > 0) return { kind: "text", text: clipBytes(text, 2_000) };
  }
  return null;
}
