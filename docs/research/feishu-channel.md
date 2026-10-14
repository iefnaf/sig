# 飞书渠道调研

日期：2026-10-14。目的：判断「部署后扫码创建飞书 bot」是否成立，以及总管的飞书适配器该怎么接。

**同日实测**：全部关键问题已在实机验证（两次扫码创建、长连接收发、webhook 切换、自定义域名可达性），见文末「实测结果」一节。

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
| DO 能当 WebSocket **客户端**吗 | 能。但文档明确：**出站 WebSocket 不能休眠**，连接期间 DO 一直在内存里。注意方向：心跳 ping 是 **DO 发给飞书**的（间隔由飞书在 `ClientConfig.PingInterval` 下发），DO 的状态是「整月不休眠」，而不是「被反复唤醒」。出站连接收到的消息是否计入请求数，未验证 |
| 费用 | 常醒的 DO 整月约 331,776 GB-s，低于付费计划每月含的 400,000 GB-s（见 [cloudflare-do-websocket.md](cloudflare-do-websocket.md)）；但这会让「休眠几乎不花钱」的假设失效，且挤占含量 |
| 崩溃 / 逐出后谁来重连 | DO 没有常驻进程。需要 alarm 心跳，在 DO 被重置后拉起并重连。原型已验证 alarm 可以唤醒被重置的 DO |
| 协议实现 | 要自己用 TypeScript 实现 protobuf 帧编解码、分片合并、ping、确认帧。`pbbp2` 很小（官方 SDK 的 `pbbp2.d.ts` 约 8.6 KB），可手写；官方 SDK 依赖 Node 的 `ws` 与 axios，不适合直接放进 Worker |
| 确认时限 | 事件需要在数秒内确认（具体时限未在源码中看到），否则飞书会重发；总管的处理必须异步，收到先确认再处理，并用 `message_id` 去重 |

### 2.4 长连接与 webhook 的取舍

| | 长连接 | webhook |
|---|---|---|
| DO 能否休眠 | 否，连接期间常醒 | 能，空闲几乎零成本 |
| 需要可被飞书访问的地址 | 否 | 是（国内大概率要自定义域名） |
| 要自己实现 | protobuf 帧、分片合并、ping、确认帧、重连、alarm 保活 | 验签、URL 验证握手、数秒内响应、去重 |
| 故障面 | 连接状态要自己发现和恢复 | 无连接状态，飞书会重发 |

结论：适配器两种都支持，有可用自定义域名且扫码创建的应用能改成 webhook 时优先 webhook，否则退回长连接。前提都是第 6 节的未验证项。OpenClaw 的 webhook 模式有两条值得借鉴的做法：先把事件**持久化再返回 200**；拒绝时间戳与本机时钟相差超过 1 小时的签名回调（飞书签名不带过期，截获的回调可被重放）。

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

（以下已于 2026-10-14 完成，见下一节。）

## 8. 实测结果（2026-10-14）

环境：Mac mini（macOS）+ 官方 SDK `@larksuiteoapi/node-sdk@1.75.0`；Cloudflare Worker `shepherd-hook` + 自定义域名 `shepherd-spike.iefnaf.cc`；两次扫码创建（两个不同的飞书账号）。原始脚本：[spikes/feishu](../../spikes/feishu)。

### 8.1 通过的

| 项 | 结果 |
|---|---|
| 扫码创建（两个账号各一次） | ✅ 均成功。返回 `client_id`/`client_secret`/扫码人 `open_id`。默认配置**完全一致**：36 个权限（含收发消息、卡片、机器人能力）、9 个事件（含 `im.message.receive_v1`）、websocket 回调（含 `card.action.trigger`）、自动发布版本 1.0.0，无需任何审核或管理员操作 |
| 二维码有效期 | 实测 `expires_in=3600s`（SDK 文档写 10 分钟，以实测为准） |
| 扫码补权限（`addons` 更新流程） | ✅ 第二个应用上成功加上 `application:application:patch`（36→37 个），**secret 不轮换**、应用不变。（第一次在另一应用上未生效，原因未定；灰度或确认页操作都有可能） |
| 长连接全链路 | ✅ 事件到达（`im.message.receive_v1`，从消息 `create_time` 到本地收到约 **500–600 ms**）、回复文本、发送卡片、`PATCH` 更新卡片、按钮回调（`card.action.trigger`）、图片消息、`messageResource.get` 下载用户发的图（30 KB webp，约 850 ms） |
| 引用回复路由 | ✅ 用户引用回复我们的卡片时，事件的 `parent_id` **正好等于**我们那张卡片的 `message_id`。「回复某条汇报即路由到对应 Thread」的强信号成立 |
| 自定义域名国内可达性 | ✅ 本机不走代理直连 `https://shepherd-spike.iefnaf.cc/` 200（约 1.2 s）。连接器与详情页走自定义域名**不需要代理** |

### 8.2 webhooks：可用，但切换需要「配置 + 控制台重新发布」两步（核心发现，含一次反复）

1. `*.workers.dev` 从国内不可达，**对飞书服务器同样不可达**：PATCH 到 workers.dev 地址报 210042（URL 验证失败 = 飞书的验证请求到不了 Worker）。
2. 换自定义域名后，**URL 验证通过**（日志看到飞书验证服务器 `123.58.10.238/239`（中国）的 `url_verification` 请求），PATCH 返回 success。
3. **但仅靠 API 切换不生效**：多次成功 PATCH（含 `add_events`）、停掉长连接客户端、甚至用 API `publish` 发版（版本 1.0.1 上线，`online_version_id` 已切换），事件投递依然走长连接。期间 `callback_info.callback_type` 的显示在 webhook/websocket 间跳动，与真实投递不一致。
4. **控制台重新发布后生效**：用户在开发者后台重新发布版本，再 PATCH 一次，`callback_type` 稳定显示 webhook，**事件投递真实切换**：
   - `im.message.receive_v1` 从飞书服务器直达 Worker，消息创建到收到约 **400 ms**；
   - `card.action.trigger` 按钮回调同样到达，`action.value` 自定义数据原样回传，`context.open_message_id` 指向卡片消息（回调路由强信号），`operator.open_id` 可校验操作者。
5. `publish` API 注意：不带 `mobile_default_ability`/`pc_default_ability` 报 210042 系的 210304（缺字段）；带全 5 个字段仍报 50516，但版本会创建并上线——**API 发版与控制台发版在服务端效果不等价**，差在哪未查明。

**结论：webhook 对扫码创建的应用可用**，条件是自定义域名 + 扫码补 `application:application:patch` 权限 + config PATCH + **控制台重新发布**（API 发版不能替代）。长连接作为无需控制台操作的备选。设置流程里「控制台重新发布」是唯一需要用户离开扫码流程的一步；`publish` API 与 PATCH 的正确组合顺序（先发版后 PATCH？）未穷尽，值得后续再试一次，若成立则全自动。

**对实现的影响**：webhook 模式下 DO 只需一个 HTTP 端点加验签（事件带 `token` 字段可校验，回调有独立 `token`），**不需要在 DO 里手写 protobuf 长连接客户端**，实现量大幅下降，且 DO 可以休眠。MVP 默认改为 webhook，长连接作为「不想去控制台」的降级选项。

### 8.3 其他实测细节

- `image.get` 不能下载用户发的图（返回 400），必须用 `im.messageResource.get`——与官方注释一致。
- 创建应用的默认名会被裁短（预填 "Shepherd Spike ({user})" → 应用名 "Spike"）；多次创建会出现多个同名 bot，产品上要注意引导用户删除旧应用或命名区分。
- `addons` 编码后的内容确实走 URL 参数（实测链接中可见 gzip+base64 的 `addons=` 段）。
- wrangler OAuth 授权页会记住上次勾选的权限范围，重新 login 不会自动补全；远程机器上 `wrangler login` 的 localhost 回调到不了远端，需要控制台手动操作或 API Token（本次用「现有权限部署 + 控制台手动绑域名」绕过）。

## 9. 对设计的影响（更新）

1. **MVP 入站 = webhook**（2026-10-14 实测后修正）：DO 完全休眠、实现只要一个 HTTP 端点加验签；设置流程多一步「控制台重新发布」。长连接降为备选（无需控制台，但 DO 常醒且要在 DO 里实现 protobuf 帧协议）。
2. 上手流程：扫码创建（默认权限/事件/自动发布）→ 扫码补 `application:application:patch` → config PATCH 切 webhook（URL 验证自动完成）→ 控制台重新发布。待验证 `publish` API 能否替代最后一步。
3. 自定义域名是国内用户的必选项（连接器、详情页、webhook 全依赖它），部署指引里要有可达性自检。
4. 引用路由的强信号已验证：文本消息的 `parent_id` 和卡片回调的 `context.open_message_id` 都指向我们的消息 ID。

