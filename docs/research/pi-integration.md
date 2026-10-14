# pi 对接调研

日期：2026-10-14。对象：pi 的 RPC 模式（`pi --mode rpc`），作为 Shepherd 连接器驱动的第一个 agent。

证据分三类：

- **实测**：在本机用 pi 1.2.0 和默认模型 `zhipu/glm-5.3` 跑过，脚本见 [spikes/pi-rpc](../../spikes/pi-rpc)。样本量小，多数只跑一次。
- **源码 / 文档**：读 `earendil-works/pi` 仓库（`packages/coding-agent`）得出，未实测。
- **未验证**：见最后一节。

## 1. 对接方式

| 方式 | 形态 | 结论 |
|---|---|---|
| `pi --print` / `--mode json` | 一次性进程 | 不适合需要插话和续上的场景 |
| **`pi --mode rpc`** | 常驻子进程，stdin 收 JSONL 命令，stdout 出响应和事件 | **采用** |
| SDK（`createAgentSession`） | 进程内调用 | 无进程隔离，会话共享进程与默认的文件型设置和凭据，文档建议隔离场景用 RPC。不采用 |

RPC 要求严格的 LF 分帧（不能用按 Unicode 行分隔符切分的读取器），stdout 只放协议记录，日志走 stderr，客户端必须持续读 stdout，否则会被背压卡住。

## 2. 实测结论

| # | 结论 | 实验 |
|---|---|---|
| 1 | `--extension <path>` 可按进程注入扩展；agent 能调用注入的 `report` 工具，结构化参数完整回传 | A |
| 2 | `steer` 不会打断正在执行的工具，要等本批工具跑完才生效（`sleep 8` 期间发出的 steer，在 sleep 结束后才改变行为）；`follow_up` 在全部结束后才处理 | B |
| 3 | `abort` 响应约 3 ms，会杀掉 bash 子进程，事件为 `agent_settled{aborted:true}`，进程仍可接新指令 | E |
| 4 | 对 pi 发 SIGKILL 后会话已落盘；用 `--session` 起新进程可读回对话，末尾悬空的工具调用（有调用无结果）不影响继续 | C |
| 5 | 连接器被 SIGKILL 后，pi 和它的 `sleep` 子进程在 2 秒内全部退出，没有孤儿 | H |
| 6 | 5 个 pi 并发：就绪约 350 ms；空闲约 135 MB RSS，跑完一个小任务后约 153 MB；共用一个会话目录互不冲突（各一个文件） | G |
| 7 | `new_session`、`switch_session`、`fork` 可用；`new_session` 产生新的 sessionId 和新文件 | F |
| 8 | `get_entries` 在一个很小的会话（9 条）就有约 15 KB（含系统提示）；`limit` 参数被忽略 | F |
| 9 | 图片输入：base64 PNG 被接收并原样保存；256x256 纯红图回答 "Red"。16x16 的图模型答非所问，属模型侧问题 | J |
| 10 | 无界面时，项目本地 `.pi/` 扩展默认**不执行**，不弹确认，不发 `extension_ui_request`；加 `--approve` 才执行；`--no-approve` 与默认行为一致。**`AGENTS.md` 无论信任与否都会加载** | L |
| 11 | `report` 调用率：仅靠工具描述 5/6（另一轮 3/4）；加 `agent_before_settle` 钩子强制补一次后 6/6，其中 1 次由钩子补救，无重复调用 | I、spike3 |
| 12 | 不注入扩展、模型用文字提问时，协议里只有 `agent_settled` 和最后一条文字，没有「在提问」信号 | I |
| 13 | 模型调用失败（403）**没有错误事件**，只在最后一条 assistant 消息上有 `stopReason:"error"` 和 `errorMessage` | A |
| 14 | 一个很小的任务，stdout 约 55–76 KB、49–90 条 `message_update` | I |
| 15 | **pi 自己被 SIGKILL 后，它启动的工具子进程（`sleep 33`）仍然存活**（6 秒后仍在），成为孤儿。与 #5 对比：连接器被杀时 pi 会因 stdin 关闭而优雅退出并清理子进程，但 pi 被直接杀时不会 | K |
| 16 | `--tools read,grep,find,ls,report` 能把 agent 限制为只读：被要求建文件时它没有可用工具，如实说明并调用 `report` 报告受阻，文件未创建；注入扩展的工具名也能出现在 `--tools` 白名单中 | M |

## 3. 源码与文档结论（未实测）

**RpcClient**（`src/modes/rpc/rpc-client.ts`）：从主入口导出，但把命令写死为 `spawn("node", [cliPath, ...])`，`cliPath` 默认 `dist/cli.js`，不能直接启动已安装的 `pi` 二进制；stderr 无上限累积；崩溃后不自动重启，需先 `stop()` 再 `start()`；`stop()` 清空待处理请求而不拒绝它们。包 `@earendil-works/pi-coding-agent` 是否已发布到 npm，仓库里说不清。

**命令集**（`rpc-types.ts`）：`prompt{message, images?, streamingBehavior?}`、`steer`、`follow_up`、`abort`、`clear_queue`、`new_session`、`get_state`、`get_messages`、`get_entries{since?}`、`get_tree`、`get_fork_messages`、`get_last_assistant_text`、`get_session_stats`、`switch_session`、`fork`、`clone`、`set_model`、`set_thinking_level`、`compact`、`set_auto_retry`、`abort_retry`、`bash`、`abort_bash`、`set_session_name`、`get_commands` 等。

**会话**：
- 存储在 `~/.pi/agent/sessions/--<cwd 路径转义>--/<时间戳>_<sessionId>.jsonl`；JSONL 第一行是 header，其余是带 `id/parentId` 的树状条目（`message`、`model_change`、`compaction`、`custom`、`custom_message` 等）。
- `--session <path|id>`：含 `/` 或以 `.jsonl` 结尾视为路径，否则按 ID 或 ID 前缀在当前项目内找，再全局找。
- `--session-id <id>`：用确切 ID 在当前项目内打开或创建；允许字符为字母、数字、`.`、`_`、`-`，首尾须为字母或数字。
- **没有文件锁**，写入是普通追加；同一会话文件被两个进程同时打开是未定义行为。
- 不启动 agent 也能读：`SessionManager.list/open` 静态方法，或直接解析 JSONL。
- `get_entries` 的 `since`（某个条目之后）是唯一的增量读取；其余读取命令无分页、无过滤。

**事件**：`agent_end` 之后可能还有重试、压缩、队列消息，**真正结束看 `agent_settled`**。重试事件为 `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}` 和 `auto_retry_end{success,attempt,finalError?}`，默认最多重试 3 次。没有专门的「运行失败」标志。

**扩展钩子**：`agent_before_settle` 是「最后一个可操作的边界」，可返回 `{entries:[custom_message...], continue:true}` 追加条目并强制再发一次模型请求，文档提醒必须防循环；`agent_settled` 只是通知。扩展在进程内运行，拥有完整的操作系统权限，可写文件。

**系统提示**：`--system-prompt` 替换，`--append-system-prompt` 追加（可重复）；扩展可在 `before_agent_start` 中修改。

**关机**：stdin 关闭 → dispose → `abortBash()`、`agent.abort()` → `killProcessTree`。`SIGTERM/SIGHUP` 额外清理 detached 子进程。bash 子进程以 `detached: true` 启动，**pi 自己被 SIGKILL 时它们不会被回收**（未实测）。

**信任**（`src/core/project-trust.ts`）：无界面时 `hasUI=false`，不阻塞。顺序：`--approve/--no-approve` → 无受保护资源则信任 → 用户级扩展的 `project_trust` 事件 → `~/.pi/agent/trust.json` 中最近的记录 → `defaultProjectTrust` 设置 → 否则不信任。受保护资源是 `.pi/` 下的 `settings.json`、`mcp.json`、`extensions`、`skills`、`prompts`、`themes`、`SYSTEM.md`、`APPEND_SYSTEM.md`，以及 `.agents/skills`。`AGENTS.md`、`CLAUDE.md` 不受保护。

**用量**：`get_session_stats` 返回 `tokens{input,output,cacheRead,cacheWrite,total}`、`cost`、调用计数和 `contextUsage`；每条 assistant 消息带 `usage`。

**图片**：`prompt/steer/follow_up` 的 `images` 为 `{type:"image", data(base64), mimeType}`；RPC 层未发现大小限制，`read` 工具默认缩放到 2000x2000 px、4.5 MB base64，prompt 图片是否经同样缩放未确认；RPC 不支持 `@file`。

**仓库内现有集成**：没有现成的远程编排或网页 UI。`packages/env`（经 SSH 的远程工具执行）和 `packages/chord`（多进程可观察状态）是相关积木。

## 4. 对设计的约束

1. 连接器自己写薄的 RPC 客户端，不用 `RpcClient`。
2. 「完成 / 受阻 / 需要决策」靠 `report` 工具加 `agent_before_settle` 强制补一次；文字提问兜底分类仍需保留。
3. 失败检测必须检查最后一条 assistant 消息的 `stopReason` 与 `auto_retry_end`，只看 `agent_end` 或 `agent_settled` 会把失败当成完成。
4. 一个会话文件同一时刻只能有一个 pi 进程，由连接器保证。可用 `--session-id <workerId>`。
5. 默认 `--no-approve`；用户明确授权的仓库才用 `--approve`。`AGENTS.md` 始终会被读取，是提示注入面。
6. 每台机器限制并发 worker 数（约 150 MB 每个）。pi 异常死亡会留下孤儿工具进程，连接器要有进程组追踪和启动时的清理。只读任务用 `--tools` 白名单实现。
7. 原始事件在连接器内压缩后再上报；L3 原始过程按需用 `get_entries since` 或读 JSONL 拉取。
8. 「马上停」走 `abort` 加续上；「换个方向」走 `steer`，但要等当前工具结束。

## 5. 未验证

- 其他模型（Claude、GPT 等）上 `report` 的调用率和钩子行为。
- 长时间运行（数小时）的内存增长；运行中压缩对事件流的影响。
- `get_entries since`、`--session-id`、`auto_retry` 事件的实际表现。
- 机器睡眠 / 唤醒后 pi 进程与连接器连接的行为。
- 注入扩展时 `AGENTS.md` 中的指令与 `report` 约定冲突的情况。
