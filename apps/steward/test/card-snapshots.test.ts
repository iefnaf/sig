// Message snapshots and the merge budget (issue #11, spec §7.5–7.6 / steward.md §6.4): the
// single done-report message and the merged quiet message are stable formats — a snapshot
// change is a deliberate, reviewable edit, never an accident. Pure unit tests: no DO, no LLM.
// ADR-0003: messages are locally rendered text (+ buttons), read back via GET /api/messages.
import { describe, expect, it } from "vitest";
import type { ReportRow, WorkerRow } from "../src/ledger.ts";
import {
  MAX_RAW_NEEDS_YOU_BYTES,
  MERGED_TEXT_BUDGET_BYTES,
  byteLength,
  clipBytes,
  didBullets,
  mergeQuietOutbound,
  mergedSectionsText,
  mergedSendUuid,
  needsYouOf,
  renderReportCard,
  reportCardFor,
  sectionFromPayload,
  toneOfReport,
  type QuietSection,
} from "../src/report-template.ts";

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
    // completions their own consent-message snapshot below.
    git: { branch: "sig/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 2, insertions: 30, deletions: 4, pushed: true },
    answer: null,
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
  branch: "sig/login-1",
  cmdId: "cmd_1",
  parentWorker: null,
  lastOutcome: "reported:done",
  lastEventAt: 1,
  lastProgress: null,
  contextPercent: null,
  createdAt: 1,
};

describe("message snapshots (issue #11)", () => {
  it("single done report: the fixed three-part message", () => {
    const done = report({ next: "跑一遍全量测试" });
    const card = reportCardFor(done, worker, "mac-studio", "修复登录 bug", "https://example.com/link/wl1.t/t_test.1.0abc");
    expect(card).toMatchSnapshot();
  });

  it("consent-carrying done report (issue #21): the ask replaces needs-you, [同意]/[先不要] ride along", () => {
    const unpushed = report({ git: { ...report().git!, pushed: false } });
    const card = reportCardFor(unpushed, worker, "mac-studio", "修复登录 bug", "https://example.com/link/wl1.t/t_test.1.0abc");
    expect(card).toMatchSnapshot();
  });

  it("merged done reports: one message, each Thread keeps its three parts", () => {
    const first = report();
    const second = report({
      workerId: "w_two",
      threadId: "t_two",
      summary: "退款接口补齐幂等，回归通过",
      changes: ["payment/refund.ts 加了幂等键", "补 2 个用例"],
      tests: { ran: true, passed: true },
      git: { branch: "sig/refund-1", base: "main", ahead: 1, dirty: 0, filesChanged: 2, insertions: 18, deletions: 2, pushed: true },
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
    expect(mergedSectionsText(sections)).toMatchSnapshot();
  });
});

describe("message size budget (issue #11: one merged message stays readable)", () => {
  const fatSection = (i: number): QuietSection => ({
    kind: "report",
    tone: "success",
    conclusion: `第 ${i} 件事完成了，结论占据接近上限的长度。`.repeat(3),
    did: [`改动第 ${i} 处：${"细节".repeat(40)}`, `验证第 ${i} 处：${"证据".repeat(40)}`, `分支 sig/x-${i}，3 个提交，已推送`, `4 个文件未提交`],
    needsYou: `建议下一步：${"具体建议".repeat(20)}`,
    threadTitle: `事项标题第 ${i} 号`,
    detailsUrl: `https://example.com/link/wl1.t/t_${i}.1.${"0".repeat(40)}abcd`,
    footer: `Thread「事项标题第 ${i} 号」 · pi @ mac-studio · 引用回复可继续这个 Thread`,
  });

  it("keeps a merged message under the budget and counts what did not fit", () => {
    const text = mergedSectionsText(Array.from({ length: 40 }, (_, i) => fatSection(i + 1)));
    expect(byteLength(text)).toBeLessThanOrEqual(MERGED_TEXT_BUDGET_BYTES + 512); // head + tail allowance
    expect(text).toContain("另有"); // overflow is COUNTED in the tail, never silently dropped
    expect(text).toContain("合并汇报：40 件事"); // the head still tells the whole truth
  });

  it("text sections count against the SAME budget as report sections (PR #58 review)", () => {
    // A full notes-maintenance bookkeeping text (~4 KB) plus budget-filling report sections
    // used to ride OUTSIDE the budget and bloat the merged message.
    const fatText = { kind: "text" as const, text: `记忆整理：${"一条已归档的记忆。".repeat(160)}` };
    const text = mergedSectionsText([fatText, ...Array.from({ length: 40 }, (_, i) => fatSection(i + 1))]);
    expect(byteLength(text)).toBeLessThanOrEqual(MERGED_TEXT_BUDGET_BYTES + 512);
    expect(text).toContain("另有"); // the text block that did not fit is counted too
  });

  it("a merged pure-text group is budgeted — merging never aggregates past the cap (PR #58 review)", () => {
    const texts = Array.from({ length: 30 }, (_, i) => ({
      kind: "text" as const,
      text: `第 ${i} 条整理记录：${"细节".repeat(300)}`, // ~1.8 KB each — 30 × 1.8 KB ≫ 28 KB
    }));
    const merged = mergeQuietOutbound(texts);
    expect(byteLength(merged.text)).toBeLessThanOrEqual(MERGED_TEXT_BUDGET_BYTES);
    expect(merged.text).toContain("另有"); // the unlisted texts are counted, never silently dropped
    expect(merged.text).toContain("第 0 条"); // arrival order kept
  });

  it("mergedSendUuid is membership-scoped: stable across retries and reorderings, fresh for a joiner", () => {
    const a = ["01AAA", "01BBB", "01CCC"];
    expect(mergedSendUuid(a)).toBe(mergedSendUuid([...a].reverse())); // membership, not order
    expect(mergedSendUuid(a)).toBe(mergedSendUuid([...a])); // same members → same id on retry
    expect(mergedSendUuid(a)).not.toBe(mergedSendUuid([...a, "01DDD"])); // a late joiner → fresh id
    expect(mergedSendUuid(a).length).toBeLessThanOrEqual(64);
  });

  it("a single message with a pathological verbatim question is clipped inside the cap", () => {
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
    expect(byteLength(card.text)).toBeLessThanOrEqual(MAX_RAW_NEEDS_YOU_BYTES + 512);
    // The clip keeps a marker so nobody mistakes it for the full question.
    expect(card.text).toContain("…");
    expect(clipBytes(longQuestion, MAX_RAW_NEEDS_YOU_BYTES).endsWith("…")).toBe(true);
    expect(clipBytes("短问题", MAX_RAW_NEEDS_YOU_BYTES)).toBe("短问题"); // short text untouched
  });

  it("quiet texts merge into one text; anything report-shaped becomes a merged report message", () => {
    const texts = mergeQuietOutbound([
      { kind: "text", text: "第一条整理完成。" },
      { kind: "text", text: "第二条整理完成。" },
    ]);
    expect(texts).toEqual({ text: "第一条整理完成。\n\n第二条整理完成。" });

    const merged = mergeQuietOutbound([
      { kind: "text", text: "整理完成。" },
      { kind: "report", tone: "success", conclusion: "修好了", did: ["a.ts"], threadTitle: "修复登录 bug" },
    ]);
    expect(merged.text).toContain("合并汇报");
    expect(merged.text).toContain("修复登录 bug");
  });

  it("the merged tone is the worst of the sections — one glance still says if anything broke", () => {
    const warn = mergedSectionsText([
      { kind: "report", tone: "success", conclusion: "a", did: [], threadTitle: "A" },
      { kind: "report", tone: "attention", conclusion: "b", did: [], threadTitle: "B" },
    ]);
    expect(warn).toContain("⚠️ 合并汇报");
    const red = mergedSectionsText([
      { kind: "report", tone: "success", conclusion: "a", did: [], threadTitle: "A" },
      { kind: "report", tone: "failure", conclusion: "b", did: [], threadTitle: "B" },
    ]);
    expect(red).toContain("❌ 合并汇报");
  });

  it("sectionFromPayload: the stored part wins; text rows pass through; a partless card degrades to its text", () => {
    const part = { kind: "report" as const, tone: "success" as const, conclusion: "c", did: ["d"], threadTitle: "T" };
    expect(sectionFromPayload({ part })).toEqual(part);
    expect(sectionFromPayload({ text: "一条普通文本" })).toEqual({ kind: "text", text: "一条普通文本" });
    // An unexpected quiet card (no part written at enqueue time) still merges: its rendered
    // text folds into a text section instead of blocking the merge.
    const section = sectionFromPayload({ card: { text: "✅ 某事完成\n- 改了 a.ts" } });
    expect(section).toEqual({ kind: "text", text: "✅ 某事完成\n- 改了 a.ts" });
    expect(sectionFromPayload({})).toBeNull();
  });
});
