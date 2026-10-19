// UI copy is shared by the workspace and logo page. A fresh visit uses English.
// Only UI and bilingual fixtures are localized; user-entered messages stay as written.
const i18n = (() => {
  const strings = {
    workspace: ['Workspace', '工作台'],
    workspaceTitle: ['Pip · Workspace', 'Pip · 工作台'],
    brandHome: ['Pip · All messages', 'Pip · 全部对话'],
    personalAgent: ['your personal agent', '你的个人助手'],
    language: ['Language', '语言'],
    machines: ['Machines', '机器'],
    machineCount: ['{count} online', '{count} 台在线'],
    machineNavigation: ['Machine details', '机器详情'],
    running: ['Running', '运行中'],
    needsYou: ['Needs you', '待处理'],
    idle: ['Idle', '空闲'],
    today: ['Today', '今日'],
    yesterday: ['Yesterday', '昨天'],
    justNow: ['Just now', '刚刚'],
    demo: ['Demo', '示例'],
    demoHint: ['Interactive prototype · Sample data', '交互草图 · 示例数据'],
    about: ['About this workspace', '关于工作台'],
    threads: ['Threads', '事项'],
    newThread: ['New task', '新事项'],
    allMessages: ['All messages', '全部对话'],
    allThreads: ['All threads', '全部事项'],
    searchThreads: ['Search threads', '搜索事项'],
    threadNavigation: ['Threads by status', '按状态查看事项'],
    unread: ['Unread', '未读'],
    offline: ['Offline', '离线'],
    online: ['Online', '在线'],
    pipOnline: ['Pip is online', 'Pip 在线'],
    reset: ['Reset demo', '重置示例'],
    resetDone: ['Demo reset.', '已重置示例。'],
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
    send: ['Send', '发送'],
    newline: ['New line', '换行'],
    notifications: ['Decisions here. Alerts in Feishu.', '在这里处理决定，通过飞书接收提醒。'],
    contextLabel: ['Workspace and thread details', '工作台与事项详情'],
    chat: ['Chat', '对话'],
    mainNavigation: ['Main navigation', '主导航'],
    close: ['Close', '关闭'],
    noResults: ['No threads found.', '未找到事项。'],
    searchHint: ['Try a title, repository, or machine.', '试试事项名称、仓库或机器。'],
    clearSearch: ['Clear search', '清空搜索'],
    you: ['You', '你'],
    process: ['Pip activity', 'Pip 的处理过程'],
    dateDivider: ['Today · Oct 17', '今天 · 10 月 17 日'],
    shortDate: ['Sat, Oct 17', '10 月 17 日 · 周六'],
    emptyMessages: ['No messages yet.', '暂无对话。'],
    emptyMessagesHelp: ['Ask Pip about this thread or add a detail.', '可以询问进展或补充要求。'],
    approvePR: ['Approve PR', '确认 PR'],
    createPRTitle: ['Create a pull request?', '创建 PR？'],
    createPRDescription: ['Push the branch and open a PR against main.', '推送分支，并向 main 创建 PR。'],
    createPR: ['Create PR', '创建 PR'],
    keepLocal: ['Keep local', '暂不创建'],
    machineOffline: ['Machine offline', '机器离线'],
    offlineTitle: ['Where should this run?', '如何安排？'],
    offlineDescription: ['MacBook Pro has workbench and 1 free slot.', 'MacBook Pro 有 workbench 仓库和 1 个空闲位置。'],
    waitMachine: ['Wait for Mac Studio', '等 Mac Studio 上线'],
    switchMachine: ['Use MacBook Pro', '改用 MacBook Pro'],
    resolvePR: ['Approved. Pip will share the PR link here.', '已确认。Pip 会在这里回复 PR 链接。'],
    resolveLocal: ['Changes kept on the local branch.', '修改已保留在本地分支。'],
    resolveWait: ['Queued until Mac Studio is online.', '已排队，Mac Studio 上线后执行。'],
    resolveSwitch: ['Starting on MacBook Pro.', '正在 MacBook Pro 上启动。'],
    demoResult: ['Demo: {result}', '演示：{result}'],
    pushing: ['Pushing branch · PR approved', '正在推送分支 · 已获准创建 PR'],
    preparing: ['Preparing the workspace', '正在准备执行环境'],
    waitingMachine: ['Waiting for machine', '等待机器上线'],
    chooseMachine: ['Choose a machine', '选择机器'],
    testsPassed: ['Fix ready · Tests passed', '修复完成 · 测试通过'],
    studioOffline: ['Mac Studio is offline', 'Mac Studio 离线'],
    allClear: ['All clear.', '暂无待处理事项。'],
    allClearHelp: ['Pip will ask when a decision is needed.', '需要决定时，Pip 会提醒你。'],
    recentActivity: ['Activity', '动态'],
    noRunning: ['No tasks running.', '暂无运行中的任务。'],
    threadDetails: ['Thread', '事项详情'],
    execution: ['Execution', '执行安排'],
    agent: ['Agent', '执行 Agent'],
    notStarted: ['Not started', '尚未启动'],
    latestSession: ['Latest session', '最近一次会话'],
    rawHistory: ['View session', '查看原始过程'],
    stop: ['Stop', '停止'],
    stopped: ['Stopped · Changes kept', '已停止 · 修改已保留'],
    stoppedEvent: ['You stopped the agent. Changes were kept.', '你停止了执行，修改已保留。'],
    timeline: ['Timeline', '时间线'],
    slots: ['{used} / {total} slots', '{used} / {total} 个位置'],
    machineSummary: ['{online} / {total} online · {running} agents running', '{online} / {total} 台在线 · {running} 个 Agent 运行中'],
    lastSeen: ['Last seen 32 min ago', '32 分钟前在线'],
    agents: ['Agents', 'Agent'],
    repositories: ['Repositories', '仓库'],
    connectMachine: ['To connect a machine, send /加机器 to Pip in Feishu.', '连接机器：在飞书向 Pip 发送「/加机器」。'],
    rawTitle: ['Session', '原始过程'],
    rawOffline: ['Mac Studio is offline.', 'Mac Studio 离线。'],
    noSession: ['The task has not started yet.', '任务尚未开始。'],
    sampleSession: ['Sample session · Read only', '示例会话 · 只读'],
    received: ['Instruction', '收到指令'],
    toolBash: ['Tool · bash', '工具 · bash'],
    report: ['Report', '执行报告'],
    scopeTitle: ['Message scope', '消息范围'],
    scopeDescription: ['Choose a thread to view its messages and send follow-ups. Each thread keeps its own draft.', '选择事项后，查看相关对话并发送补充要求。草稿按事项保留。'],
    autoRouteDescription: ['Let Pip find the right thread', '由 Pip 判断关联事项'],
    replying: ['Pip is replying…', 'Pip 正在回复…'],
    queued: ['Pip is replying · {count} queued', 'Pip 正在回复 · 还有 {count} 条排队'],
    queueHelp: ['New messages will be queued', '新消息将排队处理'],
    replyAnnounce: ['Pip replied.', 'Pip 已回复。'],
    stopTitle: ['Stop this agent?', '停止执行？'],
    stopDescription: ['Stop “{title}”. Changes will be kept so you can resume later.', '停止「{title}」。修改会保留，之后可以继续。'],
    confirmStop: ['Stop agent', '确认停止'],
    keepRunning: ['Keep running', '继续执行'],
    newTaskHint: ['Tell Pip what you need. A thread is created when work starts.', '告诉 Pip 要做什么，开始执行时会建立事项。'],
    aboutTitle: ['Pip · Demo', 'Pip · 示例'],
    aboutDescription: ['A local prototype with sample threads, machines, and costs. Actions are simulated. Reload to reset.', '本地交互草图，事项、机器和费用均为示例。操作仅模拟，刷新即可重置。'],
    aboutLanguage: ['English is the default. Your language choice is saved on this device.', '默认使用英文，语言选择保存在当前设备。'],
    brandTitle: ['Pip · Logo', 'Pip · Logo'],
    openWorkspace: ['Open workspace ↗', '打开工作台 ↗'],
    logoVariants: ['Pip logo on light and dark backgrounds', 'Pip Logo 的浅色与深色应用'],
    logoLockup: ['Pip logo and wordmark', 'Pip 图形与字标组合'],
    lightMark: ['Pip light mark', '米白色 Pip 图形'],
    brandHeadline: ['A little p. A familiar face.', '一个小 p，一位小伙伴。'],
    brandDescription: ['A rounded p doubles as a speech bubble. Two small eyes give Pip a face. The wordmark stays lowercase; in conversation, it’s Pip.', '圆润的小写 p，也像对话气泡。两只留白的眼睛，让 Pip 有一点表情。字标使用小写，日常文字中写作 Pip。'],
    smallSizes: ['Made for small spaces', '适合小尺寸'],
    logoUses: ['App icon · Browser tab · Avatar', '应用图标 · 浏览器标签 · 消息头像'],
    inConversation: ['In conversation', '在对话里'],
    brandMessage: ['The login fix passed its tests. Want me to open a PR?', '登录修复已通过测试，要帮你创建 PR 吗？'],
    palette: ['Palette', '配色'],
    downloadMark: ['Mark SVG ↓', '图形 SVG ↓'],
    downloadLogo: ['Logo SVG ↓', '组合 Logo SVG ↓'],
    downloadPNG: ['Transparent PNG ↓', '透明 PNG ↓'],
    downloadIcon: ['App icon PNG ↓', '应用图标 PNG ↓'],
    vectorNote: ['Vector paths · No fonts required', '矢量路径 · 无字体依赖'],
  };
  let locale = 'en';
  try { if (localStorage.getItem('pip.locale') === 'zh') locale = 'zh'; } catch { /* Private/file browsing can disable storage. */ }
  function t(key, values = {}) {
    const pair = strings[key];
    if (!pair) throw new Error(`Missing UI copy: ${key}`);
    return pair[locale === 'zh' ? 1 : 0].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  }
  function text(value) {
    if (typeof value === 'string') return value;
    if (value?.key) return t(value.key, Object.fromEntries(Object.entries(value.values ?? {}).map(([name, entry]) => [name, typeof entry === 'object' ? text(entry) : entry])));
    return value?.[locale] ?? value?.en ?? '';
  }
  function apply(root = document) {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    for (const [attribute, target] of [['data-i18n', null], ['data-i18n-label', 'aria-label'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-alt', 'alt']]) {
      root.querySelectorAll(`[${attribute}]`).forEach((element) => {
        const translated = t(element.getAttribute(attribute));
        if (target) element.setAttribute(target, translated);
        else element.textContent = translated;
      });
    }
    root.querySelectorAll('[data-locale]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.locale === locale)));
  }
  function setLocale(next) {
    if (!['en', 'zh'].includes(next) || locale === next) return false;
    locale = next;
    try { localStorage.setItem('pip.locale', locale); } catch { /* Switching still works in memory. */ }
    return true;
  }
  return { t, text, apply, setLocale, get locale() { return locale; } };
})();
