// Routines (spec §8.3): schedule parsing and the deterministic digest. No LLM, no clock
// dependency beyond the `from` argument passed in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openNodeSqlite } from "../src/node-db.ts";
import { Memory } from "../src/memory.ts";
import { applyEvents } from "../src/reducer.ts";
import { nextDue, renderDigest } from "../src/routines.ts";

test("nextDue: every@ seconds offset from `from`", () => {
	assert.equal(nextDue("every@60", 1_000_000), 1_060_000);
});

test("nextDue: daily@ rolls forward past the same minute and into the next day", () => {
	const at = (h: number, m: number) => Date.UTC(2026, 9, 15, h, m, 0, 0);
	// 09:00 local times are UTC here by definition of the parser; 09:00 sharp is future
	assert.equal(nextDue("daily@09:00", at(8, 59)), at(9, 0));
	assert.equal(nextDue("daily@09:00", at(9, 0)), at(9, 0) + 86_400_000);
	assert.equal(nextDue("daily@09:00", at(23, 30)), at(9, 0) + 86_400_000);
});

test("nextDue: rejects garbage", () => {
	assert.throws(() => nextDue("hourly@9"));
	assert.throws(() => nextDue("every@"));
});

test("renderDigest: null when nothing to say, content when there is", () => {
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	assert.equal(renderDigest(memory), null);

	memory.registerMachine("dev_1", "mac");
	memory.createThread("t_1", "登录 bug", "修 token", "msg_1");
	memory.registerWorker({ workerId: "w_1", threadId: "t_1", deviceId: "dev_1", repoId: "repo_x" });
	memory.setWorkerState("w_1", "running", undefined, 1);
	memory.setProgress("w_1", "edit src/a.ts", 2);
	memory.createQuestion("q_1", "t_1", "w_1", "要不要推送？", "test");

	const p = renderDigest(memory)!;
	assert.match(p.conclusion, /1 个进行中/);
	assert.match(p.conclusion, /1 件待决定/);
	assert.ok(p.did.some((d) => d.includes("登录 bug")));
	assert.ok(p.did.some((d) => d.includes("推送")));
	assert.equal(p.urgency, "push"); // open question makes it push
	assert.equal(p.tone, "attention");
});

test("reducer: error:stall opens a question and notifies (broken template)", () => {
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	memory.registerMachine("dev_1", "mac");
	memory.createThread("t_1", "挂死任务", "干活", "msg_1");
	memory.registerWorker({ workerId: "w_9", threadId: "t_1", deviceId: "dev_1", repoId: "repo_x" });
	applyEvents(memory, [{ workerId: "w_9", seq: 1, ts: 1, type: "started" }]);
	const r = applyEvents(memory, [{ workerId: "w_9", seq: 2, ts: 2, type: "settled", outcome: "error", errorClass: "stall", lastText: "stall watchdog" }]);
	assert.ok(r.intents.some((i) => i.type === "notify" && (i as any).template === "broken"), "broken card on double stall");
	assert.ok(r.intents.some((i) => i.type === "wake"));
	assert.ok(memory.question(`q_w_9_2_stall`));
});

test("reducer: unreported settles notify immediately (event runs are quiet)", () => {
	const db = openNodeSqlite(":memory:");
	const memory = new Memory(db);
	memory.registerMachine("dev_1", "mac");
	memory.createThread("t_1", "未汇报任务", "干活", "msg_1");
	memory.registerWorker({ workerId: "w_u", threadId: "t_1", deviceId: "dev_1", repoId: "repo_x" });
	applyEvents(memory, [{ workerId: "w_u", seq: 1, ts: 1, type: "started" }]);
	const r = applyEvents(memory, [{ workerId: "w_u", seq: 2, ts: 2, type: "settled", outcome: "unreported", lastText: "我觉得做完了" }]);
	const n = r.intents.find((i) => i.type === "notify") as any;
	assert.ok(n, "unreported produces a notify");
	assert.equal(n.template, "decision_fallback");
	assert.match(String(n.payload?.question), /我觉得做完了/);
});
