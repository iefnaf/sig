// The workspace's browser code, tested where it can be: the pure modules (format.js, model.js,
// i18n.js) run here directly, and the files that need a DOM are checked as shipped — through
// the same assets binding the Worker serves them from — for the properties that matter most:
// no HTML sink anywhere (everything agents and repositories write is displayed, never parsed),
// no inline script or style (the page's policy forbids both), and no missing interface copy.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { STRINGS, getLocale, setLocale, t, tOr } from "../ui/i18n.js";
import { dayKey, formatClock, formatDay, formatRelative, formatUsd, parseInline, parseMarkup, plainText, safeUrl, trimOpenMarkup } from "../ui/format.js";
import { ACTION_KEYS, FATAL_COPY, KNOWN_TITLES, groupByDay, groupThreads, messagesFor, modelAfterProviderChange, thinkingAfterModelChange, availableChatModels, initialSetupStep, previewOf, summarize, threadMatches, withPending, workOn } from "../ui/model.js";
import { cardView } from "../src/workspace.ts";
import type { ReportRow, WorkerRow } from "../src/ledger.ts";
import { askUserCard, noteDecisionCard, offlineAskCard, reportCardFor, routineOfferCard, workerQuestionCard } from "../src/report-template.ts";

async function fetchAsset(name: string): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(`https://assets.invalid/${name}`));
  if (!response.ok) throw new Error(`asset ${name}: ${response.status}`);
  return response;
}

const asset = async (name: string): Promise<string> => (await fetchAsset(name)).text();

// login.js is the pre-session sign-in script: it ships as its own public asset (not under the
// session-gated /app/assets/* tree) and deliberately does not import i18n.js (candidate-2
// design §6) — it is included here for the sink scan and the import-export check (it has no
// imports, so that check is a no-op for it) but NOT in the i18n-completeness scan below, whose
// own file list is separate and intentionally does not reach it.
const SCRIPTS = ["workspace.js", "model-picker.js", "dom.js", "format.js", "model.js", "i18n.js", "markup.js", "session.js", "session-model.js", "login.js"];

/** The text between the parentheses of every call to `fn(…)` (not `x.fn(…)`, not `prefixfn(…)`). */
function callArguments(source: string, fn: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(new RegExp(`(?<![\\w.$])${fn}\\(`, "g"))) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    calls.push(source.slice(start, end - 1));
  }
  return calls;
}

describe("shipped files", () => {
  it("contain no way to turn text into markup or code", async () => {
    for (const name of SCRIPTS) {
      const source = await asset(name);
      for (const sink of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write/, /\beval\s*\(/, /\bnew Function\b/, /\bsrcdoc\b/, /javascript:/i, /\bsetAttribute\(\s*['"]on/, /\bsetAttribute\(\s*['"]style/]) {
        expect(source, `${name} must not match ${sink}`).not.toMatch(sink);
      }
    }
  });

  it("keep the page free of inline script, inline style and external resources", async () => {
    const html = await asset("workspace.html");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)="https?:/i);
    const css = await asset("workspace.css");
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it("refer only to files that ship", async () => {
    const html = await asset("workspace.html");
    const referenced = [...html.matchAll(/\/app\/assets\/([\w.-]+)/g)].map((match) => match[1]!);
    expect(referenced.length).toBeGreaterThanOrEqual(2); // workspace.css + workspace.js
    for (const name of new Set(referenced)) await fetchAsset(name);
    const script = await asset("workspace.js");
    for (const name of new Set([...script.matchAll(/\/app\/assets\/([\w.-]+)/g)].map((match) => match[1]!))) await fetchAsset(name);
  });

  // workspace.js and session.js touch the DOM and cannot be loaded here, so a name imported from a
  // sibling that does not export it would only fail when a browser first opens the page.
  it("import only names their sibling modules really export", async () => {
    const exported = async (name: string): Promise<Set<string>> => {
      const source = await asset(name);
      const names = new Set<string>();
      for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]!);
      for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const part of match[1]!.split(",")) {
          const alias = part.trim().split(/\s+as\s+/).pop();
          if (alias) names.add(alias);
        }
      }
      return names;
    };
    let checked = 0;
    for (const script of SCRIPTS) {
      for (const match of (await asset(script)).matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+)'/g)) {
        const available = await exported(match[2]!);
        for (const part of match[1]!.split(",")) {
          const imported = part.trim().split(/\s+as\s+/)[0]!;
          if (!imported) continue;
          checked += 1;
          expect(available.has(imported), `${script} imports ${imported} from ${match[2]}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("the settings draft's provider switch (issue #74)", () => {
  const catalog = [
    { id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] },
    { id: "empty", name: "Empty", models: [] },
  ];

  it("keeps a modelId the new provider also has, else preselects its first model", () => {
    expect(modelAfterProviderChange(catalog, "deepseek", "deepseek-flash")).toBe("deepseek-flash");
    expect(modelAfterProviderChange(catalog, "deepseek", "gpt-4o")).toBe("deepseek-flash");
  });

  it("leaves the field alone for a catalog-unknown provider or a provider with no models", () => {
    expect(modelAfterProviderChange(catalog, "my-proxy", "gpt-4o")).toBeNull();
    expect(modelAfterProviderChange(catalog, "empty", "anything")).toBeNull();
    expect(modelAfterProviderChange(undefined, "deepseek", "deepseek-flash")).toBeNull();
  });
});

describe("interface copy", () => {
  it("is complete in both languages and keeps its placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const [key, pair] of Object.entries(STRINGS) as Array<[string, [string, string]]>) {
      expect(pair, key).toHaveLength(2);
      expect(pair[0].trim(), `${key} (en)`).not.toBe("");
      expect(pair[1].trim(), `${key} (zh)`).not.toBe("");
      expect(placeholders(pair[0]), `${key} placeholders`).toEqual(placeholders(pair[1]));
    }
  });

  it("covers every string the page asks for, including the data-driven ones", async () => {
    const used = new Set<string>();
    for (const name of ["workspace.js", "workspace.html", "session.js"]) {
      const source = await asset(name);
      for (const args of callArguments(source, "t")) for (const key of args.matchAll(/'([A-Za-z_:]+)'/g)) used.add(key[1]!);
      for (const attribute of source.matchAll(/data-i18n(?:-[a-z]+)?="([A-Za-z_:]+)"/g)) used.add(attribute[1]!);
    }
    // Keys built from data: card kinds, worker states, connection states, and the copy tables.
    for (const kind of ["question", "consent", "offline", "offer", "memory"]) used.add(`kind${kind[0]!.toUpperCase()}${kind.slice(1)}`);
    for (const state of ["queued", "starting", "running", "recovering", "idle", "broken"]) used.add(`worker${state[0]!.toUpperCase()}${state.slice(1)}`);
    for (const state of ["connecting", "live", "reconnecting", "disconnected"]) used.add(state);
    // The session viewer labels the bookkeeping entries an agent writes by kind (session-model.js).
    for (const kind of ["session", "model", "thinking_level", "compaction", "branch_summary", "custom", "label", "session_info", "usage", "context_edit", "system", "summary", "info", "error"]) used.add(`svMeta_${kind}`);
    for (const key of [...Object.values(ACTION_KEYS), ...Object.values(KNOWN_TITLES), ...Object.values(FATAL_COPY).flat()]) used.add(key);
    expect(used.size).toBeGreaterThan(60);
    expect([...used].filter((key) => !(key in STRINGS))).toEqual([]);
  });

  it("names every timeline event the ledger writes", () => {
    for (const kind of ["user_instruction", "dispatch", "started", "progress", "report", "question", "settled", "lost", "resumed", "machine_status", "note", "stall", "routine", "followup"]) {
      expect(`kind_${kind}` in STRINGS, kind).toBe(true);
    }
  });

  it("starts in English, switches on request, and falls back gracefully", () => {
    expect(getLocale()).toBe("en");
    expect(t("needsYou")).toBe("Needs you");
    expect(t("slots", { used: 1, total: 4 })).toBe("1 / 4 slots");
    expect(setLocale("zh")).toBe(true);
    expect(t("needsYou")).toBe("待处理");
    expect(setLocale("zh")).toBe(false); // already there
    expect(setLocale("fr")).toBe(false); // only the two languages exist
    expect(tOr("kind_unheard_of", "raw value")).toBe("raw value");
    expect(t("no_such_key")).toBe("no_such_key"); // a missing string never takes the page down
    expect(setLocale("en")).toBe(true);
  });
});

describe("text with a little markup", () => {
  it("reads paragraphs, lists, code and emphasis, and nothing else", () => {
    const blocks = parseMarkup("Line one\nline two\n\n- first\n- second\n\n1. one\n2) two\n\n```ts\nconst a = 1;\n```\nAfter **bold** and `code`.");
    expect(blocks.map((block) => block.t)).toEqual(["p", "ul", "ol", "code", "p"]);
    expect(blocks[0]).toMatchObject({ t: "p", lines: [[{ t: "text", text: "Line one" }], [{ t: "text", text: "line two" }]] });
    expect(blocks[1]).toMatchObject({ t: "ul", items: [[{ text: "first" }], [{ text: "second" }]] });
    expect(blocks[3]).toEqual({ t: "code", text: "const a = 1;" });
    expect(blocks[4]).toMatchObject({ lines: [[{ t: "text", text: "After " }, { t: "strong", text: "bold" }, { t: "text", text: " and " }, { t: "code", text: "code" }, { t: "text", text: "." }]] });
  });

  it("reads the headings models actually write, bold-wrapped or plain", () => {
    const blocks = parseMarkup("Intro line\n\n## 1. 重启那一刻发生了什么\n\n**## 2. 重启后怎么重新连上**\n\ntext\n\n#### 四级标题\n\n###nospace and ## short stay text");
    expect(blocks.map((block) => block.t)).toEqual(["p", "h", "h", "p", "h", "p"]);
    expect(blocks[1]).toEqual({ t: "h", level: 2, lines: [[{ t: "text", text: "1. 重启那一刻发生了什么" }]] });
    expect(blocks[2]).toEqual({ t: "h", level: 2, lines: [[{ t: "text", text: "2. 重启后怎么重新连上" }]] });
    expect(blocks[4]).toMatchObject({ level: 4 });
    // `###` without a space after it is not a heading — it stays text, markers and all.
    expect(JSON.stringify(blocks[5])).toContain("###nospace and ## short stay text");
  });

  it("reads quotes, horizontal rules, italics and strikethrough", () => {
    const blocks = parseMarkup("> quoted line one\n> quoted **two**\n\nplain\n\n---\n\n* * *\n\nkeep ~~this~~ and *emphasis*");
    expect(blocks.map((block) => block.t)).toEqual(["quote", "p", "hr", "hr", "p"]);
    expect(blocks[0]).toEqual({ t: "quote", lines: [[{ t: "text", text: "quoted line one" }], [{ t: "text", text: "quoted " }, { t: "strong", text: "two" }]] });
    expect(blocks[4]).toMatchObject({ lines: [[{ t: "text", text: "keep " }, { t: "del", text: "this" }, { t: "text", text: " and " }, { t: "em", text: "emphasis" }]] });
  });

  it("flattens markup to one plain line for previews", () => {
    expect(plainText("## 标题\n\n**加粗** 和 ~~删除~~ 以及 `code`，见 [文档](https://example.com)。")).toBe("标题 加粗 和 删除 以及 code，见 文档。");
    expect(plainText("> 引用一行")).toBe("引用一行");
    expect(plainText(null)).toBe("");
  });

  it("does not italicize stray asterisks or snake-case underscores", () => {
    expect(parseInline("2 * 3 * 4 and a_b_c")).toEqual([{ t: "text", text: "2 * 3 * 4 and a_b_c" }]);
    expect(parseInline("**bold** stays bold")).toEqual([{ t: "text", text: "" }, { t: "strong", text: "bold" }, { t: "text", text: " stays bold" }].filter((part) => part.text !== ""));
  });

  it("keeps HTML as the plain text it is", () => {
    const [block] = parseMarkup('<img src=x onerror="alert(1)"> and <script>alert(1)</script>');
    expect(block).toEqual({ t: "p", lines: [[{ t: "text", text: '<img src=x onerror="alert(1)"> and <script>alert(1)</script>' }]] });
  });

  it("only links web addresses, and trims the punctuation that follows them", () => {
    expect(parseInline("see https://example.com/a?b=1, then [docs](https://example.com/docs).")).toEqual([
      { t: "text", text: "see " },
      { t: "link", href: "https://example.com/a?b=1", text: "https://example.com/a?b=1" },
      { t: "text", text: ", then " },
      { t: "link", href: "https://example.com/docs", text: "docs" },
      { t: "text", text: "." },
    ]);
    expect(parseInline("[x](javascript:alert(1)) and [y](data:text/html,hi)")).toEqual([{ t: "text", text: "[x](javascript:alert(1)) and [y](data:text/html,hi)" }]);
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://example.com", "not a url", "//example.com"]) expect(safeUrl(bad)).toBeNull();
  });
});

describe("text that is still being written", () => {
  it("holds back half-written markers until the rest arrives", () => {
    expect(trimOpenMarkup("Got it: **Tell me")).toBe("Got it: Tell me");
    expect(trimOpenMarkup("Got it: **Tell me** more")).toBe("Got it: **Tell me** more");
    expect(trimOpenMarkup("run `pnpm te")).toBe("run pnpm te");
    expect(trimOpenMarkup("run `pnpm test` now")).toBe("run `pnpm test` now");
    expect(trimOpenMarkup("see [the docs](https://exa")).toBe("see the docs");
    expect(trimOpenMarkup("see [the docs](https://example.com) now")).toBe("see [the docs](https://example.com) now");
    expect(trimOpenMarkup("```ts\nconst a = `x")).toBe("```ts\nconst a = `x"); // inside a code block everything is literal
    expect(trimOpenMarkup("")).toBe("");
  });
});

describe("times and money", () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);

  it("say how long ago in the viewer's language", () => {
    expect(formatRelative(now - 10_000, now, "en", "just now")).toBe("just now");
    expect(formatRelative(now - 5 * 60_000, now, "en", "just now")).toMatch(/5.*min/);
    expect(formatRelative(now - 5 * 60_000, now, "zh-CN", "刚刚")).toContain("5");
    expect(formatRelative(now - 5 * 60_000, now, "zh-CN", "刚刚")).toContain("分钟");
    expect(formatRelative(now - 3 * 3600_000, now, "en", "just now")).toMatch(/3.*hr/);
    expect(formatRelative(now - 2 * 86_400_000, now, "en", "just now")).toMatch(/2 days ago/);
    expect(formatRelative(now + 5000, now, "en", "just now")).toBe("just now"); // a slightly fast clock never reads as the future
  });

  it("label days as today, yesterday, or the date", () => {
    const labels = { today: "Today", yesterday: "Yesterday" };
    expect(formatDay(now - 60_000, now, "en", labels)).toBe("Today");
    expect(formatDay(now - 24 * 3600_000, now, "en", labels)).toBe("Yesterday");
    expect(formatDay(now - 10 * 86_400_000, now, "en", labels)).toMatch(/Oct|Sep/);
    expect(dayKey(now)).toMatch(/^2026-10-1[67]$/);
    expect(formatClock(now)).toMatch(/^\d\d:\d\d$/);
  });

  it("show cents, and fractions of a cent when that is all there is", () => {
    expect([formatUsd(0), formatUsd(0.18), formatUsd(1), formatUsd(0.004), formatUsd(Number.NaN)]).toEqual(["$0.00", "$0.18", "$1.00", "$0.004", "$0.00"]);
  });
});

describe("what the page derives from a snapshot", () => {
  const thread = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Thread ${id}`, goal: null, summary: null, state: "idle", unread: false, machine: "mac-studio", repos: ["repo-a"],
    workers: [{ agent: "pi", machine: "mac-studio", branch: `sig/${id}`, state: "idle" }], timeline: [], ...over,
  });

  it("groups threads by who is waiting on whom, and searches every field that identifies one", () => {
    const threads = [thread("a"), thread("b", { state: "running" }), thread("c", { state: "waiting_you", repos: ["billing"] }), thread("d", { machine: "mac-mini", workers: [{ agent: "claude", machine: "mac-mini", branch: null, state: "idle" }] })];
    expect(groupThreads(threads, "").map((group) => [group.state, group.threads.map((entry: { id: string }) => entry.id)])).toEqual([["waiting_you", ["c"]], ["running", ["b"]], ["idle", ["a", "d"]]]);
    expect(groupThreads(threads, "billing").flatMap((group) => group.threads.map((entry: { id: string }) => entry.id))).toEqual(["c"]);
    expect(groupThreads(threads, "CLAUDE").flatMap((group) => group.threads.map((entry: { id: string }) => entry.id))).toEqual(["d"]);
    expect(threadMatches(threads[0], "sig/a")).toBe(true); // by branch
    expect(groupThreads(threads, "nothing like this")).toEqual([]);
  });

  it("shows a message you just sent until the server has it, then only the server's", () => {
    const server = [{ id: "reply:1", role: "assistant", at: 1 }, { id: "user:web:abc-12345", role: "user", at: 2, text: "hi" }];
    const pending = new Map([
      ["abc-12345", { id: "abc-12345", text: "hi", at: 1, status: "sending" }],
      ["later-0001", { id: "later-0001", text: "next", at: 0, status: "failed", threadId: "t_1" }],
    ]);
    const merged = withPending(server, pending);
    expect(merged.map((message: { id: string }) => message.id)).toEqual(["reply:1", "user:web:abc-12345", "user:web:later-0001"]);
    expect(merged[2]).toMatchObject({ pending: "failed", threadId: "t_1", text: "next", channel: "web" }); // newest by definition, whatever the clocks say
    expect(messagesFor(merged, "t_1").map((message: { id: string }) => message.id)).toEqual(["user:web:later-0001"]);
    expect(messagesFor(merged, null)).toHaveLength(3);
  });

  it("puts messages under one divider per day", () => {
    const keyOf = (ts: number) => (ts < 100 ? "day-1" : "day-2");
    expect(groupByDay([{ at: 1 }, { at: 50 }, { at: 150 }, { at: 160 }], keyOf).map((group: { key: string; messages: unknown[] }) => [group.key, group.messages.length])).toEqual([["day-1", 2], ["day-2", 2]]);
  });

  it("counts what the header shows, ignoring revoked machines", () => {
    const snapshot = {
      machines: [{ online: true, revoked: false }, { online: false, revoked: false }, { online: true, revoked: true }],
      threads: [thread("a", { state: "running" }), thread("b")],
      attention: [{}, {}],
    };
    expect(summarize(snapshot)).toEqual({ machinesTotal: 2, machinesOnline: 1, running: 1, needs: 2 });
  });

  it("finds the work a machine is doing, and a one-line preview of a thread", () => {
    const busy = thread("a", { state: "running", workers: [{ agent: "pi", machine: "mac-studio", branch: null, state: "running" }] });
    const done = thread("b");
    expect(workOn({ threads: [busy, done] }, { name: "mac-studio" }).map((entry: { id: string }) => entry.id)).toEqual(["a"]);
    const messages = [{ threadId: "a", text: "first" }, { threadId: "b", text: "elsewhere" }, { threadId: "a", card: { title: "Login\n  fixed", body: [] } }];
    expect(previewOf(busy, messages)).toBe("Login fixed");
    expect(previewOf(thread("z", { summary: "A  summary" }), [])).toBe("A summary");
  });
});

describe("cards as the workspace reads them", () => {
  it("turns a flat question message into a title, answers and the Thread note (ADR-0003 shape)", () => {
    const view = cardView(askUserCard({ question: "Which approach?", threadTitle: "Fix login", buttons: [{ label: "A", action: "ask:q1:0" }, { label: "B", action: "ask:q1:1", primary: true }] }));
    expect(view).toMatchObject({ tone: "attention", title: "Which approach?", note: "Fix login" });
    expect(view.body).toEqual(["点按钮即可回答；也可以直接回复这条消息。"]); // the hint stays: it is the message's own copy
    expect(view.buttons).toEqual([{ label: "A", action: "ask:q1:0" }, { label: "B", action: "ask:q1:1", primary: true }]);
    expect(cardView(askUserCard({ question: "Open question", buttons: [] })).note).toBeNull();
  });

  it("keeps real links and drops one-time login links and anything that is not http(s)", () => {
    const view = cardView({ text: "✅ Done", buttons: [
      { label: "Open PR", url: "https://github.com/acme/repo/pull/7" },
      { label: "查看详情", url: "https://example.com/link/wl1.t/t_1.1792246301233.a01d.14ca" },
      { label: "Evil", url: "javascript:alert(1)" },
      { label: "Data", url: "data:text/html,x" },
      { label: "Approve", action: "pr_approve" },
      { label: "", action: "ghost" },
      {},
    ] });
    expect(view).toMatchObject({ tone: "success", title: "Done" });
    expect(view.buttons).toEqual([{ label: "Open PR", url: "https://github.com/acme/repo/pull/7" }, { label: "Approve", action: "pr_approve" }]);
  });

  it("keeps a report's markdown whole: blank lines, lists and code fences survive, the login link goes", () => {
    const answer = "## 结论\n\n1. 先装依赖\n2. 再启动\n\n```sh\npnpm i\n\npnpm dev\n```";
    const view = cardView(reportCardFor(
      { status: "done", summary: "调研完成", answer } as ReportRow, { mode: "read", agent: "claude" } as WorkerRow, "mac-studio", "调研",
      "https://example.com/link/wl1.t/t_1.1.a.b",
    ));
    expect(view.body).toHaveLength(1);
    expect(view.body[0]).toContain(answer);
    expect(view.body[0]).not.toContain("/link/wl1.");
    expect(parseMarkup(view.body[0]!).map((block) => block.t)).toEqual(expect.arrayContaining(["h", "ol", "code"]));
  });

  it("reads the system's own messages: offline, routine offer, memory, worker question", () => {
    expect(cardView(offlineAskCard("repo-a", "mac-studio", "Fix it", ["mac-mini"])).buttons.map((button) => button.action)).toEqual(["wait_online", "switch_machine", "cancel"]);
    expect(cardView(routineOfferCard({ schedule: "cron 0 17 * * 5", instruction: "Check dependencies" })).buttons.map((button) => button.action)).toEqual(["routine_accept", "routine_decline"]);
    expect(cardView(noteDecisionCard({ noteId: "n_1", text: "Keep reports short" })).buttons.map((button) => button.action)).toEqual(["note_archive", "note_keep"]);
    const question = cardView(workerQuestionCard({ question: "Drop the old index?", threadTitle: "Migrate", footer: "Thread「Migrate」", detailsUrl: "https://example.com/link/wl1.t/t_1.1.a.b" }));
    expect(question.buttons).toEqual([]); // answered by replying; the detail link rides the text, not a button
    expect(question.body.join("\n")).toContain("Drop the old index?");
    expect(cardView(null)).toMatchObject({ tone: "info", title: "", body: [], buttons: [], note: null }); // junk in, nothing out
  });
});


describe("first-run setup", () => {
  const configured = { model: { apiKey: true }, passkeys: [] };
  it("requires a model even when security was skipped or conversations exist", () => {
    expect(initialSetupStep({ model: { apiKey: false }, passkeys: [] }, true, true)).toBe("model");
  });
  it("offers passkeys after a preconfigured model on a new deployment", () => {
    expect(initialSetupStep(configured, false, false)).toBe("security");
  });
  it("opens the workspace for existing, secured, or explicitly skipped setups", () => {
    expect(initialSetupStep(configured, true, false)).toBeNull();
    expect(initialSetupStep(configured, false, true)).toBeNull();
    expect(initialSetupStep({ ...configured, passkeys: [{ credentialId: "saved" }] }, false, false)).toBeNull();
  });
});


describe("composer model choices", () => {
  it("offers only providers with saved keys", () => {
    expect(availableChatModels({ keyedProviders: ["ready"], providers: [{ id: "ready" }, { id: "unconfigured" }] })).toEqual([{ id: "ready" }]);
    expect(availableChatModels(null)).toEqual([]);
  });
  it("preserves supported thinking, and uses the advertised default otherwise", () => {
    const model = { thinkingLevels: ["off", "high", "max"], defaultThinkingLevel: "off" };
    expect(thinkingAfterModelChange(model, "max")).toBe("max");
    expect(thinkingAfterModelChange(model, "low")).toBe("off");
    expect(thinkingAfterModelChange({ thinkingLevels: ["high"], defaultThinkingLevel: "high" }, "off")).toBe("high");
  });
});
