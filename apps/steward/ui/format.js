// Pure formatting for the workspace: no DOM, no globals beyond Intl, so it can be exercised
// directly in tests. Locale arrives as a BCP-47 tag ("en" / "zh-CN").

const pad = (n) => String(n).padStart(2, '0');

/** "18:32" in 24-hour time, in the viewer's time zone. */
export function formatClock(ts) {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Local calendar day, used to group messages under one date divider. */
export function dayKey(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Today" / "Yesterday" for the labels given, otherwise a short date like "Oct 17" or "10月17日". */
export function formatDay(ts, now, tag, labels) {
  const key = dayKey(ts);
  if (key === dayKey(now)) return labels.today;
  if (key === dayKey(now - 24 * 3600_000)) return labels.yesterday;
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(tag, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(ts);
}

/** "5 min. ago" / "5 分钟前"; anything under 45 s is `justNow`. */
export function formatRelative(ts, now, tag, justNow) {
  const delta = Math.max(0, now - ts);
  if (delta < 45_000) return justNow;
  const formatter = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'short' });
  if (delta < 3600_000) return formatter.format(-Math.max(1, Math.round(delta / 60_000)), 'minute');
  if (delta < 24 * 3600_000) return formatter.format(-Math.round(delta / 3600_000), 'hour');
  return formatter.format(-Math.round(delta / (24 * 3600_000)), 'day');
}

export function formatUsd(value) {
  const amount = Number.isFinite(value) ? value : 0;
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 3 : 2)}`;
}

/** Only web links are ever made clickable; the result is a normalised absolute URL or null. */
export function safeUrl(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** One plain line for previews: markers out, link labels kept, whitespace collapsed. */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/g, '$1')
    .replace(/(\*\*|~~|`)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- text with a little markup -----------------------------------------------------------------
// Agents write plain text with the odd list, `code`, **bold** or link, and the card templates use
// the same small subset. Parsing gives structure (never HTML); the DOM layer decides how to draw it.

/**
 * Text that is still being written can end in the middle of a marker — `**bol`, a lone backtick,
 * `[docs](https://exa`. Those half-markers would flash as raw punctuation, so they are held back
 * until the rest arrives.
 */
export function trimOpenMarkup(text) {
  let out = String(text);
  const bold = [...out.matchAll(/\*\*/g)];
  if (bold.length % 2 === 1) {
    const at = bold[bold.length - 1].index;
    out = out.slice(0, at) + out.slice(at + 2);
  }
  if (!out.includes('```') && (out.match(/`/g) ?? []).length % 2 === 1) {
    const at = out.lastIndexOf('`');
    out = out.slice(0, at) + out.slice(at + 1);
  }
  return out.replace(/\[([^\]\n]*)\]\([^)\n]*$/, '$1');
}

const INLINE = /(?<code>`[^`\n]+`)|(?<strong>\*\*[^*\n]+\*\*)|(?<strike>~~[^~\n]+~~)|(?<em>\*(?!\s)(?:[^*\n]*[^\s*])\*)|(?<link>\[(?<label>[^\]\n]+)\]\((?<href>https?:\/\/[^)\s]+)\))|(?<url>https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"，。；：！？、])/g;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
/** A heading, with or without the bold the models like to wrap it in (`**## 标题**`). */
const HEADING_BOLD = /^\s{0,3}\*\*\s*(#{1,6})\s+(.+?)\s*\*\*\s*$/;
const HEADING_PLAIN = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/;
/** Three or more of -, * or _ alone on a line. Checked before bullets: `* * *` is a rule. */
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseInline(text) {
  const out = [];
  let last = 0;
  const push = (part) => { if (part.text !== '') out.push(part); };
  for (const match of text.matchAll(INLINE)) {
    push({ t: 'text', text: text.slice(last, match.index) });
    last = match.index + match[0].length;
    const g = match.groups;
    if (g.code) push({ t: 'code', text: g.code.slice(1, -1) });
    else if (g.strong) push({ t: 'strong', text: g.strong.slice(2, -2) });
    else if (g.strike) push({ t: 'del', text: g.strike.slice(2, -2) });
    else if (g.em) push({ t: 'em', text: g.em.slice(1, -1) });
    else if (g.link) {
      const href = safeUrl(g.href);
      push(href ? { t: 'link', href, text: g.label } : { t: 'text', text: g.link });
    } else if (g.url) {
      const href = safeUrl(g.url);
      push(href ? { t: 'link', href, text: g.url } : { t: 'text', text: g.url });
    }
  }
  push({ t: 'text', text: text.slice(last) });
  return out;
}

/**
 * Blocks: { t: 'p', lines: Inline[][] } (soft line breaks kept), { t: 'ul' | 'ol', items: Inline[][] },
 * { t: 'code', text }, { t: 'h', level, lines }, { t: 'quote', lines }, { t: 'hr' }.
 * Unknown syntax simply stays text.
 */
export function parseMarkup(text) {
  const blocks = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  let list = null;
  let quote = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ t: 'p', lines: paragraph.map(parseInline) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (quote) blocks.push({ t: 'quote', lines: quote.map(parseInline) });
    quote = null;
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushAll();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    if (RULE.test(line)) {
      flushAll();
      blocks.push({ t: 'hr' });
      continue;
    }
    const heading = HEADING_BOLD.exec(line) ?? HEADING_PLAIN.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ t: 'h', level: heading[1].length, lines: [parseInline(heading[2])] });
      continue;
    }
    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote ??= [];
      quote.push(quoted[1]);
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const kind = bullet ? 'ul' : 'ol';
      if (list && list.t !== kind) flushList();
      list ??= { t: kind, items: [] };
      list.items.push(parseInline((bullet ?? ordered)[1]));
      continue;
    }
    flushList();
    flushQuote();
    if (line.trim() === '') flushParagraph();
    else paragraph.push(line);
  }
  flushAll();
  return blocks;
}
