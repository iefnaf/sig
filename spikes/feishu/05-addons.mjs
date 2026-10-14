// Spike: update flow. Scan again to add scopes to the EXISTING app through `addons`, and see whether the platform honors them.
// Usage: node 05-addons.mjs <scope> [<scope> ...]
import * as lark from "@larksuiteoapi/node-sdk";
import QRCode from "qrcode";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";

const scopes = process.argv.slice(2);
const cred = JSON.parse(readFileSync(new URL("./.credentials.json", import.meta.url), "utf8"));
const OUT = "/tmp/feishu-spike";
mkdirSync(OUT, { recursive: true });

const result = await lark.registerApp({
	source: "shepherd-spike",
	appId: cred.client_id,
	addons: { scopes: { tenant: scopes } },
	onQRCodeReady: async ({ url, expireIn }) => {
		writeFileSync(`${OUT}/qr-url.txt`, url + "\n");
		await QRCode.toFile(`${OUT}/qr.png`, url, { width: 480, margin: 2 });
		console.log(`QR_READY expiresIn=${expireIn}s\nURL: ${url}`);
		console.log(await QRCode.toString(url, { type: "utf8", margin: 2, errorCorrectionLevel: "L" }));
		execFile("open", [`${OUT}/qr.png`], () => {});
	},
	onStatusChange: (s) => { if (s.status !== "polling") console.log("STATUS", JSON.stringify(s)); },
});
console.log("DONE", JSON.stringify({ client_id: result.client_id, same_app: result.client_id === cred.client_id, secret_changed: result.client_secret !== cred.client_secret }));
if (result.client_id === cred.client_id && result.client_secret !== cred.client_secret) {
	writeFileSync(new URL("./.credentials.json", import.meta.url), JSON.stringify({ ...cred, client_secret: result.client_secret }, null, 2));
	console.log("credentials file updated with the rotated secret");
}
