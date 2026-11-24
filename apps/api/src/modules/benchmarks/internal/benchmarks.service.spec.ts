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
/** proposal by `dev`, an approving review by `rev`, so that `owner` may accept (the workflow's four eyes) */
const readyForAcceptance = async (svc: BenchmarksService) => {
  await svc.proposeThresholds('dev', {
    version: bm.THRESHOLDS_VERSION,
    summary: 'recommended set',
    ...rid(),
  });
  await svc.reviewThresholds('rev', {
    version: bm.THRESHOLDS_VERSION,
    verdict: 'approve',
    note: 'checked',
    ...rid(),
  });
};
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
    await readyForAcceptance(svc);
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

  it('accepting thresholds must name the exact version in force and needs a proposal and an approving review first', async () => {
    const { svc } = make();
    expect(await code(svc.acceptThresholds('o', { version: '1-proposed', ...rid() }))).toMatch(
      /exactly that version/,
    );
    // never auto-set: without a proposal and a review there is nothing to accept
    expect(
      await code(svc.acceptThresholds('o', { version: bm.THRESHOLDS_VERSION, ...rid() })),
    ).toMatch(/no proposal/);
    expect(((await svc.overview()) as { thresholds: { status: string } }).thresholds.status).toBe(
      'PROPOSED',
    );
    await readyForAcceptance(svc);
    const ok = await svc.acceptThresholds('o', { version: bm.THRESHOLDS_VERSION, ...rid() });
    expect(ok.acceptance).toMatchObject({ acceptedBy: 'o', version: bm.THRESHOLDS_VERSION });
    expect(((await svc.overview()) as { thresholds: { status: string } }).thresholds.status).toBe(
      'ACCEPTED',
    );
  });

  it('threshold governance end to end: propose, review, reject (recorded with a reason), propose again, accept; every step audited and idempotent', async () => {
    const { svc, audit } = make();
    const V = bm.THRESHOLDS_VERSION;
    const p = rid();
    const a = await svc.proposeThresholds('dev', { version: V, summary: 'recommended set', ...p });
    const b = await svc.proposeThresholds('dev', { version: V, summary: 'recommended set', ...p });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false); // the same requestId: the stored event, not a second proposal
    // the proposer cannot review; a reviewer must leave a note and a valid verdict
    expect(
      await code(
        svc.reviewThresholds('dev', { version: V, verdict: 'approve', note: 'x', ...rid() }),
      ),
    ).toMatch(/proposer/);
    expect(
      await code(svc.reviewThresholds('rev', { version: V, verdict: 'approve', ...rid() })),
    ).toMatch(/note is required/);
    expect(
      await code(svc.reviewThresholds('rev', { version: V, verdict: 'meh', note: 'x', ...rid() })),
    ).toMatch(/verdict/);
    await svc.reviewThresholds('rev', {
      version: V,
      verdict: 'request_changes',
      note: 'T08 is too strict',
      ...rid(),
    });
    // changes requested: the owner cannot accept
    expect(await code(svc.acceptThresholds('owner', { version: V, ...rid() }))).toMatch(
      /proposed again/,
    );
    // the owner rejects, with a reason; a rejection without one is refused
    expect(await code(svc.rejectThresholds('owner', { version: V, ...rid() }))).toMatch(
      /reason is required/,
    );
    await svc.rejectThresholds('owner', { version: V, reason: 'revise T08 first', ...rid() });
    let o = (await svc.overview()) as {
      thresholds: { status: string; governance: { state: string; reason: string } };
    };
    expect(o.thresholds.governance).toMatchObject({
      state: 'REJECTED',
      reason: 'revise T08 first',
    });
    expect(o.thresholds.status).toBe('PROPOSED');
    // a new round
    await svc.proposeThresholds('dev', { version: V, summary: 'T08 relaxed', ...rid() });
    await svc.reviewThresholds('rev', { version: V, verdict: 'approve', note: 'ok now', ...rid() });
    await svc.acceptThresholds('owner', { version: V, ...rid() });
    o = (await svc.overview()) as typeof o;
    expect(o.thresholds.governance.state).toBe('ACCEPTED');
    expect(o.thresholds.status).toBe('ACCEPTED');
    // an accepted version cannot be proposed again; the owner can still withdraw it by rejecting
    expect(
      await code(svc.proposeThresholds('dev', { version: V, summary: 'again', ...rid() })),
    ).toMatch(/new version/);
    await svc.rejectThresholds('owner', { version: V, reason: 'withdrawn', ...rid() });
    expect(((await svc.overview()) as typeof o).thresholds.status).toBe('PROPOSED');
    const actions = audit
      .map((e) => e.action)
      .filter((x) => x.startsWith('ai.benchmark.thresholds_'));
    expect(actions).toEqual([
      'ai.benchmark.thresholds_proposed',
      'ai.benchmark.thresholds_reviewed',
      'ai.benchmark.thresholds_rejected',
      'ai.benchmark.thresholds_proposed',
      'ai.benchmark.thresholds_reviewed',
      'ai.benchmark.thresholds_accepted',
      'ai.benchmark.thresholds_rejected',
    ]);
  });

  it('a stored plain acceptance from before the workflow grants nothing (it is not an event)', async () => {
    const { svc, store } = make();
    await store.insertRecord({
      id: randomUUID(),
      kind: 'threshold_acceptance',
      subject: 'thresholds',
      payload: {
        version: bm.THRESHOLDS_VERSION,
        acceptedBy: 'someone',
        acceptedAt: '2026-12-01T00:00:00Z',
      },
      requestId: null,
      recordedBy: randomUUID(),
      recordedAt: '2026-12-01T00:00:00Z',
    });
    expect(((await svc.overview()) as { thresholds: { status: string } }).thresholds.status).toBe(
      'PROPOSED',
    );
  });

  it('a malformed run id is a not-found answer, never a database error', async () => {
    const { svc } = make();
    expect(await code(svc.getRun('not-a-uuid'))).toMatch(/not_found/);
    expect(await code(svc.getRun(randomUUID()))).toMatch(/not_found/);
    expect(await code(svc.evaluateGate('u', { runId: "1' OR '1'='1" }))).toMatch(/not_found/);
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

  it('the whole administration workflow end to end, on a SIMULATED stand-in for a recorded run: thresholds, budget, reviewers, security review, human scoring, gate, qualification', async () => {
    const { svc, store, audit } = make();
    // A recorded run cannot be created through the API (only the gated live runner can, and it does not exist yet), so the test inserts the row a future capture would leave.
    // It is built from reference recordings stamped RECORDED with provenance: a SIMULATION of the shape, not evidence about any model.
    const recs = new Map(
      bm.GOLDEN_TASKS.map((t) => [
        t.id,
        {
          ...bm.referenceRecording(t),
          origin: 'RECORDED' as const,
          capture: {
            runId: 'sim-1',
            approvalRef: 'APR-1',
            providerEvidenceRef: 'EV-1',
            capturedAt: '2026-12-01T00:00:00Z',
          },
        },
      ]),
    );
    const { report, scores } = bm.runSuite(bm.GOLDEN_TASKS, recs);
    const runId = randomUUID();
    await store.insertRun({
      id: runId,
      label: 'simulated recorded run',
      datasetVersion: report.datasetVersion,
      datasetHash: report.datasetHash,
      evidenceLabel: report.evidence.label,
      origins: report.origins,
      adapters: report.adapters,
      report,
      scores,
      reportFingerprint: bm.reportFingerprint(report),
      requestId: randomUUID(),
      createdBy: randomUUID(),
      createdAt: '2026-12-01T00:00:00Z',
    });
    const V = bm.THRESHOLDS_VERSION;
    // 1. before anything is recorded the gate is closed, with the reasons
    const closed = await svc.evaluateGate('ops', { runId, baselineRunId: undefined });
    expect(closed.decision.allowed).toBe(false);
    const failed = (g: typeof closed) => g.decision.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(failed(closed)).toEqual(
      expect.arrayContaining(['thresholds-accepted', 'security-review', 'human-acceptance']),
    );
    // 2. thresholds: proposed, reviewed, ACCEPTED by a person (recorded, never auto-set)
    await svc.proposeThresholds('dev', { version: V, summary: 'recommended set', ...rid() });
    await svc.reviewThresholds('rev', {
      version: V,
      verdict: 'approve',
      note: 'checked',
      ...rid(),
    });
    await svc.acceptThresholds('owner', { version: V, noBaselineAllowed: true, ...rid() });
    // 3. budget with its price, security review, reviewers
    await svc.setBudget('owner', {
      ref: 'BUD-1',
      currency: 'USD',
      maxCostMinor: '9000',
      maxTokens: 4_200_000,
      maxRequests: 500,
      price: {
        minorPerMillionInput: '400',
        minorPerMillionOutput: '2000',
        source: 'agreement ref',
      },
      ...rid(),
    });
    await svc.recordSecurityReview('owner', {
      ref: 'SEC-1',
      reviewedBy: 'Security Person',
      passed: true,
      ...rid(),
    });
    await svc.setReviewers('ops', {
      reviewers: [
        { id: 'r1', name: 'Reviewer One' },
        { id: 'r2', name: 'Reviewer Two' },
      ],
      ...rid(),
    });
    // 4. human scoring on a blind plan
    const plan = await svc.createReviewPlan('ops', { runId, sampleSize: 20, ...rid() });
    for (const it of plan.items)
      for (const reviewerId of it.reviewerIds)
        await svc.submitReview(reviewerId, {
          planId: plan.planId,
          taskId: it.taskId,
          reviewerId,
          scores: { correctness: 5, quality: 4, ui: 4, security: 5 },
          accept: true,
          ...rid(),
        });
    expect(await svc.reviewSummary(plan.planId)).toMatchObject({ status: 'MEASURED', meets: true });
    // 5. the gate now allows the rollout
    const open = await svc.evaluateGate('ops', { runId });
    expect(failed(open)).toEqual([]);
    expect(open.decision).toMatchObject({ allowed: true, status: 'PASS' });
    // 6. qualification: proposer attaches evidence and reviews, a DIFFERENT person approves
    const q = (
      await svc.proposeQualification('alice', {
        adapterId: 'claude',
        model: 'claude-opus-5-5',
        ...rid(),
      })
    ).qualification;
    await svc.qualificationEvent('alice', {
      qualificationId: q.id,
      type: 'attach_evidence',
      runId,
      ...rid(),
    });
    await svc.qualificationEvent('alice', {
      qualificationId: q.id,
      type: 'record_reviews',
      planId: plan.planId,
      ...rid(),
    });
    expect(
      await code(
        svc.qualificationEvent('alice', { qualificationId: q.id, type: 'approve', ...rid() }),
      ),
    ).toMatch(/proposer|four|same|cannot/i);
    const done = await svc.qualificationEvent('bob', {
      qualificationId: q.id,
      type: 'approve',
      ...rid(),
    });
    expect(done.qualification).toMatchObject({
      state: 'QUALIFIED',
      effectiveState: 'QUALIFIED',
      approvedBy: 'bob',
    });
    // 7. withdrawing the threshold acceptance expires the basis: a gate evaluated now is closed again
    await svc.rejectThresholds('owner', { version: V, reason: 'withdrawn after review', ...rid() });
    const after = await svc.evaluateGate('ops', { runId });
    expect(after.decision.allowed).toBe(false);
    expect(failed(after)).toContain('thresholds-accepted');
    // every step left an audit event
    const actions = new Set(audit.map((e) => e.action));
    for (const a of [
      'ai.benchmark.thresholds_accepted',
      'ai.benchmark.budget_set',
      'ai.benchmark.review_plan_created',
      'ai.benchmark.gate_evaluated',
      'ai.benchmark.qualification_changed',
    ])
      expect(actions.has(a), a).toBe(true);
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
