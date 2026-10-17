// Card snapshots and card budget (issue #11, spec §7.5–7.6 / steward.md §6.4): the single
// done-report card and the merged quiet card are stable wire formats — a snapshot change is
// a deliberate, reviewable edit, never an accident. Pure unit tests: no DO, no LLM.
import { describe, expect, it } from "vitest";
import type { ReportRow, WorkerRow } from "../src/ledger.ts";
import {
  MERGED_CARD_BUDGET_BYTES,
  MERGED_TEXT_BUDGET_BYTES,
  MAX_RAW_NEEDS_YOU_BYTES,
  byteLength,
  clipBytes,
  didBullets,
  mergeQuietOutbound,
  mergedSendUuid,
  needsYouOf,
  renderMergedCard,
  renderReportCard,
  reportCardFor,
  sectionFromPayload,
  toneOfReport,
  type QuietSection,
} from "../src/report-template.ts";
import { MAX_SERIALIZED_BYTES } from "../src/channel/feishu.ts";

function report(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    workerId: "w_test",
    seq: 3,
    threadId: "t_test",
    status: "done",
    summary: "登录 bug 修好，测试通过",
    changes: ["auth/session.ts 里补上了 token 过期后的刷新"],
    decisions: null,
    leftovers: null,
    tests: { ran: true, passed: true },
    question: null,
    next: null,
    // pushed: an ORDINARY completion (nothing left to ask) — issue #21 gives unpushed write
    // completions their own consent-card snapshot below.
    git: { branch: "shepherd/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 2, insertions: 30, deletions: 4, pushed: true },
    ...overrides,
  };
}

const worker: WorkerRow = {
  workerId: "w_test",
  threadId: "t_test",
  deviceId: "dev_x",
  repoId: "/srv/repo-a",
  agent: "pi",
  mode: "write",
  state: "idle",
  sessionId: "w_test",
  branch: "shepherd/login-1",
  cmdId: "cmd_1",
  parentWorker: null,
  lastOutcome: "reported:done",
  lastEventAt: 1,
  lastProgress: null,
  contextPercent: null,
  createdAt: 1,
};

describe("card snapshots (issue #11)", () => {
  it("single done report: the fixed three-part card", () => {
    const done = report({ next: "跑一遍全量测试" });
    const card = reportCardFor(done, worker, "mac-studio", "修复登录 bug", "https://example.com/link/wl1.t/t_test.1.0abc");
    expect(card).toMatchSnapshot();
  });

  it("consent-carrying done report (issue #21): the ask replaces needs-you, [同意]/[先不要] ride along", () => {
    const unpushed = report({ git: { ...report().git!, pushed: false } });
    const card = reportCardFor(unpushed, worker, "mac-studio", "修复登录 bug", "https://example.com/link/wl1.t/t_test.1.0abc");
    expect(card).toMatchSnapshot();
  });

  it("merged done reports: one card, each Thread keeps its three parts", () => {
    const first = report();
    const second = report({
      workerId: "w_two",
      threadId: "t_two",
      summary: "退款接口补齐幂等，回归通过",
      changes: ["payment/refund.ts 加了幂等键", "补 2 个用例"],
      tests: { ran: true, passed: true },
      git: { branch: "shepherd/refund-1", base: "main", ahead: 1, dirty: 0, filesChanged: 2, insertions: 18, deletions: 2, pushed: true },
      leftovers: ["旧渠道还没覆盖"],
    });
    const sections: QuietSection[] = [
      {
        kind: "text",
        text: "两条记忆按 90 天规则整理完毕（归档 1 条，无新增）。",
      },
      {
        kind: "report",
        tone: toneOfReport(first.status),
        conclusion: first.summary,
        did: didBullets(first),
        needsYou: needsYouOf(first),
        threadTitle: "修复登录 bug",
        detailsUrl: "https://example.com/link/wl1.t/t_test.1.0abc",
      },
      {
        kind: "report",
        tone: toneOfReport(second.status),
        conclusion: second.summary,
        did: didBullets(second),
        needsYou: needsYouOf(second),
        threadTitle: "退款接口幂等",
        detailsUrl: "https://example.com/link/wl1.t/t_two.1.0def",
      },
    ];
    expect(renderMergedCard(sections)).toMatchSnapshot();
  });
});

describe("card size budget (issue #11: cards stay under 30 KB)", () => {
  const fatSection = (i: number): QuietSection => ({
    kind: "report",
    tone: "success",
    conclusion: `第 ${i} 件事完成了，结论占据接近上限的长度。`.repeat(3),
    did: [`改动第 ${i} 处：${"细节".repeat(40)}`, `验证第 ${i} 处：${"证据".repeat(40)}`, `分支 shepherd/x-${i}，3 个提交，已推送`, `4 个文件未提交`],
    needsYou: `建议下一步：${"具体建议".repeat(20)}`,
    threadTitle: `事项标题第 ${i} 号`,
    detailsUrl: `https://example.com/link/wl1.t/t_${i}.1.${"0".repeat(40)}abcd`,
    footer: `Thread「事项标题第 ${i} 号」 · pi @ mac-studio · 引用回复可继续这个 Thread`,
  });

  it("keeps a merged card under the transport cap and counts what did not fit", () => {
    const card = renderMergedCard(Array.from({ length: 40 }, (_, i) => fatSection(i + 1)));
    const bytes = byteLength(JSON.stringify(card));
    expect(bytes).toBeLessThanOrEqual(MERGED_CARD_BUDGET_BYTES);
    expect(bytes).toBeLessThan(MAX_SERIALIZED_BYTES);
    const json = JSON.stringify(card);
    expect(json).toContain("另有"); // overflow is COUNTED in the footer, never silently dropped
    expect(json).toContain("合并汇报：40 件事"); // the header still tells the whole truth
  });

  it("text sections count against the SAME budget as report sections (PR #58 review)", () => {
    // A full notes-maintenance bookkeeping text (~4 KB) plus budget-filling report sections
    // used to ride OUTSIDE the budget and push the card past the transport cap.
    const fatText = { kind: "text" as const, text: `记忆整理：${"一条已归档的记忆。".repeat(160)}` };
    const card = renderMergedCard([fatText, ...Array.from({ length: 40 }, (_, i) => fatSection(i + 1))]);
    const bytes = byteLength(JSON.stringify(card));
    expect(bytes).toBeLessThanOrEqual(MERGED_CARD_BUDGET_BYTES);
    expect(bytes).toBeLessThan(MAX_SERIALIZED_BYTES);
    const json = JSON.stringify(card);
    expect(json).toContain("另有"); // the text div that did not fit is counted too
  });

  it("a merged pure-text group is budgeted — merging never aggregates past the cap (PR #58 review)", () => {
    const texts = Array.from({ length: 30 }, (_, i) => ({
      kind: "text" as const,
      text: `第 ${i} 条整理记录：${"细节".repeat(300)}`, // ~1.8 KB each — 30 × 1.8 KB ≫ 28 KB
    }));
    const merged = mergeQuietOutbound(texts);
    expect(merged.kind).toBe("text");
    if (merged.kind !== "text") return;
    expect(byteLength(JSON.stringify({ text: merged.text }))).toBeLessThanOrEqual(MERGED_TEXT_BUDGET_BYTES);
    expect(merged.text).toContain("另有"); // the unlisted texts are counted, never silently dropped
    expect(merged.text).toContain("第 0 条"); // arrival order kept
  });

  it("mergedSendUuid is membership-scoped: stable across retries and reorderings, fresh for a joiner", () => {
    const a = ["01AAA", "01BBB", "01CCC"];
    expect(mergedSendUuid(a)).toBe(mergedSendUuid([...a].reverse())); // membership, not order
    expect(mergedSendUuid(a)).toBe(mergedSendUuid([...a])); // same members → same uuid on retry
    expect(mergedSendUuid(a)).not.toBe(mergedSendUuid([...a, "01DDD"])); // a late joiner → fresh uuid
    expect(mergedSendUuid(a).length).toBeLessThanOrEqual(64); // Feishu uuid limit
  });

  it("a single card with a pathological verbatim question is clipped inside the cap", () => {
    const longQuestion = "这是一个非常长的追问，".repeat(4_000); // ~52 KB of CJK
    const card = renderReportCard({
      tone: "attention",
      conclusion: "worker 需要你的回答",
      did: [],
      needsYou: longQuestion,
      rawNeedsYou: true, // the §5.3 verbatim path — the only uncapped input
      threadTitle: "长问题",
      footer: "f",
    });
    expect(byteLength(JSON.stringify(card))).toBeLessThan(MAX_SERIALIZED_BYTES);
    // The clip keeps a marker so nobody mistakes it for the full question.
    expect(JSON.stringify(card)).toContain("…");
    expect(clipBytes(longQuestion, MAX_RAW_NEEDS_YOU_BYTES).endsWith("…")).toBe(true);
    expect(clipBytes("短问题", MAX_RAW_NEEDS_YOU_BYTES)).toBe("短问题"); // short text untouched
  });

  it("quiet texts merge into one text; anything report-shaped becomes a card", () => {
    const texts = mergeQuietOutbound([
      { kind: "text", text: "第一条整理完成。" },
      { kind: "text", text: "第二条整理完成。" },
    ]);
    expect(texts).toEqual({ kind: "text", text: "第一条整理完成。\n\n第二条整理完成。" });

    const card = mergeQuietOutbound([
      { kind: "text", text: "整理完成。" },
      { kind: "report", tone: "success", conclusion: "修好了", did: ["a.ts"], threadTitle: "修复登录 bug" },
    ]);
    expect(card.kind).toBe("card");
    expect(JSON.stringify(card)).toContain("修复登录 bug");
  });

  it("the merged tone is the worst of the sections — one glance still says if anything broke", () => {
    const green = renderMergedCard([
      { kind: "report", tone: "success", conclusion: "a", did: [], threadTitle: "A" },
      { kind: "report", tone: "attention", conclusion: "b", did: [], threadTitle: "B" },
    ]);
    expect(JSON.stringify(green.header)).toContain("orange");
    const red = renderMergedCard([
      { kind: "report", tone: "success", conclusion: "a", did: [], threadTitle: "A" },
      { kind: "report", tone: "failure", conclusion: "b", did: [], threadTitle: "B" },
    ]);
    expect(JSON.stringify(red.header)).toContain("red");
  });

  it("sectionFromPayload: the stored part wins; text rows pass through; a partless card degrades to its texts", () => {
    const part = { kind: "report" as const, tone: "success" as const, conclusion: "c", did: ["d"], threadTitle: "T" };
    expect(sectionFromPayload({ part })).toEqual(part);
    expect(sectionFromPayload({ text: "一条普通文本" })).toEqual({ kind: "text", text: "一条普通文本" });
    // An unexpected quiet card (no part written at enqueue time) still merges: its header
    // title and markdown bodies fold into a text section instead of blocking the merge.
    const section = sectionFromPayload({
      card: {
        header: { title: { content: "✅ 某事完成" } },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: "- 改了 a.ts" } },
          { tag: "hr" },
          { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "查看详情" } }] },
        ],
      },
    });
    expect(section).toEqual({ kind: "text", text: "✅ 某事完成\n- 改了 a.ts" });
    expect(sectionFromPayload({})).toBeNull();
  });
});
