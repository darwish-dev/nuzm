import type { Evidence, Level } from './types';

/** Hard bounds on everything derived from untrusted text. */
export const MAX_JSON_DEPTH = 40;
export const MAX_LINE = 400;

export const levelOf = (c: number): Level => (c >= 0.8 ? 'high' : c >= 0.5 ? 'medium' : 'low');
export const round = (n: number) => Math.round(n * 100) / 100;
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Printable, single-line, bounded: the only way text from a package reaches a manifest. */
/* eslint-disable no-control-regex -- control characters are exactly what is dropped */
const UNSAFE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */
export const safeText = (s: unknown, n = 200): string =>
  clip(
    String(s ?? '')
      .replace(UNSAFE, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    n,
  );
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const join = (a: string, b: string) => (a === '.' ? b : `${a}/${b}`);
/** Path of `p` relative to directory `root` (`.` = the package root); null when `p` is outside. */
export const rel = (root: string, p: string): string | null =>
  root === '.' ? p : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : null;

function depthOk(v: unknown, d = 0): boolean {
  if (d > MAX_JSON_DEPTH) return false;
  if (v && typeof v === 'object')
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (!depthOk(x, d + 1)) return false;
  return true;
}
/** JSON.parse with a depth guard. Returns null for anything that is not a plain object or array. */
export function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!v || typeof v !== 'object' || Array.isArray(v) || !depthOk(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}
/** tsconfig and similar files allow comments and trailing commas. A small tokenizer removes them without evaluating anything. */
export function parseJsonc(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  let out = '';
  let i = 0;
  const n = Math.min(text.length, 1_000_000);
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return parseJson(out.replace(/,\s*([}\]])/g, '$1'));
}
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown, n = 200): string | null =>
  typeof v === 'string' && v.trim() ? safeText(v, n) : null;
export const entries = (v: unknown): [string, unknown][] => Object.entries(obj(v));

/** 1-based line of the first occurrence of `needle` (bounded), or undefined. */
export function lineOf(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  if (i < 0 || i > 2_000_000) return undefined;
  let n = 1;
  for (let k = text.indexOf('\n'); k !== -1 && k < i; k = text.indexOf('\n', k + 1)) n++;
  return n;
}
/** Lines of a text, each capped: a minified or hostile line can never make a regex expensive. */
export function* lines(text: string, maxLines = 20_000): Generator<[number, string]> {
  let n = 0;
  let start = 0;
  while (start <= text.length && n < maxLines) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    n++;
    const l = text.slice(start, Math.min(end, start + MAX_LINE));
    yield [n, l.endsWith('\r') ? l.slice(0, -1) : l];
    start = end + 1;
  }
}

/** Minimal glob for workspace patterns: `*` matches inside one segment, `**` any number of segments. */
export function globToRegExp(pattern: string): RegExp {
  const segs = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  let re = '';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else
      re +=
        seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}
/** `^15.0.1`, `~1.2`, `>=3 <4`, `15.0.1` → the first concrete number found, as the DECLARED version. */
export const declaredVersion = (range: string | null): string | null => {
  if (!range) return null;
  const m = /(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)/.exec(range);
  return m ? m[1]! : null;
};
export const ev = (
  kind: Evidence['kind'],
  path: string,
  detail?: string,
  line?: number,
): Evidence => ({
  kind,
  path: clip(path, 300),
  ...(line ? { line } : {}),
  ...(detail ? { detail: safeText(detail, 120) } : {}),
});
export const sortEvidence = (e: Evidence[], cap = 8): Evidence[] => {
  const seen = new Set<string>();
  return e
    .filter((x) => {
      const k = `${x.kind}|${x.path}|${x.line ?? ''}|${x.detail ?? ''}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) =>
      a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : (a.line ?? 0) - (b.line ?? 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    )
    .slice(0, cap);
};
