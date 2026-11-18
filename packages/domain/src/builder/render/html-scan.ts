/**
 * A small, strict HTML tokenizer used by the validators (not a general browser parser). It understands quoted/unquoted attributes, comments, doctype and
 * raw-text elements (script, style, textarea, title) and reports malformed markup instead of guessing.
 */
export interface Attr {
  name: string;
  value: string | null;
}
export type Token =
  | {
      kind: 'start';
      name: string;
      attrs: Attr[];
      selfClosing: boolean;
      index: number;
      raw?: string;
    }
  | { kind: 'end'; name: string; index: number }
  | { kind: 'text'; text: string; index: number }
  | { kind: 'comment' | 'doctype'; text: string; index: number }
  | { kind: 'error'; message: string; index: number };

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
export const VOID = new Set([
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
const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);

export function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    if (html[i] !== '<') {
      const j = html.indexOf('<', i);
      const end = j === -1 ? n : j;
      out.push({ kind: 'text', text: html.slice(i, end), index: i });
      i = end;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const j = html.indexOf('-->', i + 4);
      if (j === -1) {
        out.push({ kind: 'error', message: 'unterminated comment', index: i });
        break;
      }
      out.push({ kind: 'comment', text: html.slice(i + 4, j), index: i });
      i = j + 3;
      continue;
    }
    if (html[i + 1] === '!') {
      const j = html.indexOf('>', i);
      if (j === -1) {
        out.push({ kind: 'error', message: 'unterminated declaration', index: i });
        break;
      }
      out.push({ kind: 'doctype', text: html.slice(i + 2, j), index: i });
      i = j + 1;
      continue;
    }
    if (html[i + 1] === '/' && isAlpha(html[i + 2])) {
      const j = html.indexOf('>', i);
      if (j === -1) {
        out.push({ kind: 'error', message: 'unterminated end tag', index: i });
        break;
      }
      const name =
        html
          .slice(i + 2, j)
          .trim()
          .split(/\s/)[0] ?? '';
      out.push({ kind: 'end', name: name.toLowerCase(), index: i });
      i = j + 1;
      continue;
    }
    if (!isAlpha(html[i + 1])) {
      out.push({ kind: 'error', message: 'stray "<" in text', index: i });
      i += 1;
      continue;
    }
    // start tag
    const start = i;
    let j = i + 1;
    while (j < n && !isSpace(html[j]) && html[j] !== '>' && html[j] !== '/') j++;
    const name = html.slice(i + 1, j).toLowerCase();
    const attrs: Attr[] = [];
    let selfClosing = false;
    let closed = false;
    while (j < n) {
      while (isSpace(html[j])) j++;
      const c = html[j];
      if (c === '>') {
        j++;
        closed = true;
        break;
      }
      if (c === '/') {
        if (html[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          closed = true;
          break;
        }
        j++;
        continue;
      }
      const ns = j;
      while (j < n && !isSpace(html[j]) && html[j] !== '=' && html[j] !== '>' && html[j] !== '/')
        j++;
      const an = html.slice(ns, j).toLowerCase();
      if (an === '') {
        j++; // lone '=' : skip to guarantee progress
        out.push({ kind: 'error', message: `malformed attribute in <${name}>`, index: start });
        continue;
      }
      if (/["'`<]/.test(an)) {
        out.push({ kind: 'error', message: `malformed attribute name in <${name}>`, index: start });
      }
      while (isSpace(html[j])) j++;
      let value: string | null = null;
      if (html[j] === '=') {
        j++;
        while (isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          if (e === -1) {
            out.push({
              kind: 'error',
              message: `unterminated attribute value in <${name}>`,
              index: start,
            });
            return out;
          }
          value = html.slice(j + 1, e);
          j = e + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(html[j]) && html[j] !== '>') j++;
          value = html.slice(vs, j);
          out.push({
            kind: 'error',
            message: `unquoted attribute value in <${name}>`,
            index: start,
          });
        }
      }
      attrs.push({ name: an, value });
    }
    if (!closed) {
      out.push({ kind: 'error', message: `unterminated <${name}> tag`, index: start });
      break;
    }
    const tok: Token = { kind: 'start', name, attrs, selfClosing, index: start };
    i = j;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closer = new RegExp(`</${name}[\\s>]`, 'i');
      const m = closer.exec(html.slice(i));
      if (!m) {
        out.push(tok);
        out.push({ kind: 'error', message: `unterminated <${name}>`, index: start });
        break;
      }
      tok.raw = html.slice(i, i + m.index);
      out.push(tok);
      out.push({ kind: 'end', name, index: i + m.index });
      const gt = html.indexOf('>', i + m.index);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    out.push(tok);
  }
  return out;
}

export const attrOf = (
  t: Extract<Token, { kind: 'start' }>,
  name: string,
): string | null | undefined => t.attrs.find((a) => a.name === name)?.value;
