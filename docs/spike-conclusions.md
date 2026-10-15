# Spike 阶段结论

> 状态：**已收官**（2026-10-15）。本文是 `spikes/` 全部验证工作的结论沉淀，写给正式实现的执行者（人或 agent）：读完本文 + [spec](spec.md) + [design](design/) 即可开工，**不需要阅读 spike 代码**。所有代码封存在 git tag `spike-final`，按需 `git show spike-final:<path>` 查证。

## 0. 总结论

设计的关键假设**全部实证通过**：DO 上的总管协议、真模型路由、pi/Claude Code 双 agent 裁决与分支接力、可靠性层（看门狗/心跳/孤儿清扫/reap）、飞书卡片交互（含同意门控）、一键部署、无 LLM 例程。系统在生产环境跑过完整闭环，并扛过一次 4 小时云平台故障（零数据丢失，自动恢复）。**正式实现可以开工**；本文第 2、3 节是用真实代价换来的答案，优先读。

## 1. 各 spike 验证范围

| Spike | 验证了什么 | 关键产出 |
|---|---|---|
| `do-protocol` | DO↔连接器 WebSocket 协议骨架（配对、outbox、ack、重发） | 协议设计修正，见 [research/do-protocol-spike.md](research/do-protocol-spike.md) |
| `pi-rpc` | pi `--mode rpc` 的事件与控制面 | 事件形状、adjudication 输入 |
| `feishu-webhook` / `feishu` | 飞书入站 webhook、出站卡片、按钮回调 | 通道方案 [research/feishu-channel.md](research/feishu-channel.md) |
| `steward-m1` | 总管核心：账本（SQLite on DO）、reducer、汇报模板、outbound 队列 | 15/15 测试；`sh_*` 表结构雏形 |
| `steward-m2` | 总管作为 pi-durable 扩展：工具集、policy hook、真模型路由 | 路由 eval **100/106 (94.3%)**；settle-time 派发核验 |
| `e2e` | 全链路部署上线：Feishu → 总管 → 连接器 → 真实 worker → 卡片 | 一键 bootstrap；M3 可靠性层；11 条 bug 清单 |

## 2. 集成层的坑（设计文档里没有、必须带走的答案）

每一条都是实测踩出来的，正式实现直接按此处理：

**pi RPC**
- 响应用 `success` 字段，**不是 `ok`**；判 `r.success === false || r.error`。
- 事件流：`agent_start` / `tool_execution_start{toolName,args}` / `message_end` / `auto_retry_end` / `agent_settled{aborted,outcome}`。

**Claude Code headless**
- 命令形态：`claude -p --output-format stream-json --verbose --mcp-config <cfg> --append-system-prompt <text>`（权限放行按产品决定，spike 用了 `--dangerously-skip-permissions`）。
- **stdin 的 prompt 只在 EOF 后才开始处理**：写完必须 `stdin.end()`，否则进程永远挂着（实测栽过）。
- MCP 工具调用到达时**带命名空间**（`mcp__shepherd__report`），不能按裸名 `report` 匹配；用 `endsWith("__report")` 这类后缀匹配。
- stream 事件 `system/init`、`assistant{message:{content:[tool_use|text]}}`、`result{subtype,is_error}`；stop_reason 映射 `{end_turn→stop, tool_use→tool_use, max_tokens→length}`。
- 自定义 MCP server（如 report 工具）只需 LF 分隔的 JSON-RPC over stdio：initialize → tools/list → tools/call，~40 行。
- Claude worker 与 pi worker 可在同一账本混跑，裁决路径完全一致（实测：接力分支跨 agent 类型传递）。

**Cloudflare DO 部署现实**
- **常驻 isolate 会钉住旧代码与旧 secrets**：`wrangler deploy` 返回后几分钟内，被 WebSocket/alarm 挂住的 DO 仍跑旧版本。轮换 secret 后必须让它被逐出（断连+空闲）再验证。病态 isolate 的恢复手法：同代码重部署强制逐出。
- `CREATE TABLE IF NOT EXISTS` 不会给已存在的表加列——线上迁移要幂等的 `ALTER TABLE`。
- DO 存储挂了（平台故障）表现为全量 1101，**Worker 脚本本身的路由仍正常**——用这个区分故障层。
- pi-ai 在 Workers 里别用 env-var 认证：`createProvider` + 内联 `auth.apiKey.resolve`；`PiModel` 是 `{provider, id}`。

**连接器可靠性（最重要的四条）**
- **TCP 半死是常态**：两端 `send()` 都不报错，字节就是不到。唯一解：双向应用层心跳（上行 ping / 下link pong + 帧间超时强制断开重连），加 cmdId 幂等去重 + `failed` 状态命令在 hello 时重投。实测一次真实断网靠这个自愈。
- **DO 按事件去重**，所以连接器重启后事件 seq **必须续号**（持久化 seqs.json），从 1 重来会被全部吞掉。
- **stall 判定**：无 stdout 达阈值 **且** CPU 两次采样 <5%（`ps -p PID -o %cpu=`）才算挂死——安静但 CPU 高的是编译，不是 stall。一次自动重启（同 worktree，注入「从中断处继续」提示），二次 → `error:stall` 结案。
- 连接器崩溃/重启时，在跑的 worker 靠**锁文件 + worktree 残留**被识别为孤儿：锁在=崩溃时活着→报 lost；干净 worktree 直接清掉。DO 侧兜底 reap（running + 离线 10 分钟，或在线沉默 45 分钟 → lost）。

**接力（relay）依赖线程路由**
- 分支接力是线程级查找：接续消息如果路由去了**新线程**，base 查不到，leg-2 从 HEAD 重来——计划文档根本不在盘上。
- 解法在提示词层：总管规则明确「按 X 方案实施 / 接着 X 继续 / 在 X 基础上做（X 是某线程产出）→ attach 该线程」；反例（X 是外部文档）仍应新建。eval 6 个接力案例 6/6。
- worker 接力机制：DO 在 start_worker 时带 `base = 该线程最近一次 worker 的分支`，连接器 `git worktree add -b shepherd/<id> <dir> <base>`。

**飞书卡片交互**
- 按钮回调里只有 `open_message_id`——用出站记录表 `providerMsgId` **反查线程**，不要把线程 id 塞进按钮 value（卡片 JSON 会被飞书转述，塞多了乱）。
- 同意门控形态：汇报卡 [同意]/[先不要] → callback → `pr_worker` 命令（推分支 + `gh pr create`）→ 结果异步回到聊天。**happy path 未线上点击验证**（设计上必须用户本人点）。
- digest 例程走**无 LLM 的确定性渲染**（running/questions/unread → 卡片），quiet 时静默；`every@Ns` / `daily@HH:MM UTC` 两种调度，自调度 alarm 续命，owner 可停用。

**协议杂项**
- outbox 命令状态机：`queued → sent → acked / failed(timeout|rejected)`；hello 重投 queued+sent，**timeout-failed 也要重投**（半死连接的产物），靠 cmdId 去重防重放。
- 双 send 竞态：出站投递用 claim token（条件 UPDATE + 属主校验）。
- 派发后 settle-time 核验：对照 dispatchSeq 计数与回复文本里的「已派发」声明，不符 → 纠正性 follow-up run。实测无假阳性。

## 3. Bug 清单 → 正式实现的回归测试用例

spike 期间线上踩到并修掉的（细节见 tag `spike-final` 的 `spikes/e2e/README.md`）：

1. 双 send 竞态重复投递 → claim token。
2. `CREATE TABLE IF NOT EXISTS` 不迁移已有表 → 幂等 ALTER。
3. Feishu send 无超时无重试，挂死事件处理 → 10s 超时 + alarm 驱动重试。
4. 派发选中死设备（isolate 换掉后 socket 静默消失）→ 线程记住上次的机器，离线时排队等重连。
5. queued 命令永不重试 → 周期 sweep，设备回来即投，空闲 ~30 分钟判 failed。
6. 常驻 DO 钉住旧 secrets/代码 → 逐出后再验证部署。
7. pi-ai 在 Workers 的 provider 构造姿势（见上）。
8. pi RPC `success` vs `ok`（见上）。
9. 单回合派发守卫泄漏到下一回合 → 守卫随 provenance 重置。
10. **下行也能静默死**：DO 看似连接健康、命令 ack 超时报 failed、hello 不重投 failed → 永久丢失。修：双向心跳 + failed 重投 + cmdId 去重。
11. **路由决定接力是否存在**：「按 X 方案实施」开新线程 → 接力基础丢失。修：提示词接续规则 + eval 案例。

## 4. 量化结果（正式实现的基线）

- 路由 eval（deepseek-flash，106 例）：**94.3% 通过**，错路由 1.9%（目标 <2%），漏反问 0%，多余反问 4.2%（目标 <15%）。数据集在 `spike-final:spikes/steward-m2/eval/dataset.ts`——**106 条带理由标注的案例，建议正式实现直接继承当回归集**。
- 契约测试：connector 19/19，steward-m1 15/15，steward-m2 7/7。fake-pi 场景（happy/unreported/error×3/aborted/crash/throttle/stall×2/…）与 mock-steward（ping 计数、吞帧、断连）是测试基建的样板。
- 线上：digest 例程准点复现；send 改变运行中 worker 的交付物；interrupt 秒级打断；孤儿清扫回收 5 个丢失事件；reap 修复卡死线程。

## 5. 实战事件

- **4 小时云平台故障**（Cloudflare「Elevated Errors in China Network Colos」，2026-10-15）：DO 全量 1101、重部署无效（非 isolate 问题）、Worker 路由正常。连接器 5s 重试全程自愈，恢复即重连 + hello，落库数据零丢失，恢复窗口内 daily digest 准点发出。**结论：DB-backed 队列 + 幂等重试的设计正确，这类故障不需要任何人工干预。**
- 两次真实 worker 挂死（1.4% CPU 沉默 20 分钟）→ 看门狗设计由此而来。
- 一次真实家庭网络中断 → 心跳路径自愈。

## 6. 移交正式实现的缺口（按优先级）

1. **连接器重启自动续跑**：现在重启=报 lost（孤儿/reap），用户需重新派发。需要把「锁文件 + 进程指纹」升级为可恢复的 session 续接。
2. **聊天内干预入口**：send/interrupt 目前只有 `/admin/*` HTTP 路由；要变成飞书内的自然语句（「停掉那个」「改成用 pnpm」→ 总管调 interrupt/send）。
3. **pr_worker happy path**：等一次真实的 [同意] 点击完成闭环验证（门控设计保留）。
4. **安装与分发形态**：现在连接器是 nohup 挂的裸脚本。要决定 npm 包 / Tauri / launchd 服务，以及开机自启、升级。
5. **多机调度策略**：白名单已有多仓库；跨机器选机（负载、在线、亲和）未做。
6. **安全加固**：admin token 走 HTTP 头（无轮换）、SERVER_KEY 长期有效、飞书回调验签的密钥管理。
7. settle-time verify 的自然触发统计（目前零假阳性，样本还小）。

## 7. 代码处置

`spikes/` 整体从工作树移除（结论已沉淀本文），git tag `spike-final` 保留全部历史以备查证。线上部署的 `shepherd-hook` worker 与本机连接器进程在正式实现接管前可继续运行（见第 5 节，故障期也无需照看）。
