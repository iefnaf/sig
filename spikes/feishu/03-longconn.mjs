// Spike: long connection + send/reply/card/patch/button callback with the official SDK.
// Usage: node 03-longconn.mjs   (stops by itself after 12 minutes)
import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const cred = JSON.parse(readFileSync(new URL("./.credentials.json", import.meta.url), "utf8"));
const OWNER = cred.user_info.open_id;
const LOG = "/tmp/feishu-spike/events.log";
writeFileSync(LOG, "");
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 23)} ${a.join(" ")}`; console.log(line); appendFileSync(LOG, line + "\n"); };

const base = { appId: cred.client_id, appSecret: cred.client_secret, domain: lark.Domain.Feishu };
const client = new lark.Client({ ...base, loggerLevel: lark.LoggerLevel.warn });

const card = (state) => ({
	schema: "2.0",
	config: { update_multi: true },
	header: { title: { tag: "plain_text", content: "Spike 汇报" }, template: state === "done" ? "green" : "blue" },
	body: {
		elements: [
			{ tag: "markdown", content: state === "done" ? "**结论**：已处理，按钮已点击。" : "**结论**：登录 bug 已修复，测试通过。\n- 改了 2 个文件，新增 1 个测试\n- 分支 `shepherd/login-1`，尚未推送\n\n**需要你决定**：是否推送并开 PR？" },
			...(state === "done" ? [] : [
				{ tag: "button", text: { tag: "plain_text", content: "推送并开 PR" }, type: "primary", behaviors: [{ type: "callback", value: { action: "approve", threadId: "t_demo" } }] },
				{ tag: "button", text: { tag: "plain_text", content: "先不推送" }, type: "default", behaviors: [{ type: "callback", value: { action: "hold", threadId: "t_demo" } }] },
			]),
		],
	},
});

let cardMsgId = null;
const dispatcher = new lark.EventDispatcher({}).register({
	"im.message.receive_v1": async (data) => {
		const m = data.message;
		const recvAt = Date.now();
		log("EVENT im.message.receive_v1", JSON.stringify({
			event_id: data.event_id ?? data.header?.event_id, chat_type: m.chat_type, message_type: m.message_type, message_id: m.message_id,
			parent_id: m.parent_id ?? null, root_id: m.root_id ?? null, thread_id: m.thread_id ?? null,
			from_owner: data.sender?.sender_id?.open_id === OWNER, content: m.content, create_time: m.create_time,
			latency_ms: recvAt - Number(m.create_time),
		}));
		if (m.parent_id && cardMsgId) log("QUOTE-ROUTE parent_id equals our card message_id:", m.parent_id === cardMsgId);
		// reply with text (idempotent uuid), then send a card
		const t0 = Date.now();
		const r = await client.im.message.reply({ path: { message_id: m.message_id }, data: { msg_type: "text", content: JSON.stringify({ text: `收到：${m.message_type === "text" ? JSON.parse(m.content).text : m.message_type}` }), uuid: randomUUID() } });
		log("REPLY code", r.code, "message_id", r.data?.message_id, "took_ms", Date.now() - t0);
		if (!cardMsgId) {
			const c = await client.im.message.create({ params: { receive_id_type: "open_id" }, data: { receive_id: OWNER, msg_type: "interactive", content: JSON.stringify(card("open")), uuid: randomUUID() } });
			cardMsgId = c.data?.message_id;
			log("CARD sent code", c.code, c.msg ?? "", "message_id", cardMsgId);
		}
	},
	"card.action.trigger": async (data) => {
		log("CALLBACK card.action.trigger", JSON.stringify({ action: data.action?.value, open_message_id: data.context?.open_message_id, operator: data.operator?.open_id === OWNER ? "owner" : "other" }));
		setTimeout(async () => {
			const p = await client.im.message.patch({ path: { message_id: data.context.open_message_id }, data: { content: JSON.stringify(card("done")) } }).catch((e) => e.response?.data ?? { error: e.message });
			log("PATCH result", JSON.stringify({ code: p.code, msg: p.msg, error: p.error }));
		}, 500);
		return { toast: { type: "info", content: "收到：" + (data.action?.value?.action ?? "?") } };
	},
});

const ws = new lark.WSClient({ ...base, loggerLevel: lark.LoggerLevel.info });
ws.start({ eventDispatcher: dispatcher });
log("WS client started; waiting for events (12 min)");
setTimeout(() => { log("timeout, exiting"); process.exit(0); }, 12 * 60 * 1000);
