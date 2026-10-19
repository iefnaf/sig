// Text with a little markup, drawn as DOM. Shared by the conversation and the session viewer.
// parseMarkup (format.js) gives structure and never HTML; h() can only make text nodes — so
// nothing an agent, a repository or a person wrote is ever parsed as markup.
import { h } from './dom.js';
import { parseMarkup } from './format.js';

function inline(parts) {
  return parts.map((part) => {
    if (part.t === 'code') return h('code', null, part.text);
    if (part.t === 'strong') return h('strong', null, part.text);
    if (part.t === 'em') return h('em', null, part.text);
    if (part.t === 'del') return h('del', null, part.text);
    if (part.t === 'link') return h('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer', title: part.href }, part.text);
    return part.text;
  });
}

export function markup(text) {
  const blocks = parseMarkup(text).map((block) => {
    if (block.t === 'code') return h('pre', null, block.text);
    if (block.t === 'ul' || block.t === 'ol') return h(block.t, null, block.items.map((item) => h('li', null, inline(item))));
    if (block.t === 'h') return h(block.level <= 2 ? 'h4' : 'h5', { class: 'mk-h' }, inline(block.lines[0]));
    if (block.t === 'quote') return h('blockquote', { class: 'mk-quote' }, block.lines.flatMap((line, index) => (index === 0 ? [inline(line)] : [h('br'), inline(line)])));
    if (block.t === 'hr') return h('hr', { class: 'mk-hr' });
    return h('p', null, block.lines.flatMap((line, index) => (index === 0 ? [inline(line)] : [h('br'), inline(line)])));
  });
  return h('div', { class: 'markup' }, blocks);
}
