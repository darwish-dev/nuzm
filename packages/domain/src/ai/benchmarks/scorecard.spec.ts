import { describe, expect, it } from 'vitest';
import {
  GOLDEN_TASKS,
  SCORECARD_DIMENSIONS,
  buildScorecard,
  evaluateThresholds,
  mockSuite,
  referenceRecording,
  runSuite,
} from './index';

const refMap = new Map(GOLDEN_TASKS.map((t) => [t.id, referenceRecording(t)]));

describe('qualification scorecard', () => {
  it('has the seven dimensions, each tied to thresholds that exist', () => {
    const { report } = runSuite(GOLDEN_TASKS, refMap);
    const rows = buildScorecard(report, evaluateThresholds(report));
    expect(rows.map((r) => r.dimension)).toEqual([...SCORECARD_DIMENSIONS]);
    for (const r of rows)
      for (const t of r.thresholds)
        expect(t.status, `${r.dimension} ${t.id}`).not.toBe('NOT MEASURED');
  });
  it('on the reference oracle every dimension is at its best', () => {
    const { report } = runSuite(GOLDEN_TASKS, refMap);
    const by = Object.fromEntries(
      buildScorecard(report, evaluateThresholds(report)).map((r) => [r.dimension, r]),
    );
    expect(by['functional']!.value).toBe(100);
    expect(by['arabic-rtl']!.value).toBe(1);
    expect(by['arabic-rtl']!.tasks).toBe(
      GOLDEN_TASKS.filter((t) => t.locale === 'ar' || t.category === 'arabic-rtl').length,
    );
    expect(by['tool-calling-reliability']!.value).toBe(1);
    expect(by['cost-token-efficiency']!.value).toBe(report.overall.meanTokens);
  });
  it('the Arabic dimension counts only Arabic or RTL tasks and falls when they fail', () => {
    const bad = new Map(refMap);
    for (const t of GOLDEN_TASKS)
      if (t.locale === 'ar') bad.set(t.id, { ...referenceRecording(t), patch: [] });
    const { report } = runSuite(GOLDEN_TASKS, bad);
    const rows = buildScorecard(report, evaluateThresholds(report));
    const ar = rows.find((r) => r.dimension === 'arabic-rtl')!;
    expect(ar.value).toBeLessThan(1);
    expect(ar.thresholds.find((t) => t.id === 'T19')).toBeDefined();
    // English tasks are untouched: functional stays high, the Arabic dimension carries the failure
    expect(report.overall.passRate).toBeGreaterThan(ar.value!);
  });
  it('a dimension nothing measured is null, never 100', () => {
    const only = GOLDEN_TASKS.filter(
      (t) => t.category === 'database-architecture' && t.locale === 'en',
    );
    const rec = new Map(only.map((t) => [t.id, referenceRecording(t)]));
    const { report } = runSuite(only, rec);
    const rows = buildScorecard(report, evaluateThresholds(report));
    const ar = rows.find((r) => r.dimension === 'arabic-rtl')!;
    expect(ar.value).toBeNull();
    expect(ar.tasks).toBe(0);
    expect(
      buildScorecard(runSuite([], new Map()).report, []).every(
        (r) => r.value === null || r.dimension === 'code-quality',
      ),
    ).toBe(true);
  });
  it('shows a weaker mock model as weaker on its weak dimension (tool calling)', () => {
    const { report } = runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'sloppy-tools'));
    const rows = buildScorecard(report, evaluateThresholds(report));
    expect(rows.find((r) => r.dimension === 'tool-calling-reliability')!.value).toBeLessThan(0.95);
  });
});
