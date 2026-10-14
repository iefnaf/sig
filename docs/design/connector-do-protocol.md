# 设计：连接器与总管（Durable Object）之间的协议

状态：草案 v0.1。依据：[产品 spec](../spec.md)、[连接器与 pi 的对接设计](connector-pi.md)、[Cloudflare DO WebSocket 调研](../research/cloudflare-do-websocket.md)。

本文定义连接器（用户机器上的守护进程）与总管（Cloudflare Durable Object）之间的**传输、鉴权、配对、可靠投递和消息格式**。命令与事件的语义来自 [connector-pi.md](connector-pi.md)，这里只规定它们如何在线上传输。总管端如何处理事件、更新记忆和通知用户，另文设计。

## 1. 目标与非目标

目标：

1. 连接器只需**出站**连接，不需要公网地址、端口转发或隧道。
2. 命令和事件都**至少一次投递，处理时幂等**，断线、休眠、重启之后不丢不重。
3. 总管 DO 能休眠：保活几乎不花钱，机器静默时 DO 不被唤醒。
4. 配对简单，凭据可单台撤销；被偷走的凭据影响面可控。
5. 协议可演进：版本协商、未知消息的处理规则明确。
6. 同一个传输还要承载「按需读取原始过程」的流式中继。

非目标（MVP）：多租户；端到端加密（连接器与浏览器之间）；连接器之间互相通信；二进制编码（使用 JSON）。

## 2. 总体形态

```
 飞书 / 网页 ─────────────┐
                          ▼
连接器 A ──wss──▶  Worker（入口、预检）──▶  Shepherd DO（单例 "owner"）
连接器 B ──wss──▶                                ├─ 连接管理（标签：connector / web）
                                                 ├─ outbox：待投递命令
                                                 ├─ event_inbox：已收事件
                                                 └─ 记忆模块、总管的 pi-durable 任务
```

- 每台机器一个连接器，**每个连接器一条 WebSocket**，由连接器发起。
- DO 是单例（实例名固定，如 `owner`），所有连接器和所有浏览器连接都落在这个实例上。
- 同一个 Agent 类同时服务连接器连接与浏览器连接，用**连接标签**区分角色，并按角色限制可发的消息类型（§5.1）。

## 3. 传输

### 3.1 连接

```
wss://<worker-host>/agents/shepherd/owner?role=connector&proto=1
Authorization: Bearer <设备令牌>
```

- 令牌放在请求头，不放在 URL，避免进入访问日志。连接器是 Node 客户端，可以设置请求头。
- 角色用查询参数声明，仅用于路由和标签；**角色是否合法由令牌决定**，不信任参数。
- 对连接器连接关闭 SDK 默认的协议帧（`shouldSendProtocolMessages` 返回 `false`），否则每次连接都会收到与本协议无关的帧。
- 一台机器同一时刻只允许一条有效连接（§3.4）。

### 3.2 保活与休眠

- 连接器每 **25 秒**发一个 WebSocket 协议级 `ping` 帧，60 秒内收不到 `pong` 视为断线并重连。运行时自动回复 `pong`，**不唤醒休眠的 DO**，成本接近零。
- 应用层不发周期性心跳。DO 判断「机器是否在线」以连接是否存在为准；对半开连接，DO 只在需要时探测：向机器发送命令后设置确认期限（§4.2），超时则把机器标为可疑。
- DO 在约 10 秒无事件后休眠。**休眠会清空内存**，因此协议状态（待确认命令、超时、重试）全部放 SQLite，并用 `this.schedule`（alarm）驱动，不依赖内存里的 Promise 或定时器。

### 3.3 重连

指数退避加抖动：1 s、2 s、4 s … 上限 60 s，成功连接并完成握手后重置。关闭码决定是否重连（§3.5）：授权类关闭码不重连。

### 3.4 单连接约束

每个连接带 `connEpoch`（连接器每次建立连接前自增并持久化的计数器）。DO 为每个 `deviceId` 只保留 `connEpoch` 最大的连接：新连接建立后，旧连接以 `4409 superseded` 关闭。这解决「网络切换时新旧连接重叠」的竞态。

### 3.5 关闭码

| 码 | 含义 | 连接器行为 |
|---|---|---|
| 1000 / 1001 | 正常关闭、服务重启 | 重连 |
| 4401 | 令牌无效或缺失 | 不重连，提示重新配对 |
| 4403 | 设备已被撤销 | 不重连，清除本地凭据，提示用户 |
| 4409 | 被同设备的新连接取代 | 不重连（新连接已存在） |
| 4426 | 协议版本不被接受 | 不重连，提示升级连接器 |
| 4429 | 速率受限 | 按 `retryAfterMs` 退避后重连 |
| 4500 | 服务端内部错误 | 重连 |

### 3.6 消息大小与批量

- 单条 JSON 消息上限 **256 KiB**。服务端接收上限是 32 MiB，但 SQLite 单行只有 2 MB，且大消息拖慢 JSON 解析；所有分块都远小于此。
- 事件批量发送：连接器累积 **250 ms** 或 **50 条** 或 **64 KiB**，先到先发。WebSocket 消息按 20:1 折算请求计费，批量主要是为了少唤醒 DO，而不是省钱。
- 可再生的 `progress` 事件在连接器端合并（见 connector-pi.md §11.2），不会因批量而放大。

## 4. 信封与可靠性

### 4.1 信封

所有消息都是 JSON 对象：

```json
{ "t": "cmd", "id": "01J…", "re": null, "ts": 1791965696285, "...": "载荷" }
```

| 字段 | 含义 |
|---|---|
| `t` | 消息类型，见 §6 |
| `id` | 消息 ID（ULID）。需要确认或回复的消息必须带 |
| `re` | 回复的目标消息 ID，仅回复类消息带 |
| `ts` | 发送方时钟，毫秒；**仅供诊断，不用于排序或去重** |

未知 `t`：若消息带 `"opt": true` 则忽略，否则回复 `error{code:"unsupported"}`。未知字段一律忽略。

### 4.2 命令流（DO → 连接器）：至少一次，连接器去重

DO 的 `outbox` 表：

```
outbox(cmdId PK, deviceId, workerId?, cseq, kind, payload, notAfter?,
       state: queued|sent|accepted|done|failed|expired|ambiguous,
       attempts, sentAt, ackDeadline, result?)
```

- `cseq` 是该设备上单调递增的序号，**同一 `workerId` 的命令按 `cseq` 顺序处理**，不同 worker 之间可并行。
- 命令先写入 `outbox`（状态 `queued`），再发送（`sent`），设置 `ackDeadline`（15 秒）。
- 连接器收到后先落盘（connector-pi.md §6.3 的 `command` 表），再回 `cmd_ack`。`cmd_ack` 只表示**已接收并持久化**：
  - `status: "accepted"`：新命令，已排队处理。
  - `status: "duplicate"`：已见过，附带原结果（若已完成）。
  - `status: "rejected"`：拒绝，附 `code`（如 `not_registered_repo`、`lock_held`、`capacity`），DO 标 `failed`。
- 命令完成后连接器发 `cmd_result{ok, data | error}`，DO 标 `done` 或 `failed`。`cmd_result` 同样可能重复，DO 按 `cmdId` 幂等处理。
- **重发**：重连后（`welcome` 之后），DO 重发所有 `sent` 且未 `accepted` 的命令；`ackDeadline` 到期而连接仍在，也重发一次，两次失败后把机器标为可疑并通知总管。
- **过期**：命令可带 `notAfter`。连接器收到时已过期，回 `rejected{code:"expired"}`。默认 `notAfter = 下发时刻 + 10 分钟`，防止机器离线一天后突然执行陈旧的指令；用户明确选择「等它上线」的命令设为 `null`（不过期）。
- **模糊状态**：连接器在 `sending` 阶段崩溃的命令，由连接器在对账时报告为 `ambiguous`（connector-pi.md §6.3），DO 把 `outbox` 标 `ambiguous` 并交给总管处理，**不自动重发**。

### 4.3 事件流（连接器 → DO）：至少一次，DO 去重

- 每个 worker 的事件有单调递增的 `seq`（connector-pi.md §11.3）。
- 连接器发送 `events` 批次，DO **先写入 `event_inbox`（`(workerId, seq)` 唯一）再确认**；`events_ack{workerId, upTo}` 是累积确认，表示 `≤ upTo` 的事件已持久化。DO 对确认做 500 ms 的合并。
- 连接器收到确认后才可以截断本地日志。
- **缺口检测**：DO 发现收到的 `seq` 大于 `已收最大值 + 1`，发 `resync{workerId, from}`；连接器从 `from` 重放。若本地日志已因上限被丢弃，回 `events_gap{workerId, from, to}`，DO 在时间线上标记缺口并触发 `reconcile`。
- **处理与持久化分离**：`event_inbox` 记录「收到」，总管处理事件（更新 Thread、通知用户）以 `processed_upto(workerId)` 为界；DO 在处理中途被逐出，下次从 `processed_upto` 继续，处理本身对同一 `(workerId, seq)` 幂等。

### 4.4 为什么不是 exactly-once

两端都可能在任意时刻崩溃，exactly-once 做不到。取舍是：**命令至少一次投递，但由连接器按 `cmdId` 去重，并且遇到无法判定的情形宁可报告 `ambiguous` 也不重发**；事件至少一次，由 `(workerId, seq)` 去重。结果在语义上等同于 exactly-once，且崩溃场景有明确归宿。

## 5. 鉴权与配对

### 5.1 设备令牌

令牌由 DO 在配对时签发，格式：

```
st1.<deviceId>.<epoch>.<issuedAt>.<mac>
mac = HMAC-SHA256(SERVER_KEY, "st1." + deviceId + "." + epoch + "." + issuedAt)
```

- `SERVER_KEY` 是部署时生成并存放于 Worker 密钥的随机值。
- **Worker 层预检**（`onBeforeConnect`，不唤醒 DO）：校验格式和 `mac`，不通过直接返回 401。乱撞的请求到不了 DO，也不会触发 DO 计费。
- **DO 层检查**（`onConnect`）：查 `device` 表，确认设备存在、`epoch` 与当前一致、未被撤销，否则以 `4401` / `4403` 关闭。
- 撤销 = 把该设备的 `epoch` 加一并关闭其连接，之前签发的令牌随即失效，无需维护黑名单。
- 令牌是**持有者令牌**：被偷走即可冒充该设备。缓解：传输只用 TLS；本地以 `0600` 权限保存；撤销简单；后续可升级为设备密钥对加签名挑战，协议已为此预留（`hello.auth` 扩展字段）。

### 5.2 配对流程

```
用户(飞书/网页)      DO                         连接器(用户机器)
   │ "添加机器"        │                              │
   │─────────────────▶│ 创建 pairing{code, 10min}     │
   │◀── 命令提示 ──────│                              │
   │  npx shepherd connect <url> <code>              │
   │ ………………………………在目标机器终端粘贴运行 ……………………………▶│
   │                  │◀── POST /pair {code, machine}─│
   │                  │ 校验 code：存在、未过期、未用过   │
   │                  │ 创建 device，签发令牌           │
   │                  │─── {deviceId, token, wsUrl} ─▶│ 保存凭据 0600
   │                  │◀──────── wss 连接 + hello ────│
   │◀── "mac-studio 已连接" ─│                          │
```

- 配对码：8 位 Crockford Base32（40 比特），**仅在用户发起「添加机器」后的 10 分钟内有效，一次性**。
- `/pair` 是 Worker 上唯一的未认证入口。限流：同一来源 IP 与全局都有失败次数上限（如 5 次失败后锁定 15 分钟），码的熵加上短有效期使暴力枚举不可行。
- 配对只发生一次；之后连接器只用令牌。连接器保存 `{serverUrl, deviceId, token}`，服务器地址写入后**不允许降级到非 TLS**（本地开发除外）。
- 命令提示由总管在聊天里发给用户，用户在要接入的电脑上执行，因为配对必须由机器所有者在本机完成。

### 5.3 角色与权限

| 角色 | 如何识别 | 可发送 | 可接收 |
|---|---|---|---|
| `connector` | 令牌有效 | `hello`、`cmd_ack`、`cmd_result`、`events`、`history_chunk`、`machine_update`、`error` | `welcome`、`cmd`、`events_ack`、`resync`、`history_req` 等 |
| `web` | 由 IM 下发的一次性链接换取的会话（另文设计） | `subscribe`、`history_open` 等浏览器类消息 | 状态推送、历史块 |

连接器连接发送浏览器类消息，或浏览器连接发送连接器类消息，一律回 `error{code:"forbidden"}` 并计数；多次违规可关闭连接。

### 5.4 命令的信任

- 连接器只接受**自己这条已认证连接**上的命令。
- 仓库白名单、`approveProject` 仅限本机设置等约束在连接器本地强制执行（connector-pi.md §8.1、§13），不因命令来自「可信的总管」而放松。这是对总管端被攻破的最后一道防线。

## 6. 消息目录

### 6.1 握手

**`hello`**（连接器 → DO，连接后第一条）

```json
{
  "t": "hello", "id": "...",
  "protocol": { "min": 1, "max": 1 },
  "deviceId": "dev_…", "bootId": "…", "connEpoch": 42,
  "connector": { "version": "0.1.0", "os": "darwin", "arch": "arm64", "node": "22.13.0" },
  "machine": { "name": "mac-studio", "memTotalMB": 65536, "memFreeMB": 31000 },
  "agents": [ { "kind": "pi", "version": "1.2.0", "capabilities": { "steer": true, "followUp": true, "interrupt": true, "resume": true, "history": true, "images": true, "structuredReport": true, "readonly": true } } ],
  "repos": [ { "repoId": "…", "name": "shepherd", "path": "/Users/x/code/shepherd", "defaultBranch": "main", "remote": "git@github.com:…" } ],
  "limits": { "maxWorkers": 4, "running": 1 },
  "workers": [ { "workerId": "w…", "agent": "pi", "state": "idle", "lastSeq": 128, "sessionId": "…", "lastOutcome": "reported:done" } ],
  "pendingAcks": [ { "cmdId": "…", "state": "done" } ]
}
```

- `bootId`：连接器进程每次启动随机生成。DO 据此区分「网络闪断重连」（同一 `bootId`）和「连接器重启」（新 `bootId`，期间所有 pi 进程已退出）。
- `workers` 是连接器视角的全量快照，用于对账。

**`welcome`**（DO → 连接器）

```json
{
  "t": "welcome", "re": "<hello.id>",
  "protocol": 1, "serverTime": 1791965696285, "sessionId": "…",
  "acks": { "w…": 126 },
  "limits": { "maxMessageBytes": 262144, "batchMs": 250, "batchEvents": 50 }
}
```

- `acks`：DO 已持久化的每个 worker 的最大 `seq`。连接器从其后重放。
- 协商失败：`4426`，并在关闭原因里给出支持的版本范围。

随后 DO 重发 `outbox` 里未确认的命令（§4.2）。

### 6.2 命令（DO → 连接器）

统一外壳：

```json
{ "t": "cmd", "id": "<cmdId>", "cseq": 118, "kind": "start_worker",
  "workerId": "w…", "notAfter": 1791966296285, "args": { … } }
```

| `kind` | `args` | 说明 |
|---|---|---|
| `start_worker` | `threadId, repoId, mode, base?, prompt, images?, model?` | 对应 connector-pi.md §6.1；`repoId` 必须在连接器的白名单内 |
| `send` | `text, images?, intent` | `intent: now \| after \| auto` |
| `interrupt` | `then?: { text }` | 中止，可选地接一条新指示 |
| `resume` | `reason` | |
| `stop_process` | 无 | |
| `cleanup_worktree` | `force?` | |
| `reconcile` | 无 | 要求重发 `hello.workers` 的快照 |
| `diag` | 无 | 要求返回诊断信息 |

图片以 base64 放在 `images`，连同整条命令必须不超过 256 KiB（约 190 KB 的图片字节）。超出的由总管端在下发前压缩（缩小或转 JPEG）；仍放不下则拒绝并告知用户。更大图片的传递方式见 §8 待决事项第 3 项，MVP 不实现。

### 6.3 命令确认与结果（连接器 → DO）

```json
{ "t": "cmd_ack", "re": "<cmdId>", "status": "accepted" }
{ "t": "cmd_ack", "re": "<cmdId>", "status": "duplicate", "result": { "ok": true, "data": { } } }
{ "t": "cmd_ack", "re": "<cmdId>", "status": "rejected", "code": "not_registered_repo" }
{ "t": "cmd_result", "re": "<cmdId>", "ok": true, "data": { "sessionId": "…", "branch": "shepherd/login-1", "effect": "after_current_tools" } }
{ "t": "cmd_result", "re": "<cmdId>", "ok": false, "error": { "code": "lock_held", "message": "…", "retriable": false } }
```

`start_worker` 的 `cmd_result` 在 worker 进入 `running` 后发出（不等任务完成）；任务进展与结束走事件流。

### 6.4 事件（连接器 → DO）

```json
{ "t": "events", "id": "…", "batch": [
  { "workerId": "w…", "seq": 129, "ts": 1791965700000, "type": "progress", "phase": "tool", "tool": "edit", "target": "auth/session.ts", "turn": 3 },
  { "workerId": "w…", "seq": 130, "ts": 1791965712000, "type": "report", "status": "done", "summary": "…", "changes": ["…"], "git": { "branch": "shepherd/login-1", "ahead": 2, "dirty": 0, "pushed": false } },
  { "workerId": "w…", "seq": 131, "ts": 1791965712500, "type": "settled", "outcome": "reported", "usage": { "tokens": { "input": 2317, "output": 101 }, "cost": 0.004 } }
] }
```

事件类型和载荷见 connector-pi.md §11.1，此处不重复。`events_ack{workerId, upTo}` 为反向确认。`resync` 与 `events_gap` 见 §4.3。

### 6.5 机器状态

**`machine_update`**（连接器 → DO）：仓库增删、资源变化、连接器升级等。

```json
{ "t": "machine_update", "repos": [ ], "limits": { "maxWorkers": 4, "running": 2 }, "memFreeMB": 18000 }
```

仅在变化时发送。

### 6.6 历史（原始过程）中继

网页要查看某个 worker 的原始过程时，DO 作为**中继**，不存储内容。

1. 浏览器连接发 `history_open{workerId, since?, maxBytes}`。
2. DO 写入 `relay(reqId, webConnId, workerId, expiresAt)`，向连接器发 `history_req`（外壳同 `cmd`，`kind:"history"`，但不进入 `outbox`、不重发）。
3. 连接器返回若干 `history_chunk`：

```json
{ "t": "history_chunk", "re": "<reqId>", "n": 0, "entries": [ { "role": "assistant", "text": "…", "tools": [ ] } ], "cursor": "e91…", "done": false }
```

4. DO 查 `relay` 找到对应的浏览器连接并转发，收到浏览器的确认后（`history_ack{reqId, n}`）才通知连接器发下一块（简单的窗口控制，窗口大小 2）。
5. 结束条件：`done: true`、浏览器关闭连接、超时（60 秒）或累计超过 `maxBytes`（默认 2 MB）。

约束：

- 每块 ≤ 256 KiB。
- `relay` 放 SQLite，因为 DO 可能在两块之间休眠。
- 内容**经过 DO 内存，但不落盘**。日志里不记录内容。
- 机器离线时 DO 直接对浏览器返回 `machine_offline`。

### 6.7 错误

```json
{ "t": "error", "re": "<msgId>", "code": "forbidden", "message": "…", "retriable": false }
```

`code` 取值：`bad_request`、`unauthorized`、`forbidden`、`not_found`、`conflict`、`busy`、`expired`、`unsupported`、`too_large`、`rate_limited`、`internal`。

## 7. 关键流程

### 7.1 派发一个任务

```
总管任务(pi-durable)   DO outbox/协议层         连接器                  pi
   │ dispatch(start)     │                         │                      │
   │────────────────────▶│ 写 outbox(queued)       │                      │
   │                     │ cmd{start_worker}──────▶│ 落盘 command 表        │
   │                     │◀──── cmd_ack(accepted) ─│ 建 worktree，拉起 pi ──▶│
   │                     │◀──── cmd_result(ok) ────│ 发 prompt            │
   │◀── 唤醒总管(结果) ───│ outbox 标 done           │                      │
   │                     │◀── events(progress…) ───│◀──── 事件流 ───────────│
   │                     │ 写 event_inbox，events_ack│                      │
   │                     │◀── events(report, settled)                      │
   │◀── 唤醒总管(汇报) ───│                          │                      │
```

幂等键：总管工具调用把 `cmdId` 取自工具调用 ID（或 `requestId`），崩溃后重放同一调用得到同一个 `cmdId`，`outbox` 的主键保证不会产生第二条命令（与 pi-durable 的 `requestId` 幂等机制配合）。

### 7.2 断线重连与重放

```
连接断开 ─▶ 连接器退避重连 ─▶ wss + 令牌 ─▶ hello(workers, 各 lastSeq, pendingAcks)
                                                 │
                    DO: 校验、取代旧连接 ◀────────┘
                    DO ─▶ welcome(acks) ─▶ 连接器从 acks 之后重放事件
                    DO ─▶ 重发 outbox 中 sent 未 accepted 的命令
                    连接器: 对已处理的返回 cmd_ack(duplicate)
```

### 7.3 机器离线时下发命令

- DO 发现机器无有效连接：命令写入 `outbox`（`queued`），同时立即对总管返回「机器离线」，由总管问用户「等它上线，还是换一台」（spec §9）。
- 用户选「等」：命令的 `notAfter` 设为 `null`，机器上线后 `welcome` 之后自动投递。
- 用户选「换」：该命令标 `expired`，另建新命令发往其他机器。

### 7.4 中止

`interrupt` 命令作为普通命令走 `outbox`，不享受优先通道。`abort` 本身是毫秒级操作，网络往返是主要延迟。若连接器有多条排队命令，`interrupt` 在其所属 worker 的队列里仍按 `cseq` 顺序执行，但**连接器在收到 `interrupt` 时应立即对该 worker 执行 `abort`**，把队列里排在它前面、尚未开始投递的 `send` 视为被取代（返回 `result{ok:false, code:"superseded"}`）。

## 8. 待决事项

1. **唤醒总管的机制。** `cmd_result` 和事件到达后如何唤醒 pi-durable 里的总管任务：候选是写 document 触发 watch，或对主 conversation 提交一条 `followUp` 输入（参考 pi-durable 例 23）。需要原型验证。这也是此前遗留的「task 如何等待外部事件」的落点。
2. **事件的处理节流。** 每个 `events` 批次都唤醒总管处理会让 DO 常醒。倾向：`progress` 只入库、不唤醒；`report/settled/lost/error/external_activity` 才唤醒处理。
3. **大图片的传递**：connector-pi.md 允许单张图 base64 到 4 MB，超过本协议 256 KiB 的单消息上限。备选：总管端压缩到上限内（MVP 做法）；先暂存到 R2、命令里只带引用，连接器经带签名的 URL 下载（Cloudflare 内，一键部署可含）；连接器单独走 HTTP 分块上传。倾向后续用 R2 暂存。
4. **兴趣驱动的进度级别。** 默认静默（`coarse`）；用户在网页上打开某个 worker 时，通过 `set_progress{workerId, level:"live"}` 提高频率，离开后恢复。减少无人观看时的唤醒。需要在命令集里加这一条。
5. **设备密钥对**（Ed25519 签名挑战）何时替换持有者令牌；`hello.auth` 已预留。
6. **`web` 角色的会话**如何由 IM 链接换取（一次性链接、有效期、与 owner 的绑定），属于配套网页设计。
7. **同一 DO 内处理浏览器连接与连接器连接的负载隔离**：消息类型多了之后，是否拆分为两个 Agent 类，并共用同一个 SQLite（不可行，不同 DO 不共享存储），因此倾向保持一个类，用角色分发。
8. **时钟**：`ts` 仅诊断。`notAfter` 依赖连接器时钟与 DO 时钟的差，可在 `welcome.serverTime` 里让连接器计算偏移并在本地校正。

## 9. 需要原型验证的点

按优先级：

1. 休眠与唤醒：连接器的 `ping` 是否真的不唤醒 DO；唤醒后第一条消息的延迟；休眠中 alarm 驱动的重发是否可靠。
2. `onBeforeConnect` 中用 Worker 密钥做 HMAC 预检，且不唤醒 DO。
3. 自定义关闭码（4401、4403、4409）是否原样到达 Node 的 `ws` 客户端。
4. 命令重发加连接器去重的端到端行为，包括在 `sending` 阶段杀连接器。
5. 笔记本睡眠、网络切换后，半开连接多久被发现。
6. 事件批量的实际唤醒频率和时长费用。
7. 历史中继在 DO 休眠间隙的行为（`relay` 表驱动）。
