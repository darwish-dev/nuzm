import { describe, expect, it } from 'vitest';
import {
  DIMENSION_RULE_IDS,
  EFFICIENCY_SHAPE,
  GOLDEN_TASKS,
  contrastRatio,
  creditsFor,
  efficiencyScore,
  evaluateDimensions,
  validateDataset,
  type GoldenTask,
  type RunOutcome,
} from './index';

const base = GOLDEN_TASKS.find((t) => t.id === 'code-04-add-function')!;
const arTask: GoldenTask = { ...GOLDEN_TASKS.find((t) => t.id === 'rtl-02-logical-properties')! };
const outcome = (files: Record<string, string>): RunOutcome => ({
  taskId: base.id,
  turns: 2,
  toolCalls: 0,
  validToolCalls: 0,
  rejectedToolCalls: 0,
  calledTools: [],
  tokens: 1000,
  tokensIn: 800,
  tokensOut: 200,
  latencyMs: 5000,
  changedPaths: Object.keys(files),
  patchApplied: true,
  patchErrors: [],
  modeViolations: 0,
  filesChanged: Object.keys(files).length,
  files: new Map(Object.entries(files)),
  finishedWith: 'proposal',
});
const rulesFor = (task: GoldenTask, files: Record<string, string>) => evaluateDimensions(task, outcome(files), 1).findings.map((f) => f.rule);

describe('static dimensions: every rule fires on a planted flaw and a clean file scores 100', () => {
  const cases: [string, string, string][] = [
    ['Q01-any', 'a.ts', 'export const x: any = 1;\n'],
    ['Q02-console', 'a.ts', 'console.log(1);\n'],
    ['Q03-todo', 'a.ts', '// TODO later\nexport const x = 1;\n'],
    ['Q04-long-line', 'a.ts', `export const x = '${'a'.repeat(210)}';\n`],
    ['Q05-debugger', 'a.ts', 'debugger;\n'],
    ['Q06-ts-ignore', 'a.ts', '// @ts-ignore\nexport const x = 1;\n'],
    ['Q07-no-final-newline', 'a.ts', 'export const x = 1;'],
    ['Q08-empty-catch', 'a.ts', 'try { f(); } catch {}\n'],
    ['Q09-dart-print', 'a.dart', "void f() {\n  print('x');\n}\n"],
    ['Q10-var', 'a.js', 'var x = 1;\n'],
    ['S01-secret', 'a.ts', `const k = '${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}';\n`],
    ['S02-eval', 'a.ts', 'eval(code);\n'],
    ['S03-inner-html', 'a.ts', 'el.innerHTML = v;\n'],
    ['S04-sql-concat', 'a.ts', "const q = 'SELECT * FROM t WHERE id = ' + id;\n"],
    ['S05-weak-hash', 'a.ts', "createHash('md5');\n"],
    ['S06-tls-off', 'a.ts', 'const o = { rejectUnauthorized: false };\n'],
    ['S07-hardcoded-credential', 'a.ts', "const password = 'hunter2hunter2';\n"],
    ['S08-insecure-random', 'a.ts', 'const token = Math.random().toString(36);\n'],
    ['S09-plain-http', 'a.ts', "fetch('http://example.org/api');\n"],
    ['S10-cors-wildcard', 'a.ts', "const c = { origin: '*' };\n"],
    ['S11-shell-injection', 'a.ts', 'exec(`ls ${dir}`);\n'],
    ['S12-blank-target', 'a.html', '<a href="x" target="_blank">x</a>\n'],
    ['S13-jwt-weak', 'a.ts', "sign(p, k, { algorithm: 'none' });\n"],
    ['S14-eq-secret-compare', 'a.ts', 'if (password === storedPassword) ok();\n'],
    ['U01-img-alt', 'a.html', '<img src="a.png">\n'],
    ['U02-html-lang', 'a.html', '<html><body></body></html>\n'],
    ['U03-rtl-dir', 'a.html', '<html lang="ar"><body>مرحبا</body></html>\n'],
    ['U05-empty-button', 'a.html', '<button></button>\n'],
    ['U06-input-label', 'a.html', '<input type="text">\n'],
    ['U07-outline-none', 'a.css', 'a:focus { outline: none; }\n'],
    ['U08-click-on-div', 'a.tsx', 'export const A = () => <div onClick={f}>x</div>;\n'],
    ['U09-low-contrast', 'a.css', '.a { color: #777777; background: #888888; }\n'],
    ['U10-viewport', 'a.html', '<html lang="en"><head></head></html>\n'],
    ['U11-fixed-wide-width', 'a.css', '.a { width: 1200px; }\n'],
    ['U12-tiny-font', 'a.css', '.a { font-size: 10px; }\n'],
    ['U13-tabindex-positive', 'a.html', '<div tabindex="3"></div>\n'],
  ];
  for (const [rule, path, content] of cases)
    it(rule, () => {
      expect(rulesFor(base, { [path]: content }), rule).toContain(rule);
    });
  it('U04 fires only for Arabic tasks (physical CSS properties); the same CSS is fine for an English task', () => {
    const css = '.a { margin-left: 4px; }\n';
    expect(rulesFor(arTask, { 'a.css': css })).toContain('U04-physical-css-in-rtl');
    expect(rulesFor({ ...base, locale: 'en', category: 'code-editing' }, { 'a.css': css })).not.toContain('U04-physical-css-in-rtl');
  });
  it('every rule id is covered by a case', () => {
    const covered = new Set(cases.map((c) => c[0]));
    covered.add('U04-physical-css-in-rtl');
    for (const id of [...DIMENSION_RULE_IDS.codeQuality, ...DIMENSION_RULE_IDS.security, ...DIMENSION_RULE_IDS.uiQuality]) expect(covered.has(id), id).toBe(true);
  });
  it('a clean change scores 100, a dimension that does not apply is null (never a free 100), penalties accumulate and floor at 0', () => {
    const clean = evaluateDimensions(base, outcome({ 'src/a.ts': 'export const x = 1;\n' }), base.checks.length).scores;
    expect(clean).toMatchObject({ functional: 100, codeQuality: 100, security: 100, uiQuality: null });
    const json = evaluateDimensions(base, outcome({ 'data.json': '{}\n' }), 1).scores;
    expect(json.codeQuality).toBeNull();
    expect(json.uiQuality).toBeNull();
    const bad = evaluateDimensions(base, outcome({ 'a.ts': "eval(x);\ncreateHash('md5');\nel.innerHTML = v;\n" }), 0).scores;
    expect(bad.security).toBe(0);
    expect(bad.functional).toBe(0);
  });
  it('only CHANGED files are judged (a flaw already in the fixture is not charged to the model)', () => {
    const o = outcome({ 'src/a.ts': 'export const x = 1;\n' });
    o.files.set('src/old.ts', 'eval(x);\n');
    expect(evaluateDimensions(base, o, 1).scores.security).toBe(100);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#fff', '#fff')).toBe(1);
    expect(contrastRatio('#777', '#fff')).toBeCloseTo(4.48, 1);
    expect(contrastRatio('red', '#fff')).toBeNull();
  });
});

describe('efficiency', () => {
  const t = base; // 6 turns, 40k tokens
  it('is 100 for a lean fast run and 0 for a run at every ceiling', () => {
    expect(efficiencyScore(t, { tokens: 5_000, turns: 2, latencyMs: 10_000 })).toBe(100);
    expect(efficiencyScore(t, { tokens: t.budget.maxTokens, turns: t.budget.maxTurns, latencyMs: EFFICIENCY_SHAPE.latencyZeroMs })).toBe(0);
  });
  it('falls monotonically with tokens, turns and latency', () => {
    const f = (tokens: number, turns: number, latencyMs: number) => efficiencyScore(t, { tokens, turns, latencyMs });
    expect(f(20_000, 3, 40_000)).toBeLessThan(f(15_000, 3, 40_000));
    expect(f(20_000, 5, 40_000)).toBeLessThan(f(20_000, 4, 40_000));
    expect(f(20_000, 3, 100_000)).toBeLessThan(f(20_000, 3, 60_000));
  });
  it('credits are whole numbers rounded up, in integer math', () => {
    const rate = { creditsPerMillionInput: '3', creditsPerMillionOutput: '15' };
    expect(creditsFor(0, 0, rate)).toBe(0n);
    expect(creditsFor(1, 0, rate)).toBe(1n);
    expect(creditsFor(1_000_000, 1_000_000, rate)).toBe(18n);
  });
});

describe('validateDataset refuses broken tasks', () => {
  const t = GOLDEN_TASKS.find((x) => x.id === 'land-01-cta')!;
  const problems = (over: Partial<GoldenTask>) => validateDataset([{ ...t, ...over }]).join(' | ');
  it('vacuous, secret-carrying, sensitive-path, unknown-tool and mismatched tasks are named', () => {
    expect(problems({ checks: [{ type: 'max_files_changed', n: 2 }] })).toMatch(/vacuous/);
    expect(problems({ solution: [{ path: '.env', content: 'A=1\n' }] })).toMatch(/solution path not allowed/);
    expect(problems({ fixture: [{ path: 'a.txt', content: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') }] })).toMatch(/secret-like/);
    expect(problems({ tools: { mustCall: ['run_shell'], mustNotCall: [], maxCalls: 3 } })).toMatch(/unknown read tool/);
    expect(problems({ kind: 'tool-calling' })).toMatch(/kind does not match/);
    expect(problems({ checks: [{ type: 'contains', path: 'nowhere.html', text: 'x' }] })).toMatch(/cannot produce/);
    expect(problems({ checks: [{ type: 'matches', path: 'index.html', pattern: '(' }] })).toMatch(/does not compile/);
    expect(problems({ dataClass: 'public', synthetic: false as unknown as true })).toMatch(/synthetic/);
  });
});
