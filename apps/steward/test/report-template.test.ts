// Deterministic template tests (issue #5): three-part reports, tone by nature, truncation —
// all without any LLM (steward.md §6.4, spec §7.5). ADR-0003: a "card" is a local message —
// structured plain text plus opaque-action buttons.
import { describe, expect, it } from "vitest";
import type { ReportRow, WorkerRow } from "../src/ledger.ts";
import {
  askUserText,
  byteLength,
  clipBytes,
  didBullets,
  failureCard,
  MAX_CONCLUSION,
  MERGED_TEXT_BUDGET_BYTES,
  needsYouOf,
  notifyCard,
  offlineAskCard,
  prCommandArgs,
  prConsentFor,
  prCreatedCard,
  prFailureNeedsYou,
  renderReportCard,
  reportCardFor,
  toneOfReport,
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
    git: { branch: "sig/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 2, insertions: 30, deletions: 4, pushed: false },
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

describe("renderReportCard: the fixed three parts (spec §7.5)", () => {
  it("renders conclusion up front with the tone badge, did as bullets, needs-you as its own line", () => {
    const card = renderReportCard({
      tone: "success",
      conclusion: "登录 bug 修好，测试通过",
      did: ["修复 auth/session.ts", "分支 sig/login-1"],
      needsYou: "要推送并开 PR 吗？",
      threadTitle: "修复登录 bug",
      footer: "Thread「修复登录 bug」 · pi @ mac-studio",
    });
    expect(card.text).toContain("✅ 登录 bug 修好，测试通过");
    expect(card.text).toContain("做了什么：");
    expect(card.text).toContain("- 修复 auth/session.ts");
    expect(card.text).toContain("需要你：要推送并开 PR 吗？");
    expect(card.text).toContain("Thread「修复登录 bug」 · pi @ mac-studio");
    expect(card.buttons).toBeUndefined();
  });

  it("omits the needs-you line entirely when there is nothing needed", () => {
    const card = renderReportCard({ tone: "success", conclusion: "done", did: ["x"], threadTitle: "t", footer: "f" });
    expect(card.text).not.toContain("需要你");
  });

  it("tone by nature, not by needs-you: a done report with caveats stays success-badged", () => {
    // The M1 live-testing correction (steward.md §6.4): a completion with minor caveats still
    // gets the success tone so the badge alone says whether anything went wrong.
    expect(toneOfReport("done")).toBe("success");
    expect(toneOfReport("blocked")).toBe("attention");
    expect(toneOfReport("needs_decision")).toBe("attention");
    const card = renderReportCard({
      tone: toneOfReport("done"),
      conclusion: "修好了",
      did: ["x"],
      needsYou: "建议下一步：跑一遍全量测试",
      threadTitle: "t",
      footer: "f",
    });
    expect(card.text).toContain("✅");
    expect(card.text).toContain("需要你");
  });

  it("clips over-length conclusions and did items to the spec limits", () => {
    const card = renderReportCard({
      tone: "failure",
      conclusion: "错".repeat(200),
      did: ["很长的条目".repeat(60)],
      threadTitle: "t",
      footer: "f",
    });
    const title = card.text.split("\n")[0]!;
    // badge + space + conclusion; conclusion itself ≤ 80 chars + ellipsis
    expect(title.length).toBeLessThanOrEqual(2 + 1 + MAX_CONCLUSION + 2);
    expect(card.text).toContain("…");
  });

  it("renders the answer as its own section alongside did (issue #76)", () => {
    const card = renderReportCard({
      tone: "success",
      conclusion: "讲解完了 pi-memory 项目",
      did: [],
      answer: "pi-memory 是一个……完整的调研结论。",
      threadTitle: "讲解 pi-memory",
      footer: "f",
    });
    expect(card.text).toContain("pi-memory 是一个……完整的调研结论。");
  });

  it("an answer clips at MERGED_TEXT_BUDGET_BYTES, not the write-task caps", () => {
    const longAnswer = "这是一段很长的调研结论。".repeat(3_000); // well past 28 KB of CJK
    const card = renderReportCard({
      tone: "success",
      conclusion: "调研完成",
      did: [],
      answer: longAnswer,
      threadTitle: "t",
      footer: "f",
    });
    expect(byteLength(card.text)).toBeLessThanOrEqual(MERGED_TEXT_BUDGET_BYTES + 512);
    expect(card.text).toContain("…");
    expect(clipBytes(longAnswer, MERGED_TEXT_BUDGET_BYTES).endsWith("…")).toBe(true);
    expect(clipBytes("短结论", MERGED_TEXT_BUDGET_BYTES)).toBe("短结论"); // short text untouched
  });
});

describe("didBullets / needsYouOf: data in, text out", () => {
  it("builds bullets from changes, tests, and git facts only", () => {
    const bullets = didBullets(report());
    expect(bullets).toEqual([
      "auth/session.ts 里补上了 token 过期后的刷新",
      "测试通过",
      "分支 sig/login-1，2 个提交，未推送",
    ]);
  });

  it("done reports surface next/leftovers as needs-you, never a question section", () => {
    expect(needsYouOf(report())).toBeUndefined();
    expect(needsYouOf(report({ next: "跑一遍全量测试" }))).toBe("建议下一步：跑一遍全量测试");
    expect(needsYouOf(report({ leftovers: ["登录页样式没对齐", "日志还缺一行"] }))).toBe("遗留：登录页样式没对齐；日志还缺一行");
  });

  it("blocked / needs_decision reports carry the worker's question verbatim", () => {
    expect(needsYouOf(report({ status: "needs_decision", question: "JWT 还是 session？" }))).toBe("JWT 还是 session？");
  });
});

describe("failure and offline-ask messages", () => {
  it("failure messages are ❌-badged and state the outcome plainly with a next action", () => {
    const card = failureCard("派发失败：任务没有开始", "not_registered_repo。重新派发一次即可。", "t", "f");
    expect(card.text).toContain("❌ 派发失败：任务没有开始");
    expect(card.text).toContain("需要你：not_registered_repo");
  });

  it("the offline-ask message carries only the action in button values — no thread data stuffed in (§3.1)", () => {
    const card = offlineAskCard("repo-a", "mac-studio", "修复登录 bug");
    expect(card.buttons).toHaveLength(2); // no alternative machine: wait or cancel
    for (const button of card.buttons!) {
      expect(button.url).toBeUndefined();
      expect(button.action).toMatch(/^(wait_online|switch_machine|cancel)$/);
    }
    // And nothing anywhere in the message mentions a thread id.
    expect(JSON.stringify(card)).not.toMatch(/t_[0-9A-Z]+/);
  });

  it("a [换台机器] button appears only when another machine has the repo (protocol §7.3)", () => {
    const withAlt = offlineAskCard("repo-a", "mac-studio", "修复登录 bug", ["mac-mini"]);
    expect(withAlt.buttons).toHaveLength(3);
    expect(withAlt.buttons!.map((b) => b.action)).toEqual(["wait_online", "switch_machine", "cancel"]);
    expect(withAlt.buttons![1]!.label).toContain("mac-mini");
  });
});

describe("notifyCard / askUserText (issue #6)", () => {
  it("notifyCard renders the three-part message the steward's notify_user sends", () => {
    const card = notifyCard({ tone: "attention", conclusion: "构建坏了，需要你拍板", did: ["定位到依赖冲突"], needsYou: "回滚还是升级？", threadTitle: "登录 bug" });
    expect(card.text).toContain("⚠️ 构建坏了，需要你拍板");
    expect(card.text).toContain("定位到依赖冲突");
    expect(card.text).toContain("回滚还是升级？");
    expect(card.text).toContain("Thread「登录 bug」");
  });

  it("askUserText lists up to 3 options and says the reply carries the Thread", () => {
    const text = askUserText("你指的是哪件事？", ["A 登录 bug", "B 登录页样式", "新开一件事"], "登录 bug");
    expect(text).toContain("【登录 bug】");
    expect(text).toContain("1. A 登录 bug");
    expect(text).toContain("直接回复这句话");
  });
});

describe("the PR consent gate's templates (issue #21)", () => {
  it("reportCardFor adds [同意]/[先不要] exactly for done write reports with unpushed commits", () => {
    const withConsent = reportCardFor(report(), worker, "mac-studio", "登录 bug");
    expect(withConsent.buttons!.map((b) => b.action)).toEqual(["pr_approve", "pr_decline"]);
    expect(withConsent.text).toContain("还没推送");
    expect(withConsent.text).toContain("2 个提交");

    const pushed = reportCardFor(report({ git: { ...report().git!, pushed: true } }), worker, "m", "t");
    expect((pushed.buttons ?? []).some((b) => b.action?.startsWith("pr_"))).toBe(false);

    const readonlyWorker = { ...worker, mode: "readonly" } as WorkerRow;
    expect(prConsentFor(report(), readonlyWorker)).toBeNull();
    expect(prConsentFor(report({ status: "needs_decision" }), worker)).toBeNull();
    expect(prConsentFor(report({ git: { ...report().git!, ahead: 0 } }), worker)).toBeNull();
  });

  it("button values carry ONLY the action — identity resolves via the message id (§3.1)", () => {
    const card = reportCardFor(report(), worker, "mac-studio", "登录 bug");
    for (const button of card.buttons!) {
      expect(Object.keys(button)).toEqual(["label", "action", "primary"].filter((k) => button[k as keyof typeof button] !== undefined && k !== "url"));
      expect(button.url).toBeUndefined();
    }
    expect(JSON.stringify(card)).not.toMatch(/w_[0-9A-Z]+/); // no worker id stuffed in
  });

  it("prCreatedCard is success-badged, carries the URL as text and as an open-PR button", () => {
    const card = prCreatedCard({ url: "https://github.com/example/repo-a/pull/7", branch: "sig/login-1", threadTitle: "登录 bug", footer: "f" });
    expect(card.text).toContain("✅ PR 已创建");
    expect(card.text).toContain("https://github.com/example/repo-a/pull/7");
    expect(card.text).toContain("已推送到远端");
    expect(card.buttons).toEqual([{ label: "打开 PR", url: "https://github.com/example/repo-a/pull/7", primary: true }]);
  });

  it("prFailureNeedsYou names the machine-side fix per stage and the retry contract", () => {
    expect(prFailureNeedsYou("gh_missing", "")).toContain("GitHub CLI");
    expect(prFailureNeedsYou("auth", "Bad credentials")).toContain("gh auth login");
    expect(prFailureNeedsYou("push", "pre-receive declined")).toContain("推送分支被拒绝");
    expect(prFailureNeedsYou("whatever", "boom")).toContain("boom");
    expect(prFailureNeedsYou("gh_missing", "")).toContain("再点一次「同意」");
  });

  it("prCommandArgs builds the title/body from the report — data only, no LLM", () => {
    const { title, body } = prCommandArgs({ report: report(), threadTitle: "登录 bug", branch: "sig/login-1" });
    expect(title).toBe("登录 bug 修好，测试通过");
    expect(body).toContain("auth/session.ts 里补上了 token 过期后的刷新");
    expect(body).toContain("测试：通过");
    expect(body).toContain("sig/login-1");
    // No report (it was pruned): the thread title stands in, the body still names the branch.
    const fallback = prCommandArgs({ report: null, threadTitle: "登录 bug", branch: "sig/login-1" });
    expect(fallback.title).toBe("登录 bug");
    expect(fallback.body).toContain("sig/login-1");
  });
});

describe("reportCardFor: the answer section (issue #76)", () => {
  it("an informational report (no changes) surfaces its answer, not a generic did bullet", () => {
    // The discriminant is report.answer + empty report.changes, never worker.mode (issue #76).
    const readonlyWorker = { ...worker, mode: "readonly" } as WorkerRow;
    const card = reportCardFor(
      report({ changes: null, git: null, answer: "pi-memory 是一个本地记忆服务……完整结论在这里。" }),
      readonlyWorker,
      "mac-studio",
      "讲解 pi-memory",
    );
    expect(card.text).toContain("pi-memory 是一个本地记忆服务……完整结论在这里。");
  });

  it("a write task that both changed files and answered a question gets both sections", () => {
    const card = reportCardFor(report({ answer: "顺带说明一下这次改动的背景。" }), worker, "mac-studio", "登录 bug");
    expect(card.text).toContain("做了什么：");
    expect(card.text).toContain("auth/session.ts 里补上了 token 过期后的刷新");
    expect(card.text).toContain("顺带说明一下这次改动的背景。");
  });
});
