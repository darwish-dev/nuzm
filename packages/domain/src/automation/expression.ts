/**
 * M11 S51: the workflow expression language. RESTRICTED and SIDE-EFFECT-FREE by construction: it is a hand-written tokenizer, a
 * recursive-descent parser and a tree-walking interpreter. There is NO `eval`, no `Function`, no property assignment, no function
 * definitions, no access to the host environment: an expression can only read the values it is given (`input`, `steps`, `item`, ...)
 * and call the fixed, pure functions below. Resource limits (length, depth, evaluation steps, result size) make every expression
 * terminate quickly. Paths that could reach the prototype chain (`__proto__`, `constructor`, `prototype`) are refused.
 */
export class ExpressionError extends Error {
  constructor(
    readonly code: 'syntax' | 'limit' | 'type' | 'unknown_function' | 'forbidden_path',
    message: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export const EXPRESSION_LIMITS = {
  maxLength: 1000,
  maxDepth: 32,
  maxSteps: 10_000,
  maxStringLength: 100_000,
  maxArrayLength: 10_000,
} as const;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Node =
  | { t: 'lit'; v: Json }
  | { t: 'path'; root: string; parts: (string | Node)[] }
  | { t: 'un'; op: '!' | '-'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'arr'; items: Node[] };

interface Tok {
  k: 'num' | 'str' | 'id' | 'op' | 'eof';
  v: string;
  pos: number;
}

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', '[', ']', ',', '.'];
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      out.push({ k: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') {
          const n = src[j + 1];
          if (n === undefined) throw new ExpressionError('syntax', 'unterminated string');
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else s += src[j++];
      }
      if (src[j] !== ch) throw new ExpressionError('syntax', 'unterminated string');
      out.push({ k: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError('syntax', `unexpected character '${ch}' at ${i}`);
    out.push({ k: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ k: 'eof', v: '', pos: src.length });
  return out;
}

class Parser {
  private p = 0;
  private depth = 0;
  constructor(private readonly toks: Tok[]) {}
  private get cur() {
    return this.toks[this.p]!;
  }
  private eat(v: string) {
    if (this.cur.k === 'op' && this.cur.v === v) {
      this.p++;
      return true;
    }
    return false;
  }
  private expect(v: string) {
    if (!this.eat(v)) throw new ExpressionError('syntax', `expected '${v}' at ${this.cur.pos}`);
  }
  private enter() {
    if (++this.depth > EXPRESSION_LIMITS.maxDepth) throw new ExpressionError('limit', 'expression is nested too deeply');
  }
  parse(): Node {
    const n = this.ternary();
    if (this.cur.k !== 'eof') throw new ExpressionError('syntax', `unexpected '${this.cur.v}' at ${this.cur.pos}`);
    return n;
  }
  private ternary(): Node {
    this.enter();
    const c = this.binary(0);
    let n = c;
    if (this.eat('?')) {
      const a = this.ternary();
      this.expect(':');
      const b = this.ternary();
      n = { t: 'cond', c, a, b };
    }
    this.depth--;
    return n;
  }
  private static readonly LEVELS: string[][] = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
  private binary(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const op = Parser.LEVELS[level]!.find((o) => this.cur.k === 'op' && this.cur.v === o);
      if (!op) return a;
      this.p++;
      a = { t: 'bin', op, a, b: this.binary(level + 1) };
    }
  }
  private unary(): Node {
    this.enter();
    let n: Node;
    if (this.eat('!')) n = { t: 'un', op: '!', a: this.unary() };
    else if (this.eat('-')) n = { t: 'un', op: '-', a: this.unary() };
    else n = this.primary();
    this.depth--;
    return n;
  }
  private primary(): Node {
    const t = this.cur;
    if (t.k === 'num') {
      this.p++;
      return { t: 'lit', v: Number(t.v) };
    }
    if (t.k === 'str') {
      this.p++;
      return { t: 'lit', v: t.v };
    }
    if (this.eat('(')) {
      const n = this.ternary();
      this.expect(')');
      return n;
    }
    if (this.eat('[')) {
      const items: Node[] = [];
      if (!this.eat(']')) {
        do items.push(this.ternary());
        while (this.eat(','));
        this.expect(']');
      }
      return { t: 'arr', items };
    }
    if (t.k === 'id') {
      this.p++;
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (this.cur.k === 'op' && this.cur.v === '(') {
        this.p++;
        const args: Node[] = [];
        if (!this.eat(')')) {
          do args.push(this.ternary());
          while (this.eat(','));
          this.expect(')');
        }
        return { t: 'call', fn: t.v, args };
      }
      if (FORBIDDEN.has(t.v)) throw new ExpressionError('forbidden_path', `'${t.v}' is not allowed`);
      const parts: (string | Node)[] = [];
      for (;;) {
        if (this.eat('.')) {
          const id = this.cur;
          if (id.k !== 'id') throw new ExpressionError('syntax', `expected a name after '.' at ${id.pos}`);
          if (FORBIDDEN.has(id.v)) throw new ExpressionError('forbidden_path', `'${id.v}' is not allowed`);
          this.p++;
          parts.push(id.v);
        } else if (this.eat('[')) {
          const idx = this.ternary();
          this.expect(']');
          parts.push(idx);
        } else break;
      }
      return { t: 'path', root: t.v, parts };
    }
    throw new ExpressionError('syntax', `unexpected '${t.v || 'end of expression'}' at ${t.pos}`);
  }
}

export type CompiledExpression = { readonly source: string; readonly ast: unknown; readonly roots: readonly string[] };

/** Parse once (also used by the workflow validator: a definition with an unparsable expression is rejected at publish). */
export function compileExpression(source: string): CompiledExpression {
  if (typeof source !== 'string') throw new ExpressionError('type', 'an expression must be a string');
  if (source.length > EXPRESSION_LIMITS.maxLength) throw new ExpressionError('limit', 'expression is too long');
  const ast = new Parser(tokenize(source)).parse();
  const roots = new Set<string>();
  const walk = (n: Node) => {
    switch (n.t) {
      case 'path':
        roots.add(n.root);
        n.parts.forEach((p) => typeof p !== 'string' && walk(p));
        break;
      case 'un':
        walk(n.a);
        break;
      case 'bin':
        walk(n.a);
        walk(n.b);
        break;
      case 'cond':
        walk(n.c);
        walk(n.a);
        walk(n.b);
        break;
      case 'call': {
        if (!(n.fn in FUNCTIONS)) throw new ExpressionError('unknown_function', `unknown function '${n.fn}'`);
        n.args.forEach(walk);
        break;
      }
      case 'arr':
        n.items.forEach(walk);
        break;
      default:
    }
  };
  walk(ast);
  return { source, ast, roots: [...roots] };
}

type Fn = (...a: Json[]) => Json;
const str = (v: Json, f: string): string => {
  if (typeof v !== 'string') throw new ExpressionError('type', `${f}() needs a string`);
  return v;
};
const num = (v: Json, f: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ExpressionError('type', `${f}() needs a number`);
  return v;
};
const arr = (v: Json, f: string): Json[] => {
  if (!Array.isArray(v)) throw new ExpressionError('type', `${f}() needs an array`);
  return v;
};
/** The complete function library. Every function is pure and total over its declared types. */
const FUNCTIONS: Record<string, Fn> = Object.assign(Object.create(null) as Record<string, Fn>, {
  len: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0),
  lower: (v) => str(v!, 'lower').toLowerCase(),
  upper: (v) => str(v!, 'upper').toUpperCase(),
  trim: (v) => str(v!, 'trim').trim(),
  concat: (...a) => a.map((x) => (x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(''),
  contains: (h, n) => (typeof h === 'string' ? h.includes(str(n!, 'contains')) : arr(h!, 'contains').some((x) => JSON.stringify(x) === JSON.stringify(n))),
  startsWith: (s, p) => str(s!, 'startsWith').startsWith(str(p!, 'startsWith')),
  endsWith: (s, p) => str(s!, 'endsWith').endsWith(str(p!, 'endsWith')),
  replace: (s, a, b) => str(s!, 'replace').split(str(a!, 'replace')).join(str(b!, 'replace')),
  split: (s, sep) => str(s!, 'split').split(str(sep!, 'split')),
  join: (a, sep) => arr(a!, 'join').map((x) => String(x)).join(str(sep!, 'join')),
  coalesce: (...a) => a.find((x) => x !== null && x !== undefined) ?? null,
  round: (v) => Math.round(num(v!, 'round')),
  floor: (v) => Math.floor(num(v!, 'floor')),
  ceil: (v) => Math.ceil(num(v!, 'ceil')),
  abs: (v) => Math.abs(num(v!, 'abs')),
  min: (...a) => Math.min(...a.map((x) => num(x, 'min'))),
  max: (...a) => Math.max(...a.map((x) => num(x, 'max'))),
  toString: (v: Json) => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  toNumber: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  isNull: (v) => v === null || v === undefined,
  keys: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []),
  first: (a) => arr(a!, 'first')[0] ?? null,
  last: (a) => {
    const x = arr(a!, 'last');
    return x[x.length - 1] ?? null;
  },
  slice: (a, from, to) => arr(a!, 'slice').slice(num(from!, 'slice'), to === undefined ? undefined : num(to, 'slice')),
} satisfies Record<string, Fn>);
export const EXPRESSION_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS);

const get = (base: Json | undefined, key: string | number): Json => {
  if (base === null || base === undefined) return null;
  if (Array.isArray(base)) {
    return typeof key === 'number' && Number.isInteger(key) && key >= 0 ? (base[key] ?? null) : null;
  }
  if (typeof base === 'object' && typeof key === 'string') {
    if (FORBIDDEN.has(key)) throw new ExpressionError('forbidden_path', `'${key}' is not allowed`);
    // own data properties only: nothing is ever read from the prototype chain
    return Object.prototype.hasOwnProperty.call(base, key) ? (base[key] as Json) : null;
  }
  return null;
};

/** Evaluate against `scope` (a plain JSON object). Throws ExpressionError; never throws anything else. */
export function evaluateExpression(compiled: CompiledExpression, scope: Record<string, unknown>): Json {
  let steps = 0;
  const tick = () => {
    if (++steps > EXPRESSION_LIMITS.maxSteps) throw new ExpressionError('limit', 'expression took too many steps');
  };
  const truthy = (v: Json) => v !== null && v !== false && v !== 0 && v !== '';
  const ev = (n: Node): Json => {
    tick();
    switch (n.t) {
      case 'lit':
        return n.v;
      case 'arr': {
        if (n.items.length > EXPRESSION_LIMITS.maxArrayLength) throw new ExpressionError('limit', 'array is too large');
        return n.items.map(ev);
      }
      case 'path': {
        let v: Json = Object.prototype.hasOwnProperty.call(scope, n.root) ? (scope[n.root] as Json) : null;
        for (const p of n.parts) v = get(v, typeof p === 'string' ? p : (ev(p) as string | number));
        return v;
      }
      case 'un': {
        const a = ev(n.a);
        return n.op === '!' ? !truthy(a) : -num(a, 'unary minus');
      }
      case 'cond':
        return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
      case 'call':
        return FUNCTIONS[n.fn]!(...n.args.map(ev));
      case 'bin': {
        if (n.op === '&&') {
          const a = ev(n.a);
          return truthy(a) ? ev(n.b) : a;
        }
        if (n.op === '||') {
          const a = ev(n.a);
          return truthy(a) ? a : ev(n.b);
        }
        const a = ev(n.a);
        const b = ev(n.b);
        switch (n.op) {
          case '==':
            return JSON.stringify(a) === JSON.stringify(b);
          case '!=':
            return JSON.stringify(a) !== JSON.stringify(b);
          case '+':
            if (typeof a === 'string' || typeof b === 'string') {
              const s = `${String(a ?? '')}${String(b ?? '')}`;
              if (s.length > EXPRESSION_LIMITS.maxStringLength) throw new ExpressionError('limit', 'string is too long');
              return s;
            }
            return num(a, '+') + num(b, '+');
          case '-':
            return num(a, '-') - num(b, '-');
          case '*':
            return num(a, '*') * num(b, '*');
          case '/': {
            const d = num(b, '/');
            if (d === 0) throw new ExpressionError('type', 'division by zero');
            return num(a, '/') / d;
          }
          case '%': {
            const d = num(b, '%');
            if (d === 0) throw new ExpressionError('type', 'division by zero');
            return num(a, '%') % d;
          }
          case '<':
          case '<=':
          case '>':
          case '>=': {
            const bothStr = typeof a === 'string' && typeof b === 'string';
            const x = bothStr ? (a as string) : num(a, n.op);
            const y = bothStr ? (b as string) : num(b, n.op);
            return n.op === '<' ? x < y : n.op === '<=' ? x <= y : n.op === '>' ? x > y : x >= y;
          }
          default:
            throw new ExpressionError('syntax', `unknown operator ${n.op}`);
        }
      }
    }
  };
  return ev(compiled.ast as Node);
}

/** Convenience: compile + evaluate. */
export const evalExpression = (source: string, scope: Record<string, unknown>): Json =>
  evaluateExpression(compileExpression(source), scope);

/**
 * String templates: `"Hello {{ input.name }}"`. Every `{{ ... }}` is an expression. A template that is exactly one placeholder returns the
 * raw value (any JSON type); otherwise the pieces are stringified and joined.
 */
export function renderTemplate(template: string, scope: Record<string, unknown>): Json {
  const re = /\{\{([\s\S]*?)\}\}/g;
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(template);
  if (whole && !whole[1]!.includes('}}')) return evalExpression(whole[1]!.trim(), scope);
  let out = '';
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    out += template.slice(last, m.index);
    const v = evalExpression(m[1]!.trim(), scope);
    out += v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    last = m.index + m[0].length;
    if (out.length > EXPRESSION_LIMITS.maxStringLength) throw new ExpressionError('limit', 'template result is too long');
  }
  return out + template.slice(last);
}
export function templateExpressions(template: string): string[] {
  return [...template.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!.trim());
}
