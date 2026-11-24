import { scanForSecrets } from '../secret-scan';
import type { DimensionScores, GoldenTask, RunOutcome } from './types';

/**
 * Deterministic static evaluation of what a proposal CHANGED, in four dimensions: functional correctness (the task's checks), code quality, security and UI quality. No model,
 * no network, no clock: a pure function of the changed files. A dimension that does not apply to the changed files is `null`, never a free 100. The rules and weights are
 * PROPOSED (they are part of the thresholds the owner accepts); each rule has an id so a report can say exactly what was found.
 */
export interface Finding {
  dimension: 'codeQuality' | 'security' | 'uiQuality';
  rule: string;
  path: string;
  /** points taken off */
  penalty: number;
}
export interface DimensionResult {
  scores: DimensionScores;
  findings: Finding[];
}

const ext = (p: string) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'dart', 'py', 'kt', 'swift']);
const UI_EXT = new Set(['html', 'htm', 'tsx', 'jsx', 'css', 'scss', 'dart']);
const SERVER_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'dart',
  'sql',
  'html',
  'yaml',
  'yml',
  'sh',
]);

interface Rule {
  id: string;
  penalty: number;
  /** true when the rule fires for this file */
  hit: (content: string, path: string, task: GoldenTask) => boolean;
}

const lines = (c: string) => c.split('\n');
const stripLineComment = (l: string) => l.replace(/\/\/.*$/, '');

const QUALITY_RULES: Rule[] = [
  {
    id: 'Q01-any',
    penalty: 20,
    hit: (c, p) => ['ts', 'tsx'].includes(ext(p)) && /(:\s*any\b|\bas any\b|<any>)/.test(c),
  },
  {
    id: 'Q02-console',
    penalty: 10,
    hit: (c, p) => ext(p) !== 'dart' && /\bconsole\.(log|debug)\(/.test(c),
  },
  { id: 'Q03-todo', penalty: 10, hit: (c) => /\b(TODO|FIXME|XXX)\b/.test(c) },
  {
    id: 'Q04-long-line',
    penalty: 5,
    hit: (c, p) => CODE_EXT.has(ext(p)) && lines(c).some((l) => l.length > 200),
  },
  { id: 'Q05-debugger', penalty: 20, hit: (c) => /\bdebugger\s*;/.test(c) },
  {
    id: 'Q06-ts-ignore',
    penalty: 10,
    hit: (c) => /@ts-(ignore|nocheck)|eslint-disable(?!-next-line [\w/@-]+ -- )/.test(c),
  },
  { id: 'Q07-no-final-newline', penalty: 5, hit: (c) => c.length > 0 && !c.endsWith('\n') },
  { id: 'Q08-empty-catch', penalty: 15, hit: (c) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(c) },
  { id: 'Q09-dart-print', penalty: 10, hit: (c, p) => ext(p) === 'dart' && /^\s*print\(/m.test(c) },
  {
    id: 'Q10-var',
    penalty: 5,
    hit: (c, p) => ['ts', 'tsx', 'js', 'jsx'].includes(ext(p)) && /^\s*var\s/m.test(c),
  },
];

const HARDCODED = /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i;
const SECURITY_RULES: Rule[] = [
  { id: 'S01-secret', penalty: 100, hit: (c) => scanForSecrets(c).length > 0 },
  {
    id: 'S02-eval',
    penalty: 40,
    hit: (c, p) => CODE_EXT.has(ext(p)) && /(\beval\(|new Function\()/.test(c),
  },
  {
    id: 'S03-inner-html',
    penalty: 30,
    hit: (c) => /(\.innerHTML\s*=|dangerouslySetInnerHTML)/.test(c),
  },
  {
    id: 'S04-sql-concat',
    penalty: 40,
    hit: (c, p) =>
      ext(p) !== 'sql' &&
      lines(c).some(
        (l) =>
          /\b(select\s.+\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(l) &&
          /(\+\s*[\w'"(]|\$\{)/.test(stripLineComment(l)),
      ),
  },
  {
    id: 'S05-weak-hash',
    penalty: 30,
    hit: (c) => /createHash\(\s*['"](md5|sha1)['"]\s*\)/.test(c),
  },
  {
    id: 'S06-tls-off',
    penalty: 40,
    hit: (c) => /(rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED)/.test(c),
  },
  {
    id: 'S07-hardcoded-credential',
    penalty: 40,
    hit: (c) => lines(c).some((l) => HARDCODED.test(l) && !/process\.env|env\(/.test(l)),
  },
  {
    id: 'S08-insecure-random',
    penalty: 20,
    hit: (c) =>
      lines(c).some(
        (l) => /Math\.random\(\)/.test(l) && /(token|secret|session|password|otp)/i.test(l),
      ),
  },
  {
    id: 'S09-plain-http',
    penalty: 10,
    hit: (c, p) =>
      SERVER_EXT.has(ext(p)) &&
      lines(c).some((l) =>
        /http:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|www\.w3\.org|schemas\.)/.test(l),
      ),
  },
  {
    id: 'S10-cors-wildcard',
    penalty: 20,
    hit: (c) => /(origin\s*:\s*['"]\*['"]|Allow-Origin['"]\s*,\s*['"]\*['"])/.test(c),
  },
  {
    id: 'S11-shell-injection',
    penalty: 40,
    hit: (c) => /\b(exec|execSync)\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/.test(c),
  },
  {
    id: 'S12-blank-target',
    penalty: 10,
    hit: (c) => /target=["']_blank["'](?![^>]*noopener)/.test(c),
  },
  {
    id: 'S13-jwt-weak',
    penalty: 40,
    hit: (c) =>
      /(algorithm\s*:\s*['"]none['"]|alg['"]?\s*:\s*['"]none['"]|ignoreExpiration\s*:\s*true)/.test(
        c,
      ),
  },
  {
    id: 'S14-eq-secret-compare',
    penalty: 15,
    hit: (c) =>
      /(password|token|secret|hash)\w*\s*===?\s*\w*(password|token|secret|hash)/i.test(c) &&
      !/timingSafeEqual|compare\(/.test(c),
  },
];

/** WCAG 2.x relative luminance contrast of two `#rgb`/`#rrggbb` colours; `null` when a colour cannot be parsed. */
export function contrastRatio(fg: string, bg: string): number | null {
  const parse = (h: string): [number, number, number] | null => {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const x = m[1]!.length === 3 ? [...m[1]!].map((d) => d + d).join('') : m[1]!;
    return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
  };
  const lum = (rgb: [number, number, number]) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = parse(fg);
  const b = parse(bg);
  if (!a || !b) return null;
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/** CSS rule blocks that set both a text and a background colour as hex with a contrast below 4.5 (WCAG AA for normal text). */
function lowContrastBlocks(css: string): number {
  let n = 0;
  for (const m of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1]!;
    const fg = /(?:^|;|\s)color\s*:\s*(#[0-9a-f]{3,6})\b/i.exec(body)?.[1];
    const bg = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,6})\b/i.exec(body)?.[1];
    if (fg && bg) {
      const r = contrastRatio(fg, bg);
      if (r !== null && r < 4.5) n += 1;
    }
  }
  return n;
}
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);

const UI_RULES: Rule[] = [
  { id: 'U01-img-alt', penalty: 15, hit: (c) => /<img\b(?![^>]*\balt=)[^>]*>/i.test(c) },
  {
    id: 'U02-html-lang',
    penalty: 15,
    hit: (c, p) => ['html', 'htm'].includes(ext(p)) && /<html\b(?![^>]*\blang=)[^>]*>/i.test(c),
  },
  {
    id: 'U03-rtl-dir',
    penalty: 15,
    hit: (c, p) =>
      ['html', 'htm'].includes(ext(p)) &&
      hasArabic(c) &&
      /<html\b/i.test(c) &&
      !/<html\b[^>]*\bdir=["']rtl["']/i.test(c),
  },
  {
    id: 'U04-physical-css-in-rtl',
    penalty: 10,
    hit: (c, p, t) =>
      ['css', 'scss'].includes(ext(p)) &&
      (t.locale === 'ar' || t.category === 'arabic-rtl') &&
      /(margin-(left|right)|padding-(left|right)|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)|\b(left|right)\s*:\s*[\d.]+)/.test(
        c,
      ),
  },
  {
    id: 'U05-empty-button',
    penalty: 15,
    hit: (c) => /<button\b(?![^>]*aria-label)[^>]*>\s*<\/button>/i.test(c),
  },
  {
    id: 'U06-input-label',
    penalty: 10,
    hit: (c) =>
      /<input\b(?![^>]*(aria-label|aria-labelledby|\bid=|type=["']hidden["']))[^>]*>/i.test(c),
  },
  {
    id: 'U07-outline-none',
    penalty: 15,
    hit: (c, p) =>
      ['css', 'scss', 'html'].includes(ext(p)) &&
      /outline\s*:\s*(none|0)\b/.test(c) &&
      !/:focus-visible/.test(c),
  },
  {
    id: 'U08-click-on-div',
    penalty: 10,
    hit: (c) => /<(div|span)\b(?![^>]*\brole=)[^>]*\bonClick=/.test(c),
  },
  {
    id: 'U09-low-contrast',
    penalty: 20,
    hit: (c, p) => ['css', 'scss', 'html', 'htm'].includes(ext(p)) && lowContrastBlocks(c) > 0,
  },
  {
    id: 'U10-viewport',
    penalty: 10,
    hit: (c, p) =>
      ['html', 'htm'].includes(ext(p)) && /<head\b/i.test(c) && !/name=["']viewport["']/i.test(c),
  },
  {
    id: 'U11-fixed-wide-width',
    penalty: 10,
    hit: (c, p) =>
      ['css', 'scss', 'html'].includes(ext(p)) && /(^|[;{\s])width\s*:\s*\d{4,}px/.test(c),
  },
  {
    id: 'U12-tiny-font',
    penalty: 10,
    hit: (c, p) =>
      ['css', 'scss', 'html'].includes(ext(p)) && /font-size\s*:\s*(\d|1[01])px/.test(c),
  },
  { id: 'U13-tabindex-positive', penalty: 10, hit: (c) => /tabindex=["']?[1-9]/i.test(c) },
];

/** Applies a rule set to the changed files; returns the findings and `100 - sum(penalties)` floored at 0, or `null` when no changed file is in scope. */
function run(
  dimension: Finding['dimension'],
  rules: Rule[],
  task: GoldenTask,
  changed: [string, string][],
  inScope: (path: string) => boolean,
): { score: number | null; findings: Finding[] } {
  const files = changed.filter(([p]) => inScope(p));
  if (files.length === 0) return { score: null, findings: [] };
  const findings: Finding[] = [];
  let total = 0;
  for (const [path, content] of files)
    for (const r of rules)
      if (r.hit(content, path, task)) {
        findings.push({ dimension, rule: r.id, path, penalty: r.penalty });
        total += r.penalty;
      }
  return { score: Math.max(0, 100 - total), findings };
}

export function evaluateDimensions(
  task: GoldenTask,
  outcome: RunOutcome,
  checksPassed: number,
): DimensionResult {
  const changed: [string, string][] = [];
  for (const p of outcome.changedPaths) {
    const c = outcome.files.get(p);
    if (c !== undefined) changed.push([p, c]);
  }
  const q = run('codeQuality', QUALITY_RULES, task, changed, (p) => CODE_EXT.has(ext(p)));
  const s = run('security', SECURITY_RULES, task, changed, () => true);
  const u = run('uiQuality', UI_RULES, task, changed, (p) => UI_EXT.has(ext(p)));
  const functional =
    task.checks.length === 0 ? 100 : Math.round((100 * checksPassed) / task.checks.length);
  return {
    scores: {
      functional,
      codeQuality: q.score,
      security: s.score,
      uiQuality: u.score,
    },
    findings: [...q.findings, ...s.findings, ...u.findings],
  };
}
export const DIMENSION_RULE_IDS = {
  codeQuality: QUALITY_RULES.map((r) => r.id),
  security: SECURITY_RULES.map((r) => r.id),
  uiQuality: UI_RULES.map((r) => r.id),
} as const;
