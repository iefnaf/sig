// The session viewer: one worker's recorded session, read from its machine on demand and drawn
// as written. The Durable Object only relays (nothing is stored there), so the viewer works
// while the machine's connector is online — whether or not the agent process is still running —
// and says plainly when it is not.
//
// Reading is a sequence of short streams over one WebSocket: each `history_open` asks for the
// next page from a cursor and ends with `done`; a page cut by its byte budget continues at once,
// a finished one waits (while the agent is working) and asks again for whatever was appended.
// Entries arrive as fragments of their JSON text and are reassembled here (session-model.js).
//
// Everything on screen is built with h() from text nodes — a recorded message, command or tool
// output is displayed, never parsed as markup.
import { h, icon } from './dom.js';
import { formatClock } from './format.js';
import { localeTag, t, tOr } from './i18n.js';
import { markup } from './markup.js';
import { branchOf, callSummary, clip, createAssembler, describeRecord, imageSrc, inputRows, placeOf } from './session-model.js';

const PAGE_BYTES = 1024 * 1024; // per read; the page appears as the file loads
const AUTO_LOAD_CHARS = 64 * 1024 * 1024; // past this the reader decides whether to keep loading
const SHOW_LAST = 200; // entries drawn at first; earlier ones on request
const SHOW_EARLIER = 200;
const TEXT_CLIP = 6000; // characters of one message drawn before "show all"
const VALUE_CLIP = 4000; // …of one tool argument or result
const POLL_MS = 3000;
const SILENCE_MS = 65_000; // the relay forgets a stream after 60 s; silence past this means it is dead
/** States a read leaves behind when it fails; the next read starts from "loading". */
const RETRYING = new Set(['connecting', 'disconnected', 'empty', 'error', 'offline', 'outdated']);
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Mounts a viewer for one worker into `root`.
 *   workerId     the worker whose session to read
 *   agentLabel   how to name the agent on its own messages
 *   isActive()   whether the agent is working right now (the host knows; it changes)
 *   isReachable() whether the worker's machine is connected (a viewer that found it offline
 *                tries again by itself when this turns true)
 * Returns { update(), relabel(), destroy() }: `update` after the host learns the worker's state
 * changed, `relabel` after a language change.
 */
export function mountSessionViewer(root, { workerId, agentLabel, isActive, isReachable = () => false }) {
  const view = {
    ws: null,
    wantOpen: true,
    attempts: 0,
    reconnectTimer: 0,
    watchdog: 0,
    pollTimer: 0,
    renderTimer: 0,
    streaming: false,
    cursor: null,
    assembler: createAssembler(),
    items: [],
    callIds: new Set(), // every tool call seen, drawn or not
    results: new Map(), // callId → result block
    callViews: new Map(), // callId → the drawn call, so a late result can join it
    unreadable: new Set(), // entries already reported unreadable (one notice per entry, not per fragment)
    loadedChars: 0,
    initial: true, // until the first read reaches the end of what is recorded
    status: 'connecting',
    detail: '',
    resets: 0,
    firstShown: 0,
    drawnEnd: 0,
    branch: { onBranch: new Set(), forked: false },
    destroyed: false,
  };

  // ---- the page ---------------------------------------------------------------------------------------

  const statusLine = h('div', { class: 'sv-status', role: 'status' });
  const retryButton = h('button', { type: 'button', class: 'button sv-retry', hidden: true }, t('svRetry'));
  const earlier = h('button', { type: 'button', class: 'button sv-earlier', hidden: true });
  const list = h('ol', { class: 'sv-items' });
  const more = h('button', { type: 'button', class: 'button sv-more', hidden: true }, t('svLoadMore'));
  const jump = h('button', { type: 'button', class: 'sv-jump', hidden: true }, t('svJumpLatest'), icon('chevron-down'));
  const feed = h('div', { class: 'sv-feed', tabindex: '0', 'aria-label': t('svFeedLabel') }, h('div', { class: 'sv-inner' }, earlier, list, more));

  // ---- direct worker chat (issue #84, ADR-0011, §6.8): this view already knows which worker it
  // is showing, so a send/interrupt here goes straight to the connector — no steward step.
  const composeInput = h('input', { type: 'text', class: 'sv-compose-input', placeholder: t('svComposePlaceholder'), autocomplete: 'off' });
  const sendButton = h('button', { type: 'submit', class: 'button primary sv-compose-send' }, t('svSendButton'));
  const interruptButton = h('button', { type: 'button', class: 'button danger sv-compose-interrupt' }, t('svInterruptButton'));
  const composeStatus = h('span', { class: 'sv-compose-status', role: 'status' });
  const composeForm = h('form', { class: 'sv-compose' }, composeInput, sendButton, interruptButton);
  root.replaceChildren(h('div', { class: 'sv-statusbar' }, statusLine, retryButton), feed, jump, composeForm, composeStatus);

  const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const toBottom = () => { feed.scrollTop = feed.scrollHeight; };

  // ---- drawing -------------------------------------------------------------------------------------------

  /** A block of long text: the first part now, the rest on request. */
  function longText(text, render, max) {
    const { shown, hidden } = clip(text, max);
    const box = h('div', { class: 'sv-text' }, render(shown));
    if (hidden === 0) return box;
    const button = h('button', { type: 'button', class: 'sv-expand' }, t('svShowAll', { count: hidden.toLocaleString(localeTag()) }));
    button.addEventListener('click', () => {
      box.replaceChildren(render(text));
      button.remove();
    });
    return h('div', { class: 'sv-text-wrap' }, box, button);
  }

  const placeLabel = (place) => (place === 'other' ? t('svOtherBranch') : t('svSidechain'));
  const plain = (text) => h('div', { class: 'sv-plain' }, text);
  const pre = (text) => h('pre', { class: 'sv-pre' }, text);

  /** A <details> whose body is built the first time it opens (a long session has many closed ones). */
  function fold(summary, build, className = '') {
    const details = h('details', { class: `sv-fold ${className}`.trim() }, h('summary', null, summary));
    const control = {
      details,
      built: false,
      fill() {
        if (control.built) return;
        control.built = true;
        details.append(build());
      },
      rebuild() {
        if (!control.built) return;
        details.lastElementChild?.remove();
        control.built = false;
        if (details.open) control.fill();
      },
    };
    details.addEventListener('toggle', () => { if (details.open) control.fill(); });
    return control;
  }

  const labelled = (label, body) => h('div', { class: 'sv-section' }, h('div', { class: 'sv-label' }, label), body);

  function imageNode(image) {
    const src = imageSrc(image);
    if (!src) return h('div', { class: 'sv-meta' }, t('svImageHidden', { type: image.mime || '?' }));
    const picture = h('img', { class: 'sv-image', src, alt: t('svImage'), loading: 'lazy' });
    picture.addEventListener('click', () => picture.classList.toggle('sv-image-full'));
    return picture;
  }

  function resultBody(result) {
    return h('div', { class: `sv-result${result.error ? ' is-error' : ''}` },
      result.text === '' && result.images.length === 0 ? h('p', { class: 'sv-empty' }, t('svNoOutput')) : null,
      result.text === '' ? null : longText(result.text, pre, VALUE_CLIP),
      result.images.map(imageNode));
  }

  function toolStatus(result) {
    if (!result) return h('span', { class: 'sv-tool-status is-wait', title: t('svToolRunning') }, icon('clock'));
    return h('span', { class: `sv-tool-status ${result.error ? 'is-error' : 'is-ok'}`, title: t(result.error ? 'svToolFailed' : 'svToolDone') }, icon(result.error ? 'alert' : 'check'));
  }

  function toolCallNode(block) {
    const head = (result) => [
      h('span', { class: 'sv-tool-name' }, block.name || t('svTool')),
      h('span', { class: 'sv-tool-summary' }, callSummary(block.input)),
      toolStatus(result),
    ];
    const body = () => {
      const rows = inputRows(block.input);
      const result = view.results.get(block.callId) ?? null;
      return h('div', { class: 'sv-fold-body' },
        rows.length ? labelled(t('svInput'), rows.map(([key, value]) => h('div', { class: 'sv-kv' }, key ? h('span', { class: 'sv-key' }, key) : null, longText(value, pre, VALUE_CLIP)))) : null,
        result ? labelled(t('svResult'), resultBody(result)) : h('p', { class: 'sv-empty' }, t('svToolRunning')));
    };
    const control = fold(head(view.results.get(block.callId) ?? null), body, 'sv-tool');
    if (block.callId) {
      view.callViews.set(block.callId, {
        setResult(result) {
          control.details.querySelector('summary').replaceChildren(...head(result));
          control.rebuild();
        },
      });
    }
    return control.details;
  }

  const standaloneResult = (block) => fold([h('span', { class: 'sv-tool-name' }, block.name || t('svTool')), h('span', { class: 'sv-tool-summary' }, t('svResult')), toolStatus(block)], () => h('div', { class: 'sv-fold-body' }, resultBody(block)), 'sv-tool').details;

  function bashNode(block) {
    const status = block.cancelled ? t('svCancelled') : block.exitCode === null ? '' : `exit ${block.exitCode}`;
    const control = fold([h('span', { class: 'sv-tool-name' }, '$'), h('span', { class: 'sv-tool-summary' }, callSummary({ command: block.command })), h('span', { class: `sv-exit${block.exitCode ? ' is-error' : ''}` }, status)],
      () => h('div', { class: 'sv-fold-body' }, labelled(t('svCommand'), longText(block.command, pre, VALUE_CLIP)), labelled(t('svResult'), longText(block.output, pre, VALUE_CLIP)), block.truncated ? h('p', { class: 'sv-empty' }, t('svOutputTruncated')) : null), 'sv-tool');
    return control.details;
  }

  function metaNode(block) {
    const label = tOr(`svMeta_${block.kind}`, block.kind);
    const line = [h('span', { class: 'sv-meta-kind' }, label), block.title ? h('span', { class: 'sv-meta-title' }, block.title) : null];
    if (!block.detail) return h('div', { class: `sv-meta is-${block.kind}` }, line);
    return fold(line, () => h('div', { class: 'sv-fold-body' }, longText(block.detail, pre, VALUE_CLIP)), `sv-meta is-${block.kind}`).details;
  }

  const rawNode = (block) => fold([h('span', { class: 'sv-meta-kind' }, t('svRaw')), h('span', { class: 'sv-meta-title' }, block.title)], () => h('div', { class: 'sv-fold-body' }, longText(block.json, pre, VALUE_CLIP)), 'sv-meta').details;

  function blockNode(block) {
    switch (block.t) {
      case 'text':
        return block.role === 'user' ? longText(block.text, plain, TEXT_CLIP) : longText(block.text, markup, TEXT_CLIP);
      case 'thinking':
        return fold([h('span', { class: 'sv-meta-kind' }, t('svThinking'))], () => h('div', { class: 'sv-fold-body' }, block.redacted ? h('p', { class: 'sv-empty' }, t('svRedacted')) : longText(block.text, plain, TEXT_CLIP)), 'sv-meta').details;
      case 'tool_call':
        return toolCallNode(block);
      case 'tool_result':
        return view.callIds.has(block.callId) ? null : standaloneResult(block);
      case 'image':
        return imageNode(block.image);
      case 'bash':
        return bashNode(block);
      case 'meta':
        return metaNode(block);
      default:
        return rawNode(block);
    }
  }

  function itemNode(item, index) {
    const nodes = item.blocks.map(blockNode).filter(Boolean);
    if (nodes.length === 0) return null;
    const first = item.blocks[0];
    const speaker = item.blocks.some((block) => block.t === 'text' && block.role === 'user') ? 'user'
      : item.blocks.some((block) => block.t === 'text' || block.t === 'thinking' || block.t === 'tool_call') ? 'agent'
        : item.blocks.every((block) => block.t === 'meta' || block.t === 'raw') ? 'meta' : 'tool';
    const place = placeOf(item, view.branch);
    const head = speaker === 'meta' ? null : h('div', { class: 'sv-head' },
      h('span', { class: 'sv-who' }, speaker === 'user' ? t('you') : speaker === 'agent' ? agentLabel : t('svTool')),
      item.at === null ? null : h('time', null, formatClock(item.at)),
      item.model && speaker === 'agent' ? h('span', { class: 'sv-model' }, item.model) : null);
    return h('li', { class: `sv-item is-${speaker}${first?.t === 'raw' ? ' is-raw' : ''}`, dataset: { place, i: index } },
      head,
      place === 'main' ? null : h('span', { class: 'sv-place' }, placeLabel(place)),
      h('div', { class: 'sv-blocks' }, nodes));
  }

  /** Nodes for items [from, to); an item with nothing to show (a tool result drawn under its call) has none. */
  function drawRange(from, to) {
    return view.items.slice(from, to).map((item, offset) => itemNode(item, from + offset)).filter(Boolean);
  }

  /** The branch can move as entries arrive; re-mark what is drawn. */
  function classify() {
    view.branch = branchOf(view.items);
    for (const node of list.children) {
      const item = view.items[Number(node.dataset.i)];
      if (!item) continue;
      const place = placeOf(item, view.branch);
      node.dataset.place = place;
      const label = node.querySelector(':scope > .sv-place');
      if (place === 'main') label?.remove();
      else if (!label) node.querySelector(':scope > .sv-blocks')?.before(h('span', { class: 'sv-place' }, placeLabel(place)));
    }
  }

  /** Draws what has arrived and is not on the page yet. The first draw shows the latest entries. */
  function render() {
    view.renderTimer = 0;
    if (view.destroyed) return;
    renderStatus();
    if (view.initial) return;
    const follow = view.drawnEnd === 0 || nearBottom();
    if (view.drawnEnd === 0) view.firstShown = Math.max(0, view.items.length - SHOW_LAST);
    if (view.drawnEnd < view.items.length) {
      view.branch = branchOf(view.items);
      for (const node of drawRange(Math.max(view.drawnEnd, view.firstShown), view.items.length)) list.append(node);
      view.drawnEnd = view.items.length;
      classify();
      if (follow) toBottom();
      else jump.hidden = false;
    }
    earlier.hidden = view.firstShown === 0;
    earlier.textContent = t('svEarlier', { count: view.firstShown.toLocaleString(localeTag()) });
  }

  function scheduleRender() {
    if (!view.renderTimer) view.renderTimer = requestAnimationFrame(render);
  }

  function redrawAll() {
    list.replaceChildren();
    view.callViews.clear();
    view.drawnEnd = 0;
    if (!view.initial) {
      view.branch = branchOf(view.items);
      for (const node of drawRange(view.firstShown, view.items.length)) list.append(node);
      view.drawnEnd = view.items.length;
      classify();
    }
    renderStatus();
    earlier.hidden = view.firstShown === 0;
    earlier.textContent = t('svEarlier', { count: view.firstShown.toLocaleString(localeTag()) });
  }

  function showEarlier() {
    const from = Math.max(0, view.firstShown - SHOW_EARLIER);
    const before = feed.scrollHeight;
    const top = feed.scrollTop;
    const nodes = drawRange(from, view.firstShown);
    for (const node of nodes.reverse()) list.prepend(node);
    view.firstShown = from;
    classify();
    earlier.hidden = from === 0;
    earlier.textContent = t('svEarlier', { count: from.toLocaleString(localeTag()) });
    feed.scrollTop = top + (feed.scrollHeight - before);
  }

  // ---- status -----------------------------------------------------------------------------------------------

  function renderStatus() {
    const count = view.items.length.toLocaleString(localeTag());
    const size = (view.loadedChars / 1048576).toFixed(1);
    const active = isActive();
    const nothing = view.items.length === 0 && (view.status === 'live' || view.status === 'done');
    const text = nothing ? t(active ? 'svNothingYet' : 'svEmptySession') : {
      connecting: t('svConnecting'),
      loading: t('svLoading', { count, size }),
      live: t('svLive', { count }),
      done: t('svUpToDate', { count }),
      more: t('svMore', { count, size }),
      offline: t('svOffline'),
      empty: active ? t('svNothingYet') : t('svMissing'),
      disconnected: view.attempts >= 3 ? t('svDisconnectedLong') : t('svDisconnected'),
      error: t('svError', { reason: view.detail || '…' }),
      outdated: t('svOutdated'),
    }[view.status];
    statusLine.dataset.state = view.status;
    statusLine.replaceChildren(h('span', { class: `status-dot ${view.status === 'live' ? 'green pulse' : view.status === 'loading' || view.status === 'connecting' ? 'amber' : view.status === 'done' ? 'green' : 'gray'}` }), text);
    retryButton.hidden = !['offline', 'error', 'empty', 'disconnected', 'outdated'].includes(view.status);
    more.hidden = view.status !== 'more';
    refreshCompose();
  }

  function setStatus(status, detail = '') {
    view.status = status;
    view.detail = detail;
    renderStatus();
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  function stopWatchdog() {
    clearTimeout(view.watchdog);
    view.watchdog = 0;
  }

  function armWatchdog() {
    stopWatchdog();
    view.watchdog = setTimeout(() => {
      view.streaming = false;
      view.ws?.close(); // onclose reconnects and resumes from the cursor
    }, SILENCE_MS);
  }

  function connect() {
    if (view.destroyed) return;
    clearTimeout(view.reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/app/ws?view=session`);
    view.ws = ws;
    ws.addEventListener('open', () => {
      view.attempts = 0;
      // §6.8: declared on every (re)connect — the DO verifies worker_cmd against this, never
      // against the message itself, and the declaration does not survive a dropped socket.
      ws.send(JSON.stringify({ t: 'subscribe', workerId }));
      if (view.wantOpen) openStream();
    });
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => {
      if (view.ws !== ws || view.destroyed) return;
      const wasReading = view.streaming;
      view.streaming = false;
      stopWatchdog();
      // A finished session nobody is waiting on can let its socket go quietly; whatever needs it next reconnects.
      if (!wasReading && view.status === 'done' && !isActive()) {
        view.ws = null;
        return;
      }
      view.wantOpen = true;
      if (view.status !== 'offline') setStatus('disconnected');
      view.reconnectTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** view.attempts) + Math.random() * 400);
      view.attempts += 1;
    });
    ws.addEventListener('error', () => ws.close());
  }

  /** Asks for the next page from the cursor. A no-op while a read is in flight. */
  function openStream() {
    if (view.destroyed || view.streaming) return;
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) {
      view.wantOpen = true;
      if (!view.ws || view.ws.readyState > WebSocket.OPEN) connect();
      return;
    }
    view.wantOpen = false;
    view.streaming = true;
    if (view.initial || RETRYING.has(view.status)) setStatus('loading');
    view.ws.send(JSON.stringify({ t: 'history_open', id: uuid(), workerId, format: 'full', maxBytes: PAGE_BYTES, ...(view.cursor ? { since: view.cursor } : {}) }));
    armWatchdog();
  }

  function addItem(described) {
    for (const block of described.blocks) {
      if (block.t === 'tool_call' && block.callId) view.callIds.add(block.callId);
      if (block.t === 'tool_result' && block.callId) {
        view.results.set(block.callId, block);
        view.callViews.get(block.callId)?.setResult(block);
      }
    }
    view.items.push(described);
  }

  function ingest(entry) {
    view.loadedChars += entry.fragment?.data?.length ?? 0;
    const result = view.assembler.push(entry);
    if (result.pending) return false;
    if (result.error) {
      if (view.unreadable.has(entry?.id)) return false;
      view.unreadable.add(entry?.id);
      addItem({ id: null, parentId: null, at: null, agent: 'unknown', sidechain: false, model: '', blocks: [{ t: 'raw', title: t('svUnreadable'), json: result.error }] });
      return true;
    }
    addItem(describeRecord(result.record));
    return true;
  }

  function onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // not a frame of ours
    }
    if (message.t === 'history_chunk') return onChunk(message);
    if (message.t === 'machine_offline') return onOffline();
    if (message.t === 'cmd_ack' || message.t === 'cmd_result') return onWorkerCmdReply(message);
    if (message.t === 'error') return pendingCmds.has(message.re) ? onWorkerCmdError(message) : onError(message);
  }

  /** A connector that predates full reads ignores the request and answers with its old summary pages, which carry no
   *  `format`. Say so; reading them as full entries would show a list of unreadable records. */
  function onOutdated(chunk) {
    view.ws?.send(JSON.stringify({ t: 'history_ack', re: chunk.re, n: chunk.n })); // let its stream run out
    view.streaming = false;
    stopWatchdog();
    view.initial = view.items.length === 0;
    setStatus('outdated');
    render();
  }

  function onChunk(chunk) {
    if (chunk.format !== 'full') return onOutdated(chunk);
    armWatchdog();
    const before = view.cursor;
    let added = false;
    for (const entry of chunk.entries ?? []) added = ingest(entry) || added;
    if (typeof chunk.cursor === 'string') view.cursor = chunk.cursor;
    view.ws?.send(JSON.stringify({ t: 'history_ack', re: chunk.re, n: chunk.n }));
    if (view.initial) renderStatus();
    else if (added) scheduleRender();
    if (!chunk.done) return;

    view.streaming = false;
    stopWatchdog();
    if (chunk.truncated) {
      // The page ran into its byte budget: more is waiting. Keep going unless nothing moved
      // (a loop would never end) or the reader has already pulled in a great deal.
      if (view.cursor === before && !added) return setStatus('error', t('svStuck'));
      if (view.loadedChars < AUTO_LOAD_CHARS) return openStream();
      view.initial = false;
      render();
      return setStatus('more');
    }
    view.initial = false;
    view.resets = 0;
    setStatus(isActive() ? 'live' : 'done');
    render();
    schedulePoll();
  }

  function onOffline() {
    view.streaming = false;
    stopWatchdog();
    view.initial = view.items.length === 0;
    setStatus('offline');
    render();
  }

  function onError(message) {
    view.streaming = false;
    stopWatchdog();
    if (message.code === 'no_history') {
      view.initial = view.items.length === 0;
      setStatus('empty');
      schedulePoll();
      return;
    }
    if (message.code === 'cursor_invalid' && view.resets < 3) {
      resetContent(); // the file was replaced or rewritten: start over rather than splice
      return openStream();
    }
    view.initial = view.items.length === 0;
    setStatus('error', message.message || message.code || '');
    render();
  }

  function resetContent() {
    view.resets += 1;
    view.cursor = null;
    view.assembler.reset();
    view.items = [];
    view.callIds.clear();
    view.results.clear();
    view.callViews.clear();
    view.unreadable.clear();
    view.loadedChars = 0;
    view.initial = true;
    view.firstShown = 0;
    view.drawnEnd = 0;
    list.replaceChildren();
  }

  // ---- direct worker chat (issue #84, ADR-0011, §6.8) -----------------------------------------------------

  const pendingCmds = new Map(); // cmdId → 'send' | 'interrupt', while waiting on a terminal cmd_ack/cmd_result
  let composeBusy = false;

  function refreshCompose() {
    const offline = view.status === 'offline';
    composeInput.disabled = composeBusy || offline;
    sendButton.disabled = composeBusy || offline;
    interruptButton.disabled = composeBusy || offline || !isActive();
  }

  function settleWorkerCmd(cmdId, text) {
    pendingCmds.delete(cmdId);
    composeBusy = false;
    composeStatus.textContent = text;
    refreshCompose();
  }

  function sendWorkerCmd(kind, args) {
    if (!view.ws || view.ws.readyState !== WebSocket.OPEN) {
      composeStatus.textContent = t('svComposeOffline');
      return;
    }
    const id = uuid();
    pendingCmds.set(id, kind);
    composeBusy = true;
    refreshCompose();
    composeStatus.textContent = t('svComposeSending');
    view.ws.send(JSON.stringify({ t: 'worker_cmd', id, workerId, kind, ...(args ? { args } : {}) }));
  }

  /** Real cmd_ack/cmd_result only — never a fabricated optimistic one (§6.8). */
  function onWorkerCmdReply(message) {
    const kind = pendingCmds.get(message.re);
    if (!kind) return; // not a command this view issued
    const doneKey = kind === 'interrupt' ? 'svInterruptDone' : 'svComposeSent';
    if (message.t === 'cmd_result') {
      settleWorkerCmd(message.re, message.ok
        ? t(doneKey)
        : t('svComposeFailed', { reason: (message.error && (message.error.message || message.error.code)) || '' }));
      return;
    }
    // cmd_ack: 'accepted' and a result-less 'duplicate' are not terminal — still waiting on cmd_result.
    if (message.status === 'accepted' || (message.status === 'duplicate' && !message.result)) {
      composeStatus.textContent = t('svComposeAccepted');
      return;
    }
    if (message.status === 'rejected') return settleWorkerCmd(message.re, t('svComposeFailed', { reason: message.code ?? '' }));
    if (message.status === 'ambiguous') return settleWorkerCmd(message.re, t('svComposeUnknown'));
    if (message.result) {
      settleWorkerCmd(message.re, message.result.ok ? t(doneKey) : t('svComposeFailed', { reason: '' }));
    }
  }

  /** A `worker_cmd` the DO refused outright (unknown/broken worker, empty text): never reached
   *  outbox, so no cmd_ack is coming — settle right away instead of leaving the UI waiting. */
  function onWorkerCmdError(message) {
    settleWorkerCmd(message.re, t('svComposeFailed', { reason: message.message || message.code || '' }));
  }

  composeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = composeInput.value.trim();
    if (!text) return;
    sendWorkerCmd('send', { text, intent: 'auto' });
    composeInput.value = '';
  });
  interruptButton.addEventListener('click', () => sendWorkerCmd('interrupt'));

  function schedulePoll() {
    clearTimeout(view.pollTimer);
    if (view.destroyed || !isActive() || document.visibilityState !== 'visible') return;
    view.pollTimer = setTimeout(openStream, POLL_MS);
  }

  // ---- events --------------------------------------------------------------------------------------------------

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (!view.initial && view.status !== 'more' && view.status !== 'outdated') openStream(); // 'more' waits for the reader's say-so; an old connector will not change by itself
  };
  document.addEventListener('visibilitychange', onVisible);
  feed.addEventListener('scroll', () => { if (nearBottom()) jump.hidden = true; });
  jump.addEventListener('click', () => { toBottom(); jump.hidden = true; });
  earlier.addEventListener('click', showEarlier);
  more.addEventListener('click', () => {
    view.loadedChars = 0; // another allowance
    setStatus('loading');
    openStream();
  });
  retryButton.addEventListener('click', () => {
    view.attempts = 0;
    setStatus(view.items.length === 0 ? 'connecting' : 'loading');
    if (!view.ws || view.ws.readyState > WebSocket.OPEN) connect();
    view.wantOpen = true;
    openStream();
  });

  renderStatus();
  connect();

  return {
    /** The host learned the worker's state: keep following while it works, read once more when it stops. */
    update() {
      if (view.destroyed) return;
      renderStatus();
      if (view.status === 'live' && !isActive()) {
        setStatus('done');
        openStream(); // whatever was appended last
      } else if (view.status === 'done' && isActive()) {
        setStatus('live');
        openStream();
      } else if (view.status === 'empty' && isActive()) schedulePoll();
      else if (view.status === 'offline' && isReachable()) openStream(); // the machine is back
    },
    relabel() {
      retryButton.textContent = t('svRetry');
      more.textContent = t('svLoadMore');
      jump.replaceChildren(t('svJumpLatest'), icon('chevron-down'));
      feed.setAttribute('aria-label', t('svFeedLabel'));
      composeInput.setAttribute('placeholder', t('svComposePlaceholder'));
      sendButton.textContent = t('svSendButton');
      interruptButton.textContent = t('svInterruptButton');
      redrawAll();
    },
    destroy() {
      view.destroyed = true;
      clearTimeout(view.reconnectTimer);
      clearTimeout(view.pollTimer);
      stopWatchdog();
      if (view.renderTimer) cancelAnimationFrame(view.renderTimer);
      document.removeEventListener('visibilitychange', onVisible);
      // §6.8: best-effort — the socket closing right after revokes the subscription either way.
      if (view.ws?.readyState === WebSocket.OPEN) view.ws.send(JSON.stringify({ t: 'unsubscribe' }));
      view.ws?.close();
      pendingCmds.clear();
      root.replaceChildren();
    },
  };
}
