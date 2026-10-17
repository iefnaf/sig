// The Pip workspace: one continuous conversation, the threads behind it, and the decisions
// waiting for the owner. This file is the view and the wiring; what to show is decided by the
// pure helpers in model.js and format.js. Data comes from /app/api/workspace and is kept
// current by a WebSocket that only says "something changed" (the page then refetches).
//
// Everything on screen is built with h() (dom.js) from text nodes: nothing a message, an agent
// or a repository contains is ever parsed as HTML.
import { h, icon, paintIcons } from './dom.js';
import { applyStatic, getLocale, localeTag, setLocale, t, tOr } from './i18n.js';
import { dayKey, formatClock, formatDay, formatRelative, formatUsd, parseMarkup, trimOpenMarkup } from './format.js';
import {
  ACTION_KEYS, FATAL_COPY, KNOWN_TITLES, attentionFor, groupByDay, groupThreads, isActiveWorker, messagesFor, previewOf, summarize, withPending, workOn,
} from './model.js';

const $ = (selector) => document.querySelector(selector);
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const state = {
  snapshot: null,
  csrf: '',
  selected: null,
  filter: '',
  pending: new Map(), // request id -> { id, text, threadId, replyTo, at, status: 'sending' | 'failed' }
  busyCards: new Set(),
  replyTo: null, // outbound id of the card the composer is answering
  drafts: new Map(),
  dialog: null,
  connection: 'connecting',
  fatal: null, // 'signed_out' | 'logged_out' | 'unreachable'
  knownAttention: new Set(),
  live: null, // the reply Pip is writing right now: { text, threadId, ending }
  skew: 0, // server clock minus this browser's clock, so relative times agree with the server's timestamps
};

// ---- small pieces ---------------------------------------------------------------------------------

const threadById = (id) => state.snapshot?.threads.find((thread) => thread.id === id) ?? null;
const serverNow = () => Date.now() + state.skew;
const dayLabel = (ts) => formatDay(ts, serverNow(), localeTag(), { today: t('today'), yesterday: t('yesterday') });
const ago = (ts) => formatRelative(ts, serverNow(), localeTag(), t('justNow'));
const stateLabel = (value) => t({ waiting_you: 'needsYou', running: 'running', idle: 'idle' }[value] ?? 'idle');
const stateColor = (value) => ({ waiting_you: 'amber', running: 'green', idle: 'gray' }[value] ?? 'gray');
const stateClass = (value) => ({ waiting_you: 'waiting', running: 'running', idle: 'idle' }[value] ?? 'idle');
const working = () => state.snapshot.busy || [...state.pending.values()].some((entry) => entry.status === 'sending');

/**
 * Redraws a region only when what it shows changed. A refresh that changes nothing then keeps
 * the reader's text selection, scroll position and focus exactly as they were.
 */
const drawn = new Map();
function redraw(region, signature, draw) {
  const next = JSON.stringify(signature);
  if (drawn.get(region) === next) return false;
  drawn.set(region, next);
  draw();
  return true;
}
/** Relative times ("5 min. ago") go stale; regions that show them are redrawn at least this often. */
const minuteBucket = () => Math.floor(Date.now() / 30_000);

function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3600);
}

/** Keeps keyboard focus on "the same" control across a re-render (items carry data-focus keys). */
function preservingFocus(container, render) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset?.focus : null;
  render();
  if (key) container.querySelector(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

function stateBadge(value) {
  return h('span', { class: `state-badge ${stateClass(value)}` }, h('span', { class: `status-dot ${stateColor(value)}` }), stateLabel(value));
}

// ---- text with markup ------------------------------------------------------------------------------

function inline(parts) {
  return parts.map((part) => {
    if (part.t === 'code') return h('code', null, part.text);
    if (part.t === 'strong') return h('strong', null, part.text);
    if (part.t === 'link') return h('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer', title: part.href }, part.text);
    return part.text;
  });
}

function markup(text) {
  const blocks = parseMarkup(text).map((block) => {
    if (block.t === 'code') return h('pre', null, block.text);
    if (block.t === 'ul' || block.t === 'ol') return h(block.t, null, block.items.map((item) => h('li', null, inline(item))));
    return h('p', null, block.lines.flatMap((line, index) => (index === 0 ? [inline(line)] : [h('br'), inline(line)])));
  });
  return h('div', { class: 'markup' }, blocks);
}

// ---- cards ----------------------------------------------------------------------------------------------

const KIND_ICONS = { question: 'help', consent: 'branch', offline: 'monitor', offer: 'repeat', memory: 'memory', report: 'check', update: 'sparkle' };
const DECISION_KINDS = ['question', 'consent', 'offline', 'offer', 'memory'];

function buttonLabel(button) {
  const action = button.action ?? '';
  if (action.startsWith('asknew:')) return t('actionNew');
  if (action === 'switch_machine') {
    const names = /^换台机器（(.+)）$/.exec(button.label)?.[1];
    return names ? t('actionSwitchTo', { names }) : t('actionSwitch');
  }
  return ACTION_KEYS[action] ? t(ACTION_KEYS[action]) : button.label;
}

const cardTitle = (card) => (KNOWN_TITLES[card.title] ? t(KNOWN_TITLES[card.title]) : card.title);
const cardHeading = (card) => cardTitle(card) || card.body[0] || t(`kind${cap(card.kind)}`);

function cardNode(card, cardId, open) {
  const decisive = DECISION_KINDS.includes(card.kind);
  const busy = state.busyCards.has(cardId);
  const actions = card.buttons.map((button) => {
    const label = buttonLabel(button);
    const className = `button${button.primary ? ' primary' : ''}`;
    if (button.url) return h('a', { class: className, href: button.url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'));
    if (!open) return null;
    return h('button', {
      type: 'button', class: className, dataset: { card: cardId, action: button.action, focus: `card:${cardId}:${button.action}` },
      'aria-busy': busy ? 'true' : null, disabled: busy ? true : null,
    }, label);
  }).filter(Boolean);
  const canAnswer = open && card.kind === 'question';
  return h('div', { class: `card${open ? ' is-open' : ''}`, dataset: { tone: card.tone, kind: card.kind } },
    h('div', { class: 'card-kind' }, icon(KIND_ICONS[card.kind] ?? 'sparkle'), t(`kind${cap(card.kind)}`)),
    cardTitle(card) ? h('h3', { class: 'card-title' }, cardTitle(card)) : null,
    card.body.length ? h('div', { class: 'card-body' }, card.body.map(markup)) : null,
    actions.length || canAnswer ? h('div', { class: 'card-actions' }, actions,
      canAnswer ? h('button', { type: 'button', class: 'button quiet', dataset: { reply: cardId, focus: `reply:${cardId}` } }, t('answer')) : null) : null,
    busy ? h('div', { class: 'card-busy' }, t('cardWorking')) : null,
    decisive && !open ? h('div', { class: 'card-state' }, icon('check'), t('cardHandled')) : null,
    card.note ? h('p', { class: 'card-note' }, card.note) : null);
}

// ---- the top bar and the sidebar ---------------------------------------------------------------

function renderTop() {
  const snapshot = state.snapshot;
  const summary = summarize(snapshot);
  $('#machine-summary').textContent = `${summary.machinesOnline} / ${summary.machinesTotal}`;
  $('#machine-dot').className = `status-dot ${summary.machinesTotal === 0 ? 'gray' : summary.machinesOnline > 0 ? 'green' : 'amber'}`;
  $('#running-count').textContent = String(summary.running);
  $('#running-dot').className = `status-dot ${summary.running ? 'green pulse' : 'gray'}`;
  $('#waiting-count').textContent = String(summary.needs);
  $('.waiting-status').classList.toggle('all-clear', summary.needs === 0);
  const mobile = $('#mobile-count');
  mobile.textContent = String(summary.needs);
  mobile.hidden = summary.needs === 0;
  const spend = $('#spend');
  spend.hidden = false;
  spend.classList.toggle('over', snapshot.budget.over);
  spend.title = snapshot.budget.over ? t('overBudget') : t('spendTitle', { limit: formatUsd(snapshot.budget.limitUsd) });
  $('#spend-value').textContent = formatUsd(snapshot.budget.costUsd);
  document.title = `${summary.needs ? `(${summary.needs}) ` : ''}${t('workspaceTitle')}`;
}

function renderConnection() {
  $('#connection').dataset.state = state.connection;
  $('#connection-label').textContent = t(state.connection === 'live' ? 'live' : state.connection);
}

function renderSidebar() {
  const snapshot = state.snapshot;
  const list = $('#thread-list');
  const rows = snapshot.threads.map((thread) => [thread.id, thread.title, thread.state, thread.unread, thread.lastActivityAt, thread.machine, thread.workers.map((worker) => worker.agent), previewOf(thread, snapshot.messages)]);
  redraw('threads', [getLocale(), state.filter, state.selected, rows, minuteBucket()], () => preservingFocus(list, () => {
    const groups = groupThreads(snapshot.threads, state.filter);
    if (groups.length === 0) {
      const searching = state.filter.trim() !== '';
      list.replaceChildren(h('div', { class: 'empty-state' }, icon(searching ? 'search' : 'layers'),
        h('strong', null, t(searching ? 'noResults' : 'noThreads')), h('p', null, t(searching ? 'searchHint' : 'noThreadsHelp')),
        searching ? h('button', { type: 'button', class: 'button', dataset: { action: 'clear-search' } }, t('clearSearch')) : null));
      return;
    }
    list.replaceChildren(...groups.map((group) => h('section', { class: 'thread-group' },
      h('h2', { class: 'group-label' }, h('span', { class: `status-dot ${stateColor(group.state)}` }), stateLabel(group.state), h('span', { class: 'group-count' }, String(group.threads.length))),
      group.threads.map((thread) => {
        const active = state.selected === thread.id;
        const meta = [[...new Set(thread.workers.map((worker) => worker.agent))].join(', '), thread.machine].filter(Boolean).join(' · ');
        return h('a', {
          class: `thread-item${active ? ' active' : ''}`, href: `/app/threads/${thread.id}`, dataset: { nav: thread.id, focus: `thread:${thread.id}` },
          'aria-current': active ? 'page' : null,
        },
        h('div', { class: 'thread-title' }, h('span', null, thread.title), thread.unread ? h('span', { class: 'unread', 'aria-label': t('unread') }) : null),
        h('div', { class: 'thread-preview' }, previewOf(thread, snapshot.messages)),
        h('div', { class: 'thread-meta' }, h('span', null, meta), h('span', null, ago(thread.lastActivityAt))));
      }))));
  }));
  $('.all-conversation').classList.toggle('active', !state.selected);
  if (state.selected) $('.all-conversation').removeAttribute('aria-current');
  else $('.all-conversation').setAttribute('aria-current', 'page');

  const summary = summarize(snapshot);
  $('#online-count').textContent = summary.machinesTotal ? t('machineCount', { count: summary.machinesOnline }) : '';
  const machines = snapshot.machines.filter((machine) => !machine.revoked);
  redraw('machines', [getLocale(), machines], () => $('#machine-list').replaceChildren(...(machines.length ? machines.map((machine) => h('button', {
    type: 'button', class: `machine-row${machine.online ? '' : ' offline'}`, dataset: { action: 'machines' },
    title: `${machine.name} · ${machine.online ? t('slots', { used: machine.slots?.running ?? 0, total: machine.slots?.max ?? 0 }) : t('offline')}`,
  }, icon('laptop'), h('span', null, machine.name),
  h('span', { class: 'slots' }, machine.online ? `${machine.slots?.running ?? 0} / ${machine.slots?.max ?? 0}` : t('offline')),
  h('span', { class: `status-dot ${machine.online ? 'green' : 'gray'}` }))) : [h('p', { class: 'muted-copy' }, t('noMachines'))])));
}

// ---- the conversation -----------------------------------------------------------------------------

function threadReference(threadId) {
  const thread = threadById(threadId);
  return thread ? h('a', { class: 'thread-reference', href: `/app/threads/${thread.id}`, dataset: { nav: thread.id } }, icon('layers'), thread.title) : null;
}

function userMessage(message) {
  const failed = message.pending === 'failed';
  const thread = state.selected ? null : threadById(message.threadId);
  return h('article', { class: `user-message${message.pending === 'sending' ? ' is-pending' : ''}${failed ? ' is-failed' : ''}`, id: message.id },
    h('div', { class: 'user-body' }, message.text),
    h('div', { class: 'user-meta' },
      `${t('you')} · ${formatClock(message.at)}${thread ? ` · ${thread.title}` : ''}`,
      message.channel === 'feishu' ? h('span', { class: 'channel-tag' }, t('viaFeishu')) : null,
      message.pending === 'sending' ? ` · ${t('sending')}` : null,
      failed ? [' · ', h('span', { class: 'failed' }, t('notSent')), h('button', { type: 'button', dataset: { retry: message.id.slice('user:web:'.length), focus: `retry:${message.id}` } }, t('retry'))] : null));
}

function assistantMessage(message) {
  return h('article', { class: 'message', id: message.id },
    h('div', { class: 'message-header' }, h('img', { class: 'pip-avatar', src: '/app/assets/pip-mark.svg', width: 26, height: 26, alt: '' }), 'Pip', h('span', { class: 'message-time' }, formatClock(message.at))),
    h('div', { class: 'message-body' },
      state.selected ? null : threadReference(message.threadId),
      message.card ? cardNode(message.card, message.id, message.open === true) : markup(message.text ?? '')));
}

/** The reply being written, shown as it arrives; the finished message replaces it. */
function liveMessage(live) {
  return h('article', { class: 'message live', id: 'live-reply' },
    h('div', { class: 'message-header' }, h('img', { class: 'pip-avatar', src: '/app/assets/pip-mark.svg', width: 26, height: 26, alt: '' }), 'Pip'),
    h('div', { class: 'message-body' }, markup(trimOpenMarkup(live.text)), h('span', { class: 'working-dots' }, h('i'), h('i'), h('i'))));
}

function workingNode() {
  const queued = [...state.pending.values()].filter((entry) => entry.status === 'sending').length;
  return h('div', { class: 'working', role: 'status' }, h('span', { class: 'working-dots' }, h('i'), h('i'), h('i')), queued > 1 ? t('workingQueued', { count: queued - 1 }) : t('working'));
}

function renderFeed(stick) {
  const snapshot = state.snapshot;
  const feed = $('#feed');
  const thread = state.selected ? threadById(state.selected) : null;
  const titles = snapshot.threads.map((entry) => [entry.id, entry.title, entry.state]);
  const live = state.live && (!state.selected || state.live.threadId === state.selected) ? state.live : null;
  redraw('feed', [getLocale(), state.selected, snapshot.messages, snapshot.busy, [...state.pending.values()], [...state.busyCards], titles, dayKey(serverNow()), live?.text], () => {
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    const oldTop = feed.scrollTop;

    $('#conversation-title').textContent = thread ? thread.title : 'Pip';
    $('#conversation-subtitle').textContent = thread
      ? [thread.repos.join(', '), [...new Set(thread.workers.map((worker) => worker.agent))].join(', '), thread.machine].filter(Boolean).join(' · ')
      : t('allThreads');
    document.querySelector('.heading-line .state-badge')?.remove();
    if (thread) $('.heading-line').append(stateBadge(thread.state));
    const banner = $('#scope-banner');
    banner.hidden = !thread;
    banner.replaceChildren(...(thread ? [h('span', null, t('scopeNotice')), h('button', { type: 'button', dataset: { action: 'all' } }, `${t('backToAll')} ↗`)] : []));

    const messages = messagesFor(withPending(snapshot.messages, state.pending), state.selected);
    const body = [];
    if (messages.length === 0) {
      body.push(h('div', { class: 'empty-state' }, icon('chat'), h('strong', null, t(thread ? 'emptyThreadMessages' : 'emptyMessages')), h('p', null, t(thread ? 'emptyThreadHelp' : 'emptyMessagesHelp'))));
    }
    for (const group of groupByDay(messages, dayKey)) {
      body.push(h('div', { class: 'date-divider' }, dayLabel(group.at)));
      for (const message of group.messages) body.push(message.role === 'user' ? userMessage(message) : assistantMessage(message));
    }
    if (live) body.push(liveMessage(live));
    else if (working()) body.push(workingNode());

    preservingFocus(feed, () => feed.replaceChildren(h('div', { class: 'feed-inner' }, body)));
    feed.scrollTop = stick || nearBottom ? feed.scrollHeight : oldTop;
  });
}

// ---- the composer ---------------------------------------------------------------------------------------

function resizeInput() {
  const input = $('#message-input');
  input.rows = matchMedia('(max-width: 650px)').matches ? 1 : 2;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}

function renderComposer() {
  const thread = state.selected ? threadById(state.selected) : null;
  const target = state.replyTo ? state.snapshot.attention.find((item) => item.id === state.replyTo) : null;
  if (state.replyTo && !target) state.replyTo = null; // the card was handled in the meantime
  $('#scope-label').textContent = thread ? t('scopedRoute', { title: thread.title }) : t('autoRoute');
  $('#scope-chip').title = thread ? thread.title : t('routeHelp');
  $('#scope-chip').classList.toggle('scoped', Boolean(thread));
  $('#message-input').placeholder = state.replyTo ? t('replyPlaceholder') : t(thread ? 'scopedPlaceholder' : 'inputPlaceholder');
  $('#composer-status').textContent = working() ? t('queueHelp') : t(thread ? 'scopeHelp' : 'routeHelp');
  const chip = $('#reply-chip');
  chip.hidden = !state.replyTo;
  chip.replaceChildren(...(target
    ? [icon('help'), h('span', null, t('replyingTo', { title: cardHeading(target) })), h('button', { type: 'button', dataset: { action: 'clear-reply' }, 'aria-label': t('clearReply'), title: t('clearReply') }, icon('close'))]
    : []));
}

// ---- the context panel ----------------------------------------------------------------------------------

function activityItem(entry) {
  const label = tOr(`kind_${entry.kind}`, entry.kind);
  const body = h('div', { class: 'activity-item' }, h('time', null, ago(entry.at)), h('p', null, h('span', { class: 'timeline-kind' }, label), entry.text));
  const thread = entry.threadId ? threadById(entry.threadId) : null;
  return thread ? h('a', { class: 'activity-link', href: `/app/threads/${thread.id}`, dataset: { nav: thread.id } }, body) : body;
}

function attentionNode(item) {
  const inFeed = state.snapshot.messages.some((message) => message.id === item.id);
  return h('div', null,
    cardNode(item, item.id, true),
    inFeed ? h('button', { type: 'button', class: 'context-link', dataset: { jump: item.id } }, t('showInChat')) : null);
}

function workerNode(thread, worker) {
  const active = isActiveWorker(worker);
  const progress = worker.progress ? [worker.progress.phase, worker.progress.tool, worker.progress.target].filter(Boolean).join(' ') : '';
  const facts = [];
  if (worker.git) {
    const parts = [];
    if (worker.git.ahead > 0) parts.push(t('gitAhead', { count: worker.git.ahead }));
    parts.push(t(worker.git.pushed ? 'gitPushed' : 'gitLocal'));
    if (worker.git.dirty > 0) parts.push(t('gitDirty', { count: worker.git.dirty }));
    facts.push(parts.join(' · '));
  }
  if (worker.contextPercent !== null && worker.contextPercent !== undefined) facts.push(t('context', { percent: worker.contextPercent }));
  const outcome = worker.outcome ? tOr(`outcome_${worker.outcome}`, worker.outcome) : '';
  const pr = worker.pr;
  return h('div', { class: 'worker-card' },
    h('div', { class: 'worker-title' },
      h('span', null, h('span', { class: 'agent-icon' }, worker.agent === 'pi' ? 'π' : worker.agent === 'claude' ? '✳' : worker.agent.slice(0, 1).toUpperCase()), worker.agent),
      h('span', { class: 'worker-state' }, h('span', { class: `status-dot ${active ? 'green' : 'gray'}` }), tOr(`worker${cap(worker.state)}`, worker.state))),
    h('div', { class: 'worker-meta' }, [worker.machine, worker.unreachable ? t('unreachable') : null].filter(Boolean).join(' · ')),
    worker.branch ? h('code', null, worker.branch) : null,
    progress ? h('div', { class: 'worker-facts' }, t('progress', { what: progress })) : null,
    outcome ? h('div', { class: 'worker-facts' }, outcome) : null,
    facts.length ? h('div', { class: 'worker-facts' }, facts.join(' · ')) : null,
    pr?.url ? h('p', { class: 'worker-pr' }, `${t('prCreated')}: `, h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer' }, pr.url))
      : pr?.failure ? h('p', { class: 'worker-pr failed' }, `${t('prFailed')}: ${pr.failure}`)
        : pr?.decision === 'approved' ? h('p', { class: 'worker-pr' }, t('prPending'))
          : pr?.decision === 'declined' ? h('p', { class: 'worker-pr' }, t('prDeclined')) : null,
    worker.sessionId !== null || active
      ? h('div', { class: 'worker-actions' }, h('a', { href: `/app/threads/${thread.id}/workers/${worker.id}`, target: '_blank', rel: 'noopener' }, t('rawHistory'), icon('external'))) : null);
}

function renderContext() {
  const snapshot = state.snapshot;
  const panel = $('#context-panel');
  const thread = state.selected ? threadById(state.selected) : null;
  const signature = [getLocale(), state.selected, thread ?? snapshot.threads.map((entry) => [entry.id, entry.title, entry.state, entry.machine, entry.workers.map((worker) => [worker.agent, worker.state])]),
    snapshot.attention, snapshot.activity, snapshot.messages.map((message) => message.id), [...state.busyCards], minuteBucket()];
  redraw('context', signature, () => {
    const top = panel.scrollTop;
    const close = h('button', { type: 'button', class: 'icon-button close-context', dataset: { action: 'close-details' }, 'aria-label': t('closeDetails') }, icon('close'));
    const sections = [];
    if (!thread) {
      const running = snapshot.threads.filter((entry) => entry.state === 'running');
      sections.push(
        h('header', { class: 'context-header' }, h('h2', null, t('workspace')), h('span', { class: 'overline' }, dayLabel(serverNow())), close),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('needsYou'), h('strong', { class: snapshot.attention.length ? '' : 'clear-count' }, String(snapshot.attention.length))),
          snapshot.attention.length ? snapshot.attention.map(attentionNode)
            : h('div', { class: 'empty-state compact' }, icon('check'), h('strong', null, t('allClear')), h('p', null, t('allClearHelp')))),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('running'), h('span', null, String(running.length))),
          running.length ? running.map((entry) => h('a', { class: 'running-item', href: `/app/threads/${entry.id}`, dataset: { nav: entry.id } },
            h('span', null, h('strong', null, entry.title), h('small', null, [...new Set(entry.workers.filter(isActiveWorker).map((worker) => worker.agent))].join(', '), entry.machine ? ` · ${entry.machine}` : '')),
            h('span', { class: 'status-dot green' }))) : h('p', { class: 'muted-copy' }, t('noRunning'))),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('recentActivity')),
          snapshot.activity.length ? snapshot.activity.slice(-5).reverse().map(activityItem) : h('p', { class: 'muted-copy' }, t('noActivity'))));
    } else {
      const waiting = attentionFor(snapshot, thread.id);
      const workers = [...thread.workers].reverse();
      sections.push(
        h('header', { class: 'context-header' }, h('h2', null, t('threadDetails')), close),
        h('section', { class: 'context-section' },
          h('h2', { class: 'thread-detail-title' }, thread.title), stateBadge(thread.state),
          thread.summary ? h('p', { class: 'detail-summary' }, thread.summary) : null,
          thread.goal && thread.goal !== thread.summary ? h('p', { class: 'detail-goal' }, `${t('goal')}: ${thread.goal}`) : null,
          thread.repos.length ? h('div', { class: 'repo-label' }, icon('folder'), thread.repos.join(', ')) : null),
        waiting.length ? h('section', { class: 'context-section' }, h('h3', { class: 'section-title' }, t('needsYou'), h('strong', null, String(waiting.length))), waiting.map(attentionNode)) : null,
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t(workers.length ? 'agent' : 'execution'), h('span', null, workers.length ? '' : t('noWorkers'))),
          workers.map((worker) => workerNode(thread, worker))),
        h('section', { class: 'context-section' },
          h('h3', { class: 'section-title' }, t('timeline')),
          thread.timeline.length ? [...thread.timeline].reverse().map((entry) => activityItem({ ...entry, threadId: null })) : h('p', { class: 'muted-copy' }, t('noTimeline'))));
    }
    preservingFocus(panel, () => panel.replaceChildren(...sections.filter(Boolean)));
    panel.scrollTop = top;
  });
}

// ---- dialogs -------------------------------------------------------------------------------------------

function machineCard(machine) {
  const work = workOn(state.snapshot, machine);
  const status = machine.revoked ? t('revoked') : machine.online ? t('online') : t('offline');
  const detail = machine.revoked ? '' : machine.online ? t('slots', { used: machine.slots?.running ?? 0, total: machine.slots?.max ?? 0 })
    : machine.lastSeen ? t('lastSeen', { time: ago(machine.lastSeen) }) : t('neverConnected');
  return h('section', { class: `machine-card${machine.revoked ? ' revoked' : ''}` },
    h('h3', null, icon('laptop'), h('span', null, machine.name), h('span', { class: 'machine-availability' }, h('span', { class: `status-dot ${machine.online ? 'green' : 'gray'}` }), status)),
    detail ? h('p', null, detail) : null,
    h('dl', null,
      h('div', null, h('dt', null, t('agents')), h('dd', null, machine.agents.join(', ') || t('noneListed'))),
      h('div', null, h('dt', null, t('repositories')), h('dd', null, machine.repos.join(', ') || t('noneListed'))),
      work.length ? h('div', null, h('dt', null, t('running')), h('dd', null, work.map((entry) => entry.title).join(' · '))) : null));
}

function dialogContent() {
  const snapshot = state.snapshot;
  if (state.dialog.type === 'machines') {
    const summary = summarize(snapshot);
    return {
      title: t('machines'),
      body: [
        h('p', { class: 'dialog-copy' }, t('machineSummary', { online: summary.machinesOnline, total: summary.machinesTotal, running: summary.running })),
        snapshot.machines.map(machineCard),
        h('p', { class: 'dialog-copy machine-help' }, t('connectMachine')),
        h('div', { class: 'dialog-actions' }, h('a', { class: 'button', href: '/app/machines' }, t('manageMachines'), icon('external'))),
      ],
    };
  }
  if (state.dialog.type === 'scope') {
    return {
      title: t('scopeNotice'),
      body: [
        h('button', { type: 'button', class: `scope-option${state.selected ? '' : ' selected'}`, dataset: { select: 'all' } }, icon('route'), h('span', null, t('autoRoute'), h('small', null, t('routeHelp'))), state.selected ? null : icon('check')),
        snapshot.threads.map((entry) => h('button', { type: 'button', class: `scope-option${state.selected === entry.id ? ' selected' : ''}`, dataset: { select: entry.id } },
          icon('layers'), h('span', null, entry.title, h('small', null, `${entry.repos.join(', ')}${entry.repos.length ? ' · ' : ''}${stateLabel(entry.state)}`)), state.selected === entry.id ? icon('check') : null)),
      ],
    };
  }
  return {
    title: t('accountTitle'),
    body: [
      h('p', { class: 'dialog-copy' }, t('accountBody')),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'button danger', dataset: { action: 'sign-out' } }, t('signOut')),
        h('a', { class: 'button', href: '/app/machines' }, t('manageMachines'), icon('external'))),
    ],
  };
}

function renderDialog() {
  if (!state.dialog) return;
  const { title, body } = dialogContent();
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(...[body].flat(Infinity).filter(Boolean));
  if (!$('#dialog').open) $('#dialog').showModal();
}

function openDialog(type) {
  state.dialog = { type };
  renderDialog();
}

function closeDialog() {
  state.dialog = null;
  if ($('#dialog').open) $('#dialog').close();
}

// ---- full-screen states ------------------------------------------------------------------------------

function renderFatal() {
  const current = $('#fatal');
  if (!state.fatal) {
    current?.remove();
    return;
  }
  const [title, body] = FATAL_COPY[state.fatal];
  const next = h('div', { class: 'fatal', id: 'fatal', role: 'alertdialog', 'aria-labelledby': 'fatal-title' },
    h('div', { class: 'fatal-box' }, h('img', { src: '/app/assets/pip-mark.svg', alt: '' }), h('h2', { id: 'fatal-title' }, t(title)), h('p', null, t(body))));
  if (current) current.replaceWith(next);
  else document.body.append(next);
}

// ---- rendering --------------------------------------------------------------------------------------------

function renderAll({ stick = false } = {}) {
  applyStatic();
  paintIcons();
  renderConnection();
  renderFatal();
  if (!state.snapshot) return;
  $('#workspace').dataset.ready = 'true';
  renderTop();
  renderSidebar();
  renderFeed(stick);
  renderContext();
  renderComposer();
  renderDialog();
  syncDetailButton();
}

// ---- data ------------------------------------------------------------------------------------------------

async function request(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': state.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A proxy error page is not JSON; the status is what matters.
  }
  if (response.status === 401 && state.fatal !== 'logged_out') {
    state.fatal = 'signed_out';
    renderFatal();
  }
  return { status: response.status, data };
}

let refreshing = false;
let refreshAgain = false;
let retryDelay = 2000;

async function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const { status, data } = await request('/app/api/workspace');
      if (status === 401) return;
      if (status !== 200 || !data) throw new Error(`workspace ${status}`);
      if (state.fatal === 'unreachable') state.fatal = null;
      retryDelay = 2000;
      accept(data);
    } while (refreshAgain);
  } catch {
    // Unreachable: say so (once there is nothing else to show) and keep trying, gently.
    if (!state.snapshot && !state.fatal) state.fatal = 'unreachable';
    if (state.connection === 'live') state.connection = 'reconnecting';
    renderAll();
    setTimeout(refresh, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 20_000);
  } finally {
    refreshing = false;
  }
}

function accept(data) {
  const first = state.snapshot === null;
  state.csrf = data.csrf;
  state.snapshot = data;
  state.skew = data.now - Date.now();
  for (const message of data.messages) {
    if (message.id.startsWith('user:web:')) state.pending.delete(message.id.slice('user:web:'.length));
  }
  if (state.selected && !threadById(state.selected)) {
    state.selected = null; // archived or gone: fall back to the whole conversation
    history.replaceState(null, '', '/app');
  }
  const ids = new Set(data.attention.map((item) => item.id));
  if (!first && [...ids].some((id) => !state.knownAttention.has(id))) $('#announcer').textContent = t('newDecision');
  state.knownAttention = ids;
  // The words being written give way to the finished message the moment the snapshot has it.
  if (state.live && (state.live.ending || !data.busy)) state.live = null;
  renderAll({ stick: first });
  markSelectedRead();
  if (!socket) connect();
}

let reading = false;
function markSelectedRead() {
  const thread = state.selected ? threadById(state.selected) : null;
  if (!thread?.unread || reading) return;
  reading = true;
  request(`/app/api/threads/${thread.id}/read`, {}).then(() => refresh()).catch(() => {}).finally(() => { reading = false; });
}

// ---- live updates ----------------------------------------------------------------------------------------

let socket = null;
let attempts = 0;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = new WebSocket(`${scheme}//${location.host}/agents/steward/owner?role=web&view=workspace`);
  socket = current;
  current.addEventListener('open', () => {
    attempts = 0;
    state.connection = 'live';
    renderConnection();
    refresh(); // anything that changed while the socket was down
  });
  current.addEventListener('message', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return; // not a frame of ours
    }
    if (frame.t === 'workspace_changed') void refresh();
    else if (frame.t === 'stream') showLive(frame);
  });
  current.addEventListener('close', () => {
    if (socket !== current || state.fatal === 'signed_out' || state.fatal === 'logged_out') return;
    state.connection = attempts === 0 ? 'reconnecting' : 'disconnected';
    renderConnection();
    reconnectTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempts) + Math.random() * 400);
    attempts += 1;
  });
  current.addEventListener('error', () => current.close());
}

let liveTimer;

/** A `stream` frame: the reply so far. An empty one means the run ended; the snapshot that carries the final message removes the words. */
function showLive(frame) {
  clearTimeout(liveTimer);
  if (frame.text) state.live = { text: frame.text, threadId: frame.threadId ?? null, ending: false };
  else if (state.live) {
    state.live.ending = true;
    liveTimer = setTimeout(() => { state.live = null; if (state.snapshot) renderFeed(false); }, 4000);
  }
  if (state.snapshot) renderFeed(false);
}

// ---- actions -----------------------------------------------------------------------------------------------

async function postMessage(entry) {
  entry.status = 'sending';
  renderFeed(true);
  renderComposer();
  try {
    const { status, data } = await request('/app/api/messages', { id: entry.id, text: entry.text, threadId: entry.threadId ?? undefined, replyTo: entry.replyTo ?? undefined });
    if (status === 202) {
      await refresh();
      return;
    }
    if (status === 429) toast(t('queueFull'));
    else if (status === 400 || status === 413) toast(t('tooLong'));
    else if (status !== 401) toast(t('sendFailed'));
    if (data?.error === 'id_conflict') state.pending.delete(entry.id);
  } catch {
    toast(t('sendFailed'));
  }
  entry.status = 'failed';
  renderFeed(true);
  renderComposer();
}

function send() {
  const input = $('#message-input');
  const text = input.value;
  if (!text.trim()) return;
  const entry = { id: uuid(), text, threadId: state.selected, replyTo: state.replyTo, at: Date.now(), status: 'sending' };
  state.pending.set(entry.id, entry);
  input.value = '';
  state.drafts.delete(scopeKey());
  state.replyTo = null;
  $('#send-button').disabled = true;
  resizeInput();
  void postMessage(entry);
}

async function act(cardId, action) {
  if (state.busyCards.has(cardId)) return;
  state.busyCards.add(cardId);
  renderFeed(false);
  renderContext();
  try {
    const { status } = await request('/app/api/actions', { id: uuid(), cardId, action });
    if (status === 409) toast(t('cardAlreadyHandled'));
    else if (status !== 202 && status !== 401) toast(t('actionFailed'));
    await refresh();
  } catch {
    toast(t('actionFailed'));
  } finally {
    state.busyCards.delete(cardId);
    renderFeed(false);
    renderContext();
  }
}

async function signOut() {
  state.fatal = 'logged_out'; // set first: the logout response must not read as an expired session
  try {
    await request('/app/api/logout', {});
  } catch {
    // The cookie is what matters; if the request failed the session simply expires on its own.
  }
  socket?.close();
  closeDialog();
  renderFatal();
}

// ---- navigation ------------------------------------------------------------------------------------------

const scopeKey = () => state.selected ?? 'all';

const selectedFromLocation = () => /^\/app\/threads\/([\w-]+)\/?$/.exec(location.pathname)?.[1] ?? null;

function select(threadId, { push = true } = {}) {
  const next = threadId && threadById(threadId) ? threadId : null;
  const input = $('#message-input');
  state.drafts.set(scopeKey(), input.value);
  const changed = next !== state.selected;
  state.selected = next;
  input.value = state.drafts.get(scopeKey()) ?? '';
  $('#send-button').disabled = !input.value.trim();
  if (push && changed) history.pushState(null, '', next ? `/app/threads/${next}` : '/app');
  setMobile('chat');
  $('#workspace').classList.remove('context-overlay');
  resizeInput();
  renderAll({ stick: true });
  markSelectedRead();
}

function setMobile(view) {
  $('#workspace').dataset.mobile = view;
  for (const button of document.querySelectorAll('[data-mobile-view]')) {
    const active = button.dataset.mobileView === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function detailsOpen() {
  const workspace = $('#workspace');
  return matchMedia('(max-width: 990px)').matches ? workspace.classList.contains('context-overlay') : !workspace.classList.contains('context-hidden');
}

function syncDetailButton() {
  $('.detail-toggle').setAttribute('aria-expanded', String(detailsOpen()));
}

function openDetails() {
  $('#workspace').classList.remove('context-hidden');
  $('#workspace').classList.add('context-overlay');
  syncDetailButton();
}

function closeDetails() {
  $('#workspace').classList.remove('context-overlay');
  $('#workspace').classList.add('context-hidden');
  syncDetailButton();
}

function changeLanguage(locale) {
  if (!setLocale(locale)) return;
  renderAll();
  resizeInput();
}

function jumpTo(messageId) {
  const message = state.snapshot.messages.find((entry) => entry.id === messageId);
  if (!message) return;
  if (state.selected && message.threadId !== state.selected) select(message.threadId);
  setMobile('chat');
  $('#workspace').classList.remove('context-overlay');
  const target = document.getElementById(messageId);
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

// ---- events -----------------------------------------------------------------------------------------------

$('#composer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});
$('#message-input').addEventListener('input', () => {
  $('#send-button').disabled = !$('#message-input').value.trim();
  resizeInput();
});
$('#message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('#composer-form').requestSubmit();
  }
});
$('#thread-search').addEventListener('input', (event) => {
  state.filter = event.target.value;
  if (state.snapshot) renderSidebar();
});
window.addEventListener('popstate', () => select(selectedFromLocation(), { push: false }));
window.addEventListener('resize', () => {
  syncDetailButton();
  resizeInput();
});
window.addEventListener('storage', (event) => {
  if (event.key === 'pip.locale') changeLanguage(event.newValue === 'zh' ? 'zh' : 'en');
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  void refresh();
  if (socket && socket.readyState > 1 && !state.fatal) connect();
});
$('#dialog').addEventListener('close', () => { state.dialog = null; });
$('#dialog').addEventListener('click', (event) => {
  if (event.target !== $('#dialog')) return;
  const rect = $('#dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#dialog').open) {
    event.preventDefault();
    setMobile('threads');
    $('#thread-search').focus();
  }
  if (event.key === 'Escape' && !$('#dialog').open && $('#workspace').classList.contains('context-overlay')) closeDetails();
});

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-nav]');
  if (link && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    closeDialog();
    select(link.dataset.nav === 'all' ? null : link.dataset.nav);
    return;
  }
  const button = event.target.closest('button');
  if (!button) return;
  const { dataset } = button;
  if (dataset.locale) return changeLanguage(dataset.locale);
  if (dataset.mobileView) return setMobile(dataset.mobileView);
  if (dataset.card && dataset.action) return void act(dataset.card, dataset.action);
  if (dataset.reply) {
    state.replyTo = dataset.reply;
    renderComposer();
    $('#message-input').focus();
    return;
  }
  if (dataset.retry) {
    const entry = state.pending.get(dataset.retry);
    if (entry) void postMessage(entry);
    return;
  }
  if (dataset.select) {
    closeDialog();
    return select(dataset.select === 'all' ? null : dataset.select);
  }
  if (dataset.jump) return jumpTo(dataset.jump);
  switch (dataset.action) {
    case 'all': return select(null);
    case 'new':
      select(null);
      $('#message-input').focus();
      return toast(t('newTaskHint'));
    case 'machines': return openDialog('machines');
    case 'account': return openDialog('account');
    case 'scope': return openDialog('scope');
    case 'close-dialog': return closeDialog();
    case 'details': return detailsOpen() ? closeDetails() : openDetails();
    case 'attention':
      select(null);
      return openDetails();
    case 'close-details': return closeDetails();
    case 'clear-search':
      state.filter = '';
      $('#thread-search').value = '';
      renderSidebar();
      return $('#thread-search').focus();
    case 'clear-reply':
      state.replyTo = null;
      return renderComposer();
    case 'sign-out': return void signOut();
  }
});

// ---- start ----------------------------------------------------------------------------------------------------

applyStatic();
paintIcons();
state.selected = selectedFromLocation();
resizeInput();
renderConnection();
void refresh();
setInterval(() => { if (state.snapshot && document.visibilityState === 'visible') void refresh(); }, 60_000);
setInterval(() => { if (state.snapshot && document.visibilityState === 'visible') { renderSidebar(); renderContext(); renderFeed(false); } }, 30_000);
