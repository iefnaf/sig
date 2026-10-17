// Interface copy, English first. Only the interface is translated: what the owner typed, what
// Pip and the agents wrote, and the names of threads, machines and repositories are shown as
// they are. A fresh visit is English; a saved choice (`pip.locale`) wins on later visits.

export const STRINGS = {
  // chrome
  workspaceTitle: ['Pip · Workspace', 'Pip · 工作台'],
  brandHome: ['Pip · All messages', 'Pip · 全部对话'],
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
  newTaskHint: ['Tell Pip what you need. A thread is created when work starts.', '告诉 Pip 要做什么，开始执行时会建立事项。'],
  allMessages: ['All messages', '全部对话'],
  allThreads: ['All threads', '全部事项'],
  searchThreads: ['Search threads', '搜索事项'],
  threadNavigation: ['Threads by status', '按状态查看事项'],
  unread: ['Unread', '未读'],
  noResults: ['No threads found.', '未找到事项。'],
  searchHint: ['Try a title, repository, or machine.', '试试事项名称、仓库或机器。'],
  clearSearch: ['Clear search', '清空搜索'],
  noThreads: ['No threads yet.', '还没有事项。'],
  noThreadsHelp: ['Ask Pip to start something and it will show up here.', '让 Pip 开始一件事，它会出现在这里。'],
  noMachines: ['No machines yet.', '还没有机器。'],
  machineCount: ['{count} online', '{count} 台在线'],
  slots: ['{used} / {total} slots', '{used} / {total} 个位置'],
  offline: ['Offline', '离线'],
  online: ['Online', '在线'],
  revoked: ['Revoked', '已撤销'],
  // conversation
  chatLabel: ['Conversation with Pip', '与 Pip 的对话'],
  detailToggle: ['Toggle details', '展开或收起详情'],
  closeDetails: ['Close details', '收起详情'],
  history: ['Message history', '对话记录'],
  scopeNotice: ['Messages in this thread', '当前事项的对话'],
  backToAll: ['All messages', '全部对话'],
  autoRoute: ['Auto', '自动关联'],
  scopedRoute: ['Thread: {title}', '事项：{title}'],
  routeHelp: ['Pip chooses the thread', '由 Pip 关联事项'],
  scopeHelp: ['Sent to this thread', '发送到当前事项'],
  inputLabel: ['Message Pip', '给 Pip 发消息'],
  inputPlaceholder: ['Message Pip…', '发消息给 Pip…'],
  scopedPlaceholder: ['Add a detail or ask for an update…', '补充要求或询问进展…'],
  replyPlaceholder: ['Write your answer…', '写下你的回答…'],
  send: ['Send', '发送'],
  newline: ['New line', '换行'],
  notifications: ['Decisions here. Alerts in Feishu.', '在这里处理决定，通过飞书接收提醒。'],
  contextLabel: ['Workspace and thread details', '工作台与事项详情'],
  chat: ['Chat', '对话'],
  mainNavigation: ['Main navigation', '主导航'],
  close: ['Close', '关闭'],
  you: ['You', '你'],
  viaFeishu: ['Feishu', '飞书'],
  working: ['Pip is working…', 'Pip 正在处理…'],
  workingQueued: ['Pip is working · {count} queued', 'Pip 正在处理 · 还有 {count} 条排队'],
  queueHelp: ['New messages are queued', '新消息会排队处理'],
  sending: ['Sending…', '发送中…'],
  notSent: ['Not sent', '未发送'],
  retry: ['Retry', '重试'],
  emptyMessages: ['No messages yet.', '暂无对话。'],
  emptyMessagesHelp: ['Say hello, or ask Pip to start something.', '打个招呼，或让 Pip 开始一件事。'],
  emptyThreadMessages: ['No messages in this thread yet.', '这个事项还没有对话。'],
  emptyThreadHelp: ['Ask Pip for an update or add a detail.', '可以询问进展或补充要求。'],
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
  allClearHelp: ['Pip will ask when a decision is needed.', '需要决定时，Pip 会提醒你。'],
  recentActivity: ['Activity', '动态'],
  noActivity: ['Nothing yet.', '暂无动态。'],
  noRunning: ['No tasks running.', '暂无运行中的任务。'],
  threadDetails: ['Thread', '事项详情'],
  goal: ['Goal', '目标'],
  agent: ['Agent', '执行 Agent'],
  agents: ['Agents', 'Agent'],
  execution: ['Execution', '执行安排'],
  noWorkers: ['Not started', '尚未启动'],
  rawHistory: ['View session', '查看原始过程'],
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
  connectMachine: ['To connect a machine, send /加机器 to Pip in Feishu.', '连接机器：在飞书向 Pip 发送「/加机器」。'],
  manageMachines: ['Manage or revoke machines', '管理或撤销机器'],
  titleDecision: ['Needs your decision', '需要你拍板'],
  titleMemory: ['A memory hasn’t been used in a while', '一条记忆很久没用了'],
  titleRoutine: ['Make this a routine?', '要把这个变成例行任务吗？'],
  showInChat: ['Show in conversation', '在对话中查看'],
  // account
  accountTitle: ['Account', '账号'],
  accountBody: ['You are signed in as the owner of this Pip. Sessions last 7 days.', '你已作为这个 Pip 的主人登录，登录状态保持 7 天。'],
  signOut: ['Sign out', '退出登录'],
  signedOutTitle: ['Signed out', '已退出登录'],
  signedOut: ['Send /网页 to Pip in Feishu whenever you want a new sign-in link.', '需要时，在飞书向 Pip 发送「/网页」获取新的登录链接。'],
  sessionExpiredTitle: ['Please sign in again', '请重新登录'],
  sessionExpiredBody: ['Send /网页 to Pip in Feishu to get a new sign-in link. It works once and expires in 15 minutes.', '在飞书向 Pip 发送「/网页」获取新的登录链接，链接只能打开一次，15 分钟内有效。'],
  loadFailedTitle: ['Couldn’t load the workspace', '无法加载工作台'],
  loadFailedBody: ['Check your connection. Pip will keep trying.', '请检查网络，Pip 会继续重试。'],
  // feedback
  sendFailed: ['Couldn’t send that message. You can retry it.', '消息没有发出，可以重试。'],
  actionFailed: ['That didn’t go through. Try again.', '操作没有成功，请重试。'],
  queueFull: ['Pip is catching up. Try again in a moment.', 'Pip 还在处理之前的消息，请稍后再试。'],
  tooLong: ['That message is too long.', '消息太长了。'],
  replyAnnounce: ['Pip replied.', 'Pip 已回复。'],
  newDecision: ['Pip needs a decision.', 'Pip 需要你做个决定。'],
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
