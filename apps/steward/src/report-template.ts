// Core report templates (issue #5, steward.md §6.4 / spec §7.5): done-class reports go to the
// user straight from data, deterministically, with no dependence on an LLM being up or on
// budget (steward.md §0.2 / §12). The tone is decided by the NATURE of the message — success /
// attention / failure — independent of whether a needsYou is attached: a completion that comes
// with minor caveats still reads success, so one glance at the badge tells the user whether
// anything went wrong. ADR-0003: there is no chat provider anymore, so a "card" is a locally
// rendered message — structured plain text plus optional opaque-action buttons (POST
// /api/actions); Thread identity always resolves server-side from the message id, never from
// data stuffed into a button (§3.1).
import type { GitFacts, ReportRow, WorkerRow } from "./ledger.ts";

/** Lengths from spec §7.5 / steward.md §6.4. */
export const MAX_CONCLUSION = 80;
export const MAX_DID_ITEM = 100;
export const MAX_DID_ITEMS = 4;
export const MAX_NEEDS_YOU = 120;
/** Text is cheap locally, but one message must still stay readable: the merged budget. */
export const MERGED_TEXT_BUDGET_BYTES = 28_000;
/** A forwarded worker question stays VERBATIM (issue #10 review finding 6) — clipped only at
 *  a byte boundary so a pathological question cannot produce an unreadable wall. */
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

export interface MessageButton {
  label: string;
  /** Opaque action string — POST /api/actions {cardMsgId, action}. Never carries identity. */
  action?: string;
  /** URL buttons open a link; no action callback. */
  url?: string;
  primary?: boolean;
}

/** A locally rendered owner message (ADR-0003): plain text plus optional buttons. */
export interface LocalMessage {
  text: string;
  buttons?: MessageButton[];
}

export interface ReportCardButton extends MessageButton {}

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
  /** Action buttons (issue #21: the consent gate's [同意]/[先不要], the PR link). */
  buttons?: ReportCardButton[];
  /** The worker's full answer/finding (issue #76): present when `report.answer` carried a
   *  conclusion for a task that produced no code change, independent of `did`. */
  answer?: string;
}

function clip(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Renders the three-part report as one local message. */
export function renderReportCard(input: ReportCardInput): LocalMessage {
  const lines: string[] = [`${TONE_BADGE[input.tone]} ${clip(input.conclusion, MAX_CONCLUSION + 2)}`];
  const did = input.did.filter((item) => item.trim().length > 0).slice(0, MAX_DID_ITEMS).map((item) => `- ${clip(item, MAX_DID_ITEM + 2)}`);
  if (did.length > 0) lines.push("", "做了什么：", ...did);
  if (input.answer && input.answer.trim().length > 0) {
    lines.push("", clipBytes(input.answer.trim(), MERGED_TEXT_BUDGET_BYTES));
  }
  if (input.needsYou && input.needsYou.trim().length > 0) {
    // rawNeedsYou forwards the worker's question VERBATIM (issue #10 review finding 6) — no
    // 120-character cap, only the byte-boundary clip above.
    const needsYouText = input.rawNeedsYou
      ? clipBytes(input.needsYou.trim(), MAX_RAW_NEEDS_YOU_BYTES)
      : clip(input.needsYou, MAX_NEEDS_YOU + 6);
    lines.push("", `需要你：${needsYouText}`);
  }
  const buttons: MessageButton[] = [...(input.buttons ?? [])];
  if (input.detailsUrl) {
    // "查看详情" logs the owner straight into the Thread timeline (spec §7.3; the URL is a
    // one-time signed link minted per card). Text form too: text-only clients can still open it.
    lines.push("", `详情：${input.detailsUrl}`);
    buttons.push({ label: "查看详情", url: input.detailsUrl });
  }
  if (input.footer.trim().length > 0) lines.push("", clip(input.footer, 200));
  return buttons.length > 0 ? { text: lines.join("\n"), buttons } : { text: lines.join("\n") };
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

/** Issue #21 (spike-conclusions §2): whether this done report owes the consent gate — a
 *  write task with commits that never left the machine. Nothing is pushed without the tap. */
export function prConsentFor(report: ReportRow, worker: Pick<WorkerRow, "mode">): { branch: string; ahead: number } | null {
  const git = report.git;
  if (report.status !== "done" || worker.mode !== "write" || !git || git.pushed || git.ahead <= 0) return null;
  return { branch: git.branch, ahead: git.ahead };
}

/** Assembles the deterministic done-class message for a processed `report` event. */
export function reportCardFor(report: ReportRow, worker: WorkerRow, machineName: string, threadTitle: string, detailsUrl?: string): LocalMessage {
  const consent = prConsentFor(report, worker);
  return renderReportCard({
    tone: toneOfReport(report.status),
    conclusion: report.summary,
    did: didBullets(report),
    answer: report.answer ?? undefined,
    // The consent ask replaces the generic next-step line when it applies: the decision the
    // card exists to collect IS what the owner must do next.
    needsYou: consent
      ? `分支 ${consent.branch}（${consent.ahead} 个提交）还没推送。点「同意」我会推送并创建 PR；选「先不要」就先留在机器上。`
      : needsYouOf(report),
    threadTitle,
    detailsUrl,
    footer: `Thread「${threadTitle}」 · ${worker.agent} @ ${machineName} · 引用回复可继续这个 Thread`,
    ...(consent ? { buttons: [{ label: "同意", action: "pr_approve", primary: true }, { label: "先不要", action: "pr_decline" }] } : {}),
  });
}

/** The deterministic failure message for settled error / start-failure pushes. */
export function failureCard(conclusion: string, needsYou: string, threadTitle: string, footer: string, detailsUrl?: string): LocalMessage {
  return renderReportCard({ tone: "failure", conclusion, did: [], needsYou, threadTitle, footer, detailsUrl });
}

/** The pr_created message (issue #21 AC2): the loop's closing message — the PR URL lands back
 *  as text (copyable) and as a button. */
export function prCreatedCard(input: { url: string; branch: string; threadTitle: string; footer: string; detailsUrl?: string }): LocalMessage {
  return renderReportCard({
    tone: "success",
    conclusion: "PR 已创建，等你审查",
    did: [`分支 ${input.branch} 已推送到远端`],
    needsYou: input.url,
    threadTitle: input.threadTitle,
    footer: input.footer,
    detailsUrl: input.detailsUrl,
    buttons: [{ label: "打开 PR", url: input.url, primary: true }],
  });
}

/** The three-part failure report's needs-you for a pr_failed (issue #21 AC4): the fix is on
 *  the machine (install/login gh) or in the repo (push rejection); the retry is the same
 *  [同意] button on the original card — the gate re-arms after a failure. */
export function prFailureNeedsYou(stage: string, message: string): string {
  const retry = "处理好后回到原来那条汇报消息再点一次「同意」即可重试。";
  switch (stage) {
    case "gh_missing":
      return `这台机器上没有安装 GitHub CLI（gh）。安装后（macOS：brew install gh）${retry}`;
    case "auth":
      return `gh 没有登录或凭证已过期（${message}）。在这台机器上运行 gh auth login，然后${retry}`;
    case "push":
      return `推送分支被拒绝：${message}。${retry}`;
    case "ambiguous":
      // Review finding 2: the connector died mid-pr_worker — the PR may or may not exist.
      return `上一次结果不确定：${message}。先去仓库确认是否已有 PR；若没有，${retry}`;
    case "command":
      return `机器没有执行成功（${message}）。${retry}`;
    case "delivery":
      return `指令没能送到机器（${message}）。机器上线后${retry}`;
    default:
      return `gh pr create 失败：${message}。${retry}`;
  }
}

/** The pr_worker command's title/body, built deterministically from the report the user
 *  consented to (issue #21): data only, no LLM anywhere on this path. */
export function prCommandArgs(input: { report: ReportRow | null; threadTitle: string; branch: string }): { title: string; body: string } {
  const report = input.report;
  const title = (report?.summary ?? input.threadTitle).trim().slice(0, 70);
  const lines: string[] = [];
  if (report) {
    lines.push(report.summary);
    const changes = report.changes ?? [];
    if (changes.length > 0) lines.push("", "做了什么：", ...changes.slice(0, 10).map((c) => `- ${c}`));
    if (report.tests?.ran) {
      lines.push("", `测试：${report.tests.passed === false ? "未通过" : "通过"}${report.tests.note ? `（${report.tests.note}）` : ""}`);
    }
    const leftovers = report.leftovers ?? [];
    if (leftovers.length > 0) lines.push("", "遗留：", ...leftovers.slice(0, 10).map((l) => `- ${l}`));
  }
  lines.push("", `由 Sig 派发的 worker 在分支 ${input.branch} 上完成。`);
  return { title, body: lines.join("\n") };
}

/** The deterministic stall-reminder message (steward.md §8.4 / §6.2 source 1): attention, not
 *  failure — 20 straight minutes of silence may still be one very long tool call. */
export function stallCard(
  minutes: number,
  worker: { agent: string },
  machineName: string,
  threadTitle: string,
  footer: string,
  detailsUrl?: string,
): LocalMessage {
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

/** The offline-ask message (spec §9): dispatch found only an offline machine — never decide silently. */
export function offlineAskCard(repoName: string, machineName: string, threadTitle: string, alternatives: string[] = []): LocalMessage {
  // [换台机器] appears only when another machine actually has the repo (protocol §7.3
  // "switch to another machine that has the repo"); otherwise the choice is wait or cancel.
  // The title/body follow the button set (PR #51 review finding 11):「只在 X 上」is a lie
  // when alternatives exist, and the body must state the actual three-way choice.
  const buttons: MessageButton[] = [
    { label: "等它上线", action: "wait_online", primary: true },
    ...(alternatives.length > 0
      ? [{ label: `换台机器（${alternatives.slice(0, 2).join("／")}${alternatives.length > 2 ? "等" : ""}）`, action: "switch_machine" } as MessageButton]
      : []),
    { label: "算了", action: "cancel" },
  ];
  const title = alternatives.length > 0 ? `⚠️ ${machineName} 不在线（${repoName}）` : `⚠️ ${repoName} 只在 ${machineName} 上，它现在不在线`;
  const body = alternatives.length > 0
    ? `已建好 Thread「${threadTitle}」。等 ${machineName} 上线后自动开始，还是换台机器（${alternatives.slice(0, 2).join("、")}${alternatives.length > 2 ? " 等" : ""}）？`
    : `已建好 Thread「${threadTitle}」。要排队等它上线后自动开始，还是取消？`;
  return { text: [title, "", body, "", `Thread「${threadTitle}」 · ${machineName}`].join("\n"), buttons };
}

export function machineOfflineCard(machineName: string, threadTitle: string, footer: string): LocalMessage {
  return renderReportCard({
    tone: "attention",
    conclusion: `${machineName} 暂时联系不上`,
    did: [`「${threadTitle}」正在它上面运行：已标记为暂时失联，未按失败处理`],
    needsYou: "无需操作；机器重新上线后会自动对账并告诉你结果。",
    threadTitle,
    footer,
  });
}

export function machineOnlineCard(machineName: string, threadTitle: string, outcome: string, footer: string): LocalMessage {
  return renderReportCard({
    tone: "success",
    conclusion: `${machineName} 回来了`,
    did: [`「${threadTitle}」${outcome}`],
    threadTitle,
    footer,
  });
}

export function waitedStartCard(machineName: string, threadTitle: string, footer: string, detailsUrl?: string): LocalMessage {
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
}): LocalMessage {
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
 * The §5.3 fallback message (issue #10): a blocked/needs_decision question nothing handled in
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
}): LocalMessage {
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

/** One button of the ask message: `action` is what the action handler parses. */
export interface AskCardButton {
  label: string;
  /** The full action string carried in the button (`ask:<qid>:<idx>` / `asknew:<qid>`). */
  action: string;
  primary?: boolean;
}

/**
 * The `ask_user` message (issue #7, steward.md §3.3): the question plus ≤3 candidate buttons
 * and a “新开一件事” button for routing asks. Button values carry only an opaque action
 * string — Thread identity is resolved server-side from the question row and the message id,
 * never stuffed into the button (§3.1).
 */
export function askUserCard(input: { question: string; threadTitle?: string; buttons: AskCardButton[] }): LocalMessage {
  const head = input.threadTitle ? `【${input.threadTitle}】` : "";
  const lines = [`${head}❓ ${clip(input.question, 600)}`];
  if (input.buttons.length > 0) lines.push("", "点按钮即可回答；也可以直接回复这条消息。");
  else lines.push("", "直接回复这条消息即可回答。");
  const buttons = input.buttons.map((button) => ({
    label: clip(button.label, 24),
    action: button.action,
    ...(button.primary ? { primary: true } : {}),
  }));
  return buttons.length > 0 ? { text: lines.join("\n"), buttons } : { text: lines.join("\n") };
}

// ---- proactive behavior (issue #20, steward.md §8; spike-conclusions §2 "digest routines") ----

/**
 * The resident-note suggestion message (issue #19, steward.md §2.5 rule 3): a 90-day-unused
 * resident entry is proposed to the owner — archived or kept by their tap, never demoted
 * automatically. Button values carry only the action; the note is resolved server-side from
 * the message id (§3.1's rule).
 */
export function noteDecisionCard(input: { noteId: string; text: string }): LocalMessage {
  return {
    text: [
      "🧠 一条记忆很久没用了",
      "",
      `「${clip(input.text, 120)}」`,
      "已经 90 天没有被用过（常驻层，影响所有对话）。要归档吗？",
      "",
      "归档不删除，随时可搜索找回；点「保留」会再等 90 天。",
    ].join("\n"),
    buttons: [
      { label: "归档", action: "note_archive", primary: true },
      { label: "保留", action: "note_keep" },
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
 * The deterministic digest (steward.md §8.2 × spike-conclusions §2): running / waiting /
 * unread become one three-part message; the tone follows whether anything waits on the owner.
 * Nothing to say → the caller stays silent, this is never called.
 */
export function digestCard(data: DigestData, footer: string): LocalMessage {
  const section = digestSection(data, footer);
  return renderReportCard({
    tone: section.tone,
    conclusion: section.conclusion,
    did: section.did,
    threadTitle: "",
    footer: section.footer ?? footer,
  });
}

/** The digest as a mergeable quiet section (issue #11): the same lines the message renders —
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
 * The routine-suggestion message (steward.md §8.5): repeats the spec back and offers buttons —
 * the ONLY thing a suggestion may do. Creation happens on the tap (spec §8.3 consent); the
 * button value carries just the action, the offer resolves via the message id.
 */
export function routineOfferCard(input: { schedule: string; instruction: string }): LocalMessage {
  return {
    text: [
      "💡 要把这个变成例行任务吗？",
      "",
      `触发：${input.schedule}`,
      `做什么：${clip(input.instruction, 200)}`,
      "",
      "点「创建」后才会保存；随时可以让我暂停或取消。",
    ].join("\n"),
    buttons: [
      { label: "创建", action: "routine_accept", primary: true },
      { label: "先不用", action: "routine_decline" },
    ],
  };
}

// ---- quiet merging (issue #11, spec §7.6 / steward.md §6.4 / §15 item 9) -------------------------
//
// Several completions close together arrive as ONE short report: `urgency: quiet` rows hold
// for the merge window (ledger.ts anchors it per channel+receiver), and the delivery pass
// folds everything due into a single message. A merged message keeps EVERY thread's three
// parts (conclusion / did / needs-you) as its own section — merging never flattens a matter.

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

/** One report section as a text block: badge + heading, the did bullets, the needs-you line,
 *  its own 详情 link, and its footer. */
function mergedSectionText(section: ReportSection): string {
  const lines: string[] = [];
  const heading = clip(`${section.threadTitle ? `「${section.threadTitle}」` : ""}${section.conclusion}`.trim(), 120);
  lines.push(`**${TONE_BADGE[section.tone]} ${heading}**`);
  const did = section.did
    .filter((item) => item.trim().length > 0)
    .slice(0, MAX_DID_ITEMS)
    .map((item) => `- ${clip(item, MAX_DID_ITEM + 2)}`);
  if (section.needsYou && section.needsYou.trim().length > 0) {
    did.push(`**需要你**：${clip(section.needsYou, MAX_NEEDS_YOU + 6)}`);
  }
  if (section.footer && section.footer.trim().length > 0) lines.push(clip(section.footer, 200));
  if (did.length > 0) lines.splice(1, 0, ...did);
  if (section.detailsUrl) lines.push(`详情：${section.detailsUrl}`);
  return lines.join("\n");
}

/** Renders merged quiet sections as ONE text message (ADR-0003; the old interactive card
 *  became text). Tone is the WORST of the sections (the badge still tells whether anything
 *  went wrong, §6.4); report sections keep their three parts each; EVERY section — text
 *  blocks included — is counted against the byte budget, and anything past it is counted in
 *  the tail, never silently dropped (the digest rule; PR #58 review: texts rode outside the
 *  budget). */
export function mergedSectionsText(sections: QuietSection[]): string {
  const reports = sections.filter((s): s is ReportSection => s.kind === "report");
  const texts = sections.filter((s): s is Extract<QuietSection, { kind: "text" }> => s.kind === "text");
  const tone: Tone = reports.some((r) => r.tone === "failure")
    ? "failure"
    : reports.some((r) => r.tone === "attention")
      ? "attention"
      : "success";

  const blocks: string[] = [];
  let used = 128; // header + tail allowance
  let overflow = 0;
  const push = (block: string): void => {
    const add = byteLength(block) + 2; // "\n\n" separator
    if (used + add > MERGED_TEXT_BUDGET_BYTES) {
      overflow += 1; // counted in the tail, never silently dropped
      return;
    }
    blocks.push(block);
    used += add;
  };
  for (const text of texts) push(clip(text.text, 600));
  for (const report of reports) push(mergedSectionText(report));

  const head = `${TONE_BADGE[tone]} 合并汇报：${reports.length} 件事`;
  const tail =
    overflow > 0
      ? `\n\n（另有 ${overflow} 条放不进这条消息，问我要详情）`
      : reports.some((r) => r.detailsUrl)
        ? "\n\n（各件事的详情链接见上；引用回复可继续对应事项）"
        : "\n\n（引用回复可继续对应事项）";
  return [head, "", blocks.join("\n\n"), tail.trim()].filter((part) => part.length > 0).join("\n\n");
}

/** Folds the merge window's quiet sections into the ONE message that goes out (ADR-0003: one
 *  budgeted text — merging must never aggregate into an unreadable wall, PR #58 review). */
export function mergeQuietOutbound(sections: QuietSection[]): { text: string } {
  const reports = sections.filter((s) => s.kind === "report");
  if (reports.length === 0) {
    const bodies = sections.map((s) => (s.kind === "text" ? s.text.trim() : "")).filter(Boolean);
    const kept: string[] = [];
    let used = 96; // wrapper + the overflow tail's own room
    for (const body of bodies) {
      const add = byteLength(body) + 2; // "\n\n" separator
      if (used + add > MERGED_TEXT_BUDGET_BYTES) break;
      kept.push(body);
      used += add;
    }
    const overflow = bodies.length - kept.length;
    const tail = overflow > 0 ? `\n\n（另有 ${overflow} 条未列入这条消息，问我要详情）` : "";
    return { text: `${kept.join("\n\n")}${tail}` };
  }
  return { text: mergedSectionsText(sections) };
}

/** The merged group's provider message id (PR #58 review): scoped to the group's EXACT
 *  membership — a group with unchanged members keeps its id while a late arrival joining
 *  between passes gets a fresh one, so its section can never be swallowed by the first
 *  attempt's message. */
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
 *  enqueue time when known; a text row as-is; an unexpected quiet card degrades to its text
 *  rather than blocking the merge. */
export function sectionFromPayload(payload: { text?: string; card?: unknown; part?: QuietSection }): QuietSection | null {
  if (payload.part && (payload.part.kind === "text" || payload.part.kind === "report")) return payload.part;
  if (typeof payload.text === "string" && payload.text.trim().length > 0 && payload.card === undefined) {
    return { kind: "text", text: payload.text };
  }
  if (payload.card && typeof payload.card === "object") {
    const card = payload.card as LocalMessage;
    if (typeof card.text === "string" && card.text.trim().length > 0) {
      return { kind: "text", text: clipBytes(card.text, 2_000) };
    }
  }
  return null;
}
