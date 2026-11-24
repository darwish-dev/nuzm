import { describe, expect, it } from 'vitest';
import {
  CORE_TASKS,
  DEFAULT_COST_ASSUMPTIONS,
  GOLDEN_TASKS,
  PREREQUISITES,
  REFERENCE_RATE_INPUTS,
  STAGES,
  TASK_CATEGORIES,
  THRESHOLDS_VERSION,
  calibrateAssumptions,
  evaluateStageEntry,
  evaluateStageExit,
  livePreflight,
  planContinuousMonth,
  planStage,
  preflightBudget,
  programmeExposure,
  proposedBudgetFor,
  selectStageTasks,
  stageExited,
  type LivePreconditions,
  type PrerequisiteId,
  type PriceCard,
  type StageOutcome,
} from './index';

const OPUS: PriceCard = {
  currency: 'USD',
  minorPerMillionInput: '400',
  minorPerMillionOutput: '2000',
};
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

describe('stage task selection', () => {
  it('A: one smallest task per kind plus one Arabic RTL task; deterministic whatever the input order', () => {
    const a = selectStageTasks('A', GOLDEN_TASKS);
    expect(a).toHaveLength(5);
    expect(new Set(a.map((t) => t.kind)).size).toBe(4);
    expect(a.some((t) => t.category === 'arabic-rtl' && t.locale === 'ar')).toBe(true);
    for (const t of a.filter((x) => x.category !== 'arabic-rtl' || x.locale !== 'ar')) {
      const smallest = Math.min(
        ...GOLDEN_TASKS.filter((x) => x.kind === t.kind).map((x) => x.budget.maxTokens),
      );
      if (a.filter((x) => x.kind === t.kind).length === 1)
        expect(t.budget.maxTokens).toBe(smallest);
    }
    expect(selectStageTasks('A', [...GOLDEN_TASKS].reverse()).map((t) => t.id)).toEqual(
      a.map((t) => t.id),
    );
  });
  it('B: exactly one task for each of the 23 categories', () => {
    const b = selectStageTasks('B', GOLDEN_TASKS);
    expect(b).toHaveLength(23);
    expect(new Set(b.map((t) => t.category))).toEqual(new Set(TASK_CATEGORIES));
    // both languages are represented (Arabic is the product default, D-32)
    expect(b.filter((t) => t.locale === 'ar').length).toBeGreaterThanOrEqual(8);
    expect(b.filter((t) => t.locale === 'en').length).toBeGreaterThanOrEqual(8);
  });
  it('C and D: every task; E: the 24 core tasks', () => {
    expect(selectStageTasks('C', GOLDEN_TASKS)).toHaveLength(GOLDEN_TASKS.length);
    expect(selectStageTasks('D', GOLDEN_TASKS)).toHaveLength(GOLDEN_TASKS.length);
    expect(selectStageTasks('E', GOLDEN_TASKS).map((t) => t.id)).toEqual(
      CORE_TASKS.map((t) => t.id).sort(),
    );
  });
  it('every stage task is a member of the dataset (a stage never invents a task)', () => {
    const ids = new Set(GOLDEN_TASKS.map((t) => t.id));
    for (const s of STAGES)
      for (const t of selectStageTasks(s.id, GOLDEN_TASKS)) expect(ids.has(t.id)).toBe(true);
  });
});

describe('stage plans: estimated and maximum cost', () => {
  it('the maximum is the independent sum of every ceiling at the dearer price (stage C, Opus list price)', () => {
    const p = planStage('C', GOLDEN_TASKS, [OPUS]);
    expect(p.problems).toEqual([]);
    expect(p.tasks).toBe(83);
    expect(p.categories).toBe(23);
    expect(p.max.tokens).toBe(GOLDEN_TASKS.reduce((a, t) => a + t.budget.maxTokens, 0));
    expect(p.max.requests).toBe(GOLDEN_TASKS.reduce((a, t) => a + t.budget.maxTurns, 0));
    const expected = GOLDEN_TASKS.reduce(
      (a, t) => a + ceilDiv(BigInt(t.budget.maxTokens) * 2000n, 1_000_000n),
      0n,
    );
    expect(p.max.costMinor).toBe(expected.toString());
  });
  it('the estimate is below the maximum and follows the assumptions (60 % usage, 85 % input)', () => {
    const p = planStage('C', GOLDEN_TASKS, [OPUS]);
    expect(BigInt(p.estimate.costMinor)).toBeLessThan(BigInt(p.max.costMinor));
    expect(p.estimate.tokens).toBeLessThanOrEqual(Math.ceil(p.max.tokens * 0.6) + p.tasks * 2);
    expect(p.estimate.tokensIn).toBeGreaterThan(p.estimate.tokensOut * 5);
    const low = planStage('C', GOLDEN_TASKS, [OPUS], {
      ...DEFAULT_COST_ASSUMPTIONS,
      usagePermille: 300,
    });
    expect(BigInt(low.estimate.costMinor)).toBeLessThan(BigInt(p.estimate.costMinor));
    expect(low.max).toEqual(p.max); // the maximum never depends on the assumptions
  });
  it('duration is sequential runs x seconds, rounded up', () => {
    const p = planStage('C', GOLDEN_TASKS, [OPUS]);
    expect(p.duration.estimatedMinutes).toBe(Math.ceil((83 * 45) / 60));
    expect(p.duration.maximumMinutes).toBe(Math.ceil((83 * 90) / 60));
  });
  it('D needs 2-4 prices of one currency and multiplies by the number of models', () => {
    expect(planStage('D', GOLDEN_TASKS, [OPUS]).problems.join()).toContain('model(s)');
    const d = planStage('D', GOLDEN_TASKS, [OPUS, OPUS]);
    const c = planStage('C', GOLDEN_TASKS, [OPUS]);
    expect(d.problems).toEqual([]);
    expect(d.runs).toBe(166);
    expect(d.max.costMinor).toBe((BigInt(c.max.costMinor) * 2n).toString());
    expect(
      planStage('D', GOLDEN_TASKS, [OPUS, { ...OPUS, currency: 'SAR' }]).problems.join(),
    ).toContain('currencies');
    expect(planStage('A', GOLDEN_TASKS, [OPUS, OPUS]).problems.length).toBeGreaterThan(0);
  });
  it('every stage ends cheaper than the one after it for the same model (A < B < C)', () => {
    const cost = (s: 'A' | 'B' | 'C') => BigInt(planStage(s, GOLDEN_TASKS, [OPUS]).max.costMinor);
    expect(cost('A')).toBeLessThan(cost('B'));
    expect(cost('B')).toBeLessThan(cost('C'));
  });
  it('monthly regression cost = core runs x core + full runs x full', () => {
    const m = planContinuousMonth(GOLDEN_TASKS, OPUS, { coreRunsPerMonth: 4, fullRunsPerMonth: 1 });
    expect(m.core.tasks).toBe(24);
    expect(BigInt(m.monthly.maxCostMinor)).toBe(
      BigInt(m.core.max.costMinor) * 4n + BigInt(m.full.max.costMinor),
    );
    expect(m.monthly.maxTokens).toBe(m.core.max.tokens * 4 + m.full.max.tokens);
  });
  it('programme exposure is at least the sum of the stages it contains', () => {
    const x = programmeExposure(GOLDEN_TASKS, OPUS, 3, 3);
    const c = planStage('C', GOLDEN_TASKS, [OPUS]);
    expect(BigInt(x.maxMinor)).toBeGreaterThan(BigInt(c.max.costMinor) * 4n);
    expect(BigInt(x.estimateMinor)).toBeLessThan(BigInt(x.maxMinor));
  });
  it('the reference rates are inputs marked to-be-confirmed, integer minor units, USD', () => {
    expect(REFERENCE_RATE_INPUTS.length).toBeGreaterThan(0);
    for (const r of REFERENCE_RATE_INPUTS) {
      expect(r.status).toBe('TO_BE_CONFIRMED_BY_S02_D6');
      expect(r.price.currency).toBe('USD');
      expect(r.price.minorPerMillionInput).toMatch(/^[1-9]\d*$/);
      expect(BigInt(r.price.minorPerMillionOutput)).toBeGreaterThan(
        BigInt(r.price.minorPerMillionInput),
      );
    }
  });
});

describe('a stage plan agrees with the live runner preflight', () => {
  const pre = (budget: LivePreconditions['budget']): LivePreconditions => ({
    flagEnabled: true,
    liveProviderGateOpen: true,
    environment: { name: 'staging', production: false },
    providerVerified: { providerId: 'p', model: 'm', evidenceRef: 'ev-1' },
    thresholdsAccepted: {
      version: THRESHOLDS_VERSION,
      acceptedBy: 'owner',
      acceptedAt: '2026-01-01',
    },
    budget,
    reviewers: [
      { id: 'r1', name: 'Reviewer One' },
      { id: 'r2', name: 'Reviewer Two' },
    ],
    securityReview: { ref: 'sec-1', reviewedBy: 'sec', completedAt: '2026-01-01', passed: true },
  });
  for (const s of ['A', 'B', 'C', 'E'] as const) {
    it(`stage ${s}: its proposed budget passes the preflight and one minor unit less does not`, () => {
      const plan = planStage(s, GOLDEN_TASKS, [OPUS]);
      const tasks = selectStageTasks(s, GOLDEN_TASKS);
      const budget = proposedBudgetFor(plan, 'bud-1', 'owner');
      const pf = preflightBudget(tasks, budget, OPUS);
      expect(pf.ok).toBe(true);
      expect(pf.worstCase).toEqual(plan.max);
      expect(livePreflight(pre(budget), tasks, OPUS).allowed).toBe(true);
      const tight = { ...budget, maxCostMinor: (BigInt(budget.maxCostMinor) - 1n).toString() };
      const refused = livePreflight(pre(tight), tasks, OPUS);
      expect(refused.allowed).toBe(false);
      expect(refused.refusals.map((r) => r.code)).toEqual(['BUDGET_TOO_SMALL']);
    });
  }
});

describe('stage entry (what must be true before it starts)', () => {
  const all = (ref: string): Partial<Record<PrerequisiteId, string>> =>
    Object.fromEntries(Object.keys(PREREQUISITES).map((k) => [k, ref]));
  it('fails closed: nothing satisfied means every prerequisite is missing', () => {
    for (const s of STAGES) {
      const e = evaluateStageEntry(s.id, { satisfied: {} });
      expect(e.canStart).toBe(false);
      expect(e.missing.map((m) => m.id)).toEqual(s.prerequisites);
    }
  });
  it('a blank or whitespace reference does not satisfy a prerequisite', () => {
    const e = evaluateStageEntry('A', { satisfied: { ...all('ev'), PROVIDER_VERIFIED: '  ' } });
    expect(e.canStart).toBe(false);
    expect(e.missing.map((m) => m.id)).toEqual(['PROVIDER_VERIFIED']);
  });
  it('every stage needs the provider, rates, spend cap, thresholds, budget, reviewers and security review', () => {
    for (const s of STAGES)
      for (const p of [
        'PROVIDER_VERIFIED',
        'RATES_CONFIRMED',
        'VENDOR_SPEND_CAP',
        'THRESHOLDS_ACCEPTED',
        'BUDGET_APPROVED_FOR_STAGE',
        'REVIEWERS_NAMED',
        'SECURITY_REVIEW_PASSED',
      ] as const)
        expect(s.prerequisites, `${s.id} ${p}`).toContain(p);
  });
  it('B-E need the previous stage; E also needs a recorded baseline; A needs neither', () => {
    const a = STAGES.find((s) => s.id === 'A')!;
    expect(a.prerequisites).not.toContain('PREVIOUS_STAGE_EXITED');
    for (const id of ['B', 'C', 'D', 'E'] as const)
      expect(STAGES.find((s) => s.id === id)!.prerequisites).toContain('PREVIOUS_STAGE_EXITED');
    expect(STAGES.find((s) => s.id === 'E')!.prerequisites).toContain('BASELINE_RECORDED');
    expect(evaluateStageEntry('E', { satisfied: all('ev') }).canStart).toBe(true);
  });
});

describe('calibration and exit criteria', () => {
  it('calibrates from measured usage, rounding up, and ignores an empty measurement', () => {
    const c = calibrateAssumptions({ tokensIn: 70_001, tokensOut: 9_000, ceilingTokens: 200_000 });
    expect(c.usagePermille).toBe(Math.ceil((79_001 * 1000) / 200_000));
    expect(c.inputSharePermille).toBe(Math.ceil((70_001 * 1000) / 79_001));
    expect(calibrateAssumptions({ tokensIn: 0, tokensOut: 0, ceilingTokens: 1 })).toEqual(
      DEFAULT_COST_ASSUMPTIONS,
    );
    expect(
      calibrateAssumptions({ tokensIn: 900, tokensOut: 900, ceilingTokens: 100 }).usagePermille,
    ).toBe(1000);
  });
  const plan = planStage('B', GOLDEN_TASKS, [OPUS]);
  const good: StageOutcome = {
    stage: 'B',
    status: 'COMPLETED',
    recorded: plan.runs,
    rejected: 0,
    modeViolations: 0,
    actual: { tokens: 400_000, requests: 100, costMinor: plan.estimate.costMinor },
    estimateCostMinor: plan.estimate.costMinor,
  };
  it('B exits when completed, fully recorded, within maximum, near the estimate, no violations', () => {
    expect(stageExited(evaluateStageExit(plan, good))).toBe(true);
  });
  it('each failing condition blocks the exit with its own check', () => {
    const bad = (o: Partial<StageOutcome>) =>
      evaluateStageExit(plan, { ...good, ...o })
        .filter((c) => !c.ok)
        .map((c) => c.id);
    expect(bad({ status: 'STOPPED_BUDGET' })).toEqual(['completed']);
    expect(bad({ recorded: plan.runs - 1 })).toEqual(['all_recorded']);
    expect(bad({ rejected: 1 })).toEqual(['all_recorded']);
    expect(bad({ modeViolations: 1 })).toEqual(['no_mode_violations']);
    expect(
      bad({
        actual: { tokens: 1, requests: 1, costMinor: (BigInt(plan.max.costMinor) + 1n).toString() },
      }),
    ).toContain('within_maximum');
    expect(
      bad({
        actual: { ...good.actual, costMinor: (BigInt(plan.estimate.costMinor) * 2n).toString() },
      }),
    ).toEqual(['near_estimate']);
  });
  it('C needs thresholds evaluated and a gate decision; E needs no blocking regression; D comparable', () => {
    const c = planStage('C', GOLDEN_TASKS, [OPUS]);
    const base: StageOutcome = {
      stage: 'C',
      status: 'COMPLETED',
      recorded: c.runs,
      rejected: 0,
      modeViolations: 0,
      actual: { tokens: 1, requests: 1, costMinor: '1' },
    };
    expect(stageExited(evaluateStageExit(c, base))).toBe(false);
    expect(
      stageExited(evaluateStageExit(c, { ...base, thresholdsEvaluated: true, gateAllowed: false })),
    ).toBe(true); // a FAILED gate is a valid, recorded outcome of the stage; it just does not qualify the model
    const e = planStage('E', GOLDEN_TASKS, [OPUS]);
    const eo: StageOutcome = {
      ...base,
      stage: 'E',
      recorded: e.runs,
      thresholdsEvaluated: true,
    };
    expect(stageExited(evaluateStageExit(e, eo))).toBe(false);
    expect(stageExited(evaluateStageExit(e, { ...eo, blockingRegressions: 0 }))).toBe(true);
    expect(stageExited(evaluateStageExit(e, { ...eo, blockingRegressions: 2 }))).toBe(false);
  });
  it('an empty check list never counts as exited', () => {
    expect(stageExited([])).toBe(false);
  });
});
