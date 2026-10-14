# Feishu channel spike

Throwaway scripts that drove the scan-to-create / long-connection / webhook experiments on 2026-10-14. Results: [docs/research/feishu-channel.md](../../docs/research/feishu-channel.md) section 8. Not production code.

- `01-register.mjs`: scan-to-create a PersonalAgent app (device flow). Writes `.credentials.json` (gitignored, 0600).
- `02-probe.mjs`: default config of the created app (scopes, events, callback, versions).
- `03-longconn.mjs`: long-connection client; logs events, replies, sends a card, patches it, handles button callbacks.
- `04-config-patch.mjs <webhook|websocket> [url]`: switch the event/callback subscription mode via the v7 config API.
- `05-addons.mjs <scope>...`: scan-based scope top-up for the existing app (addons update flow).

Requires `@larksuiteoapi/node-sdk` and `qrcode` (`npm install --ignore-scripts`). `.credentials-app1.json` is the first test app; `.credentials.json` is whichever app the last register/update flow touched.
