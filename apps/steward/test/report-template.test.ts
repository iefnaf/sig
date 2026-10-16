// Deterministic template tests (issue #5): three-part reports, tone by nature, truncation —
// all without any LLM (steward.md §6.4, spec §7.5).
import { describe, expect, it } from "vitest";
import type { ReportRow, WorkerRow } from "../src/ledger.ts";
import {
  didBullets,
  failureCard,
  MAX_CONCLUSION,
  needsYouOf,
  offlineAskCard,
  renderReportCard,
  statusText,
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
    git: { branch: "shepherd/login-1", base: "main", ahead: 2, dirty: 0, filesChanged: 2, insertions: 30, deletions: 4, pushed: false },
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
  lastOutcome: "reported:done",
  lastEventAt: 1,
  lastProgress: null,
  createdAt: 1,
};

describe("renderReportCard: the fixed three parts (spec §7.5)", () => {
  it("renders conclusion in the header, did as bullets, needs-you as its own section", () => {
    const card = renderReportCard({
      tone: "success",
      conclusion: "登录 bug 修好，测试通过",
      did: ["修复 auth/session.ts", "分支 shepherd/login-1"],
      needsYou: "要推送并开 PR 吗？",
      threadTitle: "修复登录 bug",
      footer: "Thread「修复登录 bug」 · pi @ mac-studio",
    });
    expect(card.header).toMatchObject({
      template: "green",
      title: { content: expect.stringContaining("登录 bug 修好") },
    });
    const elements = card.elements as Array<Record<string, unknown>>;
    const did = JSON.stringify(elements[0]);
    expect(did).toContain("做了什么");
    expect(did).toContain("修复 auth/session.ts");
    expect(JSON.stringify(elements)).toContain("需要你");
    expect(JSON.stringify(elements)).toContain("要推送并开 PR 吗？");
  });

  it("omits the needs-you section entirely when there is nothing needed", () => {
    const card = renderReportCard({ tone: "success", conclusion: "done", did: ["x"], threadTitle: "t", footer: "f" });
    expect(JSON.stringify(card.elements)).not.toContain("需要你");
  });

  it("tone by nature, not by needs-you: a done report with caveats stays green", () => {
    // The M1 live-testing correction (steward.md §6.4): a completion with minor caveats still
    // gets the success tone so the color alone says whether anything went wrong.
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
    expect(card.header).toMatchObject({ template: "green" });
    expect(JSON.stringify(card.elements)).toContain("需要你");
  });

  it("clips over-length conclusions and did items to the spec limits", () => {
    const card = renderReportCard({
      tone: "failure",
      conclusion: "错".repeat(200),
      did: ["很长的条目".repeat(60)],
      threadTitle: "t",
      footer: "f",
    });
    const title = (card.header as { title: { content: string } }).title.content;
    // badge + space + conclusion; conclusion itself ≤ 80 chars + ellipsis
    expect(title.length).toBeLessThanOrEqual(2 + 1 + MAX_CONCLUSION + 2);
    const did = JSON.stringify(card.elements);
    expect(did).toContain("…");
  });
});

describe("didBullets / needsYouOf: data in, text out", () => {
  it("builds bullets from changes, tests, and git facts only", () => {
    const bullets = didBullets(report());
    expect(bullets).toEqual([
      "auth/session.ts 里补上了 token 过期后的刷新",
      "测试通过",
      "分支 shepherd/login-1，2 个提交，未推送",
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

describe("failure and offline-ask cards", () => {
  it("failure cards are red and state the outcome plainly with a next action", () => {
    const card = failureCard("派发失败：任务没有开始", "not_registered_repo。重新 /派发 一次即可。", "t", "f");
    expect(card.header).toMatchObject({ template: "red" });
  });

  it("the offline-ask card carries only the action in button values — no thread data stuffed in (§3.1)", () => {
    const card = offlineAskCard("repo-a", "mac-studio", "修复登录 bug") as { elements: Array<Record<string, unknown>> };
    const action = card.elements.find((el) => el.tag === "action") as { actions: Array<{ value: Record<string, unknown> }> };
    expect(action.actions).toHaveLength(2);
    for (const button of action.actions) {
      expect(Object.keys(button.value)).toEqual(["action"]);
      expect(button.value.action).toMatch(/^(wait_online|cancel)$/);
    }
    // And nothing anywhere in the card mentions a thread id.
    expect(JSON.stringify(card)).not.toMatch(/t_[0-9A-Z]+/);
  });
});

describe("statusText", () => {
  it("lists machines with online dots and threads with derived-state marks", () => {
    const text = statusText(
      [
        { title: "修复登录 bug", state: "running", unread: true },
        { title: "整理依赖", state: "idle", unread: false },
      ],
      [
        { name: "mac-studio", online: true },
        { name: "macbook", online: false },
      ],
    );
    expect(text).toContain("🟢 mac-studio");
    expect(text).toContain("⚫️ macbook");
    expect(text).toContain("▶ 修复登录 bug（running，未读）");
    expect(text).toContain("· 整理依赖（idle）");
  });
});
