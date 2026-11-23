import { longestLine } from '../components/dart';
import {
  DESIGN_LIMITS as L,
  categoryOf,
  cleanName,
  cleanValue,
  emptyDesignFacts,
  type DesignFileFacts,
  type SchemeFact,
  type TokenFact,
  type TokenOrigin,
} from './types';

/**
 * Static reader of CSS, SCSS and Less (S-K4): custom properties (with the mode they apply to), Tailwind v4 `@theme`, SCSS and Less variable declarations, and how custom
 * properties are used. It is NOT a stylesheet parser and compiles nothing: nothing is imported, evaluated or resolved from disk, `@import` is only noted. One linear pass over
 * the text; strings, parentheses and `#{}` interpolation are respected so a `;` or `}` inside them never splits a declaration. Anything it cannot read with certainty is absent.
 */
const MAX_DEPTH = 64;

/** Replaces comments with spaces (newlines kept, so line numbers stay true). `//` comments only for SCSS/Less, and never inside strings or url(). */
function stripComments(src: string, lineComments: boolean): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  let quote = '';
  let paren = 0;
  while (i < n) {
    const c = src[i]!;
    if (quote) {
      out.push(c);
      if (c === '\\' && i + 1 < n) out.push(src[++i]!);
      else if (c === quote) quote = '';
      else if (c === '\n') quote = ''; // an unterminated string ends at the line end
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out.push(c);
      i++;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) out.push(src[k] === '\n' ? '\n' : ' ');
      i = stop;
      continue;
    }
    if (lineComments && c === '/' && src[i + 1] === '/' && paren === 0 && src[i - 1] !== ':') {
      while (i < n && src[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

type ModeCtx = { mode: string; scheme: SchemeFact['mode'] | null; scoped: boolean };
const MARK = '(?:data-(?:bs-)?(?:theme|mode|color-scheme|color-mode|palette|skin))';
const DARK = new RegExp(
  `\\.(?:dark(?:-mode|-theme)?|theme-dark|is-dark|night)(?![\\w-])|\\[${MARK}\\s*[~|^$*]?=\\s*["']?dark["']?\\]`,
  'i',
);
const LIGHT = new RegExp(
  `\\.(?:light(?:-mode|-theme)?|theme-light|day)(?![\\w-])|\\[${MARK}\\s*[~|^$*]?=\\s*["']?light["']?\\]`,
  'i',
);
const NAMED_SCHEME = new RegExp(
  `\\[${MARK}\\s*[~|^$*]?=\\s*["']?([\\w-]{1,30})["']?\\]|\\.((?:theme|skin|palette)[-_]{1,2}[\\w]{1,30})(?![\\w-])`,
  'i',
);
const ROOTISH = /^(?::root|html|body|\*|:host|)$/i;

/** The marker must apply to the root itself (`.dark`, `:root.dark`, `html[data-theme=dark]`); `.dark .card` styles a component and is scoped. */
const rootMarker = (part: string, re: RegExp): RegExpExecArray | null => {
  const m = re.exec(part);
  if (!m) return null;
  const rest = (part.slice(0, m.index) + part.slice(m.index + m[0].length)).trim();
  return ROOTISH.test(rest) ? m : null;
};

function modeOfSelector(sel: string): ModeCtx {
  const parts = sel.split(',').map((s) => s.trim());
  if (parts.some((p) => rootMarker(p, DARK)))
    return { mode: 'dark', scheme: 'dark', scoped: false };
  if (parts.some((p) => rootMarker(p, LIGHT)))
    return { mode: 'light', scheme: 'light', scoped: false };
  for (const p of parts) {
    const m = rootMarker(p, NAMED_SCHEME);
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? '').toLowerCase().replace(/[^\w-]/g, '');
    if (raw && raw !== 'dark' && raw !== 'light')
      return {
        mode: (/^(theme|skin|palette)/.test(raw) ? raw : `theme-${raw}`).slice(0, 40),
        scheme: 'scheme',
        scoped: false,
      };
  }
  if (
    parts.some((p) => ROOTISH.test(p) && p !== '') ||
    parts.some((p) => /^(?::root|html|body)$/i.test(p))
  )
    return { mode: 'base', scheme: null, scoped: false };
  return { mode: 'scoped', scheme: null, scoped: true };
}

interface Block {
  prelude: string;
  line: number;
  /** The mode this block sets for the declarations inside it (null: inherit from the parent). */
  ctx: ModeCtx | null;
  theme: boolean;
}

export function analyzeCss(src: string, path: string): DesignFileFacts {
  const f = emptyDesignFacts('css');
  if (longestLine(src) > L.maxLine) return emptyDesignFacts('css', 'minified');
  if (src.includes('\u0000')) return emptyDesignFacts('css', 'parse_error');
  const lower = path.toLowerCase();
  const scss = /\.(scss|sass)$/.test(lower);
  const less = lower.endsWith('.less');
  const text = stripComments(src, scss || less);

  const tokens = new Map<string, TokenFact>();
  const usage = new Map<string, { name: string; bg: number; fg: number; border: number }>();
  const schemes = new Map<string, SchemeFact>();
  const stack: Block[] = [];
  let buf = '';
  let bufLine = 1;
  let line = 1;
  let quote = '';
  let paren = 0;
  let interp = 0;

  const ctxNow = (): ModeCtx => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i]!.ctx;
      if (c) return c;
    }
    return { mode: 'base', scheme: null, scoped: false };
  };
  const inTheme = () => stack.some((b) => b.theme);

  const addToken = (
    name: string,
    value: string,
    at: number,
    origin: TokenOrigin,
    mode: string,
    scheme: SchemeFact['mode'] | null,
    selector: string,
  ) => {
    const n = cleanName(name);
    const v = cleanValue(value.replace(/\s*!(important|default|global)\s*$/gi, ''));
    if (!n || v === null) {
      if (n) f.truncated = true;
      return;
    }
    const key = `${mode}\u0000${n}`;
    if (!tokens.has(key) && tokens.size >= L.maxTokensPerFile) {
      f.truncated = true;
      return;
    }
    tokens.set(key, {
      category: categoryOf(n.replace(/^(--|\$|@)/, ''), v),
      name: n,
      value: v,
      mode,
      line: at,
      origin,
      dynamic: false,
    });
    if (scheme && schemes.size < L.maxSchemesPerFile) {
      const sk = `${mode}`;
      if (!schemes.has(sk))
        schemes.set(sk, { name: mode, selector: selector.slice(0, 120), line: at, mode: scheme });
    }
  };

  const useOf = (prop: string, value: string) => {
    const p = prop.toLowerCase();
    const kind = /^(background|background-color|background-image|fill)$/.test(p)
      ? 'bg'
      : /^(color|caret-color|stroke|text-decoration-color|accent-color)$/.test(p)
        ? 'fg'
        : /^(border|border-[a-z-]*color|outline|outline-color|box-shadow)$/.test(p)
          ? 'border'
          : null;
    if (!kind) return;
    const re = /var\(\s*(--[\w-]{1,100})/g;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(value)) && guard++ < 50) {
      const name = m[1]!;
      let u = usage.get(name);
      if (!u) {
        if (usage.size >= L.maxUsagePerFile) continue;
        u = { name, bg: 0, fg: 0, border: 0 };
        usage.set(name, u);
      }
      u[kind]++;
    }
  };

  const declaration = (raw: string, at: number) => {
    const s = raw.trim();
    if (!s) return;
    if (s.startsWith('@')) {
      const at2 = /^@([\w-]+)\s*(.*)$/s.exec(s);
      const kw = at2?.[1]?.toLowerCase() ?? '';
      if (kw === 'tailwind' || kw === 'apply') f.traits.tailwind = true;
      if (kw === 'import' && /tailwindcss/i.test(s)) f.traits.tailwind = true;
      // Less variable: `@brand: #fff`
      const lv = /^@([\w-]{1,100})\s*:\s*(.+)$/s.exec(s);
      if (less && lv) {
        const c = ctxNow();
        addToken(`@${lv[1]}`, lv[2]!, at, 'less-var', c.mode, c.scheme, '');
      }
      return;
    }
    // split at the first top-level colon
    let depth = 0;
    let colon = -1;
    let q = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === ':' && depth === 0) {
        colon = i;
        break;
      }
    }
    if (colon <= 0) return;
    const prop = s.slice(0, colon).trim();
    const value = s.slice(colon + 1).trim();
    if (prop.startsWith('--')) {
      const c = ctxNow();
      const theme = inTheme();
      addToken(
        prop,
        value,
        at,
        theme ? 'tailwind-theme' : 'css-var',
        theme ? 'base' : c.mode,
        theme ? null : c.scheme,
        stack.map((b) => b.prelude).join(' '),
      );
      return;
    }
    if (scss && prop.startsWith('$')) {
      const c = ctxNow();
      addToken(prop, value, at, 'scss-var', c.mode, c.scheme, '');
      return;
    }
    if (/^direction$/i.test(prop) && /^rtl\b/i.test(value)) f.traits.rtl = true;
    if (/^(margin|padding|border|inset)(-(inline|block))(-(start|end))?(-[a-z]+)?$/i.test(prop))
      f.traits.logicalProps = true;
    useOf(prop, value);
  };

  const open = (prelude: string, at: number) => {
    const p = prelude.trim().replace(/\s+/g, ' ');
    let ctx: ModeCtx | null = null;
    let theme = false;
    if (/^@theme\b/i.test(p)) {
      theme = true;
      f.traits.tailwind = true;
    } else if (/^@media\b/i.test(p)) {
      if (/prefers-color-scheme\s*:\s*dark/i.test(p)) {
        ctx = { mode: 'dark', scheme: 'dark', scoped: false };
        f.traits.darkMedia = true;
      } else if (/prefers-color-scheme\s*:\s*light/i.test(p)) {
        ctx = { mode: 'light', scheme: 'light', scoped: false };
      }
    } else if (/^@(layer|supports|container|scope|document|starting-style)\b/i.test(p)) {
      ctx = null;
    } else if (
      /^@(keyframes|font-face|property|page|counter-style|font-feature-values)\b/i.test(p)
    ) {
      ctx = { mode: 'scoped', scheme: null, scoped: true };
    } else if (p.startsWith('@')) {
      ctx = null;
    } else {
      const parent = stack.length ? ctxNow() : null;
      const own = modeOfSelector(p);
      // a rule inside `@media (prefers-color-scheme: dark)` keeps the dark mode when its own selector is the root
      ctx = parent && parent.mode !== 'base' && parent.scheme && own.mode === 'base' ? parent : own;
      if (/\[dir\s*=\s*["']?rtl|:dir\(\s*rtl\s*\)|\.rtl\b/i.test(p)) f.traits.rtl = true;
    }
    if (stack.length < MAX_DEPTH) stack.push({ prelude: p, line: at, ctx, theme });
    else f.truncated = true;
  };

  const flushBuf = () => {
    const raw = buf;
    buf = '';
    declaration(raw, bufLine);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') line++;
    if (!buf.trim()) bufLine = line;
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < text.length) buf += text[++i]!;
      else if (c === quote || c === '\n') quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '#' && text[i + 1] === '{') {
      interp++;
      buf += '#{';
      i++;
      continue;
    }
    if (interp > 0) {
      buf += c;
      if (c === '{') interp++;
      else if (c === '}') interp--;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    if (paren > 0) {
      buf += c;
      continue;
    }
    if (c === '{') {
      open(buf, bufLine);
      buf = '';
    } else if (c === '}') {
      if (buf.trim()) flushBuf();
      stack.pop();
      buf = '';
    } else if (c === ';') flushBuf();
    else buf += c;
    if (f.truncated && tokens.size >= L.maxTokensPerFile && stack.length > MAX_DEPTH) break;
  }
  if (buf.trim()) flushBuf();

  f.tokens = [...tokens.values()].sort(
    (a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  f.usage = [...usage.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  f.schemes = [...schemes.values()].sort((a, b) => a.line - b.line);
  return f;
}
