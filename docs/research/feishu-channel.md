# Feishu Channel Research

Date: 2026-10-14. Purpose: determine whether "create a Feishu bot by scanning a QR code after deployment" holds up, and how the steward's Feishu adapter should be wired in.

**Same-day live testing**: every key question has since been verified on a real machine (two QR-code creations, long-lived connection send/receive, webhook switchover, custom-domain reachability); see the "Live Test Results" section at the end.

## Evidence Sources and Credibility

The Feishu Open Platform doc sites (`open.feishu.cn`, `open.larkoffice.com`) cannot be scraped from this environment, so the conclusions below come mainly from **the official SDK's source code** and the docs of third-party integration projects:

| Source | Version | Credibility |
|---|---|---|
| `larksuite/node-sdk` (official): `scene/registration/*`, `ws-client/*`, `code-gen/projects/application.ts`, `code-gen/projects/im.ts` | commit `e34a66f0` (2026-10-12), package version 1.75.0 | High. It is the actual implementation of the protocol; the comments in `im.ts` and `application.ts` are excerpts of the official docs |
| `docs/channels/feishu*` from `openclaw/openclaw` (third-party integration, used in production) | commit `89f8764f` (2026-10-14) | Medium-high. Pitfalls someone else has already hit, but not official |
| `SmokingMouse/trellis` PR #72 (another third-party integration) | | Medium. Corroborates the QR-code creation flow |
| Search result snippets | | Low; leads only |

No live verification yet. QR-code creation requires the user to scan with the Feishu app; it involves creating an app under the user's Feishu account and needs the user's cooperation (see the last section).

## 1. QR-code one-click creation: it really exists, and it is an official capability

The SDK's `registerApp` (`scene/registration/index.ts`) is built on the OAuth 2.0 device authorization flow (RFC 8628) and needs only two HTTP calls — **no Node runtime required, a Worker can do it with `fetch`**:

```
POST https://accounts.feishu.cn/oauth/v1/app/registration      (Lark international: accounts.larksuite.com)
Content-Type: application/x-www-form-urlencoded

1) action=begin & archetype=PersonalAgent & auth_method=client_secret & request_user_info=open_id
   → { device_code, verification_uri_complete, user_code, interval, expires_in }

2) Poll every interval seconds: action=poll & device_code=...
   → pending: { error: "authorization_pending" }     too fast: { error: "slow_down" } (interval + 5s)
   → success: { client_id, client_secret, user_info: { open_id, tenant_brand } }
   → failure: access_denied / expired_token
```

Key points:

- `archetype: "PersonalAgent"`: an app type designed for **personal agents**, which matches our scenario.
- The returned `user_info.open_id` is the open_id of **the person who scanned**, usable directly as the owner binding (OpenClaw's scan flow relies on exactly this to lock direct chats to that person). `tenant_brand` is `feishu` or `lark`; if it is `lark`, polling must switch to `accounts.larksuite.com`.
- The QR link is valid for 10 minutes and is single-use. `expires_in` defaults to 600 seconds.
- The link can carry prefilled fields: `name` (supports the `{user}` placeholder), `desc`, avatar (1–6 publicly accessible image URLs); `createOnly=true` hides the 「选择已有应用」 ("select an existing app") entry so the flow cannot bind to an existing app; `clientID` is for updating an existing app's config.
- The **permissions, events, and callbacks** preset on the scan confirmation page are passed via the `addons` parameter (only 5 public fields can be carried: `preset`, `scopes.tenant/user`, `events.items.tenant/user`, `callbacks.items`). The semantics are **add-only** — names not present in the platform catalog are silently dropped. The whole `addons` mechanism also depends on a platform gradual-rollout switch: **when it is off, the entire parameter is ignored and the default flow runs**.
- The SDK comments state explicitly: **sensitive config** such as `events.subscription_type`, `request_url`, `security.*`, and encryption keys **cannot be carried in the URL**; it must go through the "update app config" OpenAPI — `encodeAddons` will reject it.

Known pitfall (OpenClaw docs): the China-market Feishu mobile app sometimes does not react to the QR code; the recommended fallback is the manual path (create a custom app in the developer console and fill in the App ID and App Secret by hand).

**Conclusion: "show a QR code once deployment finishes, scan it to create the bot" holds, and the implementation cost is very low.** Manually entering credentials should be kept as the fallback path.

## 2. Event reception: the long-lived connection is the default, webhook is optional

| Mode | Requirements | Notes |
|---|---|---|
| **Long-lived connection (WebSocket)** | The app dials out to Feishu; **no public address needed** | QR-code-created apps use this by default (OpenClaw: WebSocket is the default transport; trellis: after creation, "wait for the long-lived connection to come up") |
| webhook | Requires a public HTTPS address for Feishu to POST events to | OpenClaw treats it as optional; callbacks carry a signature and a timestamp |

### 2.1 Whether a QR-code-created app can be switched to webhook: uncertain

The "update app config" API (`PATCH /open-apis/application/v7/applications/:app_id/config`) can set `event.subscription_type: "webhook" | "websocket"`, `request_url`, `add_events`, `callback.callback_type`, and `event_and_callback_encrypt_strategy` (`encryption_key`, `verification_token`). But the official comments state plainly:

> Only custom apps created in the developer console are supported, **excluding custom apps created through other channels such as the bot assistant**

Whether a QR-code-created `PersonalAgent` app counts as "created in the developer console" is answered nowhere in the source or the docs. **Must be tested live.**

Also: the event subscription server address takes effect immediately after modification; other config takes effect in production only after "submit for release" plus review approval.

### 2.2 Long-lived connection protocol (`ws-client/index.ts`)

1. `POST https://open.feishu.cn/callback/ws/endpoint`, body `{ AppID, AppSecret }`, request header `locale: zh`. Returns `{ code, data: { URL, ClientConfig: { PingInterval, ReconnectCount, ReconnectInterval, ReconnectNonce } } }`. The `URL` carries `device_id` and `service_id`.
2. Connect to `URL` (WebSocket). Frames are **protobuf** (`pbbp2.Frame`, header key-value pairs; `method`: 0 control frame / 1 data frame). Header keys: `type` (`ping`/`pong`/`event`/`card`), `message_id`, `sum`, `seq` (sharding of large events), `trace_id`, `biz_rt`, handshake status.
3. The client sends ping frames at the `PingInterval` cadence.
4. Event frames must be **reassembled from shards** (`sum`, `seq`); after processing, reply with a response frame of the same structure, payload `{ "code": 200 }`, and carry the elapsed time in `biz_rt`.
5. Error codes include `exceed_conn_limit` (connection count over the limit), `auth_failed`, `forbidden`.
6. The long-lived connection is available only for **custom apps on Feishu (not in some Lark international scenarios)** and requires selecting 「使用长连接接收事件/回调」 ("use long-lived connection to receive events/callbacks") in the developer console (verbatim from the SDK log). With multiple connections, Feishu runs in "cluster mode" and delivers each event to only one of the connections (from common descriptions of Feishu's long-lived connection mechanism; no direct evidence in the source, **unverified**).

### 2.3 Putting the long-lived connection inside a Durable Object: feasible, but at a cost

| Question | Analysis |
|---|---|
| Can a DO act as a WebSocket **client** | Yes. But the docs are explicit: **an outbound WebSocket cannot hibernate** — the DO stays in memory for the whole connection. Note the direction: heartbeat pings go **from the DO to Feishu** (the interval is dictated by Feishu via `ClientConfig.PingInterval`), so the DO's state is "awake all month", not "woken over and over". Whether messages received over the outbound connection count toward request quota is unverified |
| Cost | An always-awake DO burns roughly 331,776 GB-s per month, below the 400,000 GB-s included monthly with the paid plan (see [cloudflare-do-websocket.md](cloudflare-do-websocket.md)); but this breaks the "hibernation costs almost nothing" assumption and eats into the included allowance |
| Who reconnects after a crash / eviction | A DO has no resident process. An alarm heartbeat is needed to bring the DO back up and reconnect after a reset. The prototype verified that an alarm can wake a reset DO |
| Protocol implementation | We would have to implement protobuf frame encode/decode, shard reassembly, ping, and ack frames ourselves in TypeScript. `pbbp2` is tiny (the official SDK's `pbbp2.d.ts` is about 8.6 KB) and can be hand-written; the official SDK depends on Node's `ws` and axios, so it does not drop into a Worker |
| Ack deadline | Events must be acknowledged within seconds (the exact deadline is not visible in the source), otherwise Feishu redelivers; the steward's processing must be asynchronous — acknowledge first, then process — and deduplicate on `message_id` |

### 2.4 Long-lived connection vs webhook

| | Long-lived connection | webhook |
|---|---|---|
| Can the DO hibernate | No, awake for as long as the connection lives | Yes, near-zero cost while idle |
| Needs an address Feishu can reach | No | Yes (in mainland China, almost certainly a custom domain) |
| Must be implemented by us | protobuf frames, shard reassembly, ping, ack frames, reconnect, alarm keep-alive | signature verification, the URL verification handshake, responding within seconds, dedup |
| Failure surface | Connection state must be detected and recovered by us | No connection state; Feishu redelivers |

Conclusion: the adapter supports both; prefer webhook when a usable custom domain exists and the QR-code-created app can be switched to webhook, otherwise fall back to the long-lived connection. Both rest on the unverified items in section 6. Two practices from OpenClaw's webhook mode are worth borrowing: **persist the event before returning 200**; and reject signed callbacks whose timestamp deviates from the local clock by more than 1 hour (Feishu signatures carry no expiry, so an intercepted callback can be replayed).

## 3. A channel-independent risk amplified by this research: the mainland China network

We have tested locally: `*.workers.dev` is blocked in mainland China (DNS pollution, TLS reset by SNI) and is reachable only through a proxy ([protocol prototype live test](do-protocol-spike.md)). For the Feishu channel this has two layers of implication:

1. **Whether Feishu's servers can push webhook callbacks to our Worker address.** Feishu's servers are in China; their access to `workers.dev` is most likely blocked the same way (**unverified**). So webhook mode most likely needs a **custom domain**, while the long-lived connection has no such problem (it is outbound — the DO connects to Feishu from the Cloudflare edge).
2. **The more direct problem: the users themselves.** Tapping the 「查看详情」 ("view details") link in a report card on a phone, or the desktop connector connecting to the steward's WebSocket, both hit our Worker address. Mainland users **cannot reach `workers.dev` without a proxy**.

So for mainland Chinese users, "one-click deploy, zero config" does not hold: **the Worker needs a custom domain bound** (or the connector and the web pages must go through the user's own proxy). This should be written into the onboarding flow and listed in the deployment guide as a mandatory step for Chinese users. Cloudflare custom domains are themselves not reliably reachable from China; whether one works needs a live test.

## 4. Message sending (`im/v1`)

From the official comments in `code-gen/projects/im.ts`.

- **Send message** `POST /open-apis/im/v1/messages?receive_id_type=open_id`, body `{ receive_id, msg_type, content, uuid? }`. `msg_type` supports text, rich text, cards (`interactive`), images, files, audio, video, and more. The `uuid` field is for request deduplication (the exact dedup window is not stated in the source comments, **unverified**).
- **Reply to message** supports text, rich text, cards, and more. Preconditions: the app has **bot capability** enabled; when replying in a direct chat, the user must be inside the bot's **availability range**; when replying to a group message, the bot must be in the group and have permission to speak.
- **Update an already-sent card** `PATCH /open-apis/im/v1/messages/:message_id`, body `{ content }`. Per the comments: use `patch` to update a message card sent by the app; editing a message (`update`) supports only text and rich text.
- **Rate limits**: **5 QPS** cap when sending to **the same user**; for the same group, the bots in the group share 5 QPS.
- **Size**: the serialized message cap is **30 KB** (OpenClaw docs: Markdown cards and rich text beyond that get split); chunking plain text at 4000 characters is common practice.
- **Streaming replies**: via Card Kit's streaming API, the bot updates the same card in real time while generating (OpenClaw already uses this).
- **Downloading images sent by users**: `image.get` can only download images **uploaded by the bot itself**; for images a user sends to the bot, use the "get message resource" API (`im/v1/messages/:message_id/resources/:file_key`). The default media upload/download cap is 30 MB (OpenClaw's config).
- **Access token**: `tenant_access_token`, obtained by exchanging `client_id` / `client_secret`, with an expiry (about 2 hours; from common knowledge, not written in the source excerpts, **unverified**).

## 5. Impact on the steward's design

1. **The onboarding flow can be**: deployment finishes → open the settings page → the page shows the QR code obtained from the DO-initiated `begin` call → the user scans with Feishu → the DO's alarm polling obtains `client_id`, `client_secret`, `open_id` → encrypt and store, bind the owner → start receiving events. **The user scans exactly once.**
2. **Inbound defaults to the long-lived connection**, hosted by the DO; `ChannelAdapter` needs to support two inbound implementations: `LongConnection` (DO outbound connection, alarm keep-alive) and `Webhook` (HTTP callback, custom domain). The MVP does the long-lived connection first.
3. **Owner binding is done automatically**: use the `open_id` returned by `registerApp`; the user needs to enter nothing extra.
4. **Outbound must be rate-limited**: 5 QPS to the same user; the notification merge window (steward.md §6.4) matches this; the card rendered by `notify_user` must not exceed 30 KB.
5. **Card buttons** go through the `card.action.trigger` callback. In long-lived-connection mode the callback also arrives over the same connection (`MessageType.card`) and needs an ack frame.
6. **Chinese users must have a custom domain** (§3); write it into the onboarding docs and add a "reachability self-check" to the post-deployment checks.

## 6. Points still unverified

| Item | Why it matters |
|---|---|
| Whether a QR-code-created app can be switched to webhook via `PATCH .../config` | Decides whether webhook mode is available at all |
| Whether a QR-code-created app needs "publish / review" before it takes effect, and whether personal accounts face creation restrictions (developer permission required) | Decides whether onboarding is truly "one scan" |
| Whether the `addons` gradual-rollout switch is enabled for the user; which permissions and events are preset by default, and whether they include `im.message.receive_v1` and `card.action.trigger` | Decides whether extra steps are needed to top up permissions |
| Stability of the long-lived connection inside a Cloudflare DO (outbound WebSocket, protobuf frames, reconnect, alarm keep-alive) | Decides whether a "DO-hosted long-lived connection" is feasible |
| Reachability of `workers.dev` and of the custom domain from Feishu's servers | Decides whether webhook is viable |
| The event ack deadline, the redelivery policy, the `message_id` dedup window | Affects idempotency design |
| The default "availability range" for direct chats with the bot, and whether other people can message this bot | Affects security beyond owner binding |
| How often the China-market Feishu app fails to react to the QR code | Decides how important the fallback path is |

## 7. Recommended live tests

(Completed on 2026-10-14; see the next section.)

## 8. Live test results (2026-10-14)

Environment: Mac mini (macOS) + official SDK `@larksuiteoapi/node-sdk@1.75.0`; Cloudflare Worker `shepherd-hook` + custom domain `shepherd-spike.iefnaf.cc`; two QR-code creations (two different Feishu accounts). Original scripts: [spikes/feishu](../../spikes/feishu).

### 8.1 What passed

| Item | Result |
|---|---|
| QR-code creation (once for each of two accounts) | ✅ Both succeeded. Returned `client_id`/`client_secret`/the scanner's `open_id`. The default configs were **exactly identical**: 36 permissions (including message send/receive, cards, bot capability), 9 events (including `im.message.receive_v1`), websocket callback (including `card.action.trigger`), auto-published version 1.0.0 — no review or admin action of any kind |
| QR code validity | Measured `expires_in=3600s` (the SDK docs say 10 minutes; trust the measurement) |
| Permission top-up by scan (the `addons` update flow) | ✅ `application:application:patch` was successfully added on the second app (36→37); **the secret is not rotated**, the app unchanged. (A first attempt on another app did not take effect; cause undetermined — gradual rollout or an action on the confirmation page are both possible) |
| Long-lived connection, full chain | ✅ Events arrived (`im.message.receive_v1`, roughly **500–600 ms** from the message `create_time` to local receipt), text replies, sending cards, `PATCH` card updates, button callbacks (`card.action.trigger`), image messages, and `messageResource.get` downloading a user-sent image (30 KB webp, about 850 ms) |
| Quote-reply routing | ✅ When a user quote-replies to our card, the event's `parent_id` **is exactly** that card's `message_id`. The strong signal holds: "replying to a given report routes to the corresponding Thread" |
| Custom-domain reachability from China | ✅ A direct hit on `https://shepherd-spike.iefnaf.cc/` from this machine without a proxy returned 200 (about 1.2 s). The connector and the detail pages via the custom domain **need no proxy** |

### 8.2 webhooks: usable, but switching takes two steps, "config change + console republish" (key finding, with one reversal)

1. `*.workers.dev` is unreachable from mainland China, **and equally unreachable to Feishu's servers**: PATCHing a workers.dev address returned 210042 (URL verification failed = Feishu's verification request never reached the Worker).
2. After switching to the custom domain, **URL verification passed** (the logs show the `url_verification` request from Feishu's verification servers `123.58.10.238/239` (China)), and the PATCH returned success.
3. **But switching via the API alone does not take effect**: after multiple successful PATCHes (including `add_events`), stopping the long-lived-connection client, and even releasing a version via the `publish` API (version 1.0.1 went live, `online_version_id` already switched), event delivery still ran over the long-lived connection. During this period the displayed `callback_info.callback_type` bounced between webhook/websocket, out of sync with actual delivery.
4. **It took effect after a console republish**: the user republished the version in the developer console, then PATCHed once more; `callback_type` settled on webhook, and **event delivery actually switched**:
   - `im.message.receive_v1` now reaches the Worker straight from Feishu's servers, roughly **400 ms** from message creation to receipt;
   - the `card.action.trigger` button callback arrives as well: `action.value` custom data round-trips verbatim, `context.open_message_id` points at the card message (a strong signal for callback routing), and `operator.open_id` can verify the operator.
5. `publish` API caveat: without `mobile_default_ability`/`pc_default_ability` it returns 210304, of the 210042 family (missing fields); with all 5 fields it still returns 50516, yet the version is created and goes live — **an API release and a console release are not equivalent server-side**; where they differ was not determined.

**Conclusion: webhook is usable for QR-code-created apps**, on the conditions of a custom domain + a scan to add the `application:application:patch` permission + the config PATCH + **a console republish** (an API release cannot substitute for it). The long-lived connection remains the option that needs no console work. In the setup flow, "republish in the console" is the only step that pulls the user away from the scan flow; the correct combination and ordering of the `publish` API and the PATCH (release first, then PATCH?) was not exhausted — worth another try later; if it works, the whole thing is fully automatic.

**Impact on the implementation**: in webhook mode the DO needs only one HTTP endpoint plus signature verification (events carry a `token` field that can be checked; callbacks have a separate `token`); **no hand-written protobuf long-lived-connection client inside the DO**, the implementation effort drops sharply, and the DO can hibernate. The MVP default switches to webhook, with the long-lived connection as the downgrade option for "I don't want to touch the console".

### 8.3 Other live-test details

- `image.get` cannot download user-sent images (returns 400); `im.messageResource.get` is required — consistent with the official comments.
- The default app name gets truncated at creation (prefilled "Shepherd Spike ({user})" → app name "Spike"); repeated creations pile up same-named bots, so the product should guide users to delete old apps or tell them apart by name.
- The encoded `addons` content really does travel in the URL parameter (the gzip+base64 `addons=` segment is visible in the tested link).
- The wrangler OAuth consent page remembers the permission scopes checked last time; re-login does not auto-complete them. On a remote machine, `wrangler login`'s localhost callback cannot reach the remote end, so manual console operations or an API Token are needed (this round was worked around with "deploy under existing permissions + bind the domain manually in the console").

## 9. Impact on the design (updated)

1. **MVP inbound = webhook** (revised after the 2026-10-14 live test): the DO hibernates fully, and the implementation is just one HTTP endpoint plus signature verification; the setup flow gains one extra step, "republish in the console". The long-lived connection is demoted to the alternative (no console needed, but the DO stays awake and the protobuf frame protocol must be implemented inside the DO).
2. Onboarding: scan to create (default permissions/events/auto-publish) → scan to add `application:application:patch` → config PATCH to switch to webhook (URL verification happens automatically) → republish in the console. To be verified: whether the `publish` API can replace the last step.
3. A custom domain is mandatory for mainland Chinese users (the connector, the detail pages, and webhook all depend on it); the deployment guide must include a reachability self-check.
4. The strong signal for quote routing is now verified: both a text message's `parent_id` and a card callback's `context.open_message_id` point at our message ID.

