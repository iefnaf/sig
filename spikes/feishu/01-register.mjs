// Spike: scan-to-create a Feishu PersonalAgent app with the official registerApp device flow.
// Writes credentials to .credentials.json (gitignored, mode 0600). Usage: node 01-register.mjs
import * as lark from "@larksuiteoapi/node-sdk";
import QRCode from "qrcode";
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";

const OUT = "/tmp/feishu-spike";
mkdirSync(OUT, { recursive: true });

const result = await lark.registerApp({
	source: "shepherd-spike",
	createOnly: true,
	appPreset: { name: "Shepherd Spike ({user})", desc: "Throwaway test app for the Shepherd project. Safe to delete." },
	onQRCodeReady: async ({ url, expireIn }) => {
		writeFileSync(`${OUT}/qr-url.txt`, url + "\n");
		await QRCode.toFile(`${OUT}/qr.png`, url, { width: 480, margin: 2 });
		console.log(`QR_READY expiresIn=${expireIn}s`);
		console.log(`URL: ${url}`);
		execFile("open", [`${OUT}/qr.png`], () => {});
	},
	onStatusChange: (s) => console.log("STATUS", JSON.stringify(s)),
});

writeFileSync(new URL("./.credentials.json", import.meta.url), JSON.stringify(result, null, 2));
chmodSync(new URL("./.credentials.json", import.meta.url), 0o600);
console.log("REGISTERED", JSON.stringify({ client_id: result.client_id, tenant_brand: result.user_info?.tenant_brand, has_open_id: !!result.user_info?.open_id }));
