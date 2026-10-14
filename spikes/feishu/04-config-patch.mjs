// Spike: can the app's event subscription be switched to webhook through the config OpenAPI?
// Usage: node 04-config-patch.mjs <webhook|websocket> [request_url]
import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";

const [mode = "webhook", url = "https://example.com/feishu-spike"] = process.argv.slice(2);
const cred = JSON.parse(readFileSync(new URL("./.credentials.json", import.meta.url), "utf8"));
const client = new lark.Client({ appId: cred.client_id, appSecret: cred.client_secret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.fatal });

const data = mode === "webhook"
	? { event: { subscription_type: "webhook", request_url: url }, callback: { callback_type: "webhook", request_url: url } }
	: { event: { subscription_type: "websocket" }, callback: { callback_type: "websocket" } };
console.log("PATCH config", JSON.stringify(data));
const res = await client.request({ method: "PATCH", url: `/open-apis/application/v7/applications/${cred.client_id}/config`, data }).catch((e) => ({ httpError: e.response?.status, body: e.response?.data ?? e.message }));
// Never dump axios errors: they carry the Authorization header.
console.log("RESULT", JSON.stringify(res.httpError ? { httpError: res.httpError, code: res.body?.code, msg: String(res.body?.msg ?? res.body).slice(0, 300) } : res).slice(0, 1200));

const info = await client.application.application.get({ path: { app_id: cred.client_id }, params: { lang: "zh_cn" } });
console.log("now: event =", JSON.stringify(info.data.app.event ?? null), "| callback_info =", JSON.stringify(info.data.app.callback_info));
