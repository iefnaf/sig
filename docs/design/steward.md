# 设计：总管（Durable Object 内部）

状态：草案 v0.1。依据：[产品 spec](../spec.md)、[连接器与 DO 的协议](connector-do-protocol.md)、[协议原型实测](../research/do-protocol-spike.md)。

本文设计 Durable Object 内部的一半：**记忆模块、路由、Thread 管理、事件处理、通知策略、主动行为，以及总管（LLM）怎么使用它们**。连接器一侧见 [connector-pi.md](connector-pi.md)，传输协议见 [connector-do-protocol.md](connector-do-protocol.md)。

## 0. 先给结论

1. **对话只是工作缓冲区，账本才是记忆。** 总管的 pi-durable 对话会被压缩、会变长，所以所有「事」的事实（Thread、worker、报告、笔记）放在我们自己的 SQLite 表里，由独立的记忆模块管理。总管每一轮从账本取最新情况，而不是靠翻对话历史。
2. **能确定的事不交给 LLM。** 事件到达后的状态推导（进行中 / 等你 / 空闲、未读、待回答的问题）是确定性的 reducer；`done` 类汇报由核心直接按模板发给用户，**不依赖 LLM 在线或预算**。LLM 负责判断：路由、回答 worker 的事实性提问、更新摘要、记笔记。
3. **「默认安静」由结构保证，而不是靠提示词。** 事件触发的运行，总管的普通文字输出一律丢弃；只有显式调用 `notify_user` / `ask_user` 才会打扰用户。
4. **「主动行为必须有出处」由工具参数强制。** 每个会启动工作的工具都必须带 `provenance`（用户消息、例程、跟进或巡视的 ID），没有就被拒绝。
5. **记忆模块有窄接口，整体可替换。** 总管、网页、飞书适配器只通过这个接口读写；分层、容量、检索、遗忘怎么实现，对外不可见。

## 1. 在 DO 里的位置

```
 飞书 / 网页 / 连接器                    （其余层见协议与连接器设计）
        │
 ┌──────▼───────────────────────────────────────────────────────────────┐
 │ Shepherd DO（单例 "owner"，Agents SDK 的 Agent）                       │
 │                                                                      │
 │  Channel 适配器      协议网关                    Web 读模型            │
 │  (入口去重、出口发送)  (连接器/浏览器连接、outbox)   (时间线、记忆页)      │
 │        │                  │                          ▲                │
 │        ▼                  ▼                          │                │
 │  ┌────────────────────────────────────────────────────────────────┐  │
 │  │ 核心（确定性）                                                   │  │
 │  │   事件 reducer ─ 通知策略 ─ 出站队列(outbound) ─ 调度器(alarm)    │  │
 │  └───────┬──────────────────────────────┬─────────────────────────┘  │
 │          │ 窄接口                        │ wake / tools              │
 │  ┌───────▼──────────────┐       ┌───────▼──────────────────────────┐ │
 │  │ 记忆模块 Memory       │◀──────│ 总管 Steward（PiHarness 对话）    │ │
 │  │  账本 Ledger          │ tools │  工具、系统提示、策略钩子          │ │
 │  │  笔记 Notes           │       └──────────────────────────────────┘ │
 │  │  检索 / 遗忘 / 摘要    │                                            │
 │  └──────────────────────┘                                            │
 │              同一个 SQLite（Shepherd 的表 + pi-durable 自己的表）        │
 └──────────────────────────────────────────────────────────────────────┘
```

- **核心**是确定性代码，没有 LLM，可单测。
- **总管**是 `PiHarness` 的根会话，持有一组工具；它不直接写 SQL，只通过工具调用记忆模块和协议网关。
- 两者共享同一个 SQLite 数据库。核心内部用 `ctx.storage.transactionSync` 做原子更新；与 pi-durable 的提交之间**不跨事务**，靠幂等键保证一致（§11）。

## 2. 记忆模块

### 2.1 职责与边界

记忆模块 = 账本（事实）+ 笔记（知识）+ 检索 + 生命周期（遗忘、摘要）。它回答三类问题：

- **这句话属于哪件事？**（路由）
- **现在各处什么情况？**（情况简报）
- **我该知道哪些背景？**（偏好、项目约定）

对外只暴露下面这组接口，**调用方不得绕过它读写表**：

```ts
interface Memory {
  // ---- 账本 ----
  threads: {
    create(input: NewThread): Thread;
    get(id: ThreadId): ThreadView;                        // 含摘要、worker、待回答的问题、相关项目笔记
    list(filter: { state?: ThreadState[]; repoId?: RepoId; limit: number }): ThreadSummary[];
    findCandidates(q: RouteQuery): RouteCandidates;        // §3
    update(id: ThreadId, patch: { title?: string; goal?: string; summary?: string }): void;
    archive(id: ThreadId): void;
  };
  workers: { register(w: NewWorker): Worker; get(id: WorkerId): Worker; listByThread(id: ThreadId): Worker[] };
  machines: { upsertFromHello(h: Hello): void; setOnline(deviceId: DeviceId, online: boolean): void; list(): MachineView[] };
  events: { apply(batch: WorkerEvent[]): ReduceResult };   // §5：落库 + reducer，一个事务
  handoff: { build(threadId: ThreadId, fromWorker?: WorkerId): HandoffBrief };   // §2.6

  // ---- 笔记 ----
  notes: {
    context(scope: { repoIds: RepoId[] }): NotesContext;   // 常驻层 + 相关项目层，带字数预算
    propose(n: NoteDraft): ProposeResult;                  // 返回相似/冲突候选，不直接写入
    commit(n: NoteDraft, opts: { replaces?: NoteId[] }): { note: Note; changes: ChangeReport[] };
    pin(id: NoteId, pinned: boolean): void;
    remove(id: NoteId): void;
    search(q: string, opts?: { scope?: NoteScope[] }): Note[];
  };

  // ---- 生命周期 ----
  maintenance(now: number): ChangeReport[];                // 衰减、降级、容量检查，由 alarm 调用

  // ---- 视图 ----
  views: { situation(): SituationBrief; timeline(id: ThreadId, since?: Cursor): TimelinePage; memoryPage(): MemoryPage };
}
```

`ChangeReport` 是记忆模块**主动告知**的变动（记下、淘汰、降级、覆盖、被用户固定）。总管必须把它们转达给用户（§9），这是「遗忘对用户可见」的实现点。

### 2.2 账本的数据模型

表名统一前缀 `sh_`。下面只列语义，不列全部列。

| 表 | 关键字段 | 说明 |
|---|---|---|
| `sh_machine` | `deviceId, name, online, lastSeen, capabilities, reliability` | 机器。`reliability` 记在线习惯，MVP 只记录 |
| `sh_repo` | `repoId, deviceId, path, name, defaultBranch, remote` | 连接器上报的仓库 |
| `sh_thread` | `threadId, title, goal, summary, summaryAt, state, unread, lastActivityAt, archived, createdFromMsg` | `state` 是**派生**值（§5），不由 LLM 或用户直接设置 |
| `sh_thread_repo` | `threadId, repoId` | 一件事涉及哪些仓库，路由的强线索 |
| `sh_worker` | `workerId, threadId, deviceId, repoId, agent, mode, state, sessionId, branch, parentWorker, lastOutcome, lastEventAt` | 一个 worker 一条记录。`parentWorker` 记录接力关系 |
| `sh_report` | `workerId, seq, status, summary, changes, decisions, leftovers, tests, question, next, git` | worker 的结构化收尾报告（协议中的 `report` 事件），交接简报的素材 |
| `sh_timeline` | `id, threadId, ts, kind, text, refs` | 供 L2 查看的摘要级时间线：用户指令、派发、汇报、提问、系统说明。不含原始过程 |
| `sh_question` | `qid, threadId, workerId, text, options, status, askedAt, answeredAt` | 待回答的问题，是「等你」状态的依据 |
| `sh_event` / `sh_worker_ack` | 协议层的事件收件箱与水位 | 见协议文档；这里增加 `processedUpTo` |
| `sh_inbound` | `channel, msgId, receivedAt` | 入站消息去重 |
| `sh_outbound` | `id, channel, kind, threadId, payload, urgency, status, attempts, providerMsgId` | 出站消息队列，兼作「回复某条消息 → 哪个 Thread」的映射 |
| `sh_routine` / `sh_watch` / `sh_followup` | 见 §8 | 主动行为 |
| `sh_command` | 协议层 `outbox` | 增加 `provenance` 列用于审计 |

线程的全文索引：`sh_thread_fts`（FTS5，覆盖 `title + goal + summary + 最近一次 report.summary`），触发器同步。FTS5 在 DO 的 SQLite 中受支持（官方文档）。

### 2.3 笔记的数据模型与分层

```
sh_note(noteId, layer, scope_repoId?, kind, text, bytes,
        source, evidence, confirmed, pinned,
        createdAt, lastUsedAt, useCount, status, supersededBy)
sh_note_fts(text)                     -- FTS5
sh_note_log(ts, op, noteId, reason)   -- 所有变动，驱动 ChangeReport
```

| 层 | `layer` | 内容 | 容量 | 加载方式 |
|---|---|---|---|---|
| 常驻层 | `resident` | 用户偏好、全局约定 | **2,400 字符**硬上限 | 每次对话都渲染进系统提示的一个段落 |
| 项目层 | `project` | 某个仓库的约定、机器上的注意事项 | 每个仓库 **1,500 字符** | 涉及该仓库的 Thread 被取出时，随工具结果注入 |
| 归档层 | `archive` | 被降级的旧条目、淘汰的历史版本 | 不限，不删除 | 只通过 `notes.search` 按需取 |

`kind`：`preference`（偏好）、`convention`（项目约定）、`environment`（环境事实）、`fact`（其他会影响调度的事实）。纯聊天不进笔记（spec §10.1）。

`source` 与可信度（spec §10.3，防记忆投毒）：

| `source` | 含义 | 可信度 | 能进常驻层？ |
|---|---|---|---|
| `user_said` | 用户亲口说的，`evidence` 为消息 ID | 高 | 是 |
| `connector` | 连接器上报的环境事实（仓库路径、已装 agent） | 高 | 否，只进项目层；以实时上报为准，不依赖笔记 |
| `worker_reported` | 来自 worker 的 `report.decisions` 等 | 低 | **否**，需用户确认后才升级 |
| `inferred` | 总管推断 | 低 | **否**，需用户确认后才升级 |

`confirmed=false` 的低可信条目只存在于项目层（标记为「待确认」），不出现在常驻层；用户说「对」或总管发起确认并得到肯定回答后，才把 `confirmed` 置真并允许升级。

### 2.4 记下、冲突与覆盖：两段式

模块是确定性的，**语义判断留给总管**，所以写入分两步：

1. `notes.propose(draft)`：模块做规范化去重（完全相同则只增加 `useCount`），并用 FTS 找出最相近的若干条，返回 `ProposeResult { duplicate?: NoteId, similar: Note[], needsEviction?: Note[] }`。
2. 总管看完候选，决定 `commit(draft, { replaces })`：相同含义的覆盖旧条目（旧条目进归档，保留历史版本），不同的并存。

容量处理：若写入会使常驻层超过 2,400 字符，`propose` 返回 `needsEviction`（按 §2.5 的分数从低到高排序，**排除已固定**）；总管选择淘汰哪些并在 `commit.replaces` 里带上，模块强制执行上限，超出则拒绝。总管不处理时，`maintenance` 会按同一分数自动淘汰最低的并生成 `ChangeReport`。

### 2.5 遗忘

三种触发（spec §10.2）：

1. **容量压力**：写入时淘汰（上面）。淘汰 = 降级到 `archive`，不删除。
2. **冲突覆盖**：`replaces`。旧条目 `supersededBy` 指向新条目。
3. **长期未被用到**：`maintenance` 每天由 alarm 运行一次，规则：
   - 项目层条目 `lastUsedAt` 超过 60 天且未固定 → 降级到归档。
   - 常驻层条目超过 90 天未使用且未固定 → 产生「建议降级」的 `ChangeReport`，**不自动降级**，由总管问用户（常驻层条目影响面大）。

保留分数（用于选择淘汰对象，越低越先淘汰）：

```
score = recency(lastUsedAt) × (1 + log(1 + useCount)) × sourceWeight × (confirmed ? 1 : 0.5)
sourceWeight: user_said 1.0 | connector 0.9 | worker_reported 0.4 | inferred 0.3
pinned 条目不参与
```

`lastUsedAt` 在条目被装配进总管上下文时更新；这是「被使用」的近似，足够 MVP。

每次变动写入 `sh_note_log`，`ChangeReport` 由它生成。用户在网页记忆页的编辑、删除、固定走同一套接口，同样记录。

### 2.6 摘要与交接简报

**Thread 摘要**是路由和情况简报的主要素材，所以要防止失真：

- 总管在处理 `report`/`settled`/`external_activity` 等唤醒时，调用 `threads.update(summary)`。摘要上限 600 字符。
- 模块保留最近 5 个摘要版本。每累计更新 10 次，提示总管**重写**而不是在旧摘要上修改（从时间线和报告重建），抑制漂移。
- 原始来源始终可回溯：`sh_timeline`、`sh_report`、以及连接器上的原始会话。

**交接简报**由 `handoff.build` 确定性地装配，总管再补上本次任务：

```
目标        ← thread.goal
当前状态    ← thread.summary
关键决定    ← 该 Thread 下所有 sh_report.decisions，去重，附来源 worker
遗留问题    ← 最新 sh_report.leftovers
指针        ← 分支、提交、改动文件（来自连接器的 git 事实，不是模型自述）
本次要做的  ← 总管撰写
```

简报放**指针而不是内容**（connector-pi.md §5.3 / spec §5.3）。

## 3. 路由

目标（spec §0 与原则）：宁可多问一次，也不要路由错。

### 3.1 信号，由强到弱

1. **显式引用**：用户在飞书里**回复/引用**了某条汇报或提问（飞书消息带父消息 ID），通过 `sh_outbound.providerMsgId → threadId` 直接确定 Thread。卡片按钮同理，按钮的回调数据里带 `threadId`。这类信号**不经 LLM 判断**，置信度最高。
2. **明确指代**：消息里出现 Thread 的标题、短 ID、或已登记的仓库名/机器名。
3. **语义匹配**：用户的描述与候选 Thread 的标题、目标、摘要相符。
4. **时间与状态**：最近活动的 Thread、状态为「等你」的 Thread 优先。

### 3.2 候选集

`threads.findCandidates({ text, hints })`：

1. 先应用 §3.1 的 1、2 两类信号，命中则只返回该 Thread，`confidence: "explicit"`。
2. 否则装配候选：全部「进行中」和「等你」的 Thread（通常很少）+ 对 `text` 做 FTS 召回的前 8 个其余 Thread + 最近活动的前 5 个；去重，上限 **12** 个。若 `hints` 里有仓库或机器，先据此过滤。
3. 每个候选返回：`threadId, title, 一句话摘要, 仓库, 状态, 最近活动时间, 匹配原因`。

个人规模下，整个候选列表几十行文字，直接让总管（LLM）在上下文里选，**不需要向量检索**。如果以后 Thread 规模增长，在 `findCandidates` 内部加向量召回，接口不变。

### 3.3 决策规则

总管调用 `find_threads` 拿到候选，然后选择：`attach`（接到某个 Thread）、`create`（新建）或 `ask`。由**确定性策略钩子**在其后把关（§7.2）：

- 候选中有 `explicit` 信号 → 允许直接 `attach`。
- 否则要求总管同时给出 `confidence ∈ {high, medium, low}` 和理由。
  - `high` 且唯一候选 → 允许，汇报里带一句「我把它接到了 xx」。
  - 其余 → 钩子拒绝执行，要求改为 `ask_user`（列出最多 3 个候选 + 「新开一件事」）。
- **新建 Thread 的条件**：派发了 agent 的事才建；纯聊天不建（spec §13）。

「接到已空闲的旧 Thread」时，汇报里要说明（spec §5.2）：「我把它接到了之前的 xx」。

### 3.4 路由评测

路由是产品价值的核心，必须有可度量的标准。构造一个固定的评测集：20–30 个模拟 Thread（含相似标题、同仓库多事件、已空闲多天），100 条话语，标注真实归属或「应当反问」。指标：

| 指标 | 目标 |
|---|---|
| 错路由率（自动接到错误的 Thread） | < 2% |
| 应反问却未反问 | < 3% |
| 不必要的反问率 | < 15% |

在换模型、改提示、改候选装配规则时回归这个评测集。

## 4. 总管（LLM）

### 4.1 形态

- `PiHarness` 的**根会话**，永不结束；上下文由 pi-durable 自动压缩。
- 通过一个 pi-durable 扩展（`shepherd-steward`）提供：系统提示段落、工具、钩子。
- 每一轮看到的信息：

| 内容 | 放哪里 | 理由 |
|---|---|---|
| 角色、规则、自主度、汇报格式 | 系统提示（静态段） | 很少变化，提示缓存友好 |
| 常驻层笔记 | 系统提示的一个段落 | 变化少；变化时只追加差异 |
| **情况简报**（各 Thread 状态、机器在线情况、待回答的问题） | `beforeRequest` 钩子在**单次请求**里注入，不写入对话 | 每轮最新，不让对话膨胀 |
| 涉及仓库的项目层笔记 | `get_thread` 等工具的返回值 | 只在相关时出现 |
| 本轮输入 | 用户消息或系统事件 | |

`beforeRequest` 钩子能替换单次请求的消息列表（pi-durable README，Generation hooks）；是否能满足「只追加一个简报块、不持久化」需要原型验证。退路：把情况简报放进输入文本前缀。

### 4.2 输入的两种来源

PiHarness 的 `submit` 只接收内容，不支持自定义条目类型（`pi-durable@1.1.0` 的 `input` 不允许带 `entry`；更新版本 README 中允许，需要验证）。MVP 用**内容标记**区分：

```
用户消息:  <原文>                                        operationId = user:<channel message id>
系统事件:  ⟦event⟧ thread=<id> ...（紧凑文本）              operationId = evt:<batch id>
例程触发:  ⟦routine R⟧ <指令>                              operationId = routine:<id>:<fireTime>
跟进到期:  ⟦followup F⟧ <原因>                             operationId = followup:<id>
```

核心在提交时就知道输入类型，并把它记入 `sh_run(operationId, kind, replyTo)`，用于出站决策（§6）。系统提示说明这些标记的含义：以 `⟦` 开头的不是用户说的话。

### 4.3 工具

分五组。所有工具的返回都是紧凑文本加少量结构化字段。「重放」一栏是 pi-durable 的 `replay` 属性：`safe` 表示崩溃后可以重跑，`unsafe` 表示不可重跑，模型会看到「被中断」。

**记忆与查询**

| 工具 | 作用 | 重放 |
|---|---|---|
| `situation()` | 返回当前情况简报（兜底，通常已由钩子注入） | safe |
| `find_threads(text, hints?)` | §3 的候选 | safe |
| `get_thread(threadId)` | 摘要、worker、待回答的问题、项目层笔记、最近时间线 | safe |
| `update_thread(threadId, {title?, goal?, summary?})` | 更新摘要 | safe（覆盖写，幂等） |
| `notes_propose(draft)` / `notes_commit(draft, replaces?)` / `notes_pin(id, pinned)` / `notes_remove(id)` | §2.4 两段式写入 | propose: safe；commit: safe（以 `taskId` 作幂等键） |
| `notes_search(q)` | 查归档层 | safe |

**派发与控制（经协议网关）**

| 工具 | 作用 | 重放 |
|---|---|---|
| `start_worker(threadId, repoId, mode, prompt, base?, provenance, basis)` | 创建 worker 命令（connector-pi `start_worker`） | **unsafe** |
| `send_to_worker(workerId, text, intent, provenance, basis)` | 追加指示 | unsafe |
| `interrupt_worker(workerId, then?, basis)` | 中止并可选地续上 | unsafe |
| `resume_worker(workerId, reason)` | 手动续上 | unsafe |
| `worker_status(workerId?)` / `machine_status()` | 只读状态 | safe |

`unsafe` 工具的命令 ID 取自工具任务 ID：`cmdId = "tool:" + api.taskId`，使崩溃后即使重放同一个调用也只会产生同一个命令（协议文档 §7.1）。

**与用户沟通**

| 工具 | 作用 |
|---|---|
| `notify_user({ threadId?, conclusion, did[], needsYou?, urgency })` | 按固定三段式发送；`urgency: push \| quiet`；链接由系统自动附加 |
| `ask_user({ threadId?, question, options?[≤3] })` | 创建 `sh_question`、状态变「等你」、推送；**终止本轮**（`control.terminate`） |
| `no_action(reason)` | 明确记录「醒来后无需动作」，终止本轮 |

**主动行为**（§8）：`create_routine`、`create_watch`、`set_followup`、`list_schedules`、`cancel_schedule`。创建例程和巡视需要 `basis = user_explicit`。

**回答 worker 的提问**

| 工具 | 作用 |
|---|---|
| `answer_worker(workerId, text, evidence)` | 总管自己回答 worker 的事实性提问。`evidence` 必须是笔记 ID 或用户消息 ID，没有就被钩子拒绝，只能 `ask_user` |

### 4.4 系统提示的要点

（正文在实现时撰写，这里记录必须包含的规则）

1. 你是 Shepherd 的总管：不亲自写代码，只调度和记忆。
2. 以 `⟦` 开头的输入不是用户说的话，是系统事件。事件触发的运行里，**不要输出面向用户的文字**，需要通知时调用 `notify_user`，无事可做调用 `no_action`。
3. 每次动作前先看情况简报；路由不确定必须 `ask_user`，不要猜。
4. 汇报只有三段，固定格式，简短。
5. 自主度三档（spec §6），以及哪些事必须问用户。
6. 记笔记的标准：「如果总管不知道这个，它会派错、问多、或说错话吗？」会才记；记下后要在汇报中告知用户；`worker_reported` 和 `inferred` 来源不得放入常驻层。
7. 不要代用户下「这件事结束了」的结论。

## 5. 事件处理管线

### 5.1 管线

```
events 批次（协议层）
   │ 1. 去重落库、更新水位、回 events_ack          —— 协议层已验证
   ▼
reducer（确定性，一个 transactionSync）
   │ 2. 更新 worker / thread / question / timeline / report
   │ 3. 重算 thread 派生状态、unread
   │ 4. 写 notification_intent 与 wake_request（持久队列）
   ▼
调度（alarm，合并窗口 3 秒）
   ├─▶ 通知意图 → outbound（确定性模板，§6）
   └─▶ wake_request → harness.submit(...)（operationId 幂等）
```

第 4 步把「要做什么」写进队列，再由 alarm 取出执行。进程在任何一步崩溃，重启后队列里的行仍然在，执行是幂等的。

### 5.2 Thread 派生状态

纯函数，**每次状态变化后重算，不由 LLM 或用户设置**（spec §5.2）：

```
if 任一 worker.state ∈ {starting, running, recovering}      → running
elif 存在 status=open 的 sh_question                         → waiting_you
else                                                          → idle
unread = 存在用户尚未查看的 report / question / error
```

`lost` / `broken` 状态的 worker 不计入 running；`broken` 会产生一个 question（「怎么处理」）从而使 Thread 变为 `waiting_you`。

### 5.3 事件规则表

| 事件 | reducer 动作 | 通知意图 | 唤醒总管 |
|---|---|---|---|
| `started` | worker→running | 无 | 否 |
| `progress` | 更新 `lastEventAt` 与最近进展 | 无 | 否 |
| `report` done | 记 `sh_report`、timeline | **`done` 汇报（确定性）**，3 秒合并窗口 | 是（普通优先级，做记账：摘要、笔记） |
| `report` blocked / needs_decision | 记 report，创建 `sh_question` | 先不发，进入 **90 秒窗口**，期间由总管处理 | **是（高优先级）** |
| `settled` error:auth | 创建 question | 立即推送（用户必须处理机器上的凭据） | 是 |
| `settled` error:transient | timeline | 无（连接器自动续上） | 否 |
| `settled` error:context | 创建 question 建议换新 session | 推送 | 是 |
| `settled` unreported | 创建 question | 无 | 是（总管读最后一句话分类） |
| `lost` / `resumed` | timeline | 无 | 否 |
| `broken` | 创建 question | 推送 | 是 |
| `external_activity` | timeline | 无 | 是（低优先级，更新摘要，合并窗口 10 分钟） |
| 机器离线 / 上线 | 标记其上 worker 的 `unreachable` | 仅当有进行中任务受影响，去抖 2 分钟 | 否 |
| 停滞（§8.4） | timeline | 汇报一次「X 已 N 分钟没有动静」 | 否 |

**90 秒窗口**：`needs_decision` / `blocked` 的汇报先交给总管，让它按自主度第一档尝试自己回答事实性问题（`answer_worker`，必须带证据）。总管在窗口内调用 `ask_user`、`answer_worker` 或 `notify_user` 之一即视为已处理；窗口到期仍无动作（LLM 不可用、预算用尽、模型出错），核心**回退为确定性推送**，把 worker 的问题原样转给用户。这样「需要用户决策」永远不会因为 LLM 而丢失。

### 5.4 唤醒文本

多个事件在 3 秒内合并成一次唤醒，文本形如：

```
⟦event⟧ thread=t_8f2 「登录 bug」
- worker w_a1 (pi@mac-studio, 写任务) 报告 done：修复 token 过期后未刷新的问题
  改动：auth/session.ts 等 2 个文件；测试已通过；分支 shepherd/login-1，未推送
  决定：沿用 session 方案，因为……
  遗留：无
已发送给用户的通知：是（done 汇报，模板）
请做记账：更新摘要；如有值得记住的约定，走 notes_propose。无需再通知用户，除非有新的信息要补充。
```

这种文本由核心生成，不由 LLM 生成，内容来自 `sh_report` 和 git 事实。

## 6. 通知与出站

### 6.1 出站队列

所有发给用户的内容都经过 `sh_outbound`，由投递任务（alarm 驱动，指数退避重试）调用渠道适配器。每条出站消息有稳定 ID，重试不重复发送；成功后记录 `providerMsgId`，供「回复某条消息 → Thread」路由使用（§3.1）。

### 6.2 谁能产生出站

只有三个来源：

1. **核心模板**：`done` 汇报、回退推送、停滞提醒、机器状态。内容来自数据，确定性生成，不依赖 LLM。
2. **`notify_user` / `ask_user`**：总管显式调用。
3. **用户消息的回复**：由用户消息触发的运行，其最终文字回复自动发出（`sh_run.kind = user`）。

由事件、例程、跟进触发的运行，**总管的普通文字输出被丢弃**（记在对话里，不发给用户）。这是「默认安静」的结构保证。

### 6.3 回复的获取

用户消息的回复需要拿到运行的最终文字。`harness.wait(operationId)` 返回 `PiOperationResult { status, reason, text }`。做法：提交用户消息时写入 `sh_run(operationId, kind=user, replyTo=<渠道消息 ID>, status=open)`；一个 alarm 驱动的任务在存在未结算的 `sh_run` 期间每 2 秒检查一次，结算后写 `sh_outbound` 并标记完成。这依赖已验证的 `submit` 与 `PiHarness` 的 alarm 心跳；`wait` 本身只在类型声明中看到，需要原型验证。

### 6.4 汇报格式与合并

`notify_user` 的参数结构本身就是三段式（spec §7.5）：

```
conclusion   ≤ 80 字，一句话，成了还是没成
did[]        ≤ 4 条，每条 ≤ 100 字
needsYou?    ≤ 120 字
```

超出长度的由工具拒绝并要求改写。链接（Thread 时间线）由系统附加，指向带一次性签名的网页地址。

合并规则：同一个渠道内，`urgency: quiet` 的多条通知在 60 秒窗口内合并为一条；`urgency: push` 立即发送；`waiting_you` 相关的一律 `push`。

### 6.5 用户查看与未读

用户在网页打开 Thread，或回复其汇报，清除 `unread`。卡片按钮点击视为已读加一次回复。

## 7. 自主度的落地

### 7.1 工具参数里的依据

会产生副作用的工具都带 `basis`，描述总管这样做的依据：

| `basis` | 含义 |
|---|---|
| `user_explicit` | 用户明确说了要这样做 |
| `user_reply_to` | 用户回复/点击了特定消息或按钮 |
| `memory` | 依据笔记里的偏好或约定（`evidence` 为笔记 ID） |
| `routine` / `followup` / `watch` | 来自用户之前创建的主动任务（`provenance` 为其 ID） |
| `inferred` | 总管自己推断 |

### 7.2 策略钩子

`beforeTool` 钩子（pi-durable 的 `hook(ToolTask, { beforeTool })`）在工具执行前查表，返回 `{ block: "原因" }` 则模型看到拒绝理由：

| 动作 | 允许的 `basis` | 额外条件 |
|---|---|---|
| `start_worker` | 全部 | `provenance` 必填；仓库或机器有歧义（多个候选）时不允许 `inferred` |
| `send_to_worker` | 全部 | 路由置信度低时不允许 |
| `interrupt_worker` | `user_explicit`、`user_reply_to` | spec §6：中断必须先问用户或有明确指示 |
| `answer_worker` | `memory`、`user_explicit` | `evidence` 必填 |
| `create_routine` / `create_watch` | `user_explicit` | 必须关联创建它的用户消息 ID |
| `resume_worker` | 全部 | 同一 worker 每小时自动续上 ≤ 2 次（与连接器一致） |
| 范围扩大（派发超出用户原话的事） | 无 | 一律改为 `ask_user` |

`provenance` 规则（spec §8.3）：由事件触发的运行里调用 `start_worker`/`send_to_worker`，`provenance` 必须是一个存在的例程、跟进、巡视 ID 或用户消息 ID；为空一律拒绝。这使得总管无法「凭空」决定做事。

自主度开关（谨慎 / 平衡 / 放手）= 这张策略表的三套取值；MVP 只实现「平衡」，表结构为替换留好位置。

## 8. 主动行为

### 8.1 数据

```
sh_routine(routineId, createdFromMsg NOT NULL, schedule(cron|once), instruction,
           repoId?, threadId?, enabled, lastRunAt, lastResult)
sh_watch(watchId, createdFromMsg NOT NULL, kind, spec, actionPolicy, enabled)   -- MVP 仅定义，事件源后续接入
sh_followup(followupId, threadId, dueAt, reason, createdBy: user|steward, sourceRef, status)
```

`createdFromMsg` 非空是 spec「每个主动行为必须有出处」的数据层保证。

### 8.2 例程

- 创建：用户说「每个工作日早上 9 点……」，总管复述并确认后调用 `create_routine`。
- 触发：用 Agents SDK 的 `this.schedule(cron, "fireRoutine", { routineId })`（cron 调度幂等）。触发后核心提交 `⟦routine R⟧ <指令>`，`operationId = routine:<id>:<fireTime>`，重复触发不会重复处理。
- 总管收到后按指令执行，`provenance = routine:<id>`；没有要做的就 `no_action`。

### 8.3 跟进（自己给自己设闹钟）

`set_followup(threadId, after, reason)`：写入 `sh_followup` 并 `schedule`。到期提交 `⟦followup F⟧`。总管可用来「两小时后再看一眼那个任务」。创建者是总管时，`sourceRef` 必须指向触发它的用户消息或例程。

### 8.4 停滞检测

每个 running 的 worker 对应一个 alarm：`lastEventAt + 20 分钟`（可配置）。事件到达就改写这个时间。到期且 worker 仍无任何事件 → 核心生成一次停滞通知（模板），并写 timeline；同一次停滞只通知一次，worker 再有事件后重置。`progress` 事件在连接器端已节流，所以持续 20 分钟完全无事件意味着 agent 卡在一个很长的工具调用上或进程已死，值得提醒。

### 8.5 建议新例程

总管观察到重复模式（例如每周都让它查一次某事）时，可以**建议**创建例程：只发出建议并附按钮；用户确认（`user_reply_to`）后才调用 `create_routine`。

### 8.6 默认什么都不做

被唤醒后的默认结论是 `no_action`。每次主动唤醒都应有可审计的结果：`sh_routine.lastResult`、timeline 条目。

## 9. 通道：飞书

### 9.1 入站

- 路径：`POST /channels/feishu/events`（由 Agent 的 `onRequest` 处理）。校验飞书事件的签名与 token，处理 URL 验证握手。
- 去重：`sh_inbound(msgId)` 主键；重复的事件直接返回 200。飞书会重试事件，所以必须幂等。
- 身份：只处理 owner 的**私聊**。owner 在首次扫码绑定时记录 `open_id`；其他来源一律忽略并记录。
- 内容：文本、引用（父消息 ID，用于 §3.1 路由）、图片。图片由适配器经飞书 API 下载，缩放到协议的单消息上限内（协议文档 §6.2），作为 `images` 提交。
- 提交：`harness.submit(text, { operationId: "user:" + msgId })`，同时写 `sh_run`。
- 卡片按钮回调：转成带 `threadId` 的结构化输入，`basis = user_reply_to`。

### 9.2 出站

- 访问令牌（`tenant_access_token`）缓存并由 alarm 刷新。
- 发送文本或卡片；遵守长度和频率限制，失败走 §6.1 的重试。
- `notify_user` 渲染成卡片：结论加粗，要点列表，需要用户决定时带按钮（选项来自 `ask_user.options`）。

### 9.3 适配器接口

渠道是可替换的：

```ts
interface ChannelAdapter {
  verifyAndParse(req: Request): Promise<InboundEvent | Response>;   // 校验、握手、去重键
  send(out: OutboundMessage): Promise<{ providerMsgId: string }>;
  fetchAttachment(ref: AttachmentRef): Promise<Uint8Array>;
}
```

飞书是第一个实现。关于「扫码创建机器人」「个人账号能否创建应用」「事件订阅方式」「卡片回调」「限流与消息长度」这些细节，目前**没有调研**，写在待调研项里（§13）。

## 10. 网页读模型

网页是配套详情页（spec §7.3），只读加少量管理动作，全部走记忆模块的 `views` 与管理接口：

| 页面 | 来源 |
|---|---|
| Thread 列表 | `threads.list`、`views.situation` |
| 时间线 | `views.timeline` |
| 原始过程 | 协议的 `history` 中继，不在 DO 存储 |
| 记忆页 | `views.memoryPage`：按层列出，编辑、删除、固定走 `notes.*` |
| 例程列表 | `sh_routine`，可暂停、删除 |
| 机器管理 | 协议层的 device，可撤销 |

登录由 IM 下发的一次性签名链接换取会话，另文设计。网页发出的写操作同样记入 `sh_note_log` / audit，保证「遗忘与变动对用户可见」。

## 11. 一致性与幂等

两个存储（我们的表、pi-durable 的表）之间没有跨存储事务，所以靠**幂等键**和**持久队列**：

| 场景 | 幂等键 | 崩溃后的行为 |
|---|---|---|
| 飞书事件重试 | `sh_inbound.msgId`、`operationId=user:<msgId>` | 重复事件被丢弃 |
| 连接器事件重传 | `(workerId, seq)`、`operationId=evt:<batch>` | 已验证：重传 3 次仍只有 1 条总管输入 |
| 总管工具重放 | `cmdId = tool:<taskId>` | `unsafe` 工具不重跑；重放得到同一个命令 ID |
| reducer 与唤醒之间崩溃 | `wake_request` 持久化，`operationId` 幂等 | 重启后从队列继续 |
| 出站重试 | `sh_outbound.id` | 同一条只发一次，成功后记 `providerMsgId` |
| 例程重复触发 | `routine:<id>:<fireTime>` | 去重 |

注意 pi-durable 的 `submit` 在提交成功后才返回，崩溃发生在「队列行已写、`submit` 未调用」之间时，队列行仍待处理，会再次调用，`operationId` 保证不重复。

## 12. 成本与降级

| 杠杆 | 做法 |
|---|---|
| 少调用 LLM | 只有用户消息、需要判断的事件、例程、跟进才唤醒；`progress` 永不唤醒；3 秒合并窗口；`external_activity` 10 分钟窗口 |
| 少用 token | 情况简报有字数预算；常驻层 2,400 字符、项目层 1,500 字符的硬上限；Thread 摘要 600 字符 |
| 便宜的模型处理例行事件 | 后续可按输入类型选模型（用户消息用强模型，事件记账用便宜模型）。MVP 一个模型 |
| 预算上限 | 日预算软上限：超出后事件不再唤醒总管，`done` 汇报与回退推送照常；用户消息仍处理，并提示预算状态 |
| 无 LLM 也能用 | 核心模板保证 `done` 汇报、`needs_decision` 回退、停滞提醒、机器状态永远可发出 |

## 13. 依赖的 API 与验证状态

图例：✓ 已在协议原型中实测；◦ 仅见于文档或类型声明；？未验证。

| 依赖 | 状态 |
|---|---|
| `PiHarness.submit(text, { operationId, whenBusy })` 幂等 | ✓ |
| 事件触发 `submit` 并在 DO 被重置后由 alarm 续跑 | ✓ |
| `PiHarness.pending()`、`messages()` | ✓ |
| `PiHarness.wait(operationId)` 返回最终文字 | ◦（类型声明） |
| 扩展里 `defineTool`、`section`、`hook(ToolTask, beforeTool)` | ◦（pi-durable README、`pi-durable-edge` 示例） |
| 工具里 `api.taskId` 在重放中稳定，可作幂等键 | ◦（README 例 22/23 的用法） |
| `beforeRequest` 钩子只替换单次请求、不持久化 | ◦（README） |
| 工具结果 `control.terminate` 结束本轮 | ◦（README） |
| `input` 带自定义 `entry`（区分用户与事件） | ？`pi-durable@1.1.0` 类型不允许，仓库 README 允许；`PiHarness.submit` 不暴露。MVP 用内容标记 |
| DO 的 SQLite 支持 FTS5、JSON 函数 | ◦（官方文档），含触发器同步的行为未验证 |
| `ctx.storage.transactionSync` | ◦（DO 存储 API） |
| `this.schedule(cron, ...)` 幂等 | ◦（Agents SDK 文档） |
| 飞书：扫码创建机器人、事件订阅、卡片与回调、限流与长度限制 | ？未调研 |

## 14. MVP 范围与里程碑

| 里程碑 | 内容 | 验证方式 |
|---|---|---|
| M1 账本与核心 | 表结构、reducer、派生状态、出站队列、核心模板汇报、飞书收发（无 LLM，用固定指令词触发派发） | 单测 + 与协议原型的模拟连接器联调 |
| M2 总管与路由 | `PiHarness` 总管、工具、策略钩子、`find_threads`、情况简报注入、`ask_user`、回复获取 | 路由评测集（§3.4） |
| M3 笔记与遗忘 | 笔记两段式写入、分层、ChangeReport、maintenance | 笔记容量、冲突、降级的单测；人工评审 |
| M4 主动行为 | 例程、跟进、停滞检测、90 秒窗口回退 | 故障注入：LLM 失败、DO 重置 |
| M5 网页 | 时间线、记忆页、机器管理、一次性链接登录 | 手工 |

不包含：多租户、事件源（GitHub、CI 等）、语音、自主度开关、便宜模型分流、向量检索。

## 15. 待决事项

1. **`beforeRequest` 能否只在单次请求里追加情况简报。** 不行则改为输入前缀，代价是对话膨胀由压缩承担。
2. **事件与用户消息的区分。** 内容标记够用但脆弱（用户消息里恰好出现 `⟦` 如何处理）：入站时转义用户文本里的标记字符。升级 pi-durable 到支持 `input.entry` 的版本后改用结构化条目。
3. **90 秒窗口的长度**，以及总管在窗口内自己回答的比例，需要真实使用数据。
4. **常驻层 2,400 字符、项目层 1,500 字符**是否合适，取决于笔记的实际形态。
5. **笔记的 `lastUsedAt` 以「被装配进上下文」近似「被使用」**，可能高估；后续可以让总管在回复里标注引用了哪些笔记。
6. **摘要重建频率**（每 10 次）是拍脑袋值。
7. **Thread 数量增长后**，`findCandidates` 的召回策略（加向量或加分层）。
8. **Feishu 适配**的所有细节（§9.3 末尾），以及企业微信。
9. **多个 Thread 的同时汇报**怎么合并成一条，既要简短又不丢失每件事的三段，需要在真实卡片上试。
10. **用户查看 Thread 的信号**如何可靠地得到（网页打开、回复、按钮），用于清除未读。
11. **预算与用量**的计量来源：pi-durable 的 `pi.usage` 文档，总管的日用量如何汇总。
