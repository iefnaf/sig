# Cloudflare：Durable Object WebSocket 调研

日期：2026-10-14。目的：为连接器与总管（Durable Object）之间的协议提供事实依据。

来源（读的是官方仓库的源文件，不是实测）：

- `cloudflare/cloudflare-docs`，提交 `eeca142b`：`durable-objects/best-practices/websockets.mdx`、`platform/limits.mdx`、`platform/pricing.mdx`
- `cloudflare/agents`，提交 `b1e3614b`：`docs/agents/http-websockets.md`、`docs/agents/routing.md` 等

没有在真实 Worker 上实测。休眠、唤醒、关闭码和计费的实际表现需要原型验证（见最后一节）。

## 1. 休眠（Hibernation）

- DO 作为 WebSocket **服务端**时可以休眠；**作为客户端发起的外连 WebSocket 不能休眠**。
- 一段时间没有事件（消息、alarm）后 DO 被逐出内存，客户端连接仍保持在 Cloudflare 网络上；下一条消息到达时重新初始化（重新执行构造函数）并调用消息处理函数。
- 休眠期间不产生时长（GB-s）费用。
- 休眠后内存状态全部丢失。`setTimeout`、`setInterval`、alarm 和进行中的 I/O 会阻止休眠。
- Agents SDK 的 WebSocket **一律使用休眠 API，没有不休眠模式**；文档写的是空闲约 10 秒后休眠。
- 休眠后保留的：`this.state`、`connection.state`、SQLite 数据、连接元数据。不保留的：类的内存字段、定时器、进行中的 Promise、本地缓存。
- `serializeAttachment` 的序列化大小上限 **16,384 字节**；连接任一方关闭后附件丢失。
- 运行时自动处理客户端的 WebSocket **ping 帧并回复 pong**，这个过程不会唤醒休眠的 DO，也不会调用消息处理函数。

## 2. 限制

| 项 | 数值 |
|---|---|
| WebSocket 接收消息大小 | 32 MiB（仅限接收） |
| SQLite 单行 / 字符串 / BLOB | 2 MB |
| SQLite 单个 DO 存储 | 10 GB |
| 单次 SQL 语句长度 | 100 KB |
| 每次绑定参数 | 100 个 |
| 每个请求或每条 WebSocket 消息的 CPU 时间 | 默认 30 秒（每条新消息重置） |
| 连接标签（Agents SDK） | 最多 9 个，每个最长 256 字符 |

## 3. 计费

- WebSocket 消息按 **20:1** 折算成请求计费；每条新连接算一个请求。
- 请求：每月含 100 万，超出部分 $0.15 / 百万。
- 时长：每月含 400,000 GB-s，超出部分 $12.50 / 百万 GB-s，按 128 MB 计。
- 付费计划有每月 $5 的最低消费。
- 文档示例：一个 DO 全月不休眠（每秒都有消息）是 33 万 GB-s 量级，仍在含量之内。按同样算法，单个 DO 整月常醒约 2,592,000 秒 × 0.128 GB ≈ 331,776 GB-s，**低于 400,000 的含量**。所以对单租户部署，时长费用不是硬约束，但频繁唤醒仍应避免（既浪费，也会逼近含量）。
- 进行中的 I/O 最多让对象留在内存 15 分钟，期间计时长。

## 4. Agents SDK（`agents` 包）

- 钩子：`onStart`、`onRequest`、`onConnect(connection, ctx)`、`onMessage(connection, message)`、`onClose`、`onError`。`ctx.request` 是原始 HTTP 请求，**可读请求头**，适合鉴权；鉴权失败可以 `connection.close(4001, ...)`。
- `routeAgentRequest(request, env, { onBeforeConnect })`：在**唤醒 Agent 之前**运行，返回 `Response` 即拒绝，返回 `Request` 则改写。`getAgentByName` 不会运行该钩子，调用方需自行检查。
- 每个新连接默认会收到协议帧（`CF_AGENT_IDENTITY`、`CF_AGENT_STATE`、`CF_AGENT_MCP_SERVERS`）。`shouldSendProtocolMessages(connection, ctx)` 返回 `false` 可关闭，适合非浏览器客户端；该选择在休眠后保持。
- `getConnectionTags(connection, ctx)` 给连接打标签，`getConnections(tag)` 按标签取，适合区分「连接器连接」和「浏览器连接」。
- 路由形态为 `/agents/<类名 kebab>/<实例名>`；单租户部署用固定实例名（如 `owner`）。
- `agents` 仓库里有 `docs/agents/harnesses/pi.md`，说明 PiHarness 如何与 Agent 结合，以及 `push-notifications.md`、`webhooks.md`、`scheduling.md`、`tasks.md`；本次未读。

## 5. 对协议设计的约束

1. 休眠会清空内存：**任何待确认状态、超时、重试都必须在 SQLite 中**，用 `this.schedule`（alarm）驱动，不能依赖内存里的 Promise 或定时器。
2. 保活用 WebSocket 协议级 ping（连接器发），运行时自动回 pong 且不唤醒 DO，成本接近零；应用层心跳只在需要时发。
3. 鉴权分两层：Worker 层 `onBeforeConnect` 做无状态预检（不唤醒 DO）；DO 层 `onConnect` 做有状态检查（撤销、设备记录）。
4. 连接器连接要关闭协议帧，并用标签与浏览器连接区分。
5. 消息大小远小于 32 MiB 的上限，但 SQLite 单行只有 2 MB：事件和历史分块要明显小于它。
6. 连接状态的附件上限 16 KB：连接上只放身份和少量标记，其余查 SQLite。

## 6. 验证状态

以下几项已在真实 Cloudflare 上用原型验证，见 [do-protocol-spike.md](do-protocol-spike.md)：休眠后第一条消息的额外时延（约 35–50 ms）；协议级 ping 不唤醒 DO 也不阻止休眠；自定义关闭码 4403、4409 原样到达 Node 的 `ws` 客户端；`onBeforeConnect` 里用 Worker 密钥做 HMAC 预检，坏令牌不唤醒 DO；`ws` 可设置自定义请求头。

仍未验证：

- 笔记本睡眠、网络切换场景下半开连接被发现的时间。
- 空闲约 10 秒休眠的准确阈值（只确认 40 秒内必休眠），以及频繁小消息对时长费用的实际影响。
- 账单核对（控制台里的请求数与 GB-s）。
