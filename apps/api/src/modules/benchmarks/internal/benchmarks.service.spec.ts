import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { benchmarks as bm } from '@nuzm/domain';
import type { AuditEvent } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { BenchmarkFlags, BenchmarksService, type BenchmarkEnv } from './benchmarks.service';
import { InMemoryBenchmarkStore } from './store';

const make = (enabled = true, env?: Partial<BenchmarkEnv>) => {
  const audit: AuditEvent[] = [];
  const flags = new (class extends BenchmarkFlags {
    enabled = () => Promise.resolve(enabled);
  })();
  const store = new InMemoryBenchmarkStore();
  let t = 0;
  const svc = new BenchmarksService(
    store,
    { record: (e: AuditEvent) => void audit.push(e) },
    flags,
    () => ({
      liveEnabled: false,
      liveProvidersConfigured: false,
      environmentName: '',
      production: false,
      ...env,
    }),
    () => new Date(Date.UTC(2026, 11, 1, 0, 0, t++)),
  );
  return { svc, audit, store };
};
const rid = () => ({ requestId: randomUUID() });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProblemException) return `${e.code}: ${e.detail}`;
    throw e;
  }
  return 'no error';
};

describe('BenchmarksService (in-memory store)', () => {
  it('is off by default: overview says so and every action is refused', async () => {
    const { svc } = make(false);
    expect(await svc.overview()).toEqual({ enabled: false });
    expect(await code(svc.runOffline('u', { source: 'reference', ...rid() }))).toMatch(
      /kind_not_available/,
    );
    expect(await code(svc.attemptLiveRun('u', rid()))).toMatch(/kind_not_available/);
  });

  it('records an offline reference run, idempotently, labelled as evidence that is not a model', async () => {
    const { svc, audit } = make();
    const req = rid();
    const a = await svc.runOffline('u1', { source: 'reference', ...req });
    const b = await svc.runOffline('u1', { source: 'reference', ...req });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, id: a.id });
    expect(a.evidence).toBe('OFFLINE_REFERENCE_ORACLE');
    expect(audit.filter((e) => e.action === 'ai.benchmark.run_recorded')).toHaveLength(1);
    const full = await svc.getRun(a.id);
    expect(full.markdown).toContain('OFFLINE_REFERENCE_ORACLE');
    expect(JSON.stringify(full)).not.toMatch(/real[- ]model performance/i);
  });

  it('refuses any source except the reference oracle and scripted mocks (no recorded run can be created here)', async () => {
    const { svc } = make();
    for (const source of ['recorded', 'live', 'mock:unknown', 'claude', ''])
      expect(await code(svc.runOffline('u', { source, ...rid() })), source).toMatch(
        /validation_failed/,
      );
    expect(await code(svc.runOffline('u', { source: 'reference' }))).toMatch(/requestId/);
    expect((await svc.runOffline('u', { source: 'mock:ideal', ...rid() })).evidence).toBe(
      'OFFLINE_MOCK_REPLAY',
    );
  });

  it('compares stored runs and refuses a comparison with fewer than two', async () => {
    const { svc } = make();
    const a = await svc.runOffline('u', { source: 'mock:ideal', ...rid() });
    const b = await svc.runOffline('u', { source: 'mock:half-done', ...rid() });
    const c = (await svc.compare([a.id, b.id])) as bm.ModelComparison;
    expect(c.comparable).toBe(true);
    expect(c.notModelEvidence).toBe(true);
    expect(c.ranking[0]).toContain('mock:ideal');
    expect(await code(svc.compare([a.id]))).toMatch(/2 to 6/);
    expect(await code(svc.compare([a.id, 'nope']))).toMatch(/not_found/);
  });

  it('the gate is closed on a fresh system and stays closed on reference/mock evidence even with every owner input recorded', async () => {
    const { svc } = make();
    const run = await svc.runOffline('u', { source: 'mock:ideal', ...rid() });
    const empty = await svc.evaluateGate('u', { runId: run.id });
    expect(empty.decision.allowed).toBe(false);
    await svc.acceptThresholds('owner', {
      version: bm.THRESHOLDS_VERSION,
      noBaselineAllowed: true,
      ...rid(),
    });
    await svc.recordSecurityReview('owner', {
      ref: 'SEC-1',
      reviewedBy: 'Someone',
      passed: true,
      ...rid(),
    });
    const g = await svc.evaluateGate('u', { runId: run.id });
    expect(g.decision.allowed).toBe(false);
    expect(g.decision.checks.find((c) => c.id === 'evidence-recorded')!.ok).toBe(false);
    expect(g.decision.checks.find((c) => c.id === 'thresholds-accepted')!.ok).toBe(true);
    expect(g.decision.checks.find((c) => c.id === 'security-review')!.ok).toBe(true);
    expect(g.decision.checks.find((c) => c.id === 'human-acceptance')!.ok).toBe(false);
  });

  it('accepting thresholds must name the exact version in force', async () => {
    const { svc } = make();
    expect(await code(svc.acceptThresholds('o', { version: '1-proposed', ...rid() }))).toMatch(
      /exactly that version/,
    );
    const ok = await svc.acceptThresholds('o', { version: bm.THRESHOLDS_VERSION, ...rid() });
    expect(ok.acceptance).toMatchObject({ acceptedBy: 'o', version: bm.THRESHOLDS_VERSION });
    expect(((await svc.overview()) as { thresholds: { status: string } }).thresholds.status).toBe(
      'ACCEPTED',
    );
  });

  it('validates the budget', async () => {
    const { svc } = make();
    expect(
      await code(
        svc.setBudget('o', {
          ref: 'B',
          currency: 'US',
          maxCostMinor: '100',
          maxTokens: 10,
          maxRequests: 10,
          ...rid(),
        }),
      ),
    ).toMatch(/ISO code/);
    expect(
      await code(
        svc.setBudget('o', {
          ref: 'B',
          currency: 'USD',
          maxCostMinor: '0',
          maxTokens: 10,
          maxRequests: 10,
          ...rid(),
        }),
      ),
    ).toMatch(/positive integer/);
    const b = await svc.setBudget('o', {
      ref: 'B',
      currency: 'USD',
      maxCostMinor: '5000',
      maxTokens: 100000,
      maxRequests: 500,
      ...rid(),
    });
    expect(b.budget).toMatchObject({ approvedBy: 'o', maxTokens: 100000 });
  });

  it('runs the reviewer workflow end to end with blind ids, and reports the measured acceptance', async () => {
    const { svc } = make();
    const run = await svc.runOffline('u', { source: 'mock:ideal', ...rid() });
    expect(await code(svc.createReviewPlan('u', { runId: run.id, ...rid() }))).toMatch(
      /at least 2 named reviewers/,
    );
    await svc.setReviewers('u', {
      reviewers: [
        { id: 'r1', name: 'Reviewer One' },
        { id: 'r2', name: 'Reviewer Two' },
      ],
      ...rid(),
    });
    const plan = await svc.createReviewPlan('u', { runId: run.id, sampleSize: 20, ...rid() });
    expect(plan.items).toHaveLength(20);
    expect(JSON.stringify(plan)).not.toMatch(/mock/);
    for (const it of plan.items)
      for (const reviewerId of it.reviewerIds)
        await svc.submitReview(reviewerId, {
          planId: plan.planId,
          taskId: it.taskId,
          reviewerId,
          scores: { correctness: 4, quality: 4, ui: 4, security: 4 },
          accept: true,
          ...rid(),
        });
    const s = await svc.reviewSummary(plan.planId);
    expect(s).toMatchObject({ status: 'MEASURED', rate: 1, meets: true });
    expect(
      await code(
        svc.submitReview('r1', {
          planId: plan.planId,
          taskId: plan.items[0]!.taskId,
          reviewerId: 'r1',
          scores: { correctness: 9, quality: 4, ui: 4, security: 4 },
          accept: true,
          ...rid(),
        }),
      ),
    ).toMatch(/already reviewed|integer from 1 to 5/);
  });

  it('qualification: a mock run can never qualify a model', async () => {
    const { svc } = make();
    const run = await svc.runOffline('u', { source: 'mock:ideal', ...rid() });
    const q = (
      await svc.proposeQualification('alice', { adapterId: 'claude', model: 'm1', ...rid() })
    ).qualification;
    const r = await code(
      svc.qualificationEvent('alice', {
        qualificationId: q.id,
        type: 'attach_evidence',
        runId: run.id,
        ...rid(),
      }),
    );
    expect(r).toMatch(/only a recorded run of the model can qualify it/);
    expect(
      await code(
        svc.qualificationEvent('bob', { qualificationId: q.id, type: 'approve', ...rid() }),
      ),
    ).toMatch(/cannot approve in state PROPOSED/);
    expect(
      await code(
        svc.qualificationEvent('bob', { qualificationId: 'missing', type: 'approve', ...rid() }),
      ),
    ).toMatch(/not_found/);
    expect((await svc.qualifications())[0]).toMatchObject({
      state: 'PROPOSED',
      effectiveState: 'PROPOSED',
    });
  });

  it('the live run is never started: every attempt is refused, recorded and audited, even with the environment fully configured', async () => {
    const { svc, audit } = make(true, {
      liveEnabled: true,
      liveProvidersConfigured: true,
      environmentName: 'staging',
    });
    const r = await svc.attemptLiveRun('o', rid());
    expect(r.started).toBe(false);
    const codes = r.refusals.map((x) => x.code);
    expect(codes).toContain('NO_CAPTURE_SOURCE');
    expect(codes).toContain('PROVIDER_NOT_VERIFIED');
    expect(codes).toContain('THRESHOLDS_NOT_ACCEPTED');
    expect(codes).toContain('BUDGET_NOT_APPROVED');
    expect(codes).toContain('REVIEWERS_NOT_NAMED');
    expect(codes).toContain('SECURITY_REVIEW_MISSING');
    expect(codes).not.toContain('FLAG_OFF');
    expect(
      audit.some((e) => e.action === 'ai.benchmark.live_run_refused' && e.outcome === 'failure'),
    ).toBe(true);
    const def = await make().svc.attemptLiveRun('o', rid());
    expect(def.refusals.map((x) => x.code)).toEqual(
      expect.arrayContaining(['FLAG_OFF', 'LIVE_GATE_CLOSED', 'ENVIRONMENT_NOT_ALLOWED']),
    );
  });

  it('a live attempt is per stage: it reports the stage plan (estimated and maximum cost) and the missing prerequisites, and still never starts', async () => {
    const { svc } = make(true, {
      liveEnabled: true,
      liveProvidersConfigured: true,
      environmentName: 'staging',
    });
    const a = await svc.attemptLiveRun('o', { stage: 'A', ...rid() });
    expect(a.stage).toBe('A');
    expect(a.plan.tasks).toBe(5);
    expect(a.plan).not.toHaveProperty('taskIds');
    expect(a.entry.canStart).toBe(false);
    const missing = a.entry.missing.map((m) => m.id);
    expect(missing).toEqual(
      expect.arrayContaining(['PROVIDER_VERIFIED', 'CAPTURE_SOURCE_BUILT', 'VENDOR_SPEND_CAP']),
    );
    expect(missing).not.toContain('FLAG_ON');
    expect((await svc.attemptLiveRun('o', { ...rid() })).stage).toBe('A'); // the smallest stage is the default
    expect((await svc.attemptLiveRun('o', { stage: 'C', ...rid() })).plan.tasks).toBe(
      bm.GOLDEN_TASKS.length,
    );
    expect(await code(svc.attemptLiveRun('o', { stage: 'Z', ...rid() }))).toMatch(
      /validation_failed/,
    );
  });

  it('the approved budget carries the price card its caps were sized with; without one the preflight refuses (a zero price would fit any cap)', async () => {
    const { svc } = make(true, {
      liveEnabled: true,
      liveProvidersConfigured: true,
      environmentName: 'staging',
    });
    const caps = {
      ref: 'BUD-9',
      currency: 'USD',
      maxCostMinor: '9000',
      maxTokens: 4_200_000,
      maxRequests: 500,
    };
    await svc.setBudget('owner', { ...caps, ...rid() });
    const noPrice = await svc.attemptLiveRun('o', { stage: 'C', ...rid() });
    expect(noPrice.refusals.map((x) => x.code)).toContain('PRICE_CARD_INVALID');
    expect(noPrice.entry.missing.map((m) => m.id)).toContain('RATES_CONFIRMED');
    await svc.setBudget('owner', {
      ...caps,
      ref: 'BUD-10',
      price: {
        minorPerMillionInput: '400',
        minorPerMillionOutput: '2000',
        source: 'agreement ref 1',
      },
      ...rid(),
    });
    const priced = await svc.attemptLiveRun('o', { stage: 'C', ...rid() });
    const codes = priced.refusals.map((x) => x.code);
    expect(codes).not.toContain('PRICE_CARD_INVALID');
    expect(codes).not.toContain('BUDGET_TOO_SMALL'); // 9,000 cents covers the 8,360-cent worst case of stage C
    expect(priced.entry.missing.map((m) => m.id)).not.toContain('RATES_CONFIRMED');
    expect(priced.started).toBe(false);
  });

  it('a budget price must be positive integers with a stated source', async () => {
    const { svc } = make();
    const base = {
      ref: 'B',
      currency: 'USD',
      maxCostMinor: '100',
      maxTokens: 1000,
      maxRequests: 10,
    };
    for (const price of [
      { minorPerMillionInput: '0', minorPerMillionOutput: '10', source: 's' },
      { minorPerMillionInput: '1.5', minorPerMillionOutput: '10', source: 's' },
      { minorPerMillionInput: '5', minorPerMillionOutput: '10' },
      'free',
    ])
      expect(await code(svc.setBudget('o', { ...base, price, ...rid() }))).toMatch(
        /validation_failed/,
      );
  });

  it('overview lists the dataset, thresholds (PROPOSED), runs and the unavailable live runner', async () => {
    const { svc } = make();
    await svc.runOffline('u', { source: 'reference', ...rid() });
    const o = (await svc.overview()) as Extract<
      Awaited<ReturnType<BenchmarksService['overview']>>,
      { enabled: true }
    >;
    expect(o.dataset).toMatchObject({ version: bm.DATASET_VERSION, tasks: bm.GOLDEN_TASKS.length });
    expect(o.dataset.categories).toHaveLength(23);
    expect(o.thresholds).toMatchObject({ status: 'PROPOSED', version: bm.THRESHOLDS_VERSION });
    expect(o.thresholds.items).toHaveLength(20);
    expect(o.runs).toHaveLength(1);
    expect(o.live.available).toBe(false);
    const st = o.live.stages;
    expect(st.plans.map((p) => p.stage)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(st.rateBasis.status).toBe('TO_BE_CONFIRMED_BY_S02_D6'); // the list price is a labelled reference, not an approved rate
    for (const p of st.plans)
      expect(BigInt(p.estimate.costMinor)).toBeLessThan(BigInt(p.max.costMinor));
    expect(st.definitions).toHaveLength(5);
    expect(BigInt(st.monthly.maxCostMinor)).toBeGreaterThan(0n);
  });

  it('a stored run exposes the seven-dimension scorecard', async () => {
    const { svc } = make();
    const run = await svc.runOffline('u', { source: 'reference', ...rid() });
    const got = await svc.getRun(run.id);
    expect(got.scorecard.map((r) => r.dimension)).toEqual([...bm.SCORECARD_DIMENSIONS]);
    expect(got.scorecard.find((r) => r.dimension === 'arabic-rtl')!.value).toBe(1);
  });
});
