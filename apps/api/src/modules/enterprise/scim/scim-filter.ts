/** SCIM (RFC 7644 §3.4.2.2) filter parser/evaluator: attribute ops eq ne co sw ew pr gt ge lt le, logical and/or/not, parentheses. */
export class ScimFilterError extends Error {}
type Node =
  | { t: 'cmp'; path: string; op: string; value?: string | number | boolean | null }
  | { t: 'and' | 'or'; l: Node; r: Node }
  | { t: 'not'; e: Node };

const TOKEN = /\s*(\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+)/y;
export function parseFilter(src: string): Node {
  if (src.length > 1000) throw new ScimFilterError('filter too long');
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < src.length && (m = TOKEN.exec(src))) {
    toks.push(m[1]!);
    pos = TOKEN.lastIndex;
  }
  if (src.slice(pos).trim()) throw new ScimFilterError('unparseable filter');
  let i = 0;
  const peek = () => toks[i]?.toLowerCase();
  const val = (s: string): string | number | boolean | null => {
    if (s.startsWith('"')) return JSON.parse(s) as string;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (!Number.isNaN(Number(s))) return Number(s);
    throw new ScimFilterError(`bad value ${s}`);
  };
  const primary = (): Node => {
    const t = toks[i++];
    if (t === undefined) throw new ScimFilterError('unexpected end');
    if (t === '(') {
      const e = or();
      if (toks[i++] !== ')') throw new ScimFilterError('missing )');
      return e;
    }
    if (t.toLowerCase() === 'not') {
      if (toks[i++] !== '(') throw new ScimFilterError('not needs (');
      const e = or();
      if (toks[i++] !== ')') throw new ScimFilterError('missing )');
      return { t: 'not', e };
    }
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(t)) throw new ScimFilterError(`bad attribute ${t}`);
    const op = toks[i++]?.toLowerCase();
    if (op === 'pr') return { t: 'cmp', path: t.toLowerCase(), op };
    if (!op || !['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le'].includes(op))
      throw new ScimFilterError(`bad operator ${op}`);
    const v = toks[i++];
    if (v === undefined) throw new ScimFilterError('missing value');
    return { t: 'cmp', path: t.toLowerCase(), op, value: val(v) };
  };
  const and = (): Node => {
    let l = primary();
    while (peek() === 'and') {
      i++;
      l = { t: 'and', l, r: primary() };
    }
    return l;
  };
  const or = (): Node => {
    let l = and();
    while (peek() === 'or') {
      i++;
      l = { t: 'or', l, r: and() };
    }
    return l;
  };
  const n = or();
  if (i < toks.length) throw new ScimFilterError('trailing input');
  return n;
}

export type Attrs = Record<string, unknown>;
export function evaluate(n: Node, a: Attrs): boolean {
  switch (n.t) {
    case 'and':
      return evaluate(n.l, a) && evaluate(n.r, a);
    case 'or':
      return evaluate(n.l, a) || evaluate(n.r, a);
    case 'not':
      return !evaluate(n.e, a);
    case 'cmp': {
      const have = a[n.path];
      if (n.op === 'pr') return have !== undefined && have !== null && have !== '';
      if (have === undefined || have === null) return n.op === 'ne';
      const s = typeof have === 'string' ? have.toLowerCase() : have;
      const w = typeof n.value === 'string' ? n.value.toLowerCase() : n.value;
      switch (n.op) {
        case 'eq':
          return s === w;
        case 'ne':
          return s !== w;
        case 'co':
          return typeof s === 'string' && typeof w === 'string' && s.includes(w);
        case 'sw':
          return typeof s === 'string' && typeof w === 'string' && s.startsWith(w);
        case 'ew':
          return typeof s === 'string' && typeof w === 'string' && s.endsWith(w);
        case 'gt':
          return (s as string | number) > (w as string | number);
        case 'ge':
          return (s as string | number) >= (w as string | number);
        case 'lt':
          return (s as string | number) < (w as string | number);
        case 'le':
          return (s as string | number) <= (w as string | number);
      }
      return false;
    }
  }
}
