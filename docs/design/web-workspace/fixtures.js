// Bilingual sample content for the prototype, separate from interface copy.
const fixture = (() => {
  const pair = (en, zh) => ({ en, zh });
  return {
    threads: [
      {
        id: 'login', title: pair('Fix login persistence', '修复登录状态丢失'), repo: 'sig-web', agent: 'Claude Code', machine: 'Mac mini', state: 'waiting', workerStatus: 'done', unread: true, time: '19:04', branch: 'fix/session-restore',
        preview: pair('Tests passed. Ready to open a PR.', '测试通过，等待创建 PR'),
        summary: pair('Fixed session recovery after a page refresh and added a regression test. Changes are committed locally.', '已修复刷新后的 session 恢复逻辑，并补充回归测试。修改已提交到本地分支。'),
        facts: pair('2 files · +42 −8 · 12 tests passed', '2 个文件 · +42 −8 · 12 项测试通过'),
        events: [['19:04', pair('Fix ready. Waiting for PR approval.', '修复完成，等待确认创建 PR')], ['18:58', pair('Regression tests passed.', '回归测试通过')], ['18:41', pair('Found a session recovery race condition.', '定位到 session 恢复时序问题')], ['18:32', pair('Assigned to Claude Code on Mac mini.', '交给 Mac mini 上的 Claude Code')]],
      },
      {
        id: 'ci', title: pair('Investigate nightly CI timeout', '排查 nightly CI 超时'), repo: 'workbench', agent: 'Claude Code', machine: 'Mac Studio', state: 'waiting', workerStatus: 'notStarted', unread: true, time: '18:47', branch: null,
        preview: pair('Mac Studio is offline. Choose a machine.', 'Mac Studio 离线，等待安排'),
        summary: pair('Investigate the last two nightly build timeouts. Mac Studio is offline, so execution has not started.', '排查最近两次 nightly 构建超时。Mac Studio 离线，尚未开始执行。'),
        facts: { key: 'notStarted' },
        events: [['18:47', pair('Waiting for a machine choice.', '等待选择执行机器')], ['18:46', pair('Mac Studio is offline.', 'Mac Studio 离线')], ['18:46', pair('Received the CI investigation request.', '收到 CI 排查指令')]],
      },
      {
        id: 'docs', title: pair('Update connector install guide', '补充 Connector 安装文档'), repo: 'sig', agent: 'pi', machine: 'Mac mini', state: 'running', workerStatus: 'running', unread: false, time: '18:57', branch: 'docs/connector-install',
        preview: pair('Checking the Linux install steps', '正在核对 Linux 安装步骤'),
        summary: pair('Document installation, service management, and upgrades. The macOS section is ready; Linux commands are being checked.', '补充安装、服务管理和升级说明。macOS 部分已完成，正在核对 Linux 命令。'),
        facts: pair('3 files changed · Checking commands', '3 个文件已修改 · 正在核对命令'),
        events: [['18:57', pair('Checking Linux install steps.', '正在核对 Linux 安装步骤')], ['18:49', pair('Added macOS service management.', '已补充 macOS 服务管理说明')], ['18:35', pair('Assigned to pi on Mac mini.', '交给 Mac mini 上的 pi')]],
      },
      {
        id: 'keyboard', title: pair('Add keyboard search navigation', '搜索结果支持键盘导航'), repo: 'notes', agent: 'pi', machine: 'MacBook Pro', state: 'running', workerStatus: 'running', unread: false, time: '18:54', branch: 'feat/search-keyboard',
        preview: pair('Implementation ready. Running tests.', '实现完成，正在运行测试'),
        summary: pair('Use arrow keys to select results, Enter to open, and Esc to close. Implementation is ready; edge cases are being tested.', '增加上下键选择、Enter 打开和 Esc 关闭。实现已完成，正在测试边界情况。'),
        facts: pair('4 files changed · Tests running', '4 个文件已修改 · 测试运行中'),
        events: [['18:54', pair('Implementation ready. Tests started.', '实现完成，开始测试')], ['18:38', pair('Added keyboard controls and focus handling.', '补充键盘交互与焦点管理')], ['18:28', pair('Assigned to pi on MacBook Pro.', '交给 MacBook Pro 上的 pi')]],
      },
      {
        id: 'reports', title: pair('Refine Pip’s reports', '整理 Pip 的回复格式'), repo: 'sig', agent: 'pi', machine: 'Mac mini', state: 'idle', workerStatus: 'done', unread: false, time: 'yesterday', branch: 'refactor/report-format',
        preview: pair('Reports now use a consistent format.', '已统一回复格式'),
        summary: pair('Reports now cover the outcome, changes, and decisions needed. You can add preferences at any time.', '回复已统一为结果、改动和待决定的事。可以随时补充格式偏好。'),
        facts: pair('Committed · 8 tests passed', '已提交 · 8 项测试通过'),
        events: [['yesterday', pair('Report format updated and verified.', '回复格式已更新，验证通过')], ['yesterday', pair('Consolidated report templates.', '统一回复模板')]],
      },
    ],
    messages: [
      { id: 'm1', thread: 'login', role: 'user', time: '18:32', text: pair('Fix the login session being lost on refresh in sig-web, and add a test.', '修一下 sig-web 刷新后登录状态丢失的问题，补上测试。') },
      { id: 'm2', thread: 'login', role: 'assistant', time: '18:32', text: pair('Claude Code is on it, on Mac mini. I’ll let you know when it’s ready.', '已交给 Mac mini 上的 Claude Code，完成后告诉你。') },
      { id: 'm3', thread: 'ci', role: 'assistant', time: '18:47', text: pair('The CI investigation hasn’t started. Mac Studio is offline.', 'CI 排查还没开始，Mac Studio 离线了。'), decision: 'offline' },
      { id: 'm4', thread: 'docs', role: 'assistant', time: '18:57', text: pair('The macOS install guide is ready. pi is checking the Linux steps.', 'macOS 安装说明已补齐，pi 正在核对 Linux 步骤。'), process: pair('Read the agent report → Updated the thread summary\nRoutine progress stays in the conversation without a push notification.', '读取执行报告 → 更新事项摘要\n普通进展仅记录在对话中，不发送推送。') },
      { id: 'm5', thread: 'login', role: 'assistant', time: '19:04', text: pair('The login fix is ready. All 12 tests pass.', '登录问题已修复，12 项测试全部通过。'), bullets: [pair('Fixed a race between session recovery and route checks.', '修复了 session 恢复与路由校验的时序问题。'), pair('Changed 2 files and added a regression test.', '修改 2 个文件，新增 1 项回归测试。'), pair('Committed on fix/session-restore. Not pushed yet.', '已提交到 fix/session-restore，尚未推送。')], decision: 'pr', process: pair('Received Claude Code’s report\nChecked the branch and test results\nUpdated the summary → Requested PR approval', '收到 Claude Code 的报告\n核对分支和测试结果\n更新摘要 → 请求确认创建 PR') },
    ],
    machines: [
      { name: 'Mac mini', icon: 'monitor', online: true, slots: 3, agents: 'pi · Claude Code', repos: 'sig, sig-web' },
      { name: 'MacBook Pro', icon: 'laptop', online: true, slots: 2, agents: 'pi · Claude Code', repos: 'notes, workbench' },
      { name: 'Mac Studio', icon: 'monitor', online: false, slots: 2, agents: 'Claude Code', repos: 'workbench' },
    ],
    activity: [
      { thread: 'login', time: '19:04', text: pair('Login fix passed all tests.', '登录修复通过全部测试') },
      { thread: 'docs', time: '18:57', text: pair('Checking the Linux install guide.', '正在核对 Linux 安装说明') },
      { thread: 'keyboard', time: '18:54', text: pair('Keyboard navigation is in testing.', '键盘导航进入测试阶段') },
    ],
  };
})();
