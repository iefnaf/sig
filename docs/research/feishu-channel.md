# 飞书渠道调研

日期：2026-10-14。目的：判断「部署后扫码创建飞书 bot」是否成立，以及总管的飞书适配器该怎么接。

## 证据来源与可信度

飞书开放平台的文档站（`open.feishu.cn`、`open.larkoffice.com`）在本环境无法抓取，所以结论主要来自**官方 SDK 的源码**和第三方对接项目的文档：

| 来源 | 版本 | 可信度 |
|---|---|---|
| `larksuite/node-sdk`（官方）：`scene/registration/*`、`ws-client/*`、`code-gen/projects/application.ts`、`code-gen/projects/im.ts` | 提交 `e34a66f0`（2026-10-12），包版本 1.75.0 | 高。是协议的实际实现，`im.ts` 与 `application.ts` 里的注释是官方文档的摘录 |
| `openclaw/openclaw` 的 `docs/channels/feishu*`（第三方对接，生产使用） | 提交 `89f8764f`（2026-10-14） | 中高。是别人踩过的坑，但不是官方 |
| `SmokingMouse/trellis` PR #72（另一个第三方对接） | | 中。佐证扫码创建的流程 |
| 搜索结果摘要 | | 低，仅作线索 |

没有实机验证。扫码创建需要用户用飞书 App 扫码，涉及在用户的飞书账号下创建应用，需要用户配合（见最后一节）。

## 1. 扫码一键创建：确实存在，且是官方能力

SDK 的 `registerApp`（`scene/registration/index.ts`）基于 OAuth 2.0 设备授权流程（RFC 8628），只有两个 HTTP 调用，**不依赖 Node 运行时，Worker 里用 `fetch` 就能做**：

```
POST https://accounts.feishu.cn/oauth/v1/app/registration      (Lark 国际版: accounts.larksuite.com)
Content-Type: application/x-www-form-urlencoded

1) action=begin & archetype=PersonalAgent & auth_method=client_secret & request_user_info=open_id
   → { device_code, verification_uri_complete, user_code, interval, expires_in }

2) 每 interval 秒轮询： action=poll & device_code=...
   → 等待中: { error: "authorization_pending" }     太快: { error: "slow_down" }（间隔加 5 秒）
   → 成功:   { client_id, client_secret, user_info: { open_id, tenant_brand } }
   → 失败:   access_denied / expired_token
```

要点：

- `archetype: "PersonalAgent"`：这是为**个人 agent** 设计的应用类型，与我们的场景吻合。
- 返回的 `user_info.open_id` 是**扫码人**的 open_id，直接可作为 owner 绑定（OpenClaw 的扫码流程就是据此把私聊锁定为本人）。`tenant_brand` 是 `feishu` 或 `lark`；若是 `lark`，要切换到 `accounts.larksuite.com` 继续轮询。
- 二维码链接 10 分钟内有效、一次性。`expires_in` 默认 600 秒。
- 链接上可带预填信息：`name`（支持 `{user}` 占位）、`desc`、头像（1–6 个公开可访问的图片 URL）；`createOnly=true` 隐藏「选择已有应用」入口，避免绑定到已有应用；`clientID` 用于更新已有应用的配置。
- 扫码确认页上预置的**权限、事件、回调**通过 `addons` 参数传（只能带 5 个公开字段：`preset`、`scopes.tenant/user`、`events.items.tenant/user`、`callbacks.items`）。语义是**只增不减**，名称不在平台目录里的会被静默丢弃；整个 `addons` 还依赖平台灰度开关，**未开启时整个参数被忽略，走默认流程**。
- SDK 注释明确写出：`events.subscription_type`、`request_url`、`security.*`、加密密钥这类**敏感配置不能通过 URL 带**，必须走「更新应用配置」OpenAPI，`encodeAddons` 会拒绝。

已知的坑（OpenClaw 文档）：国内飞书手机 App 有时对二维码无反应，建议回退到手动方式（在开发者后台创建自建应用，手动填 App ID 和 App Secret）。

**结论：「部署完成后出二维码，扫码创建 bot」成立，且实现成本很低。** 手动填凭据应当作为兜底路径保留。

## 2. 事件接收：长连接是默认，webhook 是可选

| 模式 | 要求 | 备注 |
|---|---|---|
| **长连接（WebSocket）** | 应用主动连飞书，**不需要公网地址** | 扫码创建的应用默认走这种（OpenClaw：WebSocket 是默认传输；trellis：创建后「等长连接连上」） |
| webhook | 需要公网 HTTPS 地址，飞书把事件 POST 过来 | OpenClaw 视为可选；回调带签名，有时间戳 |

### 2.1 能否把扫码创建的应用改成 webhook：不确定

「更新应用配置」接口（`PATCH /open-apis/application/v7/applications/:app_id/config`）可以设置 `event.subscription_type: "webhook" | "websocket"`、`request_url`、`add_events`、`callback.callback_type`、`event_and_callback_encrypt_strategy`（`encryption_key`、`verification_token`）。但官方注释写明：

> 仅支持更新开发者后台创建的自建应用，**不包含通过机器人助手等其他渠道创建的自建应用**

扫码创建的 `PersonalAgent` 应用算不算「开发者后台创建的」，源码和文档里都没有答案。**必须实测。**

另外：事件订阅服务器地址修改后立即生效，其他配置要「提交发布」并审核通过后才在线上生效。

### 2.2 长连接协议（`ws-client/index.ts`）

1. `POST https://open.feishu.cn/callback/ws/endpoint`，body `{ AppID, AppSecret }`，请求头 `locale: zh`。返回 `{ code, data: { URL, ClientConfig: { PingInterval, ReconnectCount, ReconnectInterval, ReconnectNonce } } }`。`URL` 里带 `device_id`、`service_id`。
2. 连接 `URL`（WebSocket）。帧是 **protobuf**（`pbbp2.Frame`，头部键值对；`method`: 0 控制帧 / 1 数据帧）。头部键：`type`（`ping`/`pong`/`event`/`card`）、`message_id`、`sum`、`seq`（大事件分片）、`trace_id`、`biz_rt`、握手状态。
3. 客户端按 `PingInterval` 发 ping 帧。
4. 事件帧要**分片合并**（`sum`、`seq`），处理后回一个同结构的响应帧，payload 为 `{ "code": 200 }`，并带上 `biz_rt` 耗时。
5. 错误码包括 `exceed_conn_limit`（连接数超限）、`auth_failed`、`forbidden`。
6. 长连接只对**自建应用且飞书（非国际版 Lark 部分场景）**可用，需要在开发者后台选择「使用长连接接收事件/回调」（SDK 日志原文）。多连接时飞书是「集群模式」，一个事件只投递给其中一个连接（来自对飞书长连接机制的常见描述，源码里没有直接证据，**未验证**）。

### 2.3 把长连接放进 Durable Object：可行，但有代价

| 问题 | 分析 |
|---|---|
| DO 能当 WebSocket **客户端**吗 | 能。但文档明确：**出站 WebSocket 不能休眠**，连接期间 DO 一直在内存里 |
| 费用 | 常醒的 DO 整月约 331,776 GB-s，低于付费计划每月含的 400,000 GB-s（见 [cloudflare-do-websocket.md](cloudflare-do-websocket.md)）；但这会让「休眠几乎不花钱」的假设失效，且挤占含量 |
| 崩溃 / 逐出后谁来重连 | DO 没有常驻进程。需要 alarm 心跳，在 DO 被重置后拉起并重连。原型已验证 alarm 可以唤醒被重置的 DO |
| 协议实现 | 要自己用 TypeScript 实现 protobuf 帧编解码、分片合并、ping、确认帧。`pbbp2` 很小（官方 SDK 的 `pbbp2.d.ts` 约 8.6 KB），可手写；官方 SDK 依赖 Node 的 `ws` 与 axios，不适合直接放进 Worker |
| 确认时限 | 事件需要在数秒内确认（具体时限未在源码中看到），否则飞书会重发；总管的处理必须异步，收到先确认再处理，并用 `message_id` 去重 |

## 3. 一个与渠道无关、但被这次调研放大的风险：国内网络

我们在本机实测过：`*.workers.dev` 在国内被封（DNS 污染，TLS 按 SNI 重置），必须借助代理才能访问（[协议原型实测](do-protocol-spike.md)）。这对飞书渠道有两层含义：

1. **飞书服务器能否把 webhook 回调推到我们的 Worker 地址**。飞书服务器在国内，访问 `workers.dev` 大概率同样受阻（**未验证**）。所以：webhook 模式大概率需要一个**自定义域名**，长连接则没有这个问题（出站的，DO 从 Cloudflare 边缘连飞书）。
2. **更直接的问题：用户自己**。你在手机上点开汇报里的「查看详情」链接，以及电脑上的连接器连总管的 WebSocket，都要访问我们的 Worker 地址。国内用户**不加代理就访问不了 `workers.dev`**。

所以，对中国大陆用户，「一键部署后零配置」不成立：**需要给 Worker 绑定自定义域名**（或者让连接器与网页走用户自己的代理）。这应当写进上手流程，并在部署指引里把它作为中国用户的必经步骤。Cloudflare 自定义域名在国内可达性也并不稳定，是否可用需要实测。

## 4. 消息发送（`im/v1`）

来自 `code-gen/projects/im.ts` 的官方注释。

- **发送消息** `POST /open-apis/im/v1/messages?receive_id_type=open_id`，body `{ receive_id, msg_type, content, uuid? }`。`msg_type` 支持文本、富文本、卡片（`interactive`）、图片、文件、音频、视频等。`uuid` 字段用于请求去重（具体去重窗口在源码注释里没有写，**未验证**）。
- **回复消息** 支持文本、富文本、卡片等。前提：应用开启**机器人能力**；回复单聊时，用户必须在机器人的**可用范围**内；回复群消息时，机器人要在群里且有发言权限。
- **更新已发送的卡片** `PATCH /open-apis/im/v1/messages/:message_id`，body `{ content }`。注释说明：更新应用发送的消息卡片用 `patch`；编辑消息（`update`）只支持文本和富文本。
- **频率**：向**同一用户**发送限 **5 QPS**；向同一群组限群内机器人共享 5 QPS。
- **大小**：序列化后的消息上限 **30 KB**（OpenClaw 文档：Markdown 卡片与富文本超过会被拆分）；纯文本按 4000 字符分块是常见做法。
- **流式回复**：通过 Card Kit 的流式 API，机器人在生成时实时更新同一张卡片（OpenClaw 已用）。
- **下载用户发来的图片**：`image.get` 只能下载**机器人自己上传**的图片；用户发给机器人的图片要用「获取消息中的资源文件」接口（`im/v1/messages/:message_id/resources/:file_key`）。媒体上传下载默认上限 30 MB（OpenClaw 配置）。
- **访问令牌**：`tenant_access_token`，用 `client_id` / `client_secret` 换取，有有效期（约 2 小时，来自常识，源码摘录里没有写，**未验证**）。

## 5. 对总管设计的影响

1. **上手流程可以做成**：部署完成 → 打开设置页 → 页面展示由 DO 发起的 `begin` 得到的二维码 → 用户用飞书扫码 → DO 的 alarm 轮询得到 `client_id`、`client_secret`、`open_id` → 加密存储、绑定 owner → 开始接收事件。**用户只需要一次扫码。**
2. **入站默认走长连接**，由 DO 托管；`ChannelAdapter` 需要支持两种入站实现：`LongConnection`（DO 出站连接，alarm 保活）和 `Webhook`（HTTP 回调，自定义域名）。MVP 先做长连接。
3. **owner 绑定自动完成**：用 `registerApp` 返回的 `open_id`，不需要用户额外输入。
4. **出站要有限流**：同一用户 5 QPS，通知合并窗口（steward.md §6.4）与此一致；`notify_user` 渲染的卡片不得超过 30 KB。
5. **卡片按钮**走 `card.action.trigger` 回调。长连接模式下回调也通过同一连接到达（`MessageType.card`），需要确认帧。
6. **中国用户必须自定义域名**（§3），写进上手文档，并在部署后检查流程里加入「访问性自检」。

## 6. 仍未验证的点

| 项 | 为什么重要 |
|---|---|
| 扫码创建的应用能否通过 `PATCH .../config` 改成 webhook | 决定 webhook 模式是否可用 |
| 扫码创建的应用是否需要「发布 / 审核」才生效，个人账号有没有创建限制（需要开发者权限） | 决定上手流程是否真的「一次扫码」 |
| `addons` 的灰度开关对用户是否开启；默认预置哪些权限与事件，是否包含 `im.message.receive_v1` 和 `card.action.trigger` | 决定是否需要额外步骤补权限 |
| 长连接在 Cloudflare DO 里的稳定性（出站 WebSocket、protobuf 帧、重连、alarm 保活） | 决定「DO 托管长连接」可行与否 |
| 飞书服务器访问 `workers.dev` 与自定义域名的可达性 | 决定 webhook 是否可行 |
| 事件确认的时限、重发策略、`message_id` 去重窗口 | 影响幂等设计 |
| 单聊机器人对话的「可用范围」默认值，别人能不能给这个 bot 发消息 | 影响 owner 绑定之外的安全 |
| 国内飞书 App 对二维码无反应的情形占比 | 决定兜底路径的重要性 |

## 7. 建议的实测

一个小原型，需要你用飞书扫一次码：

1. 本机脚本调用 `begin`，打印二维码链接；你用飞书扫码确认。
2. 轮询得到凭据与 `open_id`；换取 `tenant_access_token`。
3. 用官方 SDK 的长连接（先在本机跑），给 bot 发消息，确认能收到 `im.message.receive_v1`；回复一条文本和一张卡片；测试 `patch` 更新卡片、按钮回调。
4. 尝试 `PATCH .../config` 切到 webhook，看是否被拒。
5. 把长连接移进 Cloudflare 的 DO（手写 protobuf 帧），验证稳定性与休眠行为。

第 1–4 步只在本机运行，不涉及 Cloudflare；会在你的飞书账号下创建一个测试应用，测完可以在开发者后台删除。
