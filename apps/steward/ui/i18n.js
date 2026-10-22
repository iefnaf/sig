// Interface copy, English first. Only the interface is translated: what the owner typed, what
// Sig and the agents wrote, and the names of threads, machines and repositories are shown as
// they are. A fresh visit is English; a saved choice (`pip.locale`) wins on later visits.

export const STRINGS = {
  // chrome
  workspaceTitle: ['Sig · Workspace', 'Sig · 工作台'],
  brandHome: ['Sig · All messages', 'Sig · 全部对话'],
  personalAgent: ['your personal agent', '你的个人助手'],
  language: ['Language', '语言'],
  account: ['Account', '账号'],
  machines: ['Machines', '机器'],
  running: ['Running', '运行中'],
  needsYou: ['Needs you', '待处理'],
  idle: ['Idle', '空闲'],
  today: ['Today', '今日'],
  yesterday: ['Yesterday', '昨天'],
  justNow: ['Just now', '刚刚'],
  overBudget: ['Over the daily limit', '已超出每日额度'],
  spendTitle: ['Today’s spend · limit {limit}', '今日花费 · 上限 {limit}'],
  // connection
  connecting: ['Connecting…', '正在连接…'],
  live: ['Live', '实时'],
  reconnecting: ['Reconnecting…', '正在重连…'],
  disconnected: ['Offline · retrying', '已断开 · 重试中'],
  // sidebar
  threads: ['Threads', '事项'],
  newThread: ['New task', '新事项'],
  newTaskHint: ['Tell Sig what you need. A thread is created when work starts.', '告诉 Sig 要做什么，开始执行时会建立事项。'],
  allMessages: ['All messages', '全部对话'],
  allThreads: ['All threads', '全部事项'],
  searchThreads: ['Search threads', '搜索事项'],
  threadNavigation: ['Threads by status', '按状态查看事项'],
  unread: ['Unread', '未读'],
  noResults: ['No threads found.', '未找到事项。'],
  searchHint: ['Try a title, repository, or machine.', '试试事项名称、仓库或机器。'],
  clearSearch: ['Clear search', '清空搜索'],
  noThreads: ['No threads yet.', '还没有事项。'],
  noThreadsHelp: ['Ask Sig to start something and it will show up here.', '让 Sig 开始一件事，它会出现在这里。'],
  noMachines: ['No machines yet.', '还没有机器。'],
  machineCount: ['{count} online', '{count} 台在线'],
  slots: ['{used} / {total} slots', '{used} / {total} 个位置'],
  offline: ['Offline', '离线'],
  online: ['Online', '在线'],
  revoked: ['Revoked', '已撤销'],
  // conversation
  chatLabel: ['Conversation with Sig', '与 Sig 的对话'],
  detailToggle: ['Toggle details', '展开或收起详情'],
  closeDetails: ['Close details', '收起详情'],
  history: ['Message history', '对话记录'],
  scopeNotice: ['Messages in this thread', '当前事项的对话'],
  backToAll: ['All messages', '全部对话'],
  autoRoute: ['Auto', '自动关联'],
  scopedRoute: ['Thread: {title}', '事项：{title}'],
  routeHelp: ['Sig chooses the thread', '由 Sig 关联事项'],
  scopeHelp: ['Sent to this thread', '发送到当前事项'],
  inputLabel: ['Message Sig', '给 Sig 发消息'],
  inputPlaceholder: ['Message Sig…', '发消息给 Sig…'],
  scopedPlaceholder: ['Add a detail or ask for an update…', '补充要求或询问进展…'],
  replyPlaceholder: ['Write your answer…', '写下你的回答…'],
  send: ['Send', '发送'],
  newline: ['New line', '换行'],
  notifications: ['Decisions wait here until you answer them.', '待处理的决定会一直保留在这里，直到你处理。'],
  contextLabel: ['Workspace and thread details', '工作台与事项详情'],
  chat: ['Chat', '对话'],
  mainNavigation: ['Main navigation', '主导航'],
  close: ['Close', '关闭'],
  you: ['You', '你'],
  viaFeishu: ['Feishu', '飞书'],
  working: ['Sig is working…', 'Sig 正在处理…'],
  workingQueued: ['Sig is working · {count} queued', 'Sig 正在处理 · 还有 {count} 条排队'],
  queueHelp: ['New messages are queued', '新消息会排队处理'],
  sending: ['Sending…', '发送中…'],
  notSent: ['Not sent', '未发送'],
  retry: ['Retry', '重试'],
  emptyMessages: ['No messages yet.', '暂无对话。'],
  emptyMessagesHelp: ['Say hello, or ask Sig to start something.', '打个招呼，或让 Sig 开始一件事。'],
  emptyThreadMessages: ['No messages in this thread yet.', '这个事项还没有对话。'],
  emptyThreadHelp: ['Ask Sig for an update or add a detail.', '可以询问进展或补充要求。'],
  replyingTo: ['Answering: {title}', '回答：{title}'],
  clearReply: ['Stop answering this card', '不再回答这张卡片'],
  answer: ['Answer', '回答'],
  showInChat: ['Show in conversation', '在对话中查看'],
  // cards
  kindQuestion: ['Question', '提问'],
  kindConsent: ['Pull request', 'PR'],
  kindOffline: ['Machine offline', '机器离线'],
  kindOffer: ['Routine suggestion', '例行任务建议'],
  kindMemory: ['Memory', '记忆'],
  kindReport: ['Report', '汇报'],
  kindUpdate: ['Update', '动态'],
  cardHandled: ['Handled', '已处理'],
  cardWorking: ['Working on it…', '处理中…'],
  cardAlreadyHandled: ['This was already handled.', '这个决定已经处理过了。'],
  cardPending: ['This card is still being delivered. Try again in a moment.', '这张卡片还在送达，请稍后再试。'],
  actionApprove: ['Create PR', '创建 PR'],
  actionDecline: ['Not now', '先不要'],
  actionWait: ['Wait for it', '等它上线'],
  actionSwitch: ['Use another machine', '换台机器'],
  actionSwitchTo: ['Use {names}', '换用 {names}'],
  actionCancel: ['Cancel', '算了'],
  actionRoutineAccept: ['Create', '创建'],
  actionRoutineDecline: ['Not now', '先不用'],
  actionArchive: ['Archive', '归档'],
  actionKeep: ['Keep', '保留'],
  actionNew: ['Something new', '新开一件事'],
  // overview and details
  workspace: ['Workspace', '工作台'],
  allClear: ['All clear.', '暂无待处理事项。'],
  allClearHelp: ['Sig will ask when a decision is needed.', '需要决定时，Sig 会提醒你。'],
  recentActivity: ['Activity', '动态'],
  noActivity: ['Nothing yet.', '暂无动态。'],
  noRunning: ['No tasks running.', '暂无运行中的任务。'],
  threadDetails: ['Thread', '事项详情'],
  goal: ['Goal', '目标'],
  agent: ['Agent', '执行 Agent'],
  agents: ['Agents', 'Agent'],
  execution: ['Execution', '执行安排'],
  noWorkers: ['Not started', '尚未启动'],
  rawHistory: ['View session', '查看 Agent 过程'],
  // thread views and the session pane
  tabConversation: ['Conversation', '对话'],
  tabSessions: ['Agent sessions', 'Agent 过程'],
  viewTabs: ['Thread views', '事项视图'],
  sessionLabel: ['Agent session', 'Agent 过程'],
  sessionPicker: ['Session', '会话'],
  sessionTitle: ['{agent} on {machine}', '{agent} @ {machine}'],
  sessionMissing: ['That session no longer exists.', '这个会话已不存在。'],
  timeline: ['Timeline', '时间线'],
  noTimeline: ['No events yet.', '还没有事件。'],
  unreachable: ['Out of contact', '失联中'],
  progress: ['Latest: {what}', '最近：{what}'],
  branch: ['Branch', '分支'],
  gitAhead: ['{count} commits', '{count} 个提交'],
  gitPushed: ['pushed', '已推送'],
  gitLocal: ['not pushed', '未推送'],
  gitDirty: ['{count} files uncommitted', '{count} 个文件未提交'],
  prCreated: ['PR created', 'PR 已创建'],
  prDeclined: ['PR declined', '已选择不创建 PR'],
  prFailed: ['PR failed', 'PR 创建失败'],
  prPending: ['Creating PR…', '正在创建 PR…'],
  context: ['Context {percent}%', '上下文 {percent}%'],
  // worker states
  workerQueued: ['Queued', '排队中'],
  workerStarting: ['Starting', '启动中'],
  workerRunning: ['Running', '运行中'],
  workerRecovering: ['Recovering', '恢复中'],
  workerIdle: ['Finished', '已结束'],
  workerBroken: ['Failed', '出错'],
  // timeline kinds
  kind_user_instruction: ['Instruction', '指令'],
  kind_dispatch: ['Dispatch', '派发'],
  kind_started: ['Started', '开始'],
  kind_progress: ['Progress', '进展'],
  kind_report: ['Report', '汇报'],
  kind_question: ['Question', '问题'],
  kind_settled: ['Ended', '结束'],
  kind_lost: ['Lost', '失联'],
  kind_resumed: ['Resumed', '恢复'],
  kind_machine_status: ['Machine', '机器'],
  kind_note: ['Note', '备注'],
  kind_stall: ['Stalled', '长时间静默'],
  kind_routine: ['Routine', '例行任务'],
  kind_followup: ['Follow-up', '回看'],
  outcome_reaped: ['Lost contact (recycled)', '失联（已回收）'],
  outcome_cancelled: ['Command withdrawn', '命令已撤回'],
  'outcome_error:stall': ['Stalled (restart did not help)', '挂死（重启一次仍无输出）'],
  // machines
  machineSummary: ['{online} / {total} online · {running} agents running', '{online} / {total} 台在线 · {running} 个 Agent 运行中'],
  lastSeen: ['Last seen {time}', '{time}在线'],
  neverConnected: ['Never connected', '从未连接'],
  repositories: ['Repositories', '仓库'],
  noneListed: ['None listed', '暂无'],
  addMachine: ['Add a machine', '添加机器'],
  pairingHelp: ['Run this command in a terminal on the machine you want to add. It works once and expires in 10 minutes.', '在要添加的机器上打开终端运行下面的命令，只能使用一次，10 分钟内有效。'],
  pairingCreate: ['Create pairing command', '生成配对命令'],
  pairingCopy: ['Copy', '复制'],
  pairingCopied: ['Copied.', '已复制。'],
  pairingCopyFailed: ['Couldn’t copy. Select the command and copy it by hand.', '没有复制成功，请手动选中命令复制。'],
  pairingFailed: ['Couldn’t create a pairing command. Try again.', '没有生成配对命令，请重试。'],
  pairingExpires: ['Expires at {time}', '{time} 前有效'],
  revokeMachine: ['Revoke', '撤销'],
  revokeConfirm: ['Revoke {name}? It disconnects now and must be paired again to come back.', '撤销 {name}？它会立即断开，之后需要重新配对。'],
  revokeConfirmAction: ['Yes, revoke', '确认撤销'],
  revokeFailed: ['Couldn’t revoke that machine. Try again.', '没有撤销成功，请重试。'],
  // first-run setup
  setupModel: ['Sig needs a model key before it can reply.', 'Sig 需要先配置模型密钥才能回复。'],
  setupModelAction: ['Add key', '添加密钥'],
  setupMachine: ['Connect a machine so Sig can run coding agents.', '连接一台机器，Sig 才能运行 coding agent。'],
  setupMachineAction: ['Add machine', '添加机器'],
  titleDecision: ['Needs your decision', '需要你拍板'],
  titleMemory: ['A memory hasn’t been used in a while', '一条记忆很久没用了'],
  titleRoutine: ['Make this a routine?', '要把这个变成例行任务吗？'],
  showInChat: ['Show in conversation', '在对话中查看'],
  // account
  accountTitle: ['Settings', '设置'],
  accountBody: ['Signed in on this browser via a device link.', '已通过设备链接在本浏览器登录。'],
  signOut: ['Sign out', '退出登录'],
  signedOutTitle: ['Signed out', '已退出登录'],
  signedOut: ['Reload this page to sign in again.', '刷新页面即可重新登录。'],
  sessionExpiredTitle: ['Please sign in again', '请重新登录'],
  sessionExpiredBody: ['Reload this page to sign in again.', '刷新页面即可重新登录。'],
  modelTitle: ['Model', '模型'],
  modelReady: ['{provider} · {model} — key saved', '{provider} · {model} — 已保存密钥'],
  modelNoKey: ['{provider} · {model} — no key yet', '{provider} · {model} — 还没有密钥'],
  modelProviderLabel: ['Provider', '服务商'],
  modelProviderPlaceholder: ['e.g. deepseek, openai, anthropic', '例如 deepseek、openai、anthropic'],
  modelIdLabel: ['Model ID', '模型 ID'],
  modelIdPlaceholder: ['e.g. deepseek-flash', '例如 deepseek-flash'],
  modelBaseUrlLabel: ['Base URL (optional)', 'Base URL（可选）'],
  modelBaseUrlPlaceholder: ['Custom endpoint, if any', '自定义接口地址（如有）'],
  modelKeyLabel: ['API key', 'API 密钥'],
  modelKeyPlaceholder: ['Paste the provider’s API key', '粘贴模型服务商的 API 密钥'],
  modelKeyKeep: ['Key saved — leave empty to keep it', '已保存密钥，留空则保持不变'],
  modelKeyMissing: ['Paste an API key for this provider first.', '请先粘贴该服务商的 API 密钥。'],
  modelSave: ['Save', '保存'],
  modelHelp: ['Each provider’s key is sealed separately in your own Cloudflare account and never shown again. Switch provider or model any time — a provider with a saved key never asks for it again.', '每个服务商的密钥分别加密保存在你自己的 Cloudflare 账号里，之后不会再显示。切换服务商或模型随时可以，已保存过密钥的服务商不会再要求重新输入。'],
  modelSaved: ['Model settings saved.', '模型设置已保存。'],
  modelSaveFailed: ['Couldn’t save the model settings. Try again.', '模型设置没有保存成功，请重试。'],
  settingsLoading: ['Loading…', '加载中…'],
  // security / passkeys
  securityTitle: ['Security', '安全'],
  passkeysEmpty: ['No passkeys yet.', '还没有通行密钥。'],
  passkeyLabelLabel: ['Passkey name', '通行密钥名称'],
  passkeyLabelPlaceholder: ['e.g. MacBook Pro', '例如：MacBook Pro'],
  passkeyAdd: ['Add a passkey', '添加通行密钥'],
  passkeyAdding: ['Adding…', '添加中…'],
  passkeyAdded: ['Passkey added.', '通行密钥已添加。'],
  passkeyAddFailed: ['Couldn’t add that passkey. Try again.', '通行密钥没有添加成功，请重试。'],
  passkeyUnsupported: ['This browser doesn’t support passkeys.', '当前浏览器不支持通行密钥。'],
  passkeyMeta: ['Added {created} · last used {lastUsed}', '添加于 {created} · 上次使用 {lastUsed}'],
  passkeyNeverUsed: ['never', '从未使用'],
  passkeyRemove: ['Remove', '移除'],
  passkeyRemoveConfirm: ['Remove {name}? You can always sign in with a login link instead.', '移除 {name}？之后仍可以用登录链接登录。'],
  passkeyRemoveConfirmAction: ['Yes, remove', '确认移除'],
  passkeyRemoveFailed: ['Couldn’t remove that passkey. Try again.', '通行密钥没有移除成功，请重试。'],
  loadFailedTitle: ['Couldn’t load the workspace', '无法加载工作台'],
  loadFailedBody: ['Check your connection. Sig will keep trying.', '请检查网络，Sig 会继续重试。'],
  // feedback
  sendFailed: ['Couldn’t send that message. You can retry it.', '消息没有发出，可以重试。'],
  actionFailed: ['That didn’t go through. Try again.', '操作没有成功，请重试。'],
  queueFull: ['Sig is catching up. Try again in a moment.', 'Sig 还在处理之前的消息，请稍后再试。'],
  tooLong: ['That message is too long.', '消息太长了。'],
  replyAnnounce: ['Sig replied.', 'Sig 已回复。'],
  newDecision: ['Sig needs a decision.', 'Sig 需要你做个决定。'],
  // the session viewer
  svRetry: ['Retry', '重试'],
  svLoadMore: ['Load more', '继续加载'],
  svJumpLatest: ['Jump to latest', '回到最新'],
  svFeedLabel: ['Recorded session', '记录的会话'],
  svShowAll: ['Show all ({count} more characters)', '显示全部（还有 {count} 个字符）'],
  svImage: ['Image in the session', '会话中的图片'],
  svImageHidden: ['Image not shown ({type})', '未显示图片（{type}）'],
  svNoOutput: ['No output.', '没有输出。'],
  svToolRunning: ['Waiting for the result…', '等待结果…'],
  svToolDone: ['Finished', '已完成'],
  svToolFailed: ['Failed', '失败'],
  svTool: ['Tool', '工具'],
  svInput: ['Input', '输入'],
  svResult: ['Result', '结果'],
  svCancelled: ['cancelled', '已取消'],
  svCommand: ['Command', '命令'],
  svOutputTruncated: ['The agent cut this output short.', 'Agent 已截断这段输出。'],
  svThinking: ['Thinking', '思考'],
  svRedacted: ['The model provider hid this reasoning.', '模型服务商隐去了这段推理。'],
  svRaw: ['Entry', '记录'],
  svUnreadable: ['Unreadable entry', '无法读取的记录'],
  svOtherBranch: ['other branch', '其他分支'],
  svSidechain: ['sub-agent', '子 Agent'],
  svEarlier: ['Show earlier entries ({count})', '显示更早的记录（{count}）'],
  svConnecting: ['Connecting…', '正在连接…'],
  svLoading: ['Reading the session from the machine… {count} entries · {size} MB', '正在从机器读取会话… {count} 条 · {size} MB'],
  svLive: ['Following live · {count} entries', '实时跟随中 · {count} 条'],
  svUpToDate: ['Up to date · {count} entries', '已是最新 · {count} 条'],
  svMore: ['Loaded {count} entries ({size} MB). There is more.', '已加载 {count} 条（{size} MB），还有更多。'],
  svOffline: ['That machine is offline. The full session is stored on it and can be read only while it is connected.', '那台机器目前离线。完整会话保存在它上面，只有它在线时才能读取。'],
  svNothingYet: ['Nothing has been recorded yet. This view updates when the agent writes its first entry.', '还没有记录，Agent 写下第一条后会自动显示。'],
  svEmptySession: ['This session has no entries.', '这个会话没有任何记录。'],
  svMissing: ['No local record of this session was found on that machine. It may have been deleted there.', '那台机器上没有找到这个会话的本地记录，可能已被删除。'],
  svDisconnected: ['Connection lost. Reconnecting…', '连接中断，正在重连…'],
  svDisconnectedLong: ['Still can’t connect. Reload the page to sign in again.', '仍然无法连接，请刷新页面重新登录。'],
  svError: ['Couldn’t read the session: {reason}', '无法读取会话：{reason}'],
  svStuck: ['The read made no progress.', '读取没有进展。'],
  svOutdated: ['That machine’s connector is too old to read full sessions. Run “sig upgrade” on it, then retry.', '那台机器上的 connector 版本太旧，读不了完整会话。在那台机器上运行「sig upgrade」后再重试。'],
  svMeta_session: ['Session', '会话'],
  svMeta_model: ['Model', '模型'],
  svMeta_thinking_level: ['Thinking level', '思考强度'],
  svMeta_compaction: ['Compaction', '压缩上下文'],
  svMeta_branch_summary: ['Branch summary', '分支摘要'],
  svMeta_custom: ['Extension', '扩展'],
  svMeta_label: ['Label', '标记'],
  svMeta_session_info: ['Session name', '会话名称'],
  svMeta_usage: ['Usage', '用量'],
  svMeta_context_edit: ['Context edit', '上下文编辑'],
  svMeta_system: ['System prompt', '系统提示'],
  svMeta_summary: ['Summary', '摘要'],
  svMeta_info: ['System', '系统'],
  svMeta_error: ['Error', '错误'],
};

const LOCALE_KEY = 'pip.locale';
let locale = 'en';
try {
  if (globalThis.localStorage?.getItem(LOCALE_KEY) === 'zh') locale = 'zh';
} catch {
  // Storage can be blocked (private mode, embedded views); the choice still works for this visit.
}

export const getLocale = () => locale;
/** BCP-47 tag for Intl formatting and the document language. */
export const localeTag = () => (locale === 'zh' ? 'zh-CN' : 'en');

export function t(key, values = {}) {
  const pair = STRINGS[key];
  // A missing string must not take the page down; the key shows instead (and a test guards the set).
  if (!pair) return key;
  return pair[locale === 'zh' ? 1 : 0].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}

/** Like `t`, but for keys that depend on data (worker states, timeline kinds): unknown → the raw value. */
export function tOr(key, fallback, values) {
  return key in STRINGS ? t(key, values) : fallback;
}

export function setLocale(next) {
  if (next !== 'en' && next !== 'zh') return false;
  if (next === locale) return false;
  locale = next;
  try {
    globalThis.localStorage?.setItem(LOCALE_KEY, locale);
  } catch {
    // See above: switching still works in memory.
  }
  return true;
}

/** Re-applies the static copy of the page shell (anything marked data-i18n*). */
export function applyStatic(root = document) {
  document.documentElement.lang = localeTag();
  const targets = [['data-i18n', null], ['data-i18n-label', 'aria-label'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder']];
  for (const [attribute, target] of targets) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      const translated = t(element.getAttribute(attribute));
      if (target) element.setAttribute(target, translated);
      else element.textContent = translated;
    }
  }
  for (const button of root.querySelectorAll('[data-locale]')) button.setAttribute('aria-pressed', String(button.dataset.locale === locale));
}
