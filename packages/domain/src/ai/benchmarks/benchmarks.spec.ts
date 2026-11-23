import { describe, expect, it } from 'vitest';
import {
  GOLDEN_TASKS,
  PROPOSED_THRESHOLDS,
  evaluateThresholds,
  referenceRecording,
  regressions,
  renderReport,
  replayTask,
  rolloutDecision,
  runSuite,
  scoreRun,
  type GoldenTask,
  type Recording,
} from './index';

const refs = () => new Map(GOLDEN_TASKS.map((t) => [t.id, referenceRecording(t)]));
const task = (id: string) => GOLDEN_TASKS.find((t) => t.id === id)!;
const withPatch = (
  t: GoldenTask,
  patch: Recording['patch'],
  over: Partial<Recording> = {},
): Recording => ({
  ...referenceRecording(t),
  patch,
  ...over,
});
const recorded = () =>
  new Map([...refs()].map(([k, v]) => [k, { ...v, origin: 'RECORDED' as const }]));

describe('the golden dataset', () => {
  it('has 24 unique synthetic public tasks, 6 per kind, in both languages', () => {
    expect(GOLDEN_TASKS).toHaveLength(24);
    expect(new Set(GOLDEN_TASKS.map((t) => t.id)).size).toBe(24);
    for (const k of ['website', 'webapp', 'code-edit', 'tool-calling'] as const)
      expect(GOLDEN_TASKS.filter((t) => t.kind === k)).toHaveLength(6);
    expect(GOLDEN_TASKS.some((t) => t.locale === 'ar')).toBe(true);
    expect(GOLDEN_TASKS.some((t) => t.locale === 'en')).toBe(true);
    expect(GOLDEN_TASKS.every((t) => t.synthetic && t.dataClass === 'public')).toBe(true);
  });
  it('every task is satisfiable (its reference solution passes) and none is vacuous (an empty proposal fails)', () => {
    for (const t of GOLDEN_TASKS) {
      const ok = scoreRun(t, replayTask(t, referenceRecording(t)));
      expect(ok.passed, `${t.id} reference`).toBe(true);
      expect(ok.quality, t.id).toBe(100);
      const empty = scoreRun(t, replayTask(t, withPatch(t, [])));
      expect(empty.passed, `${t.id} empty`).toBe(false);
    }
  });
});

describe('replay and scoring', () => {
  const t = task('code-02-constant');
  it('a path outside the project is a mode violation: nothing is applied and the quality is 0', () => {
    const o = replayTask(t, withPatch(t, [{ path: '../outside.ts', content: 'x' }]));
    expect(o.modeViolations).toBe(1);
    expect(o.patchApplied).toBe(false);
    expect(scoreRun(t, o)).toMatchObject({ quality: 0, passed: false, validPatch: false });
  });
  it('a sensitive file and a secret in a proposal are violations', () => {
    expect(replayTask(t, withPatch(t, [{ path: '.env', content: 'A=1' }])).modeViolations).toBe(1);
    const secret = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const o = replayTask(t, withPatch(t, [{ path: 'src/consts.ts', content: secret }]));
    expect(o.modeViolations).toBe(1);
    expect(o.files.get('src/consts.ts')).toBe('export const MAX_ITEMS = 10;\n');
  });
  it('a run that did not end with a proposal applies nothing', () => {
    const o = replayTask(t, withPatch(t, t.solution, { finishedWith: 'fallback' }));
    expect(o.patchApplied).toBe(false);
    expect(scoreRun(t, o).passed).toBe(false);
  });
  it('rejected tool calls lower the validity and the discipline points; a missing required tool fails the task', () => {
    const rd = task('app-04-pad-helper');
    const rec = referenceRecording(rd);
    rec.turns[0]!.toolCalls.push({ id: 'x', name: 'run_shell', args: { cmd: 'ls' } });
    const s = scoreRun(rd, replayTask(rd, rec));
    expect(s.toolCallValidity).toBe(0.5);
    expect(s.quality).toBeLessThan(100);
    const none = referenceRecording(rd);
    none.turns = none.turns.slice(1);
    expect(scoreRun(rd, replayTask(rd, none)).mustCallSatisfied).toBe(false);
  });
  it('exceeding the token budget fails the task', () => {
    const rec = referenceRecording(t);
    rec.turns[0] = { ...rec.turns[rec.turns.length - 1]!, tokensIn: 1_000_000 };
    expect(scoreRun(t, replayTask(t, rec))).toMatchObject({ withinBudget: false, passed: false });
  });
  it('is deterministic', () => {
    const a = runSuite(GOLDEN_TASKS, refs()).report;
    const b = runSuite(GOLDEN_TASKS, refs()).report;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('report, thresholds and the rollout gate', () => {
  const rate = { creditsPerMillionInput: '1000000', creditsPerMillionOutput: '2000000' };
  it('the reference suite meets every proposed threshold, and is still NOT VERIFIED for rollout (it is not a model)', () => {
    const { report } = runSuite(GOLDEN_TASKS, refs(), rate);
    expect(report.overall).toMatchObject({
      tasks: 24,
      passRate: 1,
      validPatchRate: 1,
      modeViolations: 0,
    });
    const results = evaluateThresholds(report);
    expect(results.every((r) => r.status === 'PASS')).toBe(true);
    const d = rolloutDecision(report, results, [], true);
    expect(d.allowed).toBe(false);
    expect(d.status).toBe('NOT VERIFIED');
    expect(d.reasons.join(' ')).toMatch(/REFERENCE/);
    expect(renderReport(report)).toContain('| ALL | 24 |');
    expect(report.estimatedCredits).toMatch(/^\d+$/);
  });
  it('proposed thresholds are not accepted by default: even a perfect RECORDED run is not allowed until the owner accepts them', () => {
    const { report } = runSuite(GOLDEN_TASKS, recorded());
    const results = evaluateThresholds(report);
    expect(rolloutDecision(report, results, [], false).allowed).toBe(false);
    expect(rolloutDecision(report, results, [], true)).toMatchObject({
      allowed: true,
      status: 'PASS',
    });
  });
  it('a failing metric blocks, a regression blocks, a missing recording is listed and blocks', () => {
    const base = runSuite(GOLDEN_TASKS, recorded()).report;
    const bad = recorded();
    const t = task('web-01-hero-en');
    bad.set(t.id, { ...bad.get(t.id)!, patch: [] });
    bad.delete('code-02-constant');
    const { report } = runSuite(GOLDEN_TASKS, bad);
    expect(report.missingRecordings).toEqual(['code-02-constant']);
    const regs = regressions(report, base);
    expect(regs.length).toBeGreaterThan(0);
    expect(rolloutDecision(report, evaluateThresholds(report), regs, true)).toMatchObject({
      allowed: false,
      status: 'BLOCKED',
    });
  });
  it('an unmeasured scope is NOT MEASURED, never a pass', () => {
    const only = new Map([...refs()].filter(([k]) => k.startsWith('web-')));
    const { report } = runSuite(GOLDEN_TASKS, only);
    expect(evaluateThresholds(report).find((x) => x.id === 'T06')!.status).toBe('NOT MEASURED');
  });
  it('proposes 11 thresholds with a reason each', () => {
    expect(PROPOSED_THRESHOLDS).toHaveLength(11);
    expect(PROPOSED_THRESHOLDS.every((x) => x.why.length > 10)).toBe(true);
  });
});
