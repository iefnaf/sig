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
			const tokens = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
			const scored = rows
				.map((r) => {
					const hay = `${r.title} ${r.summary ?? ""}`.toLowerCase();
					const hits = tokens.filter((t) => hay.includes(t)).length;
					return { r, score: hits + (r.state !== "idle" ? 2 : 0) };
				})
				.filter((x) => x.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, 8)
				.map((x) => ({ id: x.r.threadId, title: x.r.title, state: x.r.state, summary: (x.r.summary ?? "").slice(0, 120), matched: x.score }));
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

	// Policy hook (steward.md §7.2, M2 subset): inferred dispatch is refused; a thread is required.
	const guard = hook(ToolTask, {
		beforeTool: (call) => {
			const args = (call as { arguments?: Record<string, unknown> }).arguments ?? {};
			if (call.name === "start_worker") {
				if (args.basis === "inferred") {
					return { block: "Autonomy rule: you may not dispatch on inference alone. Use ask_user, or attach a basis the user gave you." };
				}
				if (!args.threadId && !args.newTitle) {
					return { block: "Dispatch needs a threadId (attach, from find_threads) or a newTitle (create)." };
				}
			}
			return undefined;
		},
	});

	return defineExtension({
		name: "shepherd-steward",
		tools: [findThreads, getThread, updateThread, startWorker, askUser, noAction],
		hooks: [guard],
		sections: [
			section("shepherd-role", () => ROLE_PROMPT, { tag: false }),
			section("shepherd-situation", () => buildBrief(ctx.memory), { tag: true }),
		],
	});
}

const ROLE_PROMPT = `你是 Shepherd 的总管，替用户调度其机器上的编码 agent。你不亲自写代码。

规则：
1. 以 ⟦ 开头的输入不是用户说的话，是系统事件。事件触发的运行里不要输出面向用户的文字，无事可做就调用 no_action；需要通知用户时明确说明。
2. 派发前先 find_threads。确定属于某件事就 attach；明显是新事就创建（newTitle 用用户的原话短语）；多个候选同样匹配、或拿不准时，必须 ask_user，不要猜。
3. start_worker 的 basis 只能是你真正拥有的依据；禁止 inferred。
4. 给用户的回复简短：先结论，再要点，最多几行。
5. worker 汇报到达后（⟦event⟧），做记账：更新 thread 摘要；除非有用户必须知道的新信息，否则不再通知。`;
