// A tiny element builder. Everything the workspace draws goes through it, and it can only
// create text nodes and attributes — there is deliberately no way to pass markup. Messages,
// card text, thread titles and repository names come from agents and repositories, so none of
// it may ever be parsed as HTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div', { class: 'x', dataset: { id: 1 }, onclick: fn, style: { width: '4px' } }, child, [children])
 * Children: strings and numbers become text; null, undefined and false are skipped.
 */
export function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name === 'dataset') Object.assign(element.dataset, value);
    else if (name === 'style') for (const [property, entry] of Object.entries(value)) element.style.setProperty(property, entry);
    else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return parent;
}

// Stroke icons on a 24px grid: [tag, attributes] pairs.
const ICONS = {
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  chat: [['path', { d: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z' }], ['path', { d: 'M7 10h8M7 14h5' }]],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'm16 16 4 4' }]],
  monitor: [['rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }], ['path', { d: 'M8 21h8M12 17v4' }]],
  laptop: [['path', { d: 'M5 16V5h14v11M2 16h20l-2 4H4Z' }]],
  'chevron-right': [['path', { d: 'm9 5 7 7-7 7' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'arrow-up': [['path', { d: 'M12 19V5m-6 6 6-6 6 6' }]],
  'panel-left': [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M9 4v16' }]],
  'chevron-left': [['path', { d: 'm15 5-7 7 7 7' }]],
  panel: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M15 4v16' }]],
  route: [['circle', { cx: 6, cy: 5, r: 2 }], ['circle', { cx: 18, cy: 19, r: 2 }], ['path', { d: 'M6 7v7a5 5 0 0 0 5 5h5M6 11h7a5 5 0 0 0 5-5V3m-3 3 3-3 3 3' }]],
  shield: [['path', { d: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z' }], ['path', { d: 'm8 12 3 3 5-6' }]],
  layers: [['path', { d: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5' }]],
  close: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
  branch: [['circle', { cx: 6, cy: 5, r: 2 }], ['circle', { cx: 6, cy: 19, r: 2 }], ['circle', { cx: 18, cy: 5, r: 2 }], ['path', { d: 'M6 7v10M18 7a8 8 0 0 1-8 8H6' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3 2' }]],
  check: [['path', { d: 'm5 12 4 4L19 6' }]],
  folder: [['path', { d: 'M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]],
  external: [['path', { d: 'M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5' }]],
  signal: [['path', { d: 'M4 19h1M8 15v4M12 11v8M16 7v12M20 3v16' }]],
  user: [['circle', { cx: 12, cy: 8, r: 4 }], ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]],
  help: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01' }]],
  alert: [['path', { d: 'M12 3 2 20h20Z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
  memory: [['path', { d: 'M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-1 5 3.5 3.5 0 0 0 3 5.5A3 3 0 0 0 12 20V4a3 3 0 0 0-3-1Z' }], ['path', { d: 'M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 1 5 3.5 3.5 0 0 1-3 5.5A3 3 0 0 1 12 20' }]],
  repeat: [['path', { d: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3' }]],
  sparkle: [['path', { d: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6' }]],
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attributes] of ICONS[name] ?? ICONS.chat) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, String(value));
    svg.append(shape);
  }
  return svg;
}

/** Fills every <… data-icon="name"> placeholder in the static shell. */
export function paintIcons(root = document) {
  for (const element of root.querySelectorAll('[data-icon]')) element.replaceChildren(icon(element.dataset.icon));
}

// Static, same-origin brand symbols. See provider-icons.LICENSE.txt for provenance.
const PROVIDER_ICONS = {
  'amazon-bedrock': 'bedrock-color', anthropic: 'claude-color', azure: 'azure-color',
  baseten: 'baseten', cerebras: 'cerebras', 'cloudflare-ai-gateway': 'cloudflare-color',
  'cloudflare-workers-ai': 'workersai-color', deepseek: 'deepseek-color', fireworks: 'fireworks-color',
  'github-copilot': 'githubcopilot', google: 'gemini-color', 'google-vertex': 'vertexai-color',
  groq: 'groq', huggingface: 'huggingface-color', 'kimi-coding': 'kimi', meta: 'meta-color',
  minimax: 'minimax-color', 'minimax-cn': 'minimax-color', mistral: 'mistral-color',
  moonshotai: 'kimi', 'moonshotai-cn': 'kimi', nvidia: 'nvidia-color', openai: 'openai',
  'openai-codex': 'openai', opencode: 'opencode', 'opencode-go': 'opencode', openrouter: 'openrouter',
  'qwen-token-plan': 'qwen-color', 'qwen-token-plan-cn': 'qwen-color', 'qwen-token-plan-individual': 'qwen-color',
  together: 'together-color', 'vercel-ai-gateway': 'vercel', xai: 'xai', xiaomi: 'mimocode',
  'xiaomi-token-plan-ams': 'mimocode', 'xiaomi-token-plan-cn': 'mimocode', 'xiaomi-token-plan-sgp': 'mimocode',
  zai: 'zai', 'zai-api': 'zai', 'zai-api-cn': 'zhipu-color', 'zai-coding-cn': 'zhipu-color',
};

export function providerIcon(provider) {
  const name = Object.hasOwn(PROVIDER_ICONS, provider) ? PROVIDER_ICONS[provider] : null;
  if (!name) return icon('layers');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('width', '24');
  use.setAttribute('height', '24');
  use.setAttribute('href', `/app/assets/provider-icons.svg#${name}`);
  svg.append(use);
  return svg;
}
