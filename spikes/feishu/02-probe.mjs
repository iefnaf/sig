// Spike: what did the scan-created PersonalAgent app get by default? Usage: node 02-probe.mjs
import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";

const cred = JSON.parse(readFileSync(new URL("./.credentials.json", import.meta.url), "utf8"));
const client = new lark.Client({ appId: cred.client_id, appSecret: cred.client_secret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.fatal });

const info = await client.application.application.get({ path: { app_id: cred.client_id }, params: { lang: "zh_cn" } });
const app = info.data.app;
console.log("create_source:", app.create_source, "| online_version_id:", app.online_version_id, "| abilities:", app.mobile_default_ability, app.pc_default_ability);
console.log("event:", JSON.stringify(app.event ?? null));
console.log("callback_info:", JSON.stringify(app.callback_info ?? null));
console.log("encryption:", JSON.stringify(Object.keys(app.encryption ?? {})));
console.log("security:", JSON.stringify(app.security ?? null));
console.log("scopes in app info:", app.scopes.length);
for (const s of app.scopes) console.log("  ", s.scope, s.token_types.join(","), "-", s.description);

const granted = await client.application.scope.list({});
const g = granted.data.scopes;
console.log("\ngranted scopes:", g.length, "| not granted:", g.filter((s) => s.grant_status !== 1).map((s) => s.scope_name));

const vers = await client.application.applicationAppVersion.list({ path: { app_id: cred.client_id }, params: { page_size: 5, lang: "zh_cn" } }).catch((e) => ({ error: e.response?.data ?? e.message }));
console.log("\nversions:", JSON.stringify(vers.data?.items?.map((v) => ({ version: v.version, status: v.status, events: v.events?.length, ability: v.ability })) ?? vers.error));
const v0 = vers.data?.items?.[0];
if (v0) console.log("latest version event/callback:", JSON.stringify({ events: v0.events, event_info: v0.event_info, callback_info: v0.callback_info }));
