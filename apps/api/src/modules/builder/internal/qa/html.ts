/**
 * A small, lenient HTML reader for the QA gates: text in, an element tree out. It is NOT a browser parser (axe runs on jsdom's real one); it exists so the gates that
 * must run everywhere (CLI, unit tests, the repair loop) need no DOM library. It understands raw-text elements, void elements, comments, quoted/unquoted attributes
 * and recovers from a stray end tag by closing up to the matching open element.
 */
export interface El {
  tag: string;
  attrs: Record<string, string | null>;
  children: (El | string)[];
  parent: El | null;
  /** offset of the start tag in the source, for messages */
  index: number;
}
export interface ParsedHtml {
  root: El;
  hasDoctype: boolean;
  /** structural problems found while reading (unterminated constructs, unmatched end tags) */
  errors: string[];
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

export function parseHtml(html: string): ParsedHtml {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null, index: 0 };
  const errors: string[] = [];
  let hasDoctype = false;
  let cur = root;
  const n = html.length;
  let i = 0;
  const text = (s: string) => {
    if (s !== '') cur.children.push(s);
  };
  while (i < n) {
    if (html[i] !== '<') {
      const j = html.indexOf('<', i);
      const end = j === -1 ? n : j;
      text(html.slice(i, end));
      i = end;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const j = html.indexOf('-->', i + 4);
      if (j === -1) {
        errors.push('unterminated comment');
        break;
      }
      i = j + 3;
      continue;
    }
    if (html[i + 1] === '!') {
      const j = html.indexOf('>', i);
      if (j === -1) {
        errors.push('unterminated declaration');
        break;
      }
      if (/^<!doctype\s+html/i.test(html.slice(i, j + 1))) hasDoctype = true;
      i = j + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const j = html.indexOf('>', i);
      if (j === -1) {
        errors.push('unterminated end tag');
        break;
      }
      const name = html
        .slice(i + 2, j)
        .trim()
        .toLowerCase();
      let p: El | null = cur;
      while (p && p.tag !== name) p = p.parent;
      if (p && p.parent) cur = p.parent;
      else errors.push(`unmatched </${name}>`);
      i = j + 1;
      continue;
    }
    if (!/[a-z]/i.test(html[i + 1] ?? '')) {
      text('<');
      i++;
      continue;
    }
    // start tag
    let j = i + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;
    const tag = html.slice(i + 1, j).toLowerCase();
    const attrs: Record<string, string | null> = {};
    let selfClosing = false;
    let closed = false;
    while (j < n) {
      while (j < n && isSpace(html[j])) j++;
      if (html[j] === '>') {
        j++;
        closed = true;
        break;
      }
      if (html[j] === '/') {
        selfClosing = html[j + 1] === '>';
        j++;
        continue;
      }
      let k = j;
      while (k < n && !isSpace(html[k]) && html[k] !== '=' && html[k] !== '>' && html[k] !== '/')
        k++;
      if (k === j) {
        j++;
        continue;
      }
      const name = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && isSpace(html[j])) j++;
      let value: string | null = null;
      if (html[j] === '=') {
        j++;
        while (j < n && isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          if (e === -1) {
            errors.push(`unterminated attribute value in <${tag}>`);
            j = n;
            break;
          }
          value = html.slice(j + 1, e);
          j = e + 1;
        } else {
          let e = j;
          while (e < n && !isSpace(html[e]) && html[e] !== '>') e++;
          value = html.slice(j, e);
          j = e;
        }
      }
      if (!(name in attrs)) attrs[name] = value === null ? null : decodeEntities(value);
    }
    if (!closed) {
      errors.push(`unterminated <${tag}>`);
      break;
    }
    const el: El = { tag, attrs, children: [], parent: cur, index: i };
    cur.children.push(el);
    i = j;
    if (VOID.has(tag) || selfClosing) continue;
    if (RAW.has(tag)) {
      const re = new RegExp(`</${tag}\\s*>`, 'i');
      const m = re.exec(html.slice(i));
      const end = m ? i + m.index : n;
      if (!m) errors.push(`unterminated <${tag}>`);
      const body = html.slice(i, end);
      if (body !== '') el.children.push(body);
      i = m ? end + m[0].length : n;
      continue;
    }
    cur = el;
  }
  return { root, hasDoctype, errors };
}

export function walk(el: El, fn: (e: El) => void): void {
  for (const c of el.children)
    if (typeof c !== 'string') {
      fn(c);
      walk(c, fn);
    }
}
export function findAll(el: El, pred: (e: El) => boolean): El[] {
  const out: El[] = [];
  walk(el, (e) => {
    if (pred(e)) out.push(e);
  });
  return out;
}
export const byTag = (el: El, tag: string): El[] => findAll(el, (e) => e.tag === tag);
/** Visible-ish text of an element (script/style/template excluded, entities decoded, whitespace collapsed). */
export function textOf(el: El): string {
  let out = '';
  const rec = (e: El) => {
    for (const c of e.children) {
      if (typeof c === 'string') out += `${c} `;
      else if (!['script', 'style', 'template'].includes(c.tag)) rec(c);
    }
  };
  rec(el);
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}
export const attr = (e: El, name: string): string | undefined => {
  const v = e.attrs[name];
  return v === undefined ? undefined : (v ?? '');
};
export function line(html: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < html.length; i++) if (html[i] === '\n') n++;
  return n;
}
