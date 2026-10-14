// M2: the steward as a pi-durable extension. Tools + policy hook + prompt sections,
// parameterized by a StewardContext so tests run in-process with the faux model and the
// Durable Object wires real dispatch/ask/notify behind the same interface.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Memory } from "../../steward-m1/src/memory.ts";
import { buildBrief } from "./brief.ts";

export interface StewardContext {
	memory: Memory;
	/** Dispatch a worker (creates the command). Returns ok:false with a note when refused. */
	dispatch(input: { threadId: string; prompt: string; basis: string; provenance?: string }): Promise<{ ok: boolean; workerId?: string; note?: string }>;
	/** Ask the user a question (creates the question and pushes it). */
	askUser(input: { threadId?: string; question: string; options?: string[] }): Promise<void>;
	/** Push a message to the user outside the report-card flow (event wakes). */
	notify(input: { text: string; threadId?: string; tone?: "info" | "attention" }): Promise<void>;
	/** The current run was started by a user message (vs an event/routine). */
	runIsUserInitiated: () => boolean;
	/** Provenance id of the current run (user message id, routine id, ...). */
	currentProvenance: () => string | undefined;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function buildStewardExtension(ctx: StewardContext): Extension {
	const findThreads = defineTool({
		name: "find_threads",
		description:
			"Find threads a user message may belong to. Returns candidates with id, title, state and a summary. " +
			"Choose: attach to one thread, create a new one (needs a title), or ask_user when several fit equally.",
		parameters: Type.Object({ query: Type.String({ description: "The user's words or the task description" }) }),
		execute: async (args) => {
			const rows = ctx.memory.db.all<{ threadId: string; title: string; state: string; summary: string | null }>(
				`SELECT threadId, title, state, summary FROM sh_thread WHERE archived = 0 ORDER BY lastActivityAt DESC LIMIT 30`,
			);
			// CJK has no spaces: score by character-bigram overlap plus latin word matches,
			// so 「依赖升级…」 finds 「升级依赖」 and 「文档补完」 finds 「补 API 文档」.
			const q = args.query.toLowerCase();
			const grams = new Set<string>();
			const chars = [...q];
			for (let i = 0; i < chars.length - 1; i++) if (!/\s/.test(chars[i]) && !/\s/.test(chars[i + 1])) grams.add(chars[i] + chars[i + 1]);
			const latin = q.match(/[a-z0-9_./-]{2,}/g) ?? [];
			const scored = rows
				.map((r) => {
					const hay = `${r.title} ${r.summary ?? ""}`.toLowerCase();
					const hayGrams = new Set<string>();
					const h = [...hay];
					for (let i = 0; i < h.length - 1; i++) if (!/\s/.test(h[i]) && !/\s/.test(h[i + 1])) hayGrams.add(h[i] + h[i + 1]);
					const gramHits = [...grams].filter((g) => hayGrams.has(g)).length;
					const latinHits = latin.filter((t) => hay.includes(t)).length;
					return { r, score: gramHits + latinHits * 2 + (r.state !== "idle" ? 1 : 0) };
				})
				.filter((x) => x.score >= 2)
				.sort((a, b) => b.score - a.score)
				.slice(0, 8)
				.map((x) => ({ id: x.r.threadId, title: x.r.title, state: x.r.state, summary: (x.r.summary ?? "").slice(0, 120), matched: x.score, weak: x.score <= 4 }));
			return ok(scored.length ? JSON.stringify(scored) : "[]");
		},
	});

	const getThread = defineTool({
		name: "get_thread",
		description: "Full detail of one thread: goal, summary, workers, latest report, open question.",
		parameters: Type.Object({ threadId: Type.String() }),
		execute: async (args) => {
			const t = ctx.memory.db.get<{ threadId: string; title: string; goal: string; summary: string | null; state: string }>(
				`SELECT threadId, title, goal, summary, state FROM sh_thread WHERE threadId = ?`, args.threadId,
			);
			if (!t) return ok("not found");
			const workers = ctx.memory.db.all(`SELECT workerId, state, lastOutcome FROM sh_worker WHERE threadId = ?`, args.threadId);
			const w0 = workers[0]?.workerId;
			const report = w0 ? ctx.memory.latestReport(w0) : undefined;
			return ok(JSON.stringify({ ...t, workers, latestReport: report ?? null }));
		},
	});

	const updateThread = defineTool({
		name: "update_thread",
		description: "Update a thread's title, goal or rolling summary (keep summaries <= 600 chars).",
		parameters: Type.Object({
			threadId: Type.String(),
			title: Type.Optional(Type.String()),
			goal: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
		}),
		execute: async (args) => {
			ctx.memory.db.run(
				`UPDATE sh_thread SET title = COALESCE(?, title), goal = COALESCE(?, goal), summary = COALESCE(?, summary), summaryAt = ? WHERE threadId = ?`,
				args.title ?? null, args.goal ?? null, args.summary ?? null, Date.now(), args.threadId,
			);
			return ok("updated");
		},
	});

	const startWorker = defineTool({
		name: "start_worker",
		description:
			"Dispatch a task to a worker on the user's machine. Either attach to an existing thread (threadId) or create one (newTitle + goal). " +
			"basis: user_explicit (the user asked for exactly this), user_reply_to (replying to a report), memory (a stored preference).",
		parameters: Type.Object({
			prompt: Type.String({ description: "What the worker should do, self-contained" }),
			threadId: Type.Optional(Type.String()),
			newTitle: Type.Optional(Type.String()),
			goal: Type.Optional(Type.String()),
			basis: Type.Union([Type.Literal("user_explicit"), Type.Literal("user_reply_to"), Type.Literal("memory"), Type.Literal("inferred")]),
		}),
		replay: "unsafe",
		execute: async (args) => {
			// Creating the thread here keeps the ledger the single writer of thread state.
			let threadId = args.threadId;
			if (!threadId && args.newTitle) {
				threadId = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
				ctx.memory.createThread(threadId, args.newTitle, args.goal ?? args.prompt, ctx.currentProvenance());
			}
			if (!threadId) return { content: [{ type: "text" as const, text: "refused: no thread" }], isError: true };
			const r = await ctx.dispatch({ threadId, prompt: args.prompt, basis: args.basis, provenance: ctx.currentProvenance() });
			return r.ok ? ok(`dispatched worker ${r.workerId}`) : { content: [{ type: "text" as const, text: `refused: ${r.note}` }], isError: true };
		},
	});

	const askUser = defineTool({
		name: "ask_user",
		description: "Ask the user a question and end this run. Use whenever routing or intent is ambiguous. Max 3 short options.",
		parameters: Type.Object({
			question: Type.String(),
			options: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
			threadId: Type.Optional(Type.String()),
		}),
		execute: async (args) => {
			await ctx.askUser({ threadId: args.threadId, question: args.question, options: args.options });
			return { content: [{ type: "text" as const, text: "asked" }], control: { terminate: true } };
		},
	});

	const noAction = defineTool({
		name: "no_action",
		description: "Record that this wake needs no action, and end the run. The default for event wakes.",
		parameters: Type.Object({ reason: Type.String() }),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], control: { terminate: true } }),
	});

	const notifyUser = defineTool({
		name: "notify_user",
		description:
			"Push a short message to the user (event wakes only, when they must know something beyond the standard report card). " +
			"User-initiated runs should not call this — the final reply already reaches the user.",
		parameters: Type.Object({
			text: Type.String({ description: "One or two sentences, conclusion first" }),
			threadId: Type.Optional(Type.String()),
			tone: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("attention")])),
		}),
		execute: async (args) => {
			if (ctx.runIsUserInitiated()) return { content: [{ type: "text" as const, text: "refused: user run — just reply" }], isError: true };
			await ctx.notify({ text: args.text, threadId: args.threadId, tone: args.tone });
			return ok("notified");
		},
	});

	const remember = defineTool({
		name: "remember",
		description:
			"Store a durable note about the user's preferences, constraints, or facts (e.g. 推送前必须跑全量测试). " +
			"Notes persist across conversations and are shown every run. Only for things true beyond the current task.",
		parameters: Type.Object({ text: Type.String({ description: "One self-contained fact, one sentence" }) }),
		execute: async (args) => ok(`noted as ${ctx.memory.addNote(args.text)}`),
	});

	const forget = defineTool({
		name: "forget",
		description: "Remove a stored note (visible forgetting). List current notes first if unsure of the id.",
		parameters: Type.Object({ noteId: Type.String() }),
		execute: async (args) => {
			ctx.memory.removeNote(args.noteId);
			return ok("forgotten");
		},
	});

	// Policy hook (steward.md §7.2, M2 subset): inferred dispatch is refused; a thread is required;
	// one dispatch per run — a second start_worker for a different thread means the model is
	// second-guessing itself (observed: placeholder prompt, then the real one).
	// The extension instance outlives runs, so the guard resets when the provenance (message id)
	// changes — never mid-run.
	let dispatchedThread: string | undefined;
	let guardProvenance: string | undefined;
	const guard = hook(ToolTask, {
		beforeTool: (call) => {
			const p = ctx.currentProvenance();
			if (p !== guardProvenance) {
				guardProvenance = p;
				dispatchedThread = undefined;
			}
			const args = (call as { arguments?: Record<string, unknown> }).arguments ?? {};
			if (call.name === "start_worker") {
				if (args.basis === "inferred") {
					return { block: "Autonomy rule: you may not dispatch on inference alone. Use ask_user, or attach a basis the user gave you." };
				}
				if (!args.threadId && !args.newTitle) {
					return { block: "Dispatch needs a threadId (attach, from find_threads) or a newTitle (create)." };
				}
				const target = (args.threadId as string) ?? `new:${args.newTitle}`;
				if (dispatchedThread && dispatchedThread !== target) {
					return { block: `本条消息已经派发过（${dispatchedThread}）。不要在同一个回合里改派；如有疑问用 ask_user 与用户确认。` };
				}
				dispatchedThread = target;
			}
			return undefined;
		},
	});

	return defineExtension({
		name: "shepherd-steward",
		tools: [findThreads, getThread, updateThread, startWorker, askUser, noAction, notifyUser, remember, forget],
		hooks: [guard],
		sections: [
			section("shepherd-role", () => ROLE_PROMPT, { tag: false }),
			section("shepherd-notes", () => notesSection(ctx.memory), { tag: true }),
			section("shepherd-situation", () => buildBrief(ctx.memory), { tag: true }),
		],
	});
}

function notesSection(memory: Memory): string {
	const notes = memory.notes();
	if (!notes.length) return "";
	return ["长期备忘：", ...notes.slice(0, 20).map((n) => `- ${n.id} ${n.text}`)].join("\n");
}

const ROLE_PROMPT = `你是 Shepherd 的总管，替用户调度其机器上的编码 agent。你不亲自写代码。

规则：
1. 以 ⟦ 开头的输入不是用户说的话，是系统事件。事件触发的运行里不要输出面向用户的文字，无事可做就调用 no_action；需要通知用户时明确说明。
2. 派发前先 find_threads。路由判据（从严到宽）：
   - 无匹配候选，或候选都标着 weak: true 且话语没有点名它标题里的词 → 直接新建 thread（newTitle 用用户的原话短语），不要问。
   - 有一个明显最匹配的候选 → attach 到它，并在回复里说明挂到了哪件事。
   - 两个及以上候选**同样匹配**、或话语完全没有指代对象 → 用 ask_user 工具反问（最多 3 个选项，含「新开一件事」）。
   挂靠的依据是**同一件事的延续**，不是"领域相近"：新功能、新需求即使和现有线程话题相关（比如都涉及 GitHub、都是接口），也是新事件，该新建就新建。
   但**接续指令是同一件事**：用户说「按 X 方案/计划实施」「接着 X 继续」「在 X 基础上做」，而 X 正是某个线程产出的（方案、调研、分支）→ attach 那个线程，不要新建。worker 的接力依赖同线程（新 worker 从该线程上一棒分支续作），另开线程会丢掉接续基础。
   状态/进度类问题（"修好了吗""跑到哪了"）不派发：直接根据候选线程的汇报和状态回答。
3. 反问必须走 ask_user 工具（用户在手机上点按钮），不要在文本里反问后结束。ask_user 之外的场合不要反问。
4. 只有真正调用了 start_worker 并看到 dispatched 结果才算派发过；严禁在回复文本里声称已派发而实际没有调用工具。
4. start_worker 的 basis 只能是你真正拥有的依据；禁止 inferred。
5. 给用户的回复简短：先结论，再要点，最多几行。
6. worker 汇报到达后（⟦event⟧），做记账：更新 thread 摘要；除非有用户必须知道的新信息（风险决定、需要拍板、明确失败），否则不再通知——需要时用 notify_user。
7. 用户表达的长期偏好、约束、事实（跨任务成立的那种）用 remember 记下来；单件事的进度不要记。`;
