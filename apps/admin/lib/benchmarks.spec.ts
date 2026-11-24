import { describe, expect, it } from 'vitest';
import { BENCH_KEYS, benchTexts, bt } from './benchmarks-text';
import { MOCK_SOURCES, barText, evidenceTone, parseOverview, pct, runOfflineBody, score } from './benchmarks';

describe('benchmark texts', () => {
  it('every key has an Arabic and an English text with the same placeholders', () => {
    for (const k of BENCH_KEYS) {
      expect(benchTexts.ar[k], k).toBeTruthy();
      expect(benchTexts.en[k], k).toBeTruthy();
      const ph = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(benchTexts.ar[k]), k).toEqual(ph(benchTexts.en[k]));
    }
  });
  it('never claims real-model performance and substitutes placeholders', () => {
    expect(JSON.stringify(benchTexts)).not.toMatch(/real-model performance is/i);
    expect(bt('en', 'thresholdsAccepted', { who: 'A', when: 'B' })).toBe('Accepted by A on B.');
    expect(bt('ar', 'title')).not.toBe(bt('en', 'title'));
    expect(bt('en', 'thresholdsAccepted')).toContain('{who}');
  });
});

describe('parseOverview', () => {
  it('a disabled, missing or malformed answer is the empty, switched-off overview (never an exception)', () => {
    for (const raw of [null, undefined, 5, 'x', [], { enabled: false }, { enabled: 'yes' }])
      expect(parseOverview(raw)).toMatchObject({ enabled: false, runs: [], dataset: null, thresholds: null, liveAvailable: false });
  });
  it('reads a full answer and drops malformed parts', () => {
    const o = parseOverview({
      enabled: true,
      dataset: { version: '2.0.0', hash: 'abc', tasks: 83, perCategory: { erp: 3, bad: 'x' }, categories: ['erp', 5] },
      thresholds: { version: '2-proposed', status: 'ACCEPTED', acceptance: { acceptedBy: 'owner', acceptedAt: '2026-12-01T00:00:00Z' }, items: [{ id: 'T01', scope: 'all', metric: 'validPatchRate', op: '>=', value: 0.95, why: 'w' }, null] },
      budget: { ref: 'B', currency: 'USD', maxCostMinor: '5000', maxTokens: 10, maxRequests: 5 },
      securityReview: { ref: 'S', passed: true },
      reviewers: [{ id: 'r1', name: 'A B' }, { id: '', name: 'x' }],
      runs: [{ id: 'r', label: 'l', createdAt: '2026-12-01T00:00:00Z', datasetVersion: '2.0.0', evidence: 'REAL_MODEL', adapters: ['a', 3], tasks: 83, passRate: 1, meanQuality: 100, meanSecurity: null, modeViolations: 0 }, { label: 'no id' }],
      qualifications: [{ id: 'q', adapterId: 'claude', model: 'm', effectiveState: 'QUALIFIED', datasetVersion: '2.0.0' }],
      live: { available: false },
    });
    expect(o.dataset).toMatchObject({ version: '2.0.0', tasks: 83, perCategory: { erp: 3, bad: 0 }, categories: ['erp'] });
    expect(o.thresholds).toMatchObject({ status: 'ACCEPTED', acceptedBy: 'owner' });
    expect(o.thresholds!.items).toHaveLength(2);
    expect(o.reviewers).toEqual([{ id: 'r1', name: 'A B' }]);
    expect(o.runs).toHaveLength(1);
    expect(o.runs[0]).toMatchObject({ evidence: 'NONE', adapters: ['a'], meanSecurity: null });
    expect(o.qualifications[0]).toMatchObject({ effectiveState: 'QUALIFIED' });
    expect(o.liveAvailable).toBe(false);
  });
  it('an unknown threshold status is PROPOSED (the safe reading)', () => {
    expect(parseOverview({ enabled: true, thresholds: { version: '2-proposed', status: 'WHATEVER', items: [] } }).thresholds!.status).toBe('PROPOSED');
  });
});

describe('formatters', () => {
  it('formats rates, scores, bars and tones', () => {
    expect(pct(0.8571)).toBe('85.7%');
    expect(pct(1)).toBe('100%');
    expect(score(null, 'n/a')).toBe('n/a');
    expect(score(97.5, 'n/a')).toBe('97.5');
    expect(barText({ op: '>=', value: 0.95 })).toBe('>= 0.95');
    expect(evidenceTone('OFFLINE_REFERENCE_ORACLE')).toBe('warn');
    expect(evidenceTone('OFFLINE_REPLAY_OF_RECORDED_RUN')).toBeUndefined();
  });
  it('the only action body is an offline replay of the reference or a mock, with a request id', () => {
    expect(runOfflineBody('reference', 'id')).toEqual({ action: 'run_offline', source: 'reference', requestId: 'id' });
    expect(MOCK_SOURCES.every((s) => s === 'reference' || s.startsWith('mock:'))).toBe(true);
    expect(MOCK_SOURCES.some((s) => /recorded|live/.test(s))).toBe(false);
  });
});
