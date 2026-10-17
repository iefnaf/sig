// Local prototype: all activity is simulated. No commands reach a real agent.
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/><path d="M7 10h8M7 14h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  laptop: '<path d="M5 16V5h14v11M2 16h20l-2 4H4Z"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  route: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v7a5 5 0 0 0 5 5h5M6 11h7a5 5 0 0 0 5-5V3m-3 3 3-3 3 3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M18 7a8 8 0 0 1-8 8H6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  signal: '<path d="M4 19h1M8 15v4M12 11v8M16 7v12M20 3v16"/>',
};
const $ = (selector) => document.querySelector(selector);
const { t, text: localize } = i18n;
const esc = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const label = (value) => esc(localize(value));
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
const key = (name, values) => ({ key: name, values });
const timeLabel = (time) => ['yesterday', 'justNow'].includes(time) ? t(time) : time;
const stateLabel = (state) => t({ waiting: 'needsYou', running: 'running', idle: 'idle' }[state]);
const stateColor = (state) => ({ waiting: 'amber', running: 'green', idle: 'gray' }[state]);
let threads = structuredClone(fixture.threads);
let messages = structuredClone(fixture.messages);
let activity = structuredClone(fixture.activity);
const machines = fixture.machines;
let selected = null;
let resolved = {};
let filter = '';
let busy = false;
let jobs = [];
const timers = new Set();
const drafts = new Map();
let toastTimer;
let toastValue;
let dialogState = null;
let messageSequence = 0;
const currentThread = () => threads.find((thread) => thread.id === selected);
const pending = () => messages.filter((message) => message.decision && !resolved[message.id]);
const runningOn = (machine) => threads.filter((thread) => thread.machine === machine.name && thread.state === 'running');
function later(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay); timers.add(timer); }
function announce(value) { $('#announcer').textContent = localize(value); }
function toast(value) {
  clearTimeout(toastTimer);
  toastValue = value;
  $('#toast').textContent = localize(value);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}
function threadRef(id) {
  const thread = threads.find((entry) => entry.id === id);
  return thread ? `<a class="thread-reference" href="#thread/${id}">${icon('layers')}${label(thread.title)}</a>` : '';
}
function stateBadge(thread) { return `<span class="state-badge ${thread.state}"><span class="status-dot ${stateColor(thread.state)}"></span>${stateLabel(thread.state)}</span>`; }
function processMarkup(value) { return `<details class="process"><summary>${icon('chevron-right')}${t('process')}</summary><pre>${label(value)}</pre></details>`; }

function renderThreads() {
  const list = threads.filter((thread) => `${thread.title.en} ${thread.title.zh} ${thread.repo} ${thread.machine} ${thread.agent}`.toLowerCase().includes(filter.toLowerCase()));
  $('#thread-list').innerHTML = ['waiting', 'running', 'idle'].map((state) => {
    const matches = list.filter((thread) => thread.state === state);
    if (!matches.length) return '';
    return `<section class="thread-group"><h2 class="group-label"><span class="status-dot ${stateColor(state)}"></span>${stateLabel(state)}<span class="group-count">${matches.length}</span></h2>${matches.map((thread) => `<a class="thread-item ${selected === thread.id ? 'active' : ''}" href="#thread/${thread.id}" ${selected === thread.id ? 'aria-current="page"' : ''}><div class="thread-title"><span>${label(thread.title)}</span>${thread.unread ? `<span class="unread" aria-label="${t('unread')}"></span>` : ''}</div><div class="thread-preview" title="${label(thread.preview)}">${label(thread.preview)}</div><div class="thread-meta"><span>${esc(thread.agent)} · ${esc(thread.machine)}</span><span>${timeLabel(thread.time)}</span></div></a>`).join('')}</section>`;
  }).join('') || `<div class="empty-state">${icon('search')}<strong>${t('noResults')}</strong><p>${t('searchHint')}</p><button class="button" data-action="clear-search">${t('clearSearch')}</button></div>`;
  $('.all-conversation').classList.toggle('active', !selected);
  if (selected) $('.all-conversation').removeAttribute('aria-current');
  else $('.all-conversation').setAttribute('aria-current', 'page');
  const count = pending().length;
  $('#waiting-count').textContent = count;
  $('.waiting-status').classList.toggle('all-clear', count === 0);
  $('#mobile-count').textContent = count;
  $('#mobile-count').hidden = count === 0;
  $('#running-count').textContent = threads.filter((thread) => thread.state === 'running').length;
  $('#online-count').textContent = t('machineCount', { count: machines.filter((machine) => machine.online).length });
  $('#machine-list').innerHTML = machines.map((machine) => `<button class="machine-row ${machine.online ? '' : 'offline'}" data-action="machines" title="${esc(machine.name)} · ${machine.online ? t('slots', { used: runningOn(machine).length, total: machine.slots }) : t('offline')}">${icon(machine.icon)}<span>${esc(machine.name)}</span><span class="slots">${machine.online ? `${runningOn(machine).length} / ${machine.slots}` : t('offline')}</span><span class="status-dot ${machine.online ? 'green' : 'gray'}"></span></button>`).join('');
  document.title = `${count ? `(${count}) ` : ''}${t('workspaceTitle')}`;
}
function decisionMarkup(message) {
  if (resolved[message.id]) return `<div class="decision-resolved">${icon('check')}<span>${t(resolved[message.id])}</span></div>`;
  if (message.decision === 'pr') return `<div class="decision-card"><div class="decision-label">${icon('branch')}${t('approvePR')}</div><h3>${t('createPRTitle')}</h3><p>${t('createPRDescription')}</p><div class="decision-meta">${icon('branch')}<code>fix/session-restore</code><span>→</span><code>main</code></div><div class="card-actions"><button class="button primary" data-decision="pr" data-message="${message.id}">${icon('branch')}${t('createPR')}</button><button class="button quiet" data-decision="defer" data-message="${message.id}">${t('keepLocal')}</button></div></div>`;
  return `<div class="decision-card"><div class="decision-label">${icon('monitor')}${t('machineOffline')}</div><h3>${t('offlineTitle')}</h3><p>${t('offlineDescription')}</p><div class="card-actions"><button class="button primary" data-decision="wait" data-message="${message.id}">${t('waitMachine')}</button><button class="button" data-decision="switch" data-message="${message.id}">${t('switchMachine')}</button></div></div>`;
}
function renderMessage(message) {
  const thread = threads.find((entry) => entry.id === message.thread);
  if (message.role === 'user') return `<article class="user-message" id="${message.id}"><div class="user-body">${label(message.text)}</div><div class="user-meta">${t('you')} · ${timeLabel(message.time)}${thread ? ` · ${label(thread.title)}` : ''}</div></article>`;
  return `<article class="message" id="${message.id}"><div class="message-header"><img class="pip-avatar" src="assets/pip-mark.svg" width="26" height="26" alt="">Pip<span class="message-time">${timeLabel(message.time)}</span></div><div class="message-body">${!selected && message.thread ? threadRef(message.thread) : ''}<p>${label(message.text)}</p>${message.bullets ? `<ul class="report-points">${message.bullets.map((point) => `<li>${label(point)}</li>`).join('')}</ul>` : ''}${message.decision ? decisionMarkup(message) : ''}${message.process ? processMarkup(message.process) : ''}</div></article>`;
}
function renderFeed(preservePosition = false) {
  const feed = $('#feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 12;
  const opened = new Set([...feed.querySelectorAll('details[open]')].map((details) => details.closest('article').id));
  const anchor = [...feed.querySelectorAll('article')].find((article) => article.getBoundingClientRect().bottom > feed.getBoundingClientRect().top);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top : 0;
  const oldTop = feed.scrollTop;
  const shown = messages.filter((message) => !selected || message.thread === selected);
  const thread = currentThread();
  $('#conversation-title').textContent = thread ? localize(thread.title) : 'Pip';
  $('#conversation-subtitle').textContent = thread ? `${thread.repo} · ${thread.agent} · ${thread.machine}` : t('allThreads');
  $('#scope-banner').hidden = !thread;
  $('#scope-banner').innerHTML = thread ? `<span>${t('scopeNotice')}</span><button data-action="all">${t('backToAll')} ↗</button>` : '';
  $('#scope-label').textContent = thread ? t('scopedRoute', { title: localize(thread.title) }) : t('autoRoute');
  $('#scope-chip').title = thread ? localize(thread.title) : t('autoRouteDescription');
  $('#scope-chip').classList.toggle('scoped', !!thread);
  $('#message-input').placeholder = thread ? t('scopedPlaceholder') : t('inputPlaceholder');
  feed.innerHTML = `<div class="feed-inner"><div class="date-divider">${t('dateDivider')}</div>${shown.length ? shown.map(renderMessage).join('') : `<div class="empty-state">${icon('chat')}<strong>${t('emptyMessages')}</strong><p>${t('emptyMessagesHelp')}</p></div>`}</div>`;
  feed.querySelectorAll('details').forEach((details) => { details.open = opened.has(details.closest('article').id); });
  if (!preservePosition || nearBottom) feed.scrollTop = feed.scrollHeight;
  else {
    feed.scrollTop = oldTop;
    const nextAnchor = anchor && document.getElementById(anchor.id);
    if (nextAnchor) feed.scrollTop += nextAnchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchorOffset;
  }
}
function attentionMarkup(message) {
  const thread = threads.find((entry) => entry.id === message.thread);
  return `<button class="attention-item" data-jump="${message.id}"><span class="attention-type">${icon(message.decision === 'pr' ? 'branch' : 'monitor')}${t(message.decision === 'pr' ? 'approvePR' : 'chooseMachine')}</span><h3>${label(thread.title)}</h3><span class="attention-description">${t(message.decision === 'pr' ? 'testsPassed' : 'studioOffline')}${icon('chevron-right')}</span></button>`;
}
function timelineMarkup(events) {
  return events.map(([time, description]) => `<div class="activity-item"><time>${timeLabel(time)}</time><p>${label(description)}</p></div>`).join('');
}
function renderContext() {
  const thread = currentThread();
  const close = `<button class="icon-button close-context" data-action="close-details" aria-label="${t('closeDetails')}">${icon('close')}</button>`;
  if (!thread) {
    const running = threads.filter((entry) => entry.state === 'running');
    $('#context-panel').innerHTML = `<header class="context-header"><h2>${t('workspace')}</h2><span class="overline">${t('shortDate')}</span>${close}</header><section class="context-section"><h3 class="section-title">${t('needsYou')}<strong class="${pending().length ? '' : 'clear-count'}">${pending().length}</strong></h3>${pending().map(attentionMarkup).join('') || `<div class="empty-state compact">${icon('check')}<strong>${t('allClear')}</strong><p>${t('allClearHelp')}</p></div>`}</section><section class="context-section"><h3 class="section-title">${t('running')}<span>${running.length}</span></h3>${running.map((entry) => `<a class="running-item" href="#thread/${entry.id}"><span><strong>${label(entry.title)}</strong><small>${esc(entry.agent)} · ${esc(entry.machine)}</small></span><span class="status-dot green"></span></a>`).join('') || `<p class="muted-copy">${t('noRunning')}</p>`}</section><section class="context-section"><h3 class="section-title">${t('recentActivity')}</h3>${activity.slice(0, 4).map((entry) => `<a class="activity-link" href="#thread/${entry.thread}">${timelineMarkup([[entry.time, entry.text]])}</a>`).join('')}</section>`;
    return;
  }
  const waiting = pending().filter((message) => message.thread === selected);
  const hasSession = !['notStarted', 'queued'].includes(thread.workerStatus);
  $('#context-panel').innerHTML = `<header class="context-header"><h2>${t('threadDetails')}</h2>${close}</header><section class="context-section"><h2 class="thread-detail-title">${label(thread.title)}</h2>${stateBadge(thread)}<p class="detail-summary">${label(thread.summary)}${thread.decisionSummary ? ` ${t(thread.decisionSummary)}` : ''}</p><div class="repo-label">${icon('folder')}${esc(thread.repo)}</div></section>${waiting.length ? `<section class="context-section"><h3 class="section-title">${t('needsYou')}<strong>${waiting.length}</strong></h3>${waiting.map(attentionMarkup).join('')}</section>` : ''}<section class="context-section"><h3 class="section-title">${t(hasSession ? 'agent' : 'execution')}<span>${t(thread.workerStatus === 'running' ? 'running' : hasSession ? 'latestSession' : 'notStarted')}</span></h3><div class="worker-card"><div class="worker-title"><span><span class="agent-icon">${thread.agent === 'pi' ? 'π' : '✳'}</span>${esc(thread.agent)}</span>${icon(thread.workerStatus === 'running' ? 'signal' : hasSession ? 'check' : 'clock')}</div><div class="worker-meta">${esc(thread.machine)}</div>${thread.branch ? `<code>${esc(thread.branch)}</code>` : ''}<div class="worker-facts">${label(thread.facts)}</div><div class="worker-actions"><button data-raw="${thread.id}" ${hasSession ? '' : `disabled title="${t('noSession')}"`}>${t('rawHistory')}${icon('external')}</button>${thread.state === 'running' ? `<button class="stop-button" data-stop="${thread.id}">${t('stop')}</button>` : ''}</div></div></section><section class="context-section"><h3 class="section-title">${t('timeline')}</h3>${timelineMarkup(thread.events)}</section>`;
}
function renderAll(preservePosition = false) {
  const contextTop = $('#context-panel').scrollTop;
  const listTop = $('#thread-list').scrollTop;
  i18n.apply();
  renderThreads();
  renderFeed(preservePosition);
  renderContext();
  updateQueue();
  if (preservePosition) { $('#context-panel').scrollTop = contextTop; $('#thread-list').scrollTop = listTop; }
  else $('#context-panel').scrollTop = 0;
  if (dialogState) renderDialog();
  if (toastValue && !$('#toast').hidden) $('#toast').textContent = localize(toastValue);
}
function setMobile(view) {
  $('#workspace').dataset.mobile = view;
  document.querySelectorAll('[data-mobile-view]').forEach((button) => {
    const active = button.dataset.mobileView === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (view === 'chat') resizeInput();
}
function syncDetailButton() {
  const narrow = matchMedia('(max-width: 990px)').matches;
  const open = narrow ? $('#workspace').classList.contains('context-overlay') : !$('#workspace').classList.contains('context-hidden');
  $('.detail-toggle').setAttribute('aria-expanded', String(open));
}
function openDetails() { $('#workspace').classList.remove('context-hidden'); $('#workspace').classList.add('context-overlay'); syncDetailButton(); }
function closeDetails() { $('#workspace').classList.remove('context-overlay'); $('#workspace').classList.add('context-hidden'); syncDetailButton(); $('.detail-toggle').focus(); }
function resizeInput() {
  const input = $('#message-input');
  input.rows = matchMedia('(max-width: 650px)').matches ? 1 : 2;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}
function changeSelection(id) {
  drafts.set(selected || 'all', $('#message-input').value);
  selected = threads.some((thread) => thread.id === id) ? id : null;
  if (selected) currentThread().unread = false;
  $('#message-input').value = drafts.get(selected || 'all') || '';
  $('#send-button').disabled = !$('#message-input').value.trim();
  resizeInput();
  setMobile('chat');
  $('#workspace').classList.remove('context-overlay');
  renderAll();
  syncDetailButton();
}
function route() { changeSelection(location.hash.startsWith('#thread/') ? location.hash.slice(8) : null); }
function navigate(id) { const hash = id ? `#thread/${id}` : '#all'; if (location.hash === hash) changeSelection(id); else location.hash = hash; }
function changeLanguage(locale) {
  if (!i18n.setLocale(locale)) return;
  renderAll(true);
  resizeInput();
}
function openDialog(type, id) {
  dialogState = { type, id };
  renderDialog();
  if (!$('#dialog').open) $('#dialog').showModal();
}
function renderDialog() {
  const { type, id } = dialogState;
  const thread = threads.find((entry) => entry.id === id);
  let title;
  let body;
  if (type === 'machines') {
    title = t('machines');
    body = `<p class="dialog-copy">${t('machineSummary', { online: 2, total: 3, running: threads.filter((entry) => entry.state === 'running').length })}</p>${machines.map((machine) => `<section class="machine-card"><h3>${icon(machine.icon)}<span>${esc(machine.name)}</span><span class="machine-availability"><span class="status-dot ${machine.online ? 'green' : 'gray'}"></span>${machine.online ? t('online') : t('offline')}</span></h3><p>${machine.online ? t('slots', { used: runningOn(machine).length, total: machine.slots }) : t('lastSeen')}</p><dl><div><dt>${t('agents')}</dt><dd>${esc(machine.agents)}</dd></div><div><dt>${t('repositories')}</dt><dd>${esc(machine.repos)}</dd></div>${runningOn(machine).length ? `<div><dt>${t('running')}</dt><dd>${runningOn(machine).map((entry) => label(entry.title)).join(' · ')}</dd></div>` : ''}</dl></section>`).join('')}<p class="dialog-copy machine-help">${t('connectMachine')}</p>`;
  } else if (type === 'scope') {
    title = t('scopeTitle');
    body = `<p class="dialog-copy">${t('scopeDescription')}</p><button class="scope-option ${selected ? '' : 'selected'}" data-select="all">${icon('route')}<span>${t('autoRoute')}<small>${t('autoRouteDescription')}</small></span>${selected ? '' : icon('check')}</button>${threads.map((entry) => `<button class="scope-option ${selected === entry.id ? 'selected' : ''}" data-select="${entry.id}">${icon('layers')}<span>${label(entry.title)}<small>${esc(entry.repo)} · ${stateLabel(entry.state)}</small></span>${selected === entry.id ? icon('check') : ''}</button>`).join('')}`;
  } else if (type === 'stop' && thread) {
    title = t('stopTitle');
    body = `<p class="dialog-copy">${esc(t('stopDescription', { title: localize(thread.title) }))}</p><div class="card-actions"><button class="button danger" data-confirm-stop="${thread.id}">${t('confirmStop')}</button><button class="button" data-action="close-dialog">${t('keepRunning')}</button></div>`;
  } else if (type === 'raw' && thread) {
    title = `${thread.agent} · ${t('rawTitle')}`;
    if (['notStarted', 'queued'].includes(thread.workerStatus)) body = `<p class="dialog-copy">${thread.machine === 'Mac Studio' ? t('rawOffline') : ''} ${t('noSession')}</p>`;
    else {
      const lines = id === 'login' ? [
        [`18:32 · ${t('received')}`, fixture.messages[0].text],
        ['18:41 · Claude Code', { en: 'The route guard runs before session recovery finishes. Wait for recovery before deciding whether to redirect to login.', zh: '路由守卫在 session 恢复完成前执行。改为等待恢复结果，再决定是否跳转到登录页。' }],
        [`18:58 · ${t('toolBash')}`, 'pnpm test -- auth/session.test.ts\nTest Files  1 passed (1)\nTests       12 passed (12)'],
        [`19:04 · ${t('report')}`, { en: '2 files changed. Regression test added.\nBranch: fix/session-restore\nLocal commit: 7bd40e2\nNot pushed. Awaiting PR approval.', zh: '修改 2 个文件，新增回归测试。\n分支：fix/session-restore\n本地提交：7bd40e2\n尚未推送，等待创建 PR 的确认。' }],
      ] : [[`${timeLabel(thread.time)} · ${thread.agent}`, thread.summary], [t('recentActivity'), thread.facts]];
      body = `<p class="dialog-copy">${esc(thread.machine)} / ${esc(thread.repo)} · ${t('sampleSession')}</p>${lines.map(([heading, content]) => `<div class="raw-entry"><strong>${esc(heading)}</strong><pre>${label(content)}</pre></div>`).join('')}`;
    }
  } else {
    title = t('aboutTitle');
    body = `<p class="dialog-copy">${t('aboutDescription')}</p><p class="dialog-copy">${t('aboutLanguage')}</p><a class="button" href="brand.html">Pip Logo ${icon('external')}</a>`;
  }
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
}
function closeDialog() { $('#dialog').close(); dialogState = null; }
function recordActivity(thread, value) {
  thread.events.unshift(['justNow', value]);
  thread.time = 'justNow';
  activity.unshift({ thread: thread.id, time: 'justNow', text: value });
}
function resolveDecision(action, messageId) {
  if (resolved[messageId]) return;
  const message = messages.find((entry) => entry.id === messageId);
  if (!message) return;
  const thread = threads.find((entry) => entry.id === message.thread);
  const response = { pr: 'resolvePR', defer: 'resolveLocal', wait: 'resolveWait', switch: 'resolveSwitch' }[action];
  if (!response) return;
  resolved[messageId] = response;
  thread.state = ['pr', 'switch'].includes(action) ? 'running' : 'idle';
  thread.workerStatus = thread.state === 'running' ? 'running' : action === 'wait' ? 'queued' : 'done';
  thread.preview = key(response);
  thread.decisionSummary = response;
  if (action === 'switch') { thread.machine = 'MacBook Pro'; thread.branch = 'fix/nightly-timeout'; thread.facts = key('preparing'); }
  if (action === 'pr') thread.facts = key('pushing');
  if (action === 'wait') thread.facts = key('waitingMachine');
  recordActivity(thread, key(response));
  renderAll(true);
  toast(key('demoResult', { result: key(response) }));
  announce(key(response));
}
function updateQueue() {
  $('#queue').hidden = !busy;
  $('#queue').textContent = busy ? jobs.length ? t('queued', { count: jobs.length }) : t('replying') : '';
  $('#composer-status').textContent = busy ? t('queueHelp') : t(selected ? 'scopeHelp' : 'routeHelp');
}
function now() { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
function processQueue() {
  if (busy || !jobs.length) return;
  busy = true;
  const job = jobs.shift();
  updateQueue();
  later(() => {
    const thread = threads.find((entry) => entry.id === job.thread);
    const reply = thread ? { en: `Added to “${thread.title.en}”. This is a demo; no message was sent to a real agent.`, zh: `已关联到「${thread.title.zh}」。这是交互演示，尚未发送给实际 Agent。` } : { en: 'Got it. Pip will find an existing thread or start a new one when work is needed. This is a demo; no task was dispatched.', zh: '收到。Pip 会关联已有事项，或在需要执行时建立新事项。这是交互演示，尚未派发任务。' };
    messages.push({ id: `demo-${++messageSequence}`, role: 'assistant', thread: job.thread, time: now(), text: reply });
    busy = false;
    renderFeed(true);
    announce(key('replyAnnounce'));
    updateQueue();
    processQueue();
  }, 1800);
}

$('#composer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('#message-input').value.trim();
  if (!text) return;
  messages.push({ id: `user-${++messageSequence}`, role: 'user', thread: selected, text, time: now() });
  jobs.push({ thread: selected });
  $('#message-input').value = '';
  drafts.delete(selected || 'all');
  $('#send-button').disabled = true;
  resizeInput();
  renderFeed();
  processQueue();
  updateQueue();
});
$('#message-input').addEventListener('input', () => { $('#send-button').disabled = !$('#message-input').value.trim(); resizeInput(); });
$('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer-form').requestSubmit(); } });
$('#thread-search').addEventListener('input', (event) => { filter = event.target.value.trim(); renderThreads(); });
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { syncDetailButton(); resizeInput(); });
window.addEventListener('storage', (event) => { if (event.key === 'pip.locale') changeLanguage(event.newValue === 'zh' ? 'zh' : 'en'); });
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#dialog').open) { event.preventDefault(); setMobile('threads'); $('#thread-search').focus(); }
  if (event.key === 'Escape' && !$('#dialog').open && $('#workspace').classList.contains('context-overlay')) closeDetails();
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.locale) { changeLanguage(button.dataset.locale); return; }
  if (button.dataset.mobileView) { setMobile(button.dataset.mobileView); return; }
  if (button.dataset.decision) { resolveDecision(button.dataset.decision, button.dataset.message); return; }
  if (button.dataset.raw) { openDialog('raw', button.dataset.raw); return; }
  if (button.dataset.select) { closeDialog(); navigate(button.dataset.select === 'all' ? null : button.dataset.select); return; }
  if (button.dataset.jump) {
    const message = messages.find((entry) => entry.id === button.dataset.jump);
    if (!message) return;
    changeSelection(message.thread);
    history.replaceState(null, '', `#thread/${message.thread}`);
    const target = document.getElementById(message.id);
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    target.classList.add('flash');
    later(() => target.classList.remove('flash'), 1600);
    return;
  }
  if (button.dataset.stop) { openDialog('stop', button.dataset.stop); return; }
  if (button.dataset.confirmStop) {
    const thread = threads.find((entry) => entry.id === button.dataset.confirmStop);
    thread.state = 'idle'; thread.workerStatus = 'stopped'; thread.preview = key('stopped'); thread.facts = key('stopped');
    recordActivity(thread, key('stoppedEvent'));
    closeDialog(); renderAll(true); toast(key('stopped')); return;
  }
  switch (button.dataset.action) {
    case 'all': navigate(null); break;
    case 'new': changeSelection(null); history.replaceState(null, '', '#all'); $('#message-input').focus(); toast(key('newTaskHint')); break;
    case 'machines': openDialog('machines'); break;
    case 'details': {
      const narrow = matchMedia('(max-width: 990px)').matches;
      const opened = narrow ? $('#workspace').classList.contains('context-overlay') : !$('#workspace').classList.contains('context-hidden');
      if (opened) closeDetails(); else openDetails(); break;
    }
    case 'attention': changeSelection(null); history.replaceState(null, '', '#all'); openDetails(); break;
    case 'close-details': closeDetails(); break;
    case 'scope': openDialog('scope'); break;
    case 'close-dialog': closeDialog(); break;
    case 'about': openDialog('about'); break;
    case 'clear-search': filter = ''; $('#thread-search').value = ''; renderThreads(); $('#thread-search').focus(); break;
    case 'reset': {
      timers.forEach(clearTimeout); timers.clear(); threads = structuredClone(fixture.threads); messages = structuredClone(fixture.messages); activity = structuredClone(fixture.activity); resolved = {}; jobs = []; busy = false; filter = ''; drafts.clear(); $('#thread-search').value = ''; $('#message-input').value = ''; changeSelection(null); history.replaceState(null, '', '#all'); toast(key('resetDone')); break;
    }
  }
});
$('#dialog').addEventListener('close', () => { dialogState = null; });
$('#dialog').addEventListener('click', (event) => {
  if (event.target !== $('#dialog')) return;
  const rect = $('#dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
});
document.querySelectorAll('[data-icon]').forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
route();
