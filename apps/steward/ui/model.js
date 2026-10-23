// Derived views over the workspace snapshot (see workspace.ts for its shape). Pure functions,
// no DOM: the controller asks these what to draw, and tests exercise them directly.

import { plainText } from './format.js';

export const THREAD_STATE_ORDER = ['waiting_you', 'running', 'idle'];
const ACTIVE_WORKER_STATES = ['queued', 'starting', 'running', 'recovering'];

export const isActiveWorker = (worker) => ACTIVE_WORKER_STATES.includes(worker.state);

export function threadMatches(thread, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    thread.title, thread.goal, thread.summary, thread.machine, ...thread.repos,
    ...thread.workers.flatMap((worker) => [worker.agent, worker.machine, worker.branch]),
  ];
  return haystack.filter(Boolean).join('\n').toLowerCase().includes(needle);
}

/** Threads grouped for the sidebar: waiting on the owner first, then running, then idle. */
export function groupThreads(threads, query) {
  const shown = threads.filter((thread) => threadMatches(thread, query));
  return THREAD_STATE_ORDER
    .map((state) => ({ state, threads: shown.filter((thread) => thread.state === state) }))
    .filter((group) => group.threads.length > 0);
}

/** Messages belonging to a thread, or everything when no thread is selected. */
export const messagesFor = (messages, threadId) => (threadId ? messages.filter((message) => message.threadId === threadId) : messages);

/**
 * The owner's sent-but-unconfirmed messages, shown right away. The server names a web message
 * `user:web:<request id>`, so once the snapshot contains it the pending copy disappears by id.
 * Pending messages are the newest by definition: they go last whatever the clocks say.
 */
export function withPending(messages, pending) {
  const known = new Set(messages.map((message) => message.id));
  const extra = [...pending.values()]
    .map((entry) => ({ id: `user:web:${entry.id}`, role: 'user', channel: 'web', at: entry.at, threadId: entry.threadId ?? null, text: entry.text, pending: entry.status }))
    .filter((message) => !known.has(message.id));
  return [...messages, ...extra];
}

/** Messages grouped under one divider per local calendar day. */
export function groupByDay(messages, dayKeyOf) {
  const groups = [];
  for (const message of messages) {
    const key = dayKeyOf(message.at);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.messages.push(message);
    else groups.push({ key, at: message.at, messages: [message] });
  }
  return groups;
}

export function workOn(snapshot, machine) {
  return snapshot.threads.filter((thread) => thread.workers.some((worker) => isActiveWorker(worker) && worker.machine === machine.name));
}

export function summarize(snapshot) {
  const machines = snapshot.machines.filter((machine) => !machine.revoked);
  return {
    machinesTotal: machines.length,
    machinesOnline: machines.filter((machine) => machine.online).length,
    running: snapshot.threads.filter((thread) => thread.state === 'running').length,
    needs: snapshot.attention.length,
  };
}

export const attentionFor = (snapshot, threadId) => snapshot.attention.filter((item) => item.threadId === threadId);

/** One line for the sidebar: the latest thing said in the thread, else its summary or goal. */
export function previewOf(thread, messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.threadId !== thread.id) continue;
    const text = message.text ?? message.card?.title ?? message.card?.body?.[0];
    if (text) return plainText(text);
  }
  return plainText(thread.summary ?? thread.goal ?? '');
}

/** Open messages that ask for a decision, newest last. */
export const openCards = (messages) => messages.filter((message) => message.card && message.open);

/** The model id the Settings draft should carry after its provider changed (issue #74): the
 *  current id when the new provider's catalog has it, else its first model. `null` means the
 *  provider is not in the catalog (custom free text) — leave the field as typed. */
export function modelAfterProviderChange(providers, provider, currentModelId) {
  const entry = (providers ?? []).find((candidate) => candidate.id === provider);
  if (!entry) return null;
  if (entry.models.some((model) => model.id === currentModelId)) return currentModelId;
  return entry.models[0]?.id ?? null;
}

/** Open worker requests the composer can answer: cards with something to reply to. */
export const replyTarget = (snapshot, cardId) => snapshot.attention.find((item) => item.id === cardId) ?? null;

// ---- copy tables: which interface string a piece of server data maps to ---------------------------

/** Card buttons whose meaning is fixed by the system (the template labels are Chinese). */
export const ACTION_KEYS = {
  pr_approve: 'actionApprove', pr_decline: 'actionDecline', wait_online: 'actionWait', switch_machine: 'actionSwitch', cancel: 'actionCancel',
  routine_accept: 'actionRoutineAccept', routine_decline: 'actionRoutineDecline', note_archive: 'actionArchive', note_keep: 'actionKeep',
};

/** Fixed titles of the system's own cards. */
export const KNOWN_TITLES = {
  '需要你拍板': 'titleDecision',
  '一条记忆很久没用了': 'titleMemory',
  '要把这个变成例行任务吗？': 'titleRoutine',
};

/** Full-screen states: [title, body]. */
export const FATAL_COPY = {
  signed_out: ['sessionExpiredTitle', 'sessionExpiredBody'],
  logged_out: ['signedOutTitle', 'signedOut'],
  unreachable: ['loadFailedTitle', 'loadFailedBody'],
};

/** Missing model credentials block first use; passkeys are an optional first-run step. */
export function initialSetupStep(settings, hasConversation, securitySkipped) {
  if (!settings.model?.apiKey) return 'model';
  if (!settings.passkeys.length && !hasConversation && !securitySkipped) return 'security';
  return null;
}

/** Preserve a compatible choice; otherwise use the model's advertised default. */
export function thinkingAfterModelChange(model, current = 'off') {
  return model?.thinkingLevels?.includes(current) ? current : model?.defaultThinkingLevel ?? 'off';
}

/** Only configured providers belong in the chat's model menu. */
export function availableChatModels(settings) {
  return (settings?.providers ?? []).filter((provider) => settings.keyedProviders.includes(provider.id));
}
