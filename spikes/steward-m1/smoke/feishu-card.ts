// Smoke: run the M1 core over a simulated event sequence and send the rendered
// reports to the owner's real Feishu (app credentials from ../feishu/.credentials.json).
// Usage: node smoke/feishu-card.mjs
import { openNodeSqlite } from "../src/node-db.ts";
import { Memory } from "../src/memory.ts";
import { applyEvents } from "../src/reducer.ts";
import { Outbound } from "../src/outbound.ts";
import { processIntents } from "../src/scheduler.ts";
import { readFileSync } from "node:fs";
import * as lark from "/Users/fanfei/code/shepherd/spikes/feishu/node_modules/@larksuiteoapi/node-sdk/lib/index.js";

const cred = JSON.parse(readFileSync("/Users/fanfei/code/shepherd/spikes/feishu/.credentials.json", "utf8"));
const client = new lark.Client({ appId: cred.client_id, appSecret: cred.client_secret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.fatal });

const notifyCard = (p: { conclusion: string; did: string[]; needsYou?: string }) => ({
	schema: "2.0",
	config: { update_multi: true },
	header: { title: { tag: "plain_text", content: "Shepherd 汇报" }, template: p.needsYou ? "orange" : "green" },
	body: { elements: [
		{ tag: "markdown", content: `**${p.conclusion}**` },
		...(p.did.length ? [{ tag: "markdown", content: p.did.map((d) => `- ${d}`).join("\n") }] : []),
		...(p.needsYou ? [{ tag: "markdown", content: `**需要你决定**：${p.needsYou}` }] : []),
		...(p.needsYou ? [
			{ tag: "button", text: { tag: "plain_text", content: "同意" }, type: "primary", behaviors: [{ type: "callback", value: { action: "approve" } }] },
			{ tag: "button", text: { tag: "plain_text", content: "先不要" }, type: "default", behaviors: [{ type: "callback", value: { action: "hold" } }] },
		] : []),
	] },
});

const feishu = {
	async send(out) {
		const r = await client.im.message.create({
			params: { receive_id_type: "open_id" },
			data: { receive_id: cred.user_info.open_id, msg_type: "interactive", content: JSON.stringify(notifyCard(out.payload)) },
		});
		if (r.code !== 0) throw new Error(`feishu ${r.code} ${r.msg}`);
		return { providerMsgId: r.data.message_id };
	},
};

// ---- scenario ----
const db = openNodeSqlite(":memory:");
const memory = new Memory(db);
const outbound = new Outbound(db);
memory.registerMachine("dev_mac_studio", "mac-studio");
memory.createThread("t_login", "登录 bug", "修复 token 过期后未刷新的问题", "om_demo_msg_1");
memory.registerWorker({ workerId: "w_login", threadId: "t_login", deviceId: "dev_mac_studio", repoId: "repo_web", branch: "shepherd/login-1" });

const t0 = Date.now();
console.log("1) worker started + progress…");
applyEvents(memory, [
	{ workerId: "w_login", seq: 1, ts: t0, type: "started", branch: "shepherd/login-1" },
	{ workerId: "w_login", seq: 2, ts: t0 + 1000, type: "progress", tool: "edit", target: "auth/session.ts", turn: 1 },
], t0);
console.log("   thread:", memory.situation().threads[0]);

console.log("2) worker reports done…");
applyEvents(memory, [
	{ workerId: "w_login", seq: 3, ts: t0 + 2000, type: "report", status: "done",
		summary: "登录 bug 已修复，测试通过",
		changes: ["auth/session.ts: token 过期后补发刷新请求", "auth/session.test.ts: 新增过期重试用例"],
		decisions: ["沿用现有 session 方案，避免引入新依赖"],
		tests: { ran: true, passed: true },
		git: { branch: "shepherd/login-1", ahead: 2, dirty: 0, pushed: false } },
	{ workerId: "w_login", seq: 4, ts: t0 + 2100, type: "settled", outcome: "reported" },
], t0 + 2100);
processIntents(memory, outbound, "feishu", t0 + 2200);
await outbound.flush(feishu, "feishu", t0 + 2200);
console.log("   -> done 汇报卡已发送；thread:", memory.situation().threads[0]);

console.log("3) 另一个 worker 需要决策，90 秒无人处理…");
memory.registerWorker({ workerId: "w_pay", threadId: "t_login", deviceId: "dev_mac_studio", repoId: "repo_web" });
applyEvents(memory, [
	{ workerId: "w_pay", seq: 1, ts: t0 + 3000, type: "started" },
	{ workerId: "w_pay", seq: 2, ts: t0 + 4000, type: "report", status: "needs_decision",
		summary: "支付回调需要选择验签方式", question: " webhook 用 HMAC 还是证书验签？" },
], t0 + 4000);
console.log("   thread:", memory.situation().threads[0], "| open question:", !!memory.openQuestion("t_login"));
processIntents(memory, outbound, "feishu", t0 + 5000); // inside the window: nothing goes out
const before = JSON.stringify(outbound.stats());
processIntents(memory, outbound, "feishu", t0 + 100_000); // window expired: deterministic fallback
await outbound.flush(feishu, "feishu", t0 + 100_000);
console.log("   outbound before/after window:", before, "->", JSON.stringify(outbound.stats()));
console.log("   -> 决策兜底卡已发送（LLM 不在场也不会丢）");
console.log("final thread states:", memory.situation().threads);
