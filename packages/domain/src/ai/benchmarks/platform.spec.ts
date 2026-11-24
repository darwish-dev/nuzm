import { describe, expect, it } from 'vitest';
import {
  BudgetLedger,
  CATEGORY_PASS_FLOOR,
  DATASET_VERSION,
  GOLDEN_TASKS,
  MOCK_PROFILES,
  REVIEW_PROTOCOL,
  THRESHOLDS_VERSION,
  UncertainCaptureError,
  compareModels,
  createReviewPlan,
  detectRegressions,
  effectiveState,
  evaluateRolloutGate,
  evaluateThresholds,
  isQualified,
  livePreflight,
  mockSuite,
  preflightBudget,
  proposeQualification,
  recordingProblem,
  referenceRecording,
  regressions,
  renderReport,
  renderReportCsv,
  renderReportJson,
  reportFingerprint,
  runLiveBenchmark,
  runSuite,
  signTest,
  stepQualification,
  summarizeReviews,
  taskRegressions,
  validateReview,
  type BenchmarkBudget,
  type BenchmarkReport,
  type CaptureSource,
  type GateInput,
  type HumanAcceptanceResult,
  type LivePreconditions,
  type PriceCard,
  type QualificationEvidence,
  type Recording,
  type Review,
  type Reviewer,
} from './index';

const CAPTURE = {
  runId: 'run-1',
  approvalRef: 'BUD-1',
  providerEvidenceRef: 'EV-1',
  capturedAt: '2026-01-01T00:00:00Z',
};
const asRecorded = (m: Map<string, Recording>): Map<string, Recording> =>
  new Map([...m].map(([k, v]) => [k, { ...v, origin: 'RECORDED' as const, capture: CAPTURE }]));
const refs = () => new Map(GOLDEN_TASKS.map((t) => [t.id, referenceRecording(t)]));
const recordedIdeal = () => asRecorded(mockSuite(GOLDEN_TASKS, 'ideal'));
const rate = { creditsPerMillionInput: '3', creditsPerMillionOutput: '15' };

describe('reports', () => {
  const { report } = runSuite(GOLDEN_TASKS, refs(), rate);
  it('carry the dataset version and hash, breakdowns by category, dimensions, cost and an explicit evidence label', () => {
    expect(report.datasetVersion).toBe(DATASET_VERSION);
    expect(report.datasetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(report.byCategory)).toHaveLength(23);
    expect(report.evidence.label).toBe('OFFLINE_REFERENCE_ORACLE');
    expect(report.evidence.disclaimer).toMatch(/not by a model/);
    expect(report.overall.meanSecurity).toBe(100);
    expect(report.overall.meanEfficiency).toBeGreaterThan(90);
    expect(report.creditsPerPassedTask).toMatch(/^\d+$/);
    expect(renderReport(report)).toContain('| category |');
    expect(renderReport(report)).toContain('Evidence: OFFLINE_REFERENCE_ORACLE');
  });
  it('labels each origin and never calls offline replay real-model performance', () => {
    expect(runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'ideal')).report.evidence.label).toBe(
      'OFFLINE_MOCK_REPLAY',
    );
    expect(runSuite(GOLDEN_TASKS, recordedIdeal()).report.evidence.label).toBe(
      'OFFLINE_REPLAY_OF_RECORDED_RUN',
    );
    const mixed = refs();
    mixed.set(GOLDEN_TASKS[0]!.id, { ...mixed.get(GOLDEN_TASKS[0]!.id)!, origin: 'MOCK' });
    expect(runSuite(GOLDEN_TASKS, mixed).report.evidence.label).toBe(
      'MIXED_ORIGINS_NOT_COMPARABLE',
    );
    expect(runSuite(GOLDEN_TASKS, new Map()).report.evidence.label).toBe('NONE');
    for (const r of [report, runSuite(GOLDEN_TASKS, recordedIdeal()).report])
      expect(JSON.stringify(r)).not.toMatch(/real[- ]model performance|verified model/i);
  });
  it('a RECORDED run without capture provenance, and a recording of another dataset version, are rejected and listed (never scored)', () => {
    const m = recordedIdeal();
    const a = GOLDEN_TASKS[0]!.id;
    const b = GOLDEN_TASKS[1]!.id;
    const noCapture = { ...m.get(a)! };
    delete noCapture.capture;
    m.set(a, noCapture);
    m.set(b, { ...m.get(b)!, datasetVersion: '0.0.1' });
    const r = runSuite(GOLDEN_TASKS, m).report;
    expect(r.rejectedRecordings.map((x) => x.taskId)).toEqual([a, b]);
    expect(r.tasks).toBe(GOLDEN_TASKS.length - 2);
    expect(recordingProblem(m.get(a)!, DATASET_VERSION)).toMatch(/capture provenance/);
  });
  it('serializes deterministically (JSON with sorted keys, CSV) and fingerprints', () => {
    const again = runSuite(GOLDEN_TASKS, refs(), rate).report;
    expect(renderReportJson(report)).toBe(renderReportJson(again));
    expect(reportFingerprint(report)).toBe(reportFingerprint(again));
    const csv = renderReportCsv(report).split('\n');
    expect(csv[0]).toContain('meanSecurity');
    expect(csv).toHaveLength(1 + 1 + 4 + 23);
  });
  it('the insecure mock passes the functional checks but is charged by the security dimension', () => {
    const r = runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'insecure')).report;
    expect(r.overall.passRate).toBe(1);
    expect(r.overall.meanSecurity!).toBeLessThan(100);
    expect(r.findingsByRule['S02-eval']).toBeGreaterThan(0);
    expect(evaluateThresholds(r).find((x) => x.id === 'T12')!.status).toBe('FAIL');
  });
  it('the leaky mock produces mode violations (T02) and the half-done mock fails tasks', () => {
    expect(
      runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'leaky')).report.overall.modeViolations,
    ).toBeGreaterThan(0);
    expect(
      runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'half-done')).report.overall.passRate,
    ).toBeLessThan(0.9);
  });
});

describe('model comparison', () => {
  const entry = (label: string, m: Map<string, Recording>) => {
    const r = runSuite(GOLDEN_TASKS, m, rate);
    return { label, report: r.report, scores: r.scores };
  };
  const ideal = entry('ideal', recordedIdeal());
  const half = entry('half-done', asRecorded(mockSuite(GOLDEN_TASKS, 'half-done')));
  const verbose = entry('verbose', asRecorded(mockSuite(GOLDEN_TASKS, 'verbose')));
  it('ranks deterministically, reports pairwise wins and a sign test, and category leaders', () => {
    const c = compareModels([half, ideal, verbose]);
    expect(c.comparable).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.notModelEvidence).toBe(false);
    expect(c.ranking[2]).toBe('half-done');
    expect(c.ranking.slice(0, 2).sort()).toEqual(['ideal', 'verbose']);
    const p = c.pairwise.find((x) => x.a === 'half-done' && x.b === 'ideal')!;
    expect(p.bWins).toBeGreaterThan(0);
    expect(p.aWins).toBe(0);
    expect(p.signTestP).toBeLessThan(0.001);
    expect(Object.keys(c.categoryLeaders)).toHaveLength(23);
    expect(JSON.stringify(compareModels([ideal, half, verbose]).rows.map((r) => r.label))).toBe(
      JSON.stringify(c.rows.map((r) => r.label)),
    );
  });
  it('cost breaks the tie between equally good models: the cheaper ranks first', () => {
    expect(compareModels([verbose, ideal]).ranking).toEqual(['ideal', 'verbose']);
  });
  it('refuses to call reports of different dataset versions comparable, and flags non-model evidence', () => {
    const other: typeof ideal = {
      ...ideal,
      label: 'old',
      report: { ...ideal.report, datasetVersion: '1.0.0' },
    };
    const c = compareModels([ideal, other]);
    expect(c.comparable).toBe(false);
    expect(c.problems.join(' ')).toMatch(/different dataset versions/);
    const ref = entry('ref', refs());
    expect(compareModels([ideal, ref]).notModelEvidence).toBe(true);
    expect(compareModels([ideal]).comparable).toBe(false);
  });
  it('the exact sign test is right on known values', () => {
    expect(signTest(0, 0)).toBeNull();
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(0, 5)).toBe(0.0625);
    expect(signTest(1, 9)).toBe(0.0215);
  });
  it('every mock profile is a deterministic MOCK recording', () => {
    for (const p of MOCK_PROFILES) {
      const a = mockSuite(GOLDEN_TASKS, p);
      expect(JSON.stringify([...a])).toBe(JSON.stringify([...mockSuite(GOLDEN_TASKS, p)]));
      expect([...a.values()].every((r) => r.origin === 'MOCK')).toBe(true);
    }
  });
});

describe('regression detection', () => {
  const base = runSuite(GOLDEN_TASKS, recordedIdeal()).report;
  it('is silent on an identical report and flags each kind of regression with its severity', () => {
    expect(detectRegressions(base, base)).toEqual([]);
    const half = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'half-done'))).report;
    const r = detectRegressions(half, base);
    expect(r.some((x) => x.metric === 'passRate' && x.severity === 'BLOCKING')).toBe(true);
    expect(r.some((x) => x.scope.startsWith('category '))).toBe(true);
    const leaky = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'leaky'))).report;
    expect(detectRegressions(leaky, base).some((x) => x.metric === 'modeViolations')).toBe(true);
    const ins = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'insecure'))).report;
    expect(
      detectRegressions(ins, base).some(
        (x) => x.metric === 'meanSecurity' || x.metric === 'minSecurity',
      ),
    ).toBe(true);
    const verbose = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'verbose'))).report;
    expect(detectRegressions(verbose, base).some((x) => x.metric === 'meanTokens')).toBe(true);
    const slow = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'slow'))).report;
    const sl = detectRegressions(slow, base).filter((x) => x.metric === 'p95LatencyMs');
    expect(sl[0]?.severity).toBe('WARNING');
    expect(regressions(slow, base).join(' ')).not.toMatch(/p95/);
  });
  it('a baseline of another dataset version is itself blocking, and a category that vanished is flagged', () => {
    const old = { ...base, datasetVersion: '1.0.0' };
    expect(detectRegressions(base, old)[0]).toMatchObject({
      scope: 'dataset',
      severity: 'BLOCKING',
    });
    const partial = runSuite(
      GOLDEN_TASKS.filter((t) => t.category !== 'erp'),
      recordedIdeal(),
    ).report;
    expect(
      detectRegressions(partial, base).some(
        (x) => x.scope === 'category erp' && x.metric === 'coverage',
      ),
    ).toBe(true);
  });
  it('lists tasks that passed before and fail now', () => {
    const a = runSuite(GOLDEN_TASKS, recordedIdeal());
    const b = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'half-done')));
    const ids = taskRegressions(b.scores, a.scores);
    expect(ids.length).toBeGreaterThan(0);
    expect(taskRegressions(a.scores, a.scores)).toEqual([]);
  });
});

const goodHuman: HumanAcceptanceResult = {
  status: 'MEASURED',
  reason: null,
  planned: 30,
  decided: 30,
  accepted: 27,
  disputed: [],
  coverage: 1,
  rate: 0.9,
  percentAgreement: 0.9,
  kappa: 0.5,
  bar: 0.7,
  meets: true,
};
const accepted = { version: THRESHOLDS_VERSION, acceptedBy: 'Owner', acceptedAt: '2026-12-01' };
const secOk = { ref: 'SEC-1', reviewedBy: 'Reviewer', completedAt: '2026-12-02', passed: true };
const goodReport = (): BenchmarkReport => runSuite(GOLDEN_TASKS, recordedIdeal(), rate).report;
const gateInput = (over: Partial<GateInput> = {}): GateInput => ({
  report: goodReport(),
  baseline: goodReport(),
  acceptance: accepted,
  humanReview: goodHuman,
  securityReview: secOk,
  ...over,
});

describe('the rollout gate fails closed', () => {
  it('passes only when every check holds', () => {
    const d = evaluateRolloutGate(gateInput());
    expect(d.reasons).toEqual([]);
    expect(d).toMatchObject({ allowed: true, status: 'PASS' });
    expect(d.checks.every((c) => c.ok)).toBe(true);
  });
  const blocked: [string, Partial<GateInput>, string][] = [
    ['no acceptance', { acceptance: null }, 'thresholds-accepted'],
    [
      'acceptance of an older list',
      { acceptance: { ...accepted, version: '1-proposed' } },
      'thresholds-accepted',
    ],
    [
      'REFERENCE evidence',
      { report: runSuite(GOLDEN_TASKS, refs(), rate).report },
      'evidence-recorded',
    ],
    [
      'MOCK evidence',
      { report: runSuite(GOLDEN_TASKS, mockSuite(GOLDEN_TASKS, 'ideal'), rate).report },
      'evidence-recorded',
    ],
    ['no baseline', { baseline: null }, 'no-regression'],
    ['no human review', { humanReview: null }, 'human-acceptance'],
    [
      'human review below bar',
      { humanReview: { ...goodHuman, rate: 0.5, meets: false } },
      'human-acceptance',
    ],
    [
      'human review incomplete',
      { humanReview: { ...goodHuman, status: 'INCOMPLETE', meets: null } },
      'human-acceptance',
    ],
    ['no security review', { securityReview: null }, 'security-review'],
    ['failed security review', { securityReview: { ...secOk, passed: false } }, 'security-review'],
    ['old dataset', { currentDatasetVersion: '9.9.9' }, 'dataset-current'],
  ];
  for (const [name, over, id] of blocked)
    it(`blocks: ${name}`, () => {
      const d = evaluateRolloutGate(gateInput(over));
      expect(d.allowed).toBe(false);
      expect(d.checks.find((c) => c.id === id)!.ok).toBe(false);
    });
  it('allows a first run without a baseline only when the owner accepted that', () => {
    expect(
      evaluateRolloutGate(
        gateInput({ baseline: null, acceptance: { ...accepted, noBaselineAllowed: true } }),
      ).allowed,
    ).toBe(true);
  });
  it('blocks a missing recording, a weak category, a failing threshold and a regression', () => {
    const m = recordedIdeal();
    m.delete(GOLDEN_TASKS[0]!.id);
    expect(
      evaluateRolloutGate(gateInput({ report: runSuite(GOLDEN_TASKS, m).report })).checks.find(
        (c) => c.id === 'all-tasks-scored',
      )!.ok,
    ).toBe(false);
    const half = runSuite(GOLDEN_TASKS, asRecorded(mockSuite(GOLDEN_TASKS, 'half-done'))).report;
    const d = evaluateRolloutGate(gateInput({ report: half }));
    expect(d.status).toBe('BLOCKED');
    expect(d.failedThresholds.length).toBeGreaterThan(0);
    expect(d.regressions.length).toBeGreaterThan(0);
    expect(d.checks.find((c) => c.id === 'category-floor')!.ok).toBe(false);
    expect(CATEGORY_PASS_FLOOR.status).toBe('PROPOSED');
  });
  it('is NOT VERIFIED (not BLOCKED) when only the owner/human inputs are missing', () => {
    const d = evaluateRolloutGate(
      gateInput({ acceptance: null, humanReview: null, securityReview: null }),
    );
    expect(d.status).toBe('NOT VERIFIED');
  });
  it('is not allowed on the unmodified proposed state of the repository', () => {
    const d = evaluateRolloutGate({
      report: runSuite(GOLDEN_TASKS, refs(), rate).report,
      baseline: null,
      acceptance: null,
      humanReview: null,
      securityReview: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(5);
  });
});

describe('human reviewer workflow', () => {
  const reviewers: Reviewer[] = [
    { id: 'r1', name: 'Reviewer One' },
    { id: 'r2', name: 'Reviewer Two' },
    { id: 'r3', name: 'Reviewer Three' },
  ];
  const ids = GOLDEN_TASKS.map((t) => t.id);
  const planOf = (rs = reviewers, size = 30) => {
    const p = createReviewPlan({
      runRef: 'run',
      seed: 'seed-1',
      reviewers: rs,
      taskIds: ids,
      sampleSize: size,
    });
    if (!p.ok) throw new Error(p.errors.join());
    return p.plan;
  };
  const review = (
    plan: ReturnType<typeof planOf>,
    taskId: string,
    reviewerId: string,
    accept: boolean,
    extra: Partial<Review> = {},
  ): Review => ({
    planId: plan.planId,
    taskId,
    reviewerId,
    scores: { correctness: accept ? 4 : 2, quality: 4, ui: 4, security: 4 },
    accept,
    ...extra,
  });
  it('needs two named reviewers, a big enough sample and unique ids', () => {
    expect(
      createReviewPlan({ runRef: 'r', seed: 's', reviewers: [reviewers[0]!], taskIds: ids }),
    ).toMatchObject({ ok: false });
    expect(
      createReviewPlan({
        runRef: 'r',
        seed: 's',
        reviewers: [reviewers[0]!, { id: 'r2', name: '' }],
        taskIds: ids,
      }),
    ).toMatchObject({ ok: false });
    expect(
      createReviewPlan({ runRef: 'r', seed: 's', reviewers, taskIds: ids, sampleSize: 5 }),
    ).toMatchObject({ ok: false });
    expect(
      createReviewPlan({
        runRef: 'r',
        seed: 's',
        reviewers: [reviewers[0]!, reviewers[0]!],
        taskIds: ids,
      }),
    ).toMatchObject({ ok: false });
  });
  it('samples deterministically, assigns two distinct reviewers in balance and hides the model identity', () => {
    const a = planOf();
    expect(JSON.stringify(a)).toBe(JSON.stringify(planOf()));
    expect(a.items).toHaveLength(30);
    expect(a.items.every((i) => i.reviewerIds[0] !== i.reviewerIds[1])).toBe(true);
    const load = new Map<string, number>();
    for (const i of a.items) for (const r of i.reviewerIds) load.set(r, (load.get(r) ?? 0) + 1);
    expect(Math.max(...load.values()) - Math.min(...load.values())).toBeLessThanOrEqual(1);
    expect(
      a.items.every((i) => i.blindId.startsWith('blind-') && !JSON.stringify(i).includes('mock')),
    ).toBe(true);
  });
  it('validates reviews: assignment, duplicates, scale, accept floor', () => {
    const plan = planOf();
    const it0 = plan.items[0]!;
    const ok = review(plan, it0.taskId, it0.reviewerIds[0], true);
    expect(validateReview(plan, [], ok)).toEqual([]);
    expect(validateReview(plan, [ok], ok).join()).toMatch(/already reviewed/);
    const outsider = reviewers.find((r) => !it0.reviewerIds.includes(r.id))!;
    expect(validateReview(plan, [], review(plan, it0.taskId, outsider.id, true)).join()).toMatch(
      /not assigned/,
    );
    expect(validateReview(plan, [], { ...ok, scores: { ...ok.scores, ui: 9 } }).join()).toMatch(
      /integer from 1 to 5/,
    );
    expect(
      validateReview(plan, [], { ...ok, scores: { ...ok.scores, security: 1 } }).join(),
    ).toMatch(/cannot be accepted/);
    expect(validateReview(plan, [], { ...ok, planId: 'other' }).join()).toMatch(/another plan/);
    expect(validateReview(plan, [], review(plan, 'nope', 'r1', true)).join()).toMatch(
      /not in the plan/,
    );
  });
  const full = (plan: ReturnType<typeof planOf>, rule: (i: number) => [boolean, boolean]) =>
    plan.items.flatMap((it, i) => {
      const [a, b] = rule(i);
      return [
        review(plan, it.taskId, it.reviewerIds[0], a),
        review(plan, it.taskId, it.reviewerIds[1], b),
      ];
    });
  it('is MEASURED with a rate, agreement and kappa when coverage is complete', () => {
    const plan = planOf();
    const res = summarizeReviews(
      plan,
      full(plan, (i) => (i < 6 ? [false, false] : [true, true])),
    );
    expect(res).toMatchObject({
      status: 'MEASURED',
      planned: 30,
      decided: 30,
      accepted: 24,
      rate: 0.8,
      meets: true,
      percentAgreement: 1,
    });
    expect(res.kappa).toBe(1);
    const low = summarizeReviews(
      plan,
      full(plan, (i) => (i < 15 ? [false, false] : [true, true])),
    );
    expect(low).toMatchObject({ rate: 0.5, meets: false });
  });
  it('a dispute is not an acceptance until an unassigned reviewer adjudicates', () => {
    const plan = planOf();
    const reviews = full(plan, (i) => (i === 0 ? [true, false] : [true, true]));
    const r0 = summarizeReviews(plan, reviews);
    expect(r0.disputed).toEqual([plan.items[0]!.taskId]);
    expect(r0.decided).toBe(29);
    const first = plan.items[0]!;
    const adj = reviewers.find((r) => !first.reviewerIds.includes(r.id))!;
    const r1 = summarizeReviews(plan, [
      ...reviews,
      review(plan, first.taskId, adj.id, true, { adjudication: true }),
    ]);
    expect(r1.disputed).toEqual([]);
    expect(r1.decided).toBe(30);
    expect(
      validateReview(
        plan,
        [],
        review(plan, first.taskId, first.reviewerIds[0], true, { adjudication: true }),
      ).join(),
    ).toMatch(/must not be one of the assigned/);
  });
  it('is INCOMPLETE with too few decided tasks and NOT MEASURED without a plan; neither ever meets the bar', () => {
    const plan = planOf();
    const some = full(plan, () => [true, true]).slice(0, 20);
    const r = summarizeReviews(plan, some);
    expect(r.status).toBe('INCOMPLETE');
    expect(r.meets).toBeNull();
    expect(summarizeReviews(null, [])).toMatchObject({ status: 'NOT MEASURED', meets: null });
    expect(summarizeReviews(plan, [])).toMatchObject({ status: 'INCOMPLETE', rate: null });
    expect(REVIEW_PROTOCOL.status).toBe('PROPOSED');
  });
});

describe('qualification workflow', () => {
  const evidence = (over: Partial<QualificationEvidence> = {}): QualificationEvidence => ({
    reportFingerprint: 'fp',
    evidenceLabel: 'OFFLINE_REPLAY_OF_RECORDED_RUN',
    datasetVersion: DATASET_VERSION,
    gate: { allowed: true, status: 'PASS' },
    ...over,
  });
  const at = '2026-12-03T00:00:00Z';
  const start = () =>
    proposeQualification({ id: 'q1', adapterId: 'claude', model: 'm1', proposedBy: 'alice', at });
  const must = (r: ReturnType<typeof stepQualification>) => {
    if (!r.ok) throw new Error(r.error);
    return r.record;
  };
  const toReview = () => {
    let r = must(
      stepQualification(start(), {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence(),
      }),
    );
    r = must(
      stepQualification(r, {
        type: 'record_reviews',
        by: 'bob',
        at,
        humanReview: goodHuman,
        securityReview: secOk,
      }),
    );
    return r;
  };
  it('walks PROPOSED to QUALIFIED only through evidence, reviews and a second person', () => {
    const r = must(stepQualification(toReview(), { type: 'approve', by: 'carol', at }));
    expect(r.state).toBe('QUALIFIED');
    expect(r.history.map((h) => h.event)).toEqual([
      'propose',
      'attach_evidence',
      'record_reviews',
      'approve',
    ]);
    expect(isQualified([r], 'claude', 'm1')).toBe(true);
    expect(isQualified([r], 'claude', 'other')).toBe(false);
  });
  it('refuses illegal or unsupported steps and changes nothing', () => {
    const s = start();
    expect(stepQualification(s, { type: 'approve', by: 'carol', at })).toMatchObject({ ok: false });
    expect(
      stepQualification(s, {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence({ evidenceLabel: 'OFFLINE_REFERENCE_ORACLE' }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      stepQualification(s, {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence({ evidenceLabel: 'OFFLINE_MOCK_REPLAY' }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      stepQualification(s, {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence({ gate: { allowed: false, status: 'BLOCKED' } }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      stepQualification(s, {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence({ datasetVersion: '0.1.0' }),
      }),
    ).toMatchObject({ ok: false });
    expect(
      stepQualification(s, { type: 'attach_evidence', by: ' ', at, evidence: evidence() }),
    ).toMatchObject({ ok: false });
    expect(s.state).toBe('PROPOSED');
    const r = toReview();
    expect(stepQualification(r, { type: 'approve', by: 'alice', at })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/different person/),
    });
    const ev = must(
      stepQualification(start(), {
        type: 'attach_evidence',
        by: 'alice',
        at,
        evidence: evidence(),
      }),
    );
    expect(
      stepQualification(ev, {
        type: 'record_reviews',
        by: 'bob',
        at,
        humanReview: { ...goodHuman, meets: false },
        securityReview: secOk,
      }),
    ).toMatchObject({ ok: false });
    expect(
      stepQualification(ev, {
        type: 'record_reviews',
        by: 'bob',
        at,
        humanReview: goodHuman,
        securityReview: { ...secOk, passed: false },
      }),
    ).toMatchObject({ ok: false });
  });
  it('reject needs a reason; suspend withdraws the approval; reinstate needs fresh passing evidence and a new approval', () => {
    expect(stepQualification(start(), { type: 'reject', by: 'bob', at, reason: '' })).toMatchObject(
      { ok: false },
    );
    expect(
      must(stepQualification(start(), { type: 'reject', by: 'bob', at, reason: 'quality' })).state,
    ).toBe('REJECTED');
    let r = must(stepQualification(toReview(), { type: 'approve', by: 'carol', at }));
    r = must(stepQualification(r, { type: 'suspend', by: 'dave', at, reason: 'regression' }));
    expect(r).toMatchObject({ state: 'SUSPENDED', approvedBy: null });
    expect(isQualified([r], 'claude', 'm1')).toBe(false);
    expect(
      stepQualification(r, {
        type: 'reinstate',
        by: 'dave',
        at,
        evidence: evidence({ gate: { allowed: false, status: 'BLOCKED' } }),
      }),
    ).toMatchObject({ ok: false });
    r = must(stepQualification(r, { type: 'reinstate', by: 'dave', at, evidence: evidence() }));
    expect(r.state).toBe('UNDER_REVIEW');
    expect(must(stepQualification(r, { type: 'approve', by: 'carol', at })).state).toBe(
      'QUALIFIED',
    );
  });
  it('expires when the dataset or the thresholds version changes', () => {
    const q = must(stepQualification(toReview(), { type: 'approve', by: 'carol', at }));
    expect(effectiveState(q)).toBe('QUALIFIED');
    expect(
      effectiveState(q, { datasetVersion: '3.0.0', thresholdsVersion: THRESHOLDS_VERSION }),
    ).toBe('EXPIRED');
    expect(
      effectiveState(q, { datasetVersion: DATASET_VERSION, thresholdsVersion: '9-proposed' }),
    ).toBe('EXPIRED');
    expect(effectiveState(start())).toBe('PROPOSED');
  });
});

describe('budget enforcement', () => {
  const price: PriceCard = {
    currency: 'USD',
    minorPerMillionInput: '300',
    minorPerMillionOutput: '1500',
  };
  const tasks = GOLDEN_TASKS.slice(0, 5);
  const worstTokens = tasks.reduce((a, t) => a + t.budget.maxTokens, 0);
  const worstTurns = tasks.reduce((a, t) => a + t.budget.maxTurns, 0);
  const budget = (over: Partial<BenchmarkBudget> = {}): BenchmarkBudget => ({
    ref: 'BUD-1',
    approvedBy: 'Owner',
    currency: 'USD',
    maxCostMinor: '100000',
    maxTokens: worstTokens,
    maxRequests: worstTurns,
    ...over,
  });
  it('validates the budget and the worst case of the suite against every cap', () => {
    expect(preflightBudget(tasks, budget(), price)).toMatchObject({ ok: true });
    expect(preflightBudget(tasks, null, price)).toMatchObject({ ok: false });
    expect(preflightBudget(tasks, budget({ ref: ' ' }), price)).toMatchObject({ ok: false });
    expect(preflightBudget(tasks, budget({ maxTokens: worstTokens - 1 }), price)).toMatchObject({
      ok: false,
    });
    expect(preflightBudget(tasks, budget({ maxRequests: 1 }), price)).toMatchObject({ ok: false });
    expect(preflightBudget(tasks, budget({ maxCostMinor: '1' }), price)).toMatchObject({
      ok: false,
    });
    expect(preflightBudget(tasks, budget({ currency: 'SAR' }), price)).toMatchObject({ ok: false });
    expect(preflightBudget(tasks, budget({ maxCostMinor: '12.5' }), price)).toMatchObject({
      ok: false,
    });
  });
  it('reserves per task, commits actuals and stops when the next task no longer fits', () => {
    const l = new BudgetLedger(budget({ maxTokens: tasks[0]!.budget.maxTokens + 1 }), price);
    expect(l.reserve(tasks[0]!)).toBe(true);
    expect(l.reserve(tasks[1]!)).toBe(false);
    l.commit(1000, 500, 2);
    expect(l.usage()).toMatchObject({ tokens: 1500, requests: 2, costMinor: '2' });
    expect(l.reserve(tasks[1]!)).toBe(false);
    expect(l.stopReason).toMatch(/cannot cover/);
  });
  it('an overrun of the reservation stops the ledger for good', () => {
    const l = new BudgetLedger(budget(), price);
    expect(l.reserve(tasks[0]!)).toBe(true);
    l.commit(tasks[0]!.budget.maxTokens, 5000, 1);
    expect(l.stopReason).toMatch(/more than its reserved/);
    expect(l.reserve(tasks[1]!)).toBe(false);
  });
  it('rounds money up and rejects an invalid budget at construction', () => {
    const l = new BudgetLedger(budget(), price);
    l.reserve(tasks[0]!);
    l.commit(1, 0, 1);
    expect(l.usage().costMinor).toBe('1');
    expect(() => new BudgetLedger(budget({ maxTokens: 0 }), price)).toThrow(
      /invalid benchmark budget/,
    );
  });
});

describe('the live benchmark runner refuses unless every approval exists', () => {
  const tasks = GOLDEN_TASKS.slice(0, 3);
  const price: PriceCard = {
    currency: 'USD',
    minorPerMillionInput: '300',
    minorPerMillionOutput: '1500',
  };
  const pre = (over: Partial<LivePreconditions> = {}): LivePreconditions => ({
    flagEnabled: true,
    liveProviderGateOpen: true,
    environment: { name: 'staging', production: false },
    providerVerified: { providerId: 'claude', model: 'm1', evidenceRef: 'EV-1' },
    thresholdsAccepted: accepted,
    budget: {
      ref: 'BUD-1',
      approvedBy: 'Owner',
      currency: 'USD',
      maxCostMinor: '100000',
      maxTokens: 1_000_000,
      maxRequests: 1000,
    },
    reviewers: [
      { id: 'r1', name: 'Reviewer One' },
      { id: 'r2', name: 'Reviewer Two' },
    ],
    securityReview: secOk,
    ...over,
  });
  const source = (over: Partial<CaptureSource> = {}) => {
    const calls: string[] = [];
    const s: CaptureSource = {
      mode: 'live',
      adapterId: 'claude',
      model: 'm1',
      async capture({ task }) {
        calls.push(task.id);
        const ref = referenceRecording(task);
        return {
          recording: {
            turns: ref.turns,
            patch: ref.patch,
            finishedWith: 'proposal',
            contractVersion: '1.1.0',
          },
          usage: { tokensIn: 2300, tokensOut: 720, requests: ref.turns.length },
        };
      },
      ...over,
    };
    return { s, calls };
  };
  const run = (p: LivePreconditions, s: CaptureSource) =>
    runLiveBenchmark({
      tasks,
      pre: p,
      source: s,
      price,
      runId: 'run-1',
      now: () => '2026-12-05T00:00:00Z',
    });
  const refusals: [string, Partial<LivePreconditions>, string][] = [
    ['flag off (the default)', { flagEnabled: false }, 'FLAG_OFF'],
    ['live gate closed', { liveProviderGateOpen: false }, 'LIVE_GATE_CLOSED'],
    ['no environment', { environment: null }, 'ENVIRONMENT_NOT_ALLOWED'],
    [
      'production environment',
      { environment: { name: 'prod', production: true } },
      'ENVIRONMENT_NOT_ALLOWED',
    ],
    ['provider not verified', { providerVerified: null }, 'PROVIDER_NOT_VERIFIED'],
    [
      'provider without evidence',
      { providerVerified: { providerId: 'claude', model: 'm1', evidenceRef: ' ' } },
      'PROVIDER_NOT_VERIFIED',
    ],
    ['thresholds not accepted', { thresholdsAccepted: null }, 'THRESHOLDS_NOT_ACCEPTED'],
    [
      'old threshold acceptance',
      { thresholdsAccepted: { ...accepted, version: '1-proposed' } },
      'THRESHOLDS_NOT_ACCEPTED',
    ],
    ['no budget', { budget: null }, 'BUDGET_NOT_APPROVED'],
    [
      'budget too small',
      {
        budget: {
          ref: 'B',
          approvedBy: 'O',
          currency: 'USD',
          maxCostMinor: '1',
          maxTokens: 10,
          maxRequests: 1,
        },
      },
      'BUDGET_TOO_SMALL',
    ],
    ['one reviewer', { reviewers: [{ id: 'r1', name: 'Reviewer One' }] }, 'REVIEWERS_NOT_NAMED'],
    [
      'unnamed reviewers',
      {
        reviewers: [
          { id: 'r1', name: '' },
          { id: 'r2', name: '' },
        ],
      },
      'REVIEWERS_NOT_NAMED',
    ],
    ['no security review', { securityReview: null }, 'SECURITY_REVIEW_MISSING'],
    [
      'failed security review',
      { securityReview: { ...secOk, passed: false } },
      'SECURITY_REVIEW_MISSING',
    ],
  ];
  for (const [name, over, code] of refusals)
    it(`refuses: ${name} (and never calls the source)`, async () => {
      const { s, calls } = source();
      const r = await run(pre(over), s);
      expect(r.status).toBe('REFUSED');
      expect(r.refusals.map((x) => x.code)).toContain(code);
      expect(calls).toEqual([]);
      expect(r.recordings.size).toBe(0);
    });
  it('refuses a source that is not the verified provider and model', async () => {
    const { s, calls } = source({ model: 'other' });
    expect((await run(pre(), s)).refusals.map((x) => x.code)).toContain('SOURCE_MISMATCH');
    expect(calls).toEqual([]);
  });
  it('malformed stored records (missing fields) are refused, never thrown on', () => {
    const bad = pre({
      budget: { ref: 'B' } as unknown as BenchmarkBudget,
      thresholdsAccepted: { version: THRESHOLDS_VERSION } as never,
      securityReview: { passed: true } as never,
      providerVerified: { providerId: 'claude', model: 'm1' } as never,
      reviewers: [{ id: 'r1' }, { name: 'X Y' }] as never,
      environment: {} as never,
    });
    const f = livePreflight(bad, tasks, price);
    expect(f.allowed).toBe(false);
    expect(f.refusals.map((x) => x.code)).toEqual(
      expect.arrayContaining([
        'BUDGET_TOO_SMALL',
        'THRESHOLDS_NOT_ACCEPTED',
        'SECURITY_REVIEW_MISSING',
        'PROVIDER_NOT_VERIFIED',
        'REVIEWERS_NOT_NAMED',
        'ENVIRONMENT_NOT_ALLOWED',
      ]),
    );
    expect(
      evaluateRolloutGate(
        gateInput({
          acceptance: { version: THRESHOLDS_VERSION } as never,
          securityReview: { passed: true } as never,
        }),
      ).allowed,
    ).toBe(false);
    expect(preflightBudget(tasks, { ref: 'B' } as unknown as BenchmarkBudget, price)).toMatchObject(
      { ok: false },
    );
  });
  it('with the default (empty) preconditions everything is refused', () => {
    const none: LivePreconditions = {
      flagEnabled: false,
      liveProviderGateOpen: false,
      environment: null,
      providerVerified: null,
      thresholdsAccepted: null,
      budget: null,
      reviewers: [],
      securityReview: null,
    };
    const f = livePreflight(none, tasks, price);
    expect(f.allowed).toBe(false);
    expect(new Set(f.refusals.map((x) => x.code)).size).toBeGreaterThanOrEqual(8);
  });
  it('when everything holds it records RECORDED runs with capture provenance, inside the budget', async () => {
    const { s, calls } = source();
    const r = await run(pre(), s);
    expect(r.status).toBe('COMPLETED');
    expect(calls).toEqual(tasks.map((t) => t.id));
    const rec = r.recordings.get(tasks[0]!.id)!;
    expect(rec).toMatchObject({
      origin: 'RECORDED',
      datasetVersion: DATASET_VERSION,
      capture: { runId: 'run-1', approvalRef: 'BUD-1', providerEvidenceRef: 'EV-1' },
    });
    expect(r.usage!.tokens).toBe(3 * 3020);
    const report = runSuite(tasks, r.recordings).report;
    expect(report.evidence.label).toBe('OFFLINE_REPLAY_OF_RECORDED_RUN');
    expect(report.rejectedRecordings).toEqual([]);
  });
  it('a source that declares itself mock yields MOCK recordings, never RECORDED', async () => {
    const { s } = source({ mode: 'mock' });
    const r = await run(pre(), s);
    expect(
      [...r.recordings.values()].every((x) => x.origin === 'MOCK' && x.capture === undefined),
    ).toBe(true);
  });
  it('stops when the budget runs out, keeping what it recorded and paid for', async () => {
    const { s } = source();
    const small = pre({
      budget: {
        ref: 'B',
        approvedBy: 'O',
        currency: 'USD',
        maxCostMinor: '100000',
        maxTokens: 1_000_000,
        maxRequests: 1000,
      },
    });
    const heavy: CaptureSource = {
      ...s,
      capture: async (req) => ({
        ...(await s.capture(req)),
        usage: { tokensIn: 900_000, tokensOut: 90_000, requests: 2 },
      }),
    };
    const r = await run(small, heavy);
    expect(r.status).toBe('STOPPED_BUDGET');
    expect(r.recordings.size).toBeGreaterThan(0);
    expect(r.recordings.size).toBeLessThan(tasks.length);
    expect(r.notRecorded.length).toBeGreaterThan(0);
  });
  it('stops after an uncertain outcome and names the task to reconcile; a plain failure stops too', async () => {
    const { s } = source();
    let n = 0;
    const uncertain: CaptureSource = {
      ...s,
      capture: async (req) => {
        if (++n === 2) throw new UncertainCaptureError('timeout');
        return s.capture(req);
      },
    };
    const r = await run(pre(), uncertain);
    expect(r).toMatchObject({ status: 'STOPPED_UNCERTAIN', uncertainTaskId: tasks[1]!.id });
    expect(r.recordings.size).toBe(1);
    const failing: CaptureSource = {
      ...s,
      capture: async () => {
        throw new Error('boom');
      },
    };
    expect((await run(pre(), failing)).status).toBe('STOPPED_FAILED');
  });
  it('stops when a recording claims more tokens than were billed', async () => {
    const { s } = source();
    const liar: CaptureSource = {
      ...s,
      capture: async (req) => ({
        ...(await s.capture(req)),
        usage: { tokensIn: 1, tokensOut: 1, requests: 1 },
      }),
    };
    expect((await run(pre(), liar)).status).toBe('STOPPED_FAILED');
  });
});
