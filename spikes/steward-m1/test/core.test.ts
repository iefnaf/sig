import assert from "node:assert/strict";
import { test } from "node:test";
import { openNodeSqlite } from "../src/node-db.ts";
import { Memory } from "../src/memory.ts";
import { applyEvents } from "../src/reducer.ts";
import { Outbound, NoopAdapter } from "../src/outbound.ts";
import { processIntents, runDecisionWindows } from "../src/scheduler.ts";

function fresh() {
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	const outbound = new Outbound(db);
	return { db, memory, outbound };
}

function setupThread(memory: Memory) {
	memory.registerMachine("dev_1", "mac-studio");
	memory.createThread("t_1", "登录 bug", "修复 token 过期未刷新的问题", "msg_1");
	memory.registerWorker({ workerId: "w_1", threadId: "t_1", deviceId: "dev_1", repoId: "repo_x", branch: "shepherd/login-1" });
}

const ev = (seq: number, e: Partial<Parameters<typeof applyEvents>[1][number]> & { type: string; workerId?: string }) =>
	({ workerId: "w_1", seq, ts: seq * 1000, ...e }) as never;

test("lifecycle: started -> running, report done -> idle + done notify + wake", () => {
	const { memory, outbound } = fresh();
	setupThread(memory);
	let r = applyEvents(memory, [ev(1, { type: "started", branch: "shepherd/login-1" })]);
	assert.equal(memory.worker("w_1")!.state, "running");
	assert.deepEqual(r.intents, []);

	r = applyEvents(memory, [ev(2, { type: "progress", tool: "edit", target: "auth/session.ts" })]);
	assert.equal(memory.worker("w_1")!.lastProgress, "edit auth/session.ts");
	assert.equal(r.intents.length, 0);

	r = applyEvents(memory, [ev(3, {
		type: "report", status: "done", summary: "登录 bug 已修复",
		changes: ["auth/session.ts: token 刷新逻辑", "auth/session.test.ts: 新增用例"],
		tests: { ran: true, passed: true }, git: { branch: "shepherd/login-1", ahead: 2, pushed: false },
	}), ev(4, { type: "settled", outcome: "reported" })]);
	assert.equal(memory.worker("w_1")!.state, "idle");
	assert.equal(memory.worker("w_1")!.lastOutcome, "settled:reported");
	assert.ok(r.intents.some((i) => i.type === "notify" && i.template === "done_report"));
	assert.ok(r.intents.some((i) => i.type === "wake"));

	const s = processIntents(memory, outbound, "feishu");
	assert.equal(s.notified, 1);
	const sent = new NoopAdapter().sent; // placeholder to satisfy type; real check below
	const adapter = new NoopAdapter();
	outbound.flush(adapter, "feishu");
	assert.equal(adapter.sent.length, 1);
	const p = adapter.sent[0].payload;
	assert.equal(p.conclusion, "登录 bug 已修复");
	assert.ok(p.did.some((d) => d.includes("auth/session.ts")));
	assert.ok(p.did.some((d) => d.includes("未推送")));
	assert.equal(p.needsYou, "是否推送并开 PR？");
	assert.equal(p.urgency, "push");
	// thread went back to idle and is marked unread
	const t = memory.situation().threads.find((x) => x.threadId === "t_1")!;
	assert.equal(t.state, "idle");
	assert.equal(t.unread, 1);
	memory.markThreadRead("t_1");
	assert.equal(memory.situation().threads.find((x) => x.threadId === "t_1")!.unread, 0);
});

test("dedup: retransmitted batch applies once", () => {
	const { memory } = fresh();
	setupThread(memory);
	const batch = [ev(1, { type: "started" })];
	const a = applyEvents(memory, batch);
	const b = applyEvents(memory, batch);
	assert.deepEqual([a.applied, a.duplicated], [1, 0]);
	assert.deepEqual([b.applied, b.duplicated], [0, 1]);
});

test("needs_decision: question + waiting_you + 90s window fallback", () => {
	const { memory, outbound } = fresh();
	setupThread(memory);
	const t0 = 1_000_000;
	applyEvents(memory, [ev(1, { type: "started" })], t0);
	applyEvents(memory, [ev(2, { type: "report", status: "needs_decision", summary: "需要选择方案", question: "用 JWT 还是 session？" })], t0);

	assert.equal(memory.situation().threads.find((x) => x.threadId === "t_1")!.state, "waiting_you");
	assert.ok(memory.openQuestion("t_1"));

	// inside the window: nothing goes out
	let s = processIntents(memory, outbound, "feishu", t0 + 10_000);
	assert.equal(s.notified, 0);

	// question answered inside the window: fallback is cancelled
	memory.answerQuestion("q_w_1_2", t0 + 20_000);
	s = processIntents(memory, outbound, "feishu", t0 + 100_000);
	assert.equal(s.notified, 0);
	assert.equal(memory.situation().threads.find((x) => x.threadId === "t_1")!.state, "idle");
});

test("needs_decision: window expires unhandled -> deterministic fallback push", () => {
	const { memory, outbound } = fresh();
	setupThread(memory);
	const t0 = 1_000_000;
	applyEvents(memory, [ev(2, { type: "report", status: "blocked", summary: "被阻塞", question: "缺少数据库密码" })], t0);
	let s = processIntents(memory, outbound, "feishu", t0 + 5_000);
	assert.equal(s.notified, 0);
	s = processIntents(memory, outbound, "feishu", t0 + 95_000);
	assert.equal(s.notified, 1);
	const adapter = new NoopAdapter();
	outbound.flush(adapter, "feishu", t0 + 95_000);
	assert.match(adapter.sent[0].payload.did[0], /数据库密码/);
	assert.equal(adapter.sent[0].payload.urgency, "push");
});

test("errors: auth pushes immediately and opens a question; transient stays silent", () => {
	const { memory, outbound } = fresh();
	setupThread(memory);
	applyEvents(memory, [ev(1, { type: "started" })]);
	applyEvents(memory, [ev(2, { type: "settled", outcome: "error", errorClass: "auth" })]);
	let s = processIntents(memory, outbound, "feishu");
	assert.equal(s.notified, 1); // immediate, no window
	assert.ok(memory.openQuestion("t_1"));

	// transient: connector auto-resumes, nothing reaches the user
	applyEvents(memory, [ev(3, { type: "settled", outcome: "error", errorClass: "transient" })]);
	applyEvents(memory, [ev(4, { type: "lost" }), ev(5, { type: "resumed", attempt: 1 })]);
	s = processIntents(memory, outbound, "feishu");
	assert.equal(s.notified, 0);
	assert.equal(memory.worker("w_1")!.state, "running");
});

test("unreported: question with the worker's last words", () => {
	const { memory } = fresh();
	setupThread(memory);
	applyEvents(memory, [ev(1, { type: "settled", outcome: "unreported", lastText: "我觉得还差一个测试没写" })]);
	const q = memory.openQuestion("t_1");
	assert.ok(q);
	const row = memory.question(q.qid)!;
	assert.match(row.text, /还差一个测试/);
});

test("broken: push + question; thread becomes waiting_you", () => {
	const { memory, outbound } = fresh();
	setupThread(memory);
	applyEvents(memory, [ev(1, { type: "broken", reason: "会话文件损坏" })]);
	const s = processIntents(memory, outbound, "feishu");
	assert.equal(s.notified, 1);
	assert.equal(memory.situation().threads.find((x) => x.threadId === "t_1")!.state, "waiting_you");
});

test("outbound: retry with backoff, then give up; quiet merge", async () => {
	const { db, memory, outbound } = fresh();
	setupThread(memory);
	// failing adapter
	let calls = 0;
	const failing = {
		async send() {
			calls++;
			throw new Error("feishu down");
		},
	};
	outbound.enqueue("o1", "feishu", "done_report", { conclusion: "a", did: ["d1"], urgency: "push" }, "t_1", 0);
	await outbound.flush(failing, "feishu", 0);
	await outbound.flush(failing, "feishu", 10_000);
	await outbound.flush(failing, "feishu", 60_000);
	await outbound.flush(failing, "feishu", 300_000);
	const row = db.get<{ status: string; attempts: number }>(`SELECT status, attempts FROM sh_outbound WHERE id = 'o1'`)!;
	assert.equal(row.status, "failed");
	assert.equal(row.attempts, 4);
	assert.equal(calls, 4);

	// quiet merge
	outbound.enqueue("q1", "feishu", "done_report", { conclusion: "第一件完成", did: ["a"], urgency: "quiet" }, "t_1", 1_000);
	outbound.enqueue("q2", "feishu", "done_report", { conclusion: "第二件完成", did: ["b"], urgency: "quiet" }, "t_1", 5_000);
	assert.equal(outbound.mergeQuiet(60_000), 1);
	const adapter = new NoopAdapter();
	await outbound.flush(adapter, "feishu", 10_000);
	assert.equal(adapter.sent.length, 1);
	assert.match(adapter.sent[0].payload.conclusion, /第一件完成；第二件完成/);
});

test("timeline records the story for L2", () => {
	const { memory } = fresh();
	setupThread(memory);
	applyEvents(memory, [
		ev(1, { type: "started" }),
		ev(2, { type: "report", status: "done", summary: "完成" }),
		ev(3, { type: "settled", outcome: "reported" }),
	]);
	const rows = memory.db.all<{ kind: string }>(`SELECT kind FROM sh_timeline WHERE threadId = 't_1' ORDER BY id`).map((r) => r.kind);
	assert.deepEqual(rows, ["thread_created", "worker_started", "report", "settled"]);
});
