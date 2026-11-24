import { describe, expect, it } from 'vitest';
import { BENCH_KEYS, EXTRA_TEXTS, bt, type ExtraBenchKey } from './benchmarks-text';
import {
  MOCK_SOURCES,
  barText,
  GOVERNANCE_STATES,
  PREREQUISITE_IDS,
  SCORECARD_DIMENSIONS,
  STAGE_IDS,
  evidenceTone,
  governanceActions,
  governanceBody,
  money,
  parseGovernance,
  parseOverview,
  parseScorecard,
  parseStages,
  permille,
  scorecardValue,
  pct,
  runOfflineBody,
  score,
} from './benchmarks';

describe('benchmark texts', () => {
  it('every key has an Arabic and an English text with the same placeholders', () => {
    for (const k of BENCH_KEYS) {
      const ar = bt('ar', k);
      const en = bt('en', k);
      expect(ar, k).toBeTruthy();
      expect(en, k).toBeTruthy();
      expect(ar, k).not.toBe(`bench.${k}`);
      const ph = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(ar), k).toEqual(ph(en));
    }
  });
  it('never claims real-model performance and substitutes placeholders', () => {
    for (const k of BENCH_KEYS) expect(bt('en', k)).not.toMatch(/real-model performance is/i);
    expect(bt('en', 'thresholdsAccepted', { who: 'A', when: 'B' })).toBe('Accepted by A on B.');
    expect(bt('ar', 'title')).not.toBe(bt('en', 'title'));
  });
});

describe('parseOverview', () => {
  it('a disabled, missing or malformed answer is the empty, switched-off overview (never an exception)', () => {
    for (const raw of [null, undefined, 5, 'x', [], { enabled: false }, { enabled: 'yes' }])
      expect(parseOverview(raw)).toMatchObject({
        enabled: false,
        runs: [],
        dataset: null,
        thresholds: null,
        liveAvailable: false,
      });
  });
  it('reads a full answer and drops malformed parts', () => {
    const o = parseOverview({
      enabled: true,
      dataset: {
        version: '2.0.0',
        hash: 'abc',
        tasks: 83,
        perCategory: { erp: 3, bad: 'x' },
        categories: ['erp', 5],
      },
      thresholds: {
        version: '2-proposed',
        status: 'ACCEPTED',
        acceptance: { acceptedBy: 'owner', acceptedAt: '2026-12-01T00:00:00Z' },
        items: [
          { id: 'T01', scope: 'all', metric: 'validPatchRate', op: '>=', value: 0.95, why: 'w' },
          null,
        ],
      },
      budget: { ref: 'B', currency: 'USD', maxCostMinor: '5000', maxTokens: 10, maxRequests: 5 },
      securityReview: { ref: 'S', passed: true },
      reviewers: [
        { id: 'r1', name: 'A B' },
        { id: '', name: 'x' },
      ],
      runs: [
        {
          id: 'r',
          label: 'l',
          createdAt: '2026-12-01T00:00:00Z',
          datasetVersion: '2.0.0',
          evidence: 'REAL_MODEL',
          adapters: ['a', 3],
          tasks: 83,
          passRate: 1,
          meanQuality: 100,
          meanSecurity: null,
          modeViolations: 0,
        },
        { label: 'no id' },
      ],
      qualifications: [
        {
          id: 'q',
          adapterId: 'claude',
          model: 'm',
          effectiveState: 'QUALIFIED',
          datasetVersion: '2.0.0',
        },
      ],
      live: { available: false },
    });
    expect(o.dataset).toMatchObject({
      version: '2.0.0',
      tasks: 83,
      perCategory: { erp: 3, bad: 0 },
      categories: ['erp'],
    });
    expect(o.thresholds).toMatchObject({ status: 'ACCEPTED', acceptedBy: 'owner' });
    expect(o.thresholds!.items).toHaveLength(2);
    expect(o.reviewers).toEqual([{ id: 'r1', name: 'A B' }]);
    expect(o.runs).toHaveLength(1);
    expect(o.runs[0]).toMatchObject({ evidence: 'NONE', adapters: ['a'], meanSecurity: null });
    expect(o.qualifications[0]).toMatchObject({ effectiveState: 'QUALIFIED' });
    expect(o.liveAvailable).toBe(false);
  });
  it('an unknown threshold status is PROPOSED (the safe reading)', () => {
    expect(
      parseOverview({
        enabled: true,
        thresholds: { version: '2-proposed', status: 'WHATEVER', items: [] },
      }).thresholds!.status,
    ).toBe('PROPOSED');
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
    expect(runOfflineBody('reference', 'id')).toEqual({
      action: 'run_offline',
      source: 'reference',
      requestId: 'id',
    });
    expect(MOCK_SOURCES.every((s) => s === 'reference' || s.startsWith('mock:'))).toBe(true);
    expect(MOCK_SOURCES.some((s) => /recorded|live/.test(s))).toBe(false);
  });
});

describe('Phase 2 texts', () => {
  const keys = Object.keys(EXTRA_TEXTS.en) as ExtraBenchKey[];
  it('every staged-plan and scorecard text exists in both languages with the same placeholders', () => {
    expect(Object.keys(EXTRA_TEXTS.ar).sort()).toEqual([...keys].sort());
    const ph = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) {
      expect(EXTRA_TEXTS.en[k], k).toBeTruthy();
      expect(EXTRA_TEXTS.ar[k], k).toBeTruthy();
      expect(ph(EXTRA_TEXTS.ar[k]), k).toEqual(ph(EXTRA_TEXTS.en[k]));
    }
  });
  it('covers every stage, prerequisite and scorecard dimension the screen can show', () => {
    for (const id of STAGE_IDS) {
      expect(keys).toContain(`stageName_${id}`);
      expect(keys).toContain(`stagePurpose_${id}`);
    }
    for (const q of PREREQUISITE_IDS) expect(keys).toContain(`prereq_${q}`);
    for (const d of SCORECARD_DIMENSIONS) expect(keys).toContain(`dim_${d}`);
  });
  it('keeps the base texts reachable when an extra key shares a word with one (runs vs runCount)', () => {
    expect(bt('en', 'runs')).toBe('Benchmark runs');
    expect(bt('en', 'runCount')).toBe('Runs');
  });
});

describe('money, stages and scorecard parsing', () => {
  it('formats minor units with integer arithmetic only', () => {
    expect(money('8360', 'USD')).toBe('83.60 USD');
    expect(money('5', 'USD')).toBe('0.05 USD');
    expect(money('100', 'USD')).toBe('1.00 USD');
    expect(money('not-a-number', 'USD')).toBe('0.00 USD');
    expect(money('99999999999999999999', 'USD')).toBe('999999999999999999.99 USD');
    expect(permille(600)).toBe('60%');
    expect(permille(855)).toBe('85.5%');
  });
  const plan = (stage: string, extra: Record<string, unknown> = {}) => ({
    stage,
    tasks: 5,
    runs: 5,
    models: 1,
    currency: 'USD',
    max: { tokens: 220000, requests: 30, costMinor: '440' },
    estimate: { tokens: 132000, costMinor: '88' },
    duration: { estimatedMinutes: 4, maximumMinutes: 8 },
    ...extra,
  });
  const stages = {
    rateBasis: {
      model: 'Claude Opus 5.5',
      source: 'list price',
      status: 'TO_BE_CONFIRMED_BY_S02_D6',
    },
    prices: { currency: 'USD', input: '400', output: '2000' },
    assumptions: { usagePermille: 600, inputSharePermille: 850 },
    plans: [plan('A'), plan('Z'), plan('B', { max: { costMinor: 'x' } })],
    definitions: [{ id: 'A', prerequisites: ['PROVIDER_VERIFIED', 'NOT_A_PREREQUISITE'] }],
    monthly: { estimateCostMinor: '3400', maxCostMinor: '17000' },
  };
  it('reads the plan and drops unknown stages, unknown prerequisites and non-numeric money', () => {
    const v = parseStages(stages)!;
    expect(v.plans.map((p) => p.stage)).toEqual(['A', 'B']);
    expect(v.plans[0]).toMatchObject({
      maxCostMinor: '440',
      estimateCostMinor: '88',
      estimatedMinutes: 4,
    });
    expect(v.plans[0]!.prerequisites).toEqual(['PROVIDER_VERIFIED']);
    expect(v.plans[1]!.maxCostMinor).toBe('0');
    expect(v.rateBasis.status).toBe('TO_BE_CONFIRMED_BY_S02_D6');
    expect(v.monthly).toEqual({
      estimateCostMinor: '3400',
      maxCostMinor: '17000',
      currency: 'USD',
    });
  });
  it('a missing or empty plan is null, and the overview carries it only when the API sent it', () => {
    expect(parseStages(undefined)).toBeNull();
    expect(parseStages({ plans: [] })).toBeNull();
    expect(
      parseOverview({ enabled: true, live: { available: false, stages } }).stages?.plans,
    ).toHaveLength(2);
    expect(parseOverview({ enabled: true }).stages).toBeNull();
  });
  it('reads a scorecard, keeps unknown statuses as not measured and ignores unknown dimensions', () => {
    const rows = parseScorecard({
      scorecard: [
        {
          dimension: 'latency',
          value: 5500,
          unit: 'ms',
          tasks: 83,
          thresholds: [{ id: 'T11', status: 'PASS' }],
        },
        {
          dimension: 'arabic-rtl',
          value: null,
          unit: 'rate',
          tasks: 0,
          thresholds: [{ id: 'T19', status: 'maybe' }],
        },
        { dimension: 'invented', value: 1, unit: 'rate', tasks: 1, thresholds: [] },
      ],
    });
    expect(rows.map((r) => r.dimension)).toEqual(['latency', 'arabic-rtl']);
    expect(rows[1]!.thresholds[0]!.status).toBe('NOT MEASURED');
    expect(parseScorecard(null)).toEqual([]);
    expect(scorecardValue(rows[0]!, 'n/a')).toBe('5.5 s');
    expect(scorecardValue(rows[1]!, 'n/a')).toBe('n/a');
    expect(scorecardValue({ value: 0.8571, unit: 'rate' }, 'n/a')).toBe('85.7%');
    expect(scorecardValue({ value: 2160, unit: 'tokens' }, 'n/a')).toBe('2160');
  });
});

describe('threshold governance parsing and actions', () => {
  it('reads the state and reviews; unknown states and verdicts fall back safely (nothing accepted)', () => {
    expect(parseGovernance(undefined).state).toBe('NOT_PROPOSED');
    expect(parseGovernance({ state: 'ACCEPTED_BY_MAGIC' }).state).toBe('NOT_PROPOSED');
    const g = parseGovernance({
      state: 'UNDER_REVIEW',
      proposedBy: 'dev',
      summary: 's',
      reviews: [
        { by: 'r1', verdict: 'approve', note: 'ok' },
        { by: 'r2', verdict: 'shrug', note: 'x' },
      ],
    });
    expect(g.state).toBe('UNDER_REVIEW');
    expect(g.reviews).toEqual([{ by: 'r1', verdict: 'approve', note: 'ok' }]);
    expect(GOVERNANCE_STATES).toHaveLength(6);
  });
  it('offers only the actions that make sense in a state', () => {
    expect(governanceActions('NOT_PROPOSED')).toEqual(['propose']);
    expect(governanceActions('UNDER_REVIEW')).toContain('accept');
    expect(governanceActions('CHANGES_REQUESTED')).not.toContain('accept');
    expect(governanceActions('ACCEPTED')).toEqual(['reject']);
    expect(governanceActions('REJECTED')).toEqual(['propose']);
  });
  it('builds each body with the version and a request id', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(governanceBody('propose', '2-proposed', { text: 's' }, id)).toEqual({
      action: 'propose_thresholds',
      version: '2-proposed',
      requestId: id,
      summary: 's',
    });
    expect(
      governanceBody('review', '2-proposed', { text: 'n', verdict: 'approve' }, id),
    ).toMatchObject({ action: 'review_thresholds', verdict: 'approve', note: 'n' });
    expect(governanceBody('accept', '2-proposed', {}, id)).toEqual({
      action: 'accept_thresholds',
      version: '2-proposed',
      requestId: id,
    });
    expect(governanceBody('reject', '2-proposed', { text: 'why' }, id)).toMatchObject({
      action: 'reject_thresholds',
      reason: 'why',
    });
  });
});
