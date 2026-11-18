/**
 * HTML sanitizer for email templates and rendered messages (M08 S36 task 1, §9 "HTML sanitized"). A strict ALLOW-LIST tokenizer, not a regex scrub: tags,
 * attributes and URL schemes outside the lists are dropped; dangerous containers (script, style, iframe, svg, form, ...) are removed WITH their content; comments,
 * CDATA and processing instructions are removed; text is re-escaped. Output never contains an event handler, an inline style, a `javascript:`/`data:` URL or a tag
 * that is not listed. Used twice: when a template is saved, and again on the RENDERED html (so a variable value can never smuggle markup or a script URL).
 */
const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);
const VOID = new Set(['br', 'hr', 'img']);
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'meta',
  'base',
  'template',
  'noscript',
  'title',
  'head',
  'audio',
  'video',
  'canvas',
  'xmp',
  'plaintext',
  'listing',
]);
const ATTRS: Record<string, Set<string>> = {
  '*': new Set(['dir', 'lang', 'title', 'align']),
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'width', 'height']),
  th: new Set(['colspan', 'rowspan', 'width', 'height']),
  table: new Set(['width', 'border', 'cellpadding', 'cellspacing']),
};
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  tab: '\t',
  newline: '\n',
  colon: ':',
  lpar: '(',
  rpar: ')',
};
const PLACEHOLDER = /^\{\{[A-Za-z_][A-Za-z0-9_]{0,40}\}\}$/;

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
/** Decodes numeric and the few named entities that matter for scheme detection; unknown entities stay literal. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
// Character classes are built at runtime so that this source file contains no raw control or separator characters.
const BS = String.fromCharCode(92);
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const range = (a: number, b: number) =>
  a === b ? BS + 'u' + hex4(a) : BS + 'u' + hex4(a) + '-' + BS + 'u' + hex4(b);
export const classOf = (rs: [number, number][]) =>
  '[' + rs.map(([a, b]) => range(a, b)).join('') + ']';
/** Everything that can hide a scheme: C0/C1 controls, spaces and zero-width/format characters. */
export const INVISIBLE = new RegExp(
  classOf([
    [0, 0x20],
    [0x7f, 0x9f],
    [0xa0, 0xa0],
    [0x1680, 0x1680],
    [0x2000, 0x200f],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
  ]),
  'g',
);
export const CONTROL = new RegExp(
  classOf([
    [0, 0x1f],
    [0x7f, 0x7f],
  ]),
  'g',
);
/** A URL is kept only when, after entity decoding and removal of whitespace/control characters, it is absolute http(s)/mailto/tel (or a lone `{{placeholder}}`). */
export function safeUrl(raw: string, schemes: string[]): string | null {
  const decoded = decodeEntities(raw);
  const flat = decoded.replace(INVISIBLE, '');
  if (PLACEHOLDER.test(flat)) return flat;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(flat);
  if (!m || !schemes.includes(m[1]!.toLowerCase())) return null;
  if (/^(https?):\/\/$/i.test(flat)) return null;
  return decoded.trim().replace(CONTROL, '');
}
const escText = (t: string): string =>
  t
    .replace(/&(?!(?:amp|lt|gt|quot|#39|nbsp);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function sanitizeHtml(input: string): string {
  const src = String(input);
  let out = '';
  let i = 0;
  const stack: string[] = [];
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += escText(src.slice(i));
      break;
    }
    out += escText(src.slice(i, lt));
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[i + 1] === '?' || src[i + 1] === '!') {
      const end = src.indexOf('>', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const head = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(i, i + 80));
    if (!head) {
      out += '&lt;';
      i += 1;
      continue;
    }
    // find the end of the tag, honouring quotes
    let j = i + head[0].length;
    let q: string | null = null;
    while (j < src.length) {
      const c = src[j]!;
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= src.length) {
      // an unterminated tag: everything from here is dropped (never echoed)
      break;
    }
    const closing = head[1] === '/';
    const name = head[2]!.toLowerCase();
    const rawAttrs = src.slice(i + head[0].length, j);
    i = j + 1;
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) {
        const re = new RegExp(`</${name}\\s*>`, 'i');
        const m = re.exec(src.slice(i));
        i = m ? i + m.index + m[0].length : src.length;
      }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // unknown tag: dropped, its text content is kept (escaped)
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) {
        while (stack.length > at) out += `</${stack.pop()}>`;
      }
      continue;
    }
    const allowed = new Set([...(ATTRS['*'] ?? []), ...(ATTRS[name] ?? [])]);
    let attrs = '';
    const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(rawAttrs))) {
      const an = m[1]!.toLowerCase();
      if (!allowed.has(an) || seen.has(an) || an.startsWith('on')) continue;
      seen.add(an);
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      if (an === 'href') {
        const u = safeUrl(val, ['http', 'https', 'mailto', 'tel']);
        if (u) attrs += ` href="${escapeHtml(u)}" rel="noopener noreferrer"`;
      } else if (an === 'src') {
        const u = safeUrl(val, ['https']);
        if (u) attrs += ` src="${escapeHtml(u)}"`;
      } else if (an === 'dir') {
        if (['rtl', 'ltr', 'auto'].includes(val.toLowerCase()))
          attrs += ` dir="${val.toLowerCase()}"`;
      } else if (an === 'lang') {
        if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(val)) attrs += ` lang="${val}"`;
      } else if (
        ['width', 'height', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing'].includes(
          an,
        )
      ) {
        if (/^\d{1,4}%?$/.test(val)) attrs += ` ${an}="${val}"`;
      } else if (an === 'align') {
        if (['left', 'right', 'center', 'justify'].includes(val.toLowerCase()))
          attrs += ` align="${val.toLowerCase()}"`;
      } else attrs += ` ${an}="${escapeHtml(decodeEntities(val))}"`;
    }
    if (name === 'img' && !attrs.includes('src=')) continue; // an image without a safe https source is nothing
    if (name === 'a' && !attrs.includes('href=')) {
      // an anchor without a safe target is only its text
      stack.push('__skip_a');
      continue;
    }
    if (VOID.has(name)) out += `<${name}${attrs}>`;
    else {
      out += `<${name}${attrs}>`;
      stack.push(name);
    }
  }
  while (stack.length) {
    const t = stack.pop()!;
    if (t !== '__skip_a') out += `</${t}>`;
  }
  return out;
}
