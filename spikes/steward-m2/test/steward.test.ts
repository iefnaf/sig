// M2 tests: run the steward loop in-process on pi-durable with a scripted faux model.
// The scripts below deliberately exercise the policy hook (inferred dispatch refused).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, AssistantEntry } from "@earendil-works/pi-durable";
import { openNodeSqlite } from "../../steward-m1/src/node-db.ts";
import { Memory } from "../../steward-m1/src/memory.ts";
import { buildStewardExtension, type StewardContext } from "../src/steward.ts";

function setup(route: FauxResponseStep) {
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	const dispatches: Array<{ threadId: string; prompt: string; basis: string; provenance?: string }> = [];
	const asks: Array<{ question: string; options?: string[] }> = [];
	let userInitiated = true;
	let provenance: string | undefined = "om_test";
	const ctx: StewardContext = {
		memory,
		dispatch: async (input) => {
			const workerId = `w_${Math.random().toString(36).slice(2, 8)}`;
			memory.registerWorker({ workerId, threadId: input.threadId, deviceId: "dev_test" });
			dispatches.push({ ...input });
			return { ok: true, workerId };
		},
		askUser: async (a) => asks.push(a),
		runIsUserInitiated: () => userInitiated,
		currentProvenance: () => provenance,
	};
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 200 }, () => route));
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = createRegistry();
	registry.install(buildStewardExtension(ctx));
	return { memory, dispatches, asks, ctx, faux, models, registry, setInitiated: (v: boolean) => (userInitiated = v) };
}

async function run(steward: ReturnType<typeof setup>, text: string) {
	const harness = await Harness.open(new MemoryStorage(), { models: steward.models, registry: steward.registry }, BACKGROUND_CONTEXT);
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const settled = await (await root.submit({ type: "input", content: text, requestId: `t_${Math.random()}` }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
	assert.equal(settled.status, "done", `run failed: ${JSON.stringify(settled)}`);
	const answer = settled.type === "input" ? await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT) : undefined;
	const textOf = (m: unknown) =>
		((m as { content?: Array<{ type: string; text?: string }> })?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
	await harness.close(BACKGROUND_CONTEXT);
	return { settled, reply: textOf(answer?.model?.[0]) };
}

const lastUserText = (req: Parameters<FauxResponseStep>[0]) => {
	const m = [...req.messages].reverse().find((x) => x.role === "user");
	const c = typeof m?.content === "string" ? [{ type: "text", text: m.content }] : (m?.content ?? []);
	return c.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
};
const lastToolResult = (req: Parameters<FauxResponseStep>[0]) => {
	const m = [...req.messages].reverse().find((x) => x.role === "toolResult");
	const c = typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => (p as { text?: string }).text ?? "").join("");
	return String(c);
};

test("new task: find -> create -> dispatch, reply captured", async () => {
	const s = setup((req) => {
		if (lastToolResult(req).startsWith("[]")) {
			return fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "修复登录页 token 过期", newTitle: "登录 bug", basis: "user_explicit" })], { stopReason: "toolUse" });
		}
		if (lastToolResult(req).startsWith("dispatched")) return fauxAssistantMessage([fauxText("已创建「登录 bug」并派发，完成后我会汇报。")]);
		return fauxAssistantMessage([fauxToolCall("find_threads", { query: lastUserText(req) })], { stopReason: "toolUse" });
	});
	const { reply } = await run(s, "帮我修一下登录页的 bug");
	assert.equal(s.dispatches.length, 1);
	assert.equal(s.dispatches[0].prompt, "修复登录页 token 过期");
	assert.equal(s.dispatches[0].basis, "user_explicit");
	assert.match(reply, /已创建.*派发/);
	assert.equal(s.asks.length, 0);
});

test("ambiguity: inferred dispatch blocked by the policy hook, model falls back to ask_user", async () => {
	const s = setup((req) => {
		const tr = lastToolResult(req);
		if (tr.startsWith("[")) {
			// two candidates returned; model tries an inferred dispatch first (must be blocked)
			return fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "改登录", threadId: "t_a", basis: "inferred" })], { stopReason: "toolUse" });
		}
		if (tr.includes("Autonomy rule")) {
			return fauxAssistantMessage([fauxToolCall("ask_user", { question: "你指的是哪件事？", options: ["A 登录 bug", "B 登录页样式"] })], { stopReason: "toolUse" });
		}
		if (tr === "asked") return fauxAssistantMessage([fauxText("已询问用户。")]);
		return fauxAssistantMessage([fauxToolCall("find_threads", { query: "登录" })], { stopReason: "toolUse" });
	});
	// two similar threads exist
	s.memory.createThread("t_a", "登录 bug", "修 token");
	s.memory.createThread("t_b", "登录页样式", "调样式");
	await run(s, "把登录那个再改改");
	assert.equal(s.dispatches.length, 0, "inferred dispatch must not go through");
	assert.equal(s.asks.length, 1);
	assert.match(s.asks[0].question, /哪件事/);
});

test("attach: routes an existing thread and updates it", async () => {
	const s = setup((req) => {
		const tr = lastToolResult(req);
		if (tr.startsWith("[") && tr.includes("t_a")) {
			return fauxAssistantMessage([fauxToolCall("start_worker", { prompt: "补一个单测", threadId: "t_a", basis: "user_explicit" })], { stopReason: "toolUse" });
		}
		if (tr.startsWith("dispatched")) {
			return fauxAssistantMessage([fauxToolCall("update_thread", { threadId: "t_a", summary: "登录 bug 修复中，追加单测" })], { stopReason: "toolUse" });
		}
		if (tr === "updated") return fauxAssistantMessage([fauxText("已把「补单测」接到了之前的登录 bug 上。")]);
		return fauxAssistantMessage([fauxToolCall("find_threads", { query: lastUserText(req) })], { stopReason: "toolUse" });
	});
	s.memory.createThread("t_a", "登录 bug", "修 token 过期");
	const { reply } = await run(s, "昨天那个登录 bug 补个单测");
	assert.equal(s.dispatches.length, 1);
	assert.equal(s.dispatches[0].threadId, "t_a");
	assert.match(reply, /接到了之前/);
	const t = s.memory.db.get<{ summary: string }>(`SELECT summary FROM sh_thread WHERE threadId = 't_a'`);
	assert.match(t!.summary, /追加单测/);
});

test("event wake: no_action ends the run quietly", async () => {
	const s = setup((req) => {
		const tr = lastToolResult(req);
		if (tr === "ok") return fauxAssistantMessage([fauxText("（记账完成）")]);
		return fauxAssistantMessage([fauxToolCall("no_action", { reason: "progress only" })], { stopReason: "toolUse" });
	});
	s.setInitiated(false);
	const { reply } = await run(s, "⟦event⟧ thread=t_a progress only");
	assert.equal(s.dispatches.length, 0);
	assert.equal(s.asks.length, 0);
	// terminate ends the run at the tool round: no final text is produced at all.
	assert.equal(reply, "");
});
