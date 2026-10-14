// Routing eval runner (steward.md §3.4): each case gets a fresh in-memory world seeded
// from the dataset, then the real steward extension runs against the real model. The
// outcome (attach:X / new / ask / chat) is scored against the label.
//
// Usage: node eval/run-eval.ts [--limit N] [--only id,id,...] [--model deepseek-flash] [--out file]
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { createRegistry, Harness, MemoryStorage, AssistantEntry } from "@earendil-works/pi-durable";
import { readFileSync } from "node:fs";
import { openNodeSqlite } from "../../steward-m1/src/node-db.ts";
import { Memory } from "../../steward-m1/src/memory.ts";
import { applyEvents } from "../../steward-m1/src/reducer.ts";
import type { WorkerEvent } from "../../steward-m1/src/types.ts";
import { buildStewardExtension, type StewardContext } from "../src/steward.ts";
import { CASES, THREADS, type Case } from "./dataset.ts";

// ---- args ----
const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIMIT = Number(arg("limit") ?? 0);
const ONLY = arg("only")?.split(",").map(Number);
const MODEL_ID = arg("model") ?? "deepseek-flash";
const OUT = arg("out") ?? `eval/results/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`;
const CONCURRENCY = Number(arg("concurrency") ?? 4);

// ---- api key: env first, then the e2e spike's gitignored .dev.vars ----
function apiKey(): string {
	if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
	try {
		const m = readFileSync(new URL("../../e2e/.dev.vars", import.meta.url), "utf8").match(/^DEEPSEEK_API_KEY=(.+)$/m);
		if (m) return m[1].trim();
	} catch {}
	throw new Error("DEEPSEEK_API_KEY not set (env or spikes/e2e/.dev.vars)");
}

const provider = createProvider({
	id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com",
	auth: { apiKey: { name: "DeepSeek API key", resolve: async () => ({ auth: { apiKey: apiKey() }, source: "eval" }) } },
	models: Object.values(DEEPSEEK_MODELS), api: openAICompletionsApi(),
} as never);

// ---- world seeding ----
function seedWorld(memory: Memory, now: number) {
	memory.registerMachine("dev_eval", "MacBook Pro");
	for (const t of THREADS) {
		memory.createThread(t.id, t.title, t.goal, "seed");
		const workerId = `w_${t.id.slice(2)}`;
		memory.registerWorker({ workerId, threadId: t.id, deviceId: "dev_eval", agent: "pi", mode: "write" });
		const events: WorkerEvent[] = [{ workerId, seq: 1, ts: now - t.ageH * 3600_000 - 600_000, type: "started", branch: "shepherd/seed" }];
		if (t.state === "idle_clean" || t.state === "idle_unread") {
			events.push({ workerId, seq: 2, ts: now - t.ageH * 3600_000 - 300_000, type: "report", status: "done", summary: t.summary ?? t.goal, changes: [], decisions: [], leftovers: [], tests: { ran: true, passed: true } });
			events.push({ workerId, seq: 3, ts: now - t.ageH * 3600_000, type: "settled", outcome: "reported" });
		}
		if (t.state === "waiting") {
			events.push({ workerId, seq: 2, ts: now - t.ageH * 3600_000, type: "report", status: "needs_decision", summary: t.summary ?? t.goal, changes: [], decisions: [], leftovers: [], tests: null, question: `${t.summary ?? t.goal}——需要你拍板` });
		}
		applyEvents(memory, events, now - t.ageH * 3600_000);
		if (t.summary) memory.db.run(`UPDATE sh_thread SET summary = ? WHERE threadId = ?`, t.summary, t.id);
		memory.db.run(`UPDATE sh_thread SET lastActivityAt = ? WHERE threadId = ?`, now - t.ageH * 3600_000, t.id);
		if (t.state === "idle_clean") memory.db.run(`UPDATE sh_thread SET unread = 0 WHERE threadId = ?`, t.id);
	}
}

// ---- one case ----
type Outcome = { kind: "attach"; threadId: string; isNew: boolean } | { kind: "new" } | { kind: "ask" } | { kind: "chat" } | { kind: "error"; reason: string };

async function runCase(c: Case): Promise<{ outcome: Outcome; reply: string; dispatches: number }> {
	const now = Date.now();
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	seedWorld(memory, now);
	const seedIds = new Set(THREADS.map((t) => t.id));

	const dispatches: Array<{ threadId: string; isNew: boolean }> = [];
	const asks: unknown[] = [];
	const ctx: StewardContext = {
		memory,
		dispatch: async (input) => {
			const isNew = !seedIds.has(input.threadId);
			dispatches.push({ threadId: input.threadId, isNew });
			return { ok: true, workerId: `w_eval_${dispatches.length}` };
		},
		askUser: async (a) => { asks.push(a); },
		runIsUserInitiated: () => true,
		currentProvenance: () => `eval_${c.id}`,
	};

	const models = createModels();
	models.setProvider(provider);
	const registry = createRegistry();
	registry.install(buildStewardExtension(ctx));
	const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "deepseek", modelId: MODEL_ID } } });
		const settled = await Promise.race([
			(await root.submit({ type: "input", content: c.text, requestId: `eval_${c.id}_${Math.random().toString(36).slice(2, 6)}` }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT),
			new Promise<never>((_, rej) => setTimeout(() => rej(new Error("case timeout")), 90_000)),
		]);
		if (settled.status !== "done") return { outcome: { kind: "error", reason: settled.reason ?? settled.status }, reply: "", dispatches: dispatches.length };
		let reply = "";
		if (settled.type === "input") {
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
			reply = ((entry?.model?.[0] as { content?: Array<{ type: string; text?: string }> })?.content ?? [])
				.filter((p) => p.type === "text").map((p) => p.text).join("").slice(0, 200);
		}
		const outcome: Outcome = asks.length ? { kind: "ask" }
			: dispatches.length
				? dispatches[0].isNew ? { kind: "new" } : { kind: "attach", threadId: dispatches[0].threadId, isNew: false }
				: { kind: "chat" };
		return { outcome, reply, dispatches: dispatches.length };
	} catch (err) {
		return { outcome: { kind: "error", reason: err instanceof Error ? err.message : String(err) }, reply: "", dispatches: dispatches.length };
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

// ---- scoring (steward.md §3.4 metrics) ----
// A prose question that lists candidates ("哪件？…A…B…") counts as asking — the product wants the
// ask_user tool (buttons), but text-asking is not a routing failure. Flagged so it stays visible.
const isTextAsk = (reply: string) => /(哪件|哪个|哪一|是哪|哪种|还是|定一个|定一下|选一个|回一句|告诉我)/.test(reply);
function score(expect: Case["expect"], outcome: Outcome, reply: string): "pass" | "wrong_route" | "missed_ask" | "unnecessary_ask" | "pass_text_ask" | "error" {
	if (outcome.kind === "error") return "error";
	if (expect.kind === "ask") {
		if (outcome.kind === "ask") return "pass";
		if (outcome.kind === "chat" && isTextAsk(reply)) return "pass_text_ask";
		return "missed_ask"; // attached/created/conversed instead of asking
	}
	if (outcome.kind === "ask") return "unnecessary_ask";
	if (expect.kind === "chat") return outcome.kind === "chat" ? "pass" : "wrong_route"; // dispatched while chatting
	if (expect.kind === "new") return outcome.kind === "new" ? "pass" : "wrong_route"; // attached to something
	// expect attach
	if (outcome.kind === "attach" && outcome.threadId === expect.threadId) return "pass";
	return "wrong_route";
}

// ---- main ----
const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id)).slice(0, LIMIT || undefined);
console.error(`routing eval: ${cases.length} cases, model ${MODEL_ID}, concurrency ${CONCURRENCY}`);

const results: Array<Case & { outcome: Outcome; verdict: string; reply: string; dispatches: number; ms: number }> = [];
let done = 0;
const queue = [...cases];
async function worker() {
	for (;;) {
		const c = queue.shift();
		if (!c) return;
		const t0 = Date.now();
		let r = await runCase(c);
		if (r.outcome.kind === "error" && !/timeout/.test(r.outcome.reason)) r = await runCase(c); // one retry on transient errors
		const verdict = score(c.expect, r.outcome, r.reply);
		results.push({ ...c, outcome: r.outcome, verdict, reply: r.reply, dispatches: r.dispatches, ms: Date.now() - t0 });
		done++;
		console.error(`[${done}/${cases.length}] #${c.id} expect=${JSON.stringify(c.expect)} got=${JSON.stringify(r.outcome)} -> ${verdict} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	}
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// summary
const n = results.length || 1;
const by = (v: string) => results.filter((r) => r.verdict === v);
const asks = results.filter((r) => r.expect.kind === "ask").length;
const nonAsks = results.length - asks;
const wrongRoute = by("wrong_route").length;
const missedAsk = by("missed_ask").length;
const unask = by("unnecessary_ask").length;
const errors = by("error").length;
console.log(`
路由评测结果（n=${results.length}, model=${MODEL_ID}）
  pass            ${by("pass").length + by("pass_text_ask").length}  (${((by("pass").length + by("pass_text_ask").length) / n * 100).toFixed(1)}%)  (其中文字反问 ${by("pass_text_ask").length})
  错路由          ${wrongRoute}  (${(wrongRoute / n * 100).toFixed(1)}%)  目标 <2%
  应反问未反问    ${missedAsk}  (${asks ? (missedAsk / asks * 100).toFixed(1) : "0"}% of ${asks} ask-cases)  目标 <3%
  不必要反问      ${unask}  (${nonAsks ? (unask / nonAsks * 100).toFixed(1) : "0"}% of ${nonAsks} non-ask)  目标 <15%
  错误/超时       ${errors}
`);
if (wrongRoute + missedAsk + unask + errors > 0) {
	console.log("失败明细:");
	for (const r of results.filter((x) => x.verdict !== "pass")) {
		console.log(`  #${r.id} [${r.verdict}] "${r.text}"  expect=${JSON.stringify(r.expect)} got=${JSON.stringify(r.outcome)}${r.note ? `  (${r.note})` : ""}`);
		if (r.reply) console.log(`      reply: ${r.reply.replace(/\n/g, " ").slice(0, 140)}`);
	}
}

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync("eval/results", { recursive: true });
writeFileSync(OUT, JSON.stringify({ model: MODEL_ID, at: new Date().toISOString(), summary: { n: results.length, pass: by("pass").length, passTextAsk: by("pass_text_ask").length, wrongRoute, missedAsk, unnecessaryAsk: unask, errors }, results }, null, 1));
console.error(`results -> ${OUT}`);
process.exit((by("pass").length + by("pass_text_ask").length) / n >= 0.9 ? 0 : 1);
