// The session viewer's pure half (no DOM; session.js draws what this describes).
//
// A machine records each worker's session as JSON lines — pi's session file or Claude Code's
// transcript. The viewer receives those lines whole (reassembled from fragments) and shows them
// as written. Nothing is dropped here: a record or block this module does not recognise becomes
// a `raw` block — collapsed in the page, but present.
//
// Block shapes (`t` says which):
//   text         { role: 'user' | 'assistant', text }
//   thinking     { text, redacted }
//   tool_call    { callId, name, input }
//   tool_result  { callId, name, text, images, error }
//   image        { image: { mime, data } }
//   bash         { command, output, exitCode, cancelled, truncated }
//   meta         { kind, title, detail }       bookkeeping the agent wrote (model change, compaction…)
//   raw          { title, json }               anything else, verbatim

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const asText = (value) => (typeof value === 'string' ? value : '');

export function pretty(value) {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

// ---- reassembling fragments -----------------------------------------------------------------------

/**
 * A recorded entry travels as fragments of its JSON text (`fragment: { data, offset, total }`),
 * in order, possibly across several pages. `push` takes one wire entry and answers with
 * `{ record }` when it completes an entry, `{ pending: true }` while more is due, or
 * `{ error }` ('malformed' | 'gap' | 'overflow' | 'parse') when the stream cannot be trusted.
 * A read that resumes mid-entry continues where it left off: keep one assembler per view.
 */
export function createAssembler() {
  let open = null;
  return {
    push(entry) {
      const fragment = entry?.fragment;
      if (!fragment || typeof fragment.data !== 'string' || !Number.isInteger(fragment.offset) || !Number.isInteger(fragment.total) || typeof entry.id !== 'string') {
        return { error: 'malformed' };
      }
      if (fragment.offset === 0) {
        open = { id: entry.id, total: fragment.total, parts: [], length: 0 }; // a restart supersedes an abandoned entry
      } else if (!open || open.id !== entry.id || open.total !== fragment.total || open.length !== fragment.offset) {
        open = null;
        return { error: 'gap' };
      }
      open.parts.push(fragment.data);
      open.length += fragment.data.length;
      if (open.length > open.total) {
        open = null;
        return { error: 'overflow' };
      }
      if (open.length < open.total) return { pending: true };
      const json = open.parts.join('');
      open = null;
      try {
        return { record: JSON.parse(json) };
      } catch {
        return { error: 'parse' };
      }
    },
    /** True while an entry is half-received. */
    get partial() {
      return open !== null;
    },
    reset() {
      open = null;
    },
  };
}

// ---- reading one record -----------------------------------------------------------------------------

const raw = (title, value) => ({ t: 'raw', title, json: typeof value === 'string' ? value : pretty(value) });
const meta = (kind, title = '', detail = '') => ({ t: 'meta', kind, title, detail });

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** pi: { type: 'image', data, mimeType } · Claude Code: { type: 'image', source: { type: 'base64', media_type, data } }. */
function imageOf(block) {
  const source = isObject(block.source) ? block.source : block;
  return { mime: asText(source.mimeType) || asText(source.media_type) || asText(block.mimeType), data: asText(source.data) };
}

/** A data: URL for an image the page may show, or null — only common raster types, only real base64. */
export function imageSrc(image) {
  if (!image || !IMAGE_TYPES.has(image.mime) || image.data === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) return null;
  return `data:${image.mime};base64,${image.data}`;
}

function toolResult(callId, name, content, error) {
  const images = [];
  const texts = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') texts.push(part);
      else if (isObject(part) && part.type === 'text') texts.push(asText(part.text));
      else if (isObject(part) && part.type === 'image') images.push(imageOf(part));
      else texts.push(pretty(part));
    }
  } else if (content !== undefined && content !== null) texts.push(pretty(content));
  return { t: 'tool_result', callId, name, text: texts.join('\n'), images, error };
}

/** The blocks of a message's `content`: a string, or an array of typed parts from either agent. */
function partsOf(content, role) {
  if (typeof content === 'string') return content === '' ? [] : [{ t: 'text', role, text: content }];
  if (content === undefined || content === null) return [];
  if (!Array.isArray(content)) return [raw('content', content)];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') blocks.push({ t: 'text', role, text: part });
    else if (!isObject(part)) blocks.push(raw('content', part));
    else if (part.type === 'text') blocks.push({ t: 'text', role, text: asText(part.text) });
    else if (part.type === 'thinking') blocks.push({ t: 'thinking', text: asText(part.thinking) || asText(part.text), redacted: part.redacted === true });
    else if (part.type === 'redacted_thinking') blocks.push({ t: 'thinking', text: '', redacted: true });
    else if (part.type === 'toolCall') blocks.push({ t: 'tool_call', callId: asText(part.id), name: asText(part.name), input: part.arguments });
    else if (part.type === 'tool_use') blocks.push({ t: 'tool_call', callId: asText(part.id), name: asText(part.name), input: part.input });
    else if (part.type === 'tool_result') blocks.push(toolResult(asText(part.tool_use_id), '', part.content, part.is_error === true));
    else if (part.type === 'image') blocks.push({ t: 'image', image: imageOf(part) });
    else blocks.push(raw(asText(part.type) || 'content', part));
  }
  return blocks;
}

const PI_TYPES = new Set(['session', 'message', 'model_change', 'thinking_level_change', 'compaction', 'branch_summary', 'custom', 'custom_message', 'label', 'session_info', 'usage', 'context_edit']);

function piMessage(message) {
  switch (message.role) {
    case 'user':
      return partsOf(message.content, 'user');
    case 'assistant': {
      const blocks = partsOf(message.content, 'assistant');
      if (message.stopReason === 'error' || asText(message.errorMessage)) blocks.push(meta('error', asText(message.stopReason) || 'error', asText(message.errorMessage)));
      return blocks;
    }
    case 'toolResult':
      return [toolResult(asText(message.toolCallId), asText(message.toolName), message.content, message.isError === true)];
    case 'bashExecution':
      return [{ t: 'bash', command: asText(message.command), output: asText(message.output), exitCode: Number.isInteger(message.exitCode) ? message.exitCode : null, cancelled: message.cancelled === true, truncated: message.truncated === true }];
    case 'custom':
      return [meta('custom', asText(message.customType), partsOf(message.content, 'user').map((block) => block.text ?? pretty(block)).join('\n'))];
    case 'branchSummary':
    case 'compactionSummary':
      return [meta(message.role === 'branchSummary' ? 'branch_summary' : 'compaction', '', asText(message.summary))];
    case 'system': {
      const sections = isObject(message.sections) ? message.sections : {};
      const names = Object.keys(sections);
      const added = Array.isArray(message.toolsAdded) ? message.toolsAdded.length : 0;
      const removed = Array.isArray(message.toolsRemoved) ? message.toolsRemoved.length : 0;
      const title = [names.length ? names.join(', ') : '', added ? `+${added} tools` : '', removed ? `−${removed} tools` : ''].filter(Boolean).join(' · ');
      const detail = [asText(message.content), ...names.map((name) => `## ${name}\n${typeof sections[name] === 'string' ? sections[name] : pretty(sections[name])}`)].filter(Boolean).join('\n\n');
      return [meta('system', title, detail)];
    }
    default:
      return [raw(`message · ${asText(message.role) || 'unknown'}`, message)];
  }
}

function piEntry(record) {
  switch (record.type) {
    case 'session':
      return [meta('session', asText(record.cwd), record.parentSession ? `parent: ${asText(record.parentSession)}` : '')];
    case 'message':
      return isObject(record.message) ? piMessage(record.message) : [raw('message', record)];
    case 'model_change':
      return [meta('model', [asText(record.provider), asText(record.modelId)].filter(Boolean).join('/'))];
    case 'thinking_level_change':
      return [meta('thinking_level', asText(record.thinkingLevel))];
    case 'compaction':
      return [meta('compaction', Number.isFinite(record.tokensBefore) ? String(record.tokensBefore) : '', asText(record.summary))];
    case 'branch_summary':
      return [meta('branch_summary', asText(record.fromId), asText(record.summary))];
    case 'custom':
      return [meta('custom', asText(record.customType), record.data === undefined ? '' : pretty(record.data))];
    case 'custom_message':
      return [meta('custom', asText(record.customType), partsOf(record.content, 'user').map((block) => block.text ?? pretty(block)).join('\n'))];
    case 'label':
      return [meta('label', asText(record.label), `→ ${asText(record.targetId)}`)];
    case 'session_info':
      return [meta('session_info', asText(record.name))];
    case 'usage':
      return [meta('usage', [asText(record.kind), isObject(record.usage) && Number.isFinite(record.usage.totalTokens) ? `${record.usage.totalTokens} tokens` : ''].filter(Boolean).join(' · '))];
    case 'context_edit':
      return [meta('context_edit', asText(record.targetId), record.replacement === null ? '' : pretty(record.replacement))];
    default:
      return [raw(asText(record.type) || 'entry', record)];
  }
}

function claudeEntry(record) {
  switch (record.type) {
    case 'user':
    case 'assistant': {
      const message = isObject(record.message) ? record.message : {};
      const blocks = partsOf(message.content, record.type);
      return blocks.length > 0 ? blocks : [raw(record.type, record)];
    }
    case 'system':
      return [meta('info', [asText(record.subtype), asText(record.level)].filter(Boolean).join(' · '), asText(record.content))];
    case 'summary':
      return [meta('summary', '', asText(record.summary))];
    default:
      return [raw(asText(record.type) || 'entry', record)]; // file-history-snapshot, queue-operation, …
  }
}

/**
 * One recorded entry, ready to draw. `id`/`parentId` place it in the agent's conversation tree
 * (null for entries outside it, like pi's file header); `agent` says which format it was.
 */
export function describeRecord(record) {
  if (!isObject(record)) return { id: null, parentId: null, at: null, agent: 'unknown', sidechain: false, model: '', blocks: [raw('entry', record)] };
  const type = asText(record.type);
  const agent = PI_TYPES.has(type) ? 'pi' : typeof record.uuid === 'string' || ['user', 'assistant', 'system', 'summary'].includes(type) ? 'claude' : 'unknown';
  const id = type === 'session' ? null : asText(record.id) || asText(record.uuid) || null;
  const parent = record.parentId ?? record.parentUuid;
  const at = Date.parse(asText(record.timestamp));
  const message = isObject(record.message) ? record.message : {};
  return {
    id,
    parentId: typeof parent === 'string' ? parent : null,
    at: Number.isFinite(at) ? at : null,
    agent,
    sidechain: record.isSidechain === true,
    model: asText(message.model),
    blocks: agent === 'pi' ? piEntry(record) : agent === 'claude' ? claudeEntry(record) : [raw(type || 'entry', record)],
  };
}

// ---- the conversation tree --------------------------------------------------------------------------------

/**
 * Which entries sit on the branch the agent would continue from. pi's session file is a tree in
 * which every entry has exactly one child unless the agent really forked (a rewind, a /tree
 * jump); the file keeps the abandoned branches, and showing them is honest — passing them off as
 * the conversation is not. So: when some entry has two children, the branch is the chain from the
 * last entry back to the root and everything else is "other". Claude Code is deliberately left
 * out: its parallel tool calls write sibling results under sibling assistant entries, which looks
 * like a fork and is not one. Sub-agent (sidechain) entries form their own chains and are
 * reported separately. `nodes` are described records in file order (see describeRecord).
 */
export function branchOf(nodes) {
  const parents = new Map();
  const children = new Map();
  let leaf = null;
  for (const node of nodes) {
    if (node.agent !== 'pi' || node.id === null || node.sidechain) continue;
    parents.set(node.id, node.parentId);
    leaf = node.id;
    if (node.parentId !== null) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  }
  const forked = [...children.values()].some((count) => count > 1);
  const onBranch = new Set();
  if (forked) for (let id = leaf; id !== null && id !== undefined && parents.has(id) && !onBranch.has(id); id = parents.get(id)) onBranch.add(id);
  return { onBranch, forked };
}

/** 'main' | 'other' | 'sidechain' for one entry, given the result of `branchOf`. */
export function placeOf(node, branch) {
  if (node.sidechain) return 'sidechain';
  if (!branch.forked || node.agent !== 'pi' || node.id === null) return 'main';
  return branch.onBranch.has(node.id) ? 'main' : 'other';
}

// ---- showing values -----------------------------------------------------------------------------------------

const SUMMARY_KEYS = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'prompt'];

/** One line for a tool call's heading: the argument that says what it is about. */
export function callSummary(input, max = 140) {
  if (!isObject(input)) return typeof input === 'string' ? firstLine(input, max) : '';
  for (const key of SUMMARY_KEYS) {
    if (typeof input[key] === 'string' && input[key] !== '') return firstLine(input[key], max);
  }
  return '';
}

function firstLine(text, max) {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A tool call's arguments as rows of [name, text]: strings as written (newlines intact), the rest as JSON. */
export function inputRows(input) {
  if (isObject(input)) return Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value : pretty(value)]);
  if (input === undefined || input === null) return [];
  return [['', typeof input === 'string' ? input : pretty(input)]];
}

/** The part of `text` to show before "show all": `{ shown, hidden }` where hidden counts the characters left out. */
export function clip(text, max) {
  if (text.length <= max) return { shown: text, hidden: 0 };
  let end = max;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1; // not mid-character
  return { shown: text.slice(0, end), hidden: text.length - end };
}
