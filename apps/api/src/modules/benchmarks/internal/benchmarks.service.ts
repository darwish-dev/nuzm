import { v7 as uuidv7 } from 'uuid';
import { benchmarks as bm } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { BenchmarkStore, type RecordKind, type RecordRow, type RunRow } from './store';

/** Feature flag port: `ai.benchmarks` (platform.feature_flags, default OFF). */
export abstract class BenchmarkFlags {
  abstract enabled(): Promise<boolean>;
}
/** The environment facts the live-run preflight reads (never a secret). */
export interface BenchmarkEnv {
  liveEnabled: boolean;
  liveProvidersConfigured: boolean;
  environmentName: string;
  production: boolean;
}
export const envFrom = (env: NodeJS.ProcessEnv = process.env): BenchmarkEnv => ({
  liveEnabled: env.BENCHMARK_LIVE_ENABLED === 'true',
  liveProvidersConfigured: (env.AI_LIVE_PROVIDERS ?? '').trim() !== '',
  environmentName: env.NUZM_ENV ?? '',
  production: env.NODE_ENV === 'production' || env.NUZM_ENV === 'production',
});

const invalid = (detail: string): never => {
  throw new ProblemException('validation_failed', detail);
};
const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max)
    return invalid(`${name} is required (text, at most ${max} characters)`);
  return v.trim();
};
const requestIdOf = (b: Record<string, unknown>): string => {
  const v = b.requestId;
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    return invalid(
      'requestId (a UUID chosen by the caller) is required: a repeated request returns the stored result',
    );
  return v;
};
const PROFILES = new Set<string>(bm.MOCK_PROFILES);
const RATE: bm.RateCard = { creditsPerMillionInput: '3', creditsPerMillionOutput: '15' };

export interface RunSummary {
  id: string;
  label: string;
  createdAt: string;
  datasetVersion: string;
  evidence: string;
  adapters: string[];
  tasks: number;
  passRate: number;
  meanQuality: number;
  meanSecurity: number | null;
  modeViolations: number;
}
const summaryOf = (r: RunRow): RunSummary => {
  const rep = r.report as bm.BenchmarkReport;
  return {
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    datasetVersion: r.datasetVersion,
    evidence: r.evidenceLabel,
    adapters: r.adapters,
    tasks: rep.tasks,
    passRate: rep.overall.passRate,
    meanQuality: rep.overall.meanQuality,
    meanSecurity: rep.overall.meanSecurity,
    modeViolations: rep.overall.modeViolations,
  };
};

/**
 * Benchmark service (S-AG5): offline runs, comparison, the strict rollout gate, the reviewer and qualification workflows, budget and acceptance records, and the live-run
 * PREFLIGHT. Nothing here calls a model: the only run sources are the reference oracle and scripted mocks (`runOffline`), `attemptLiveRun` only EVALUATES the preconditions
 * and records the (refused) attempt, and no capture source is wired in this build. Every mutation is audited; creating calls are idempotent by a caller-chosen `requestId`.
 */
export class BenchmarksService {
  constructor(
    private readonly store: BenchmarkStore,
    private readonly audit: AuditSink,
    private readonly flags: BenchmarkFlags,
    private readonly env: () => BenchmarkEnv = () => envFrom(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async requireEnabled(): Promise<void> {
    if (!(await this.flags.enabled()))
      throw new ProblemException(
        'kind_not_available',
        'benchmarks are disabled (feature flag ai.benchmarks is off)',
      );
  }
  private async log(
    action: `${string}.${string}.${string}`,
    who: string,
    resource: { type: string; id?: string },
    detail: Record<string, unknown>,
    ok = true,
  ): Promise<void> {
    await this.audit.record({
      action,
      actorUserId: who,
      actorType: 'user',
      resource,
      outcome: ok ? 'success' : 'failure',
      detail,
    });
  }
  private async put(
    kind: RecordKind,
    subject: string,
    payload: unknown,
    who: string,
    requestId: string | null,
  ) {
    return this.store.insertRecord({
      id: uuidv7(),
      kind,
      subject,
      payload,
      requestId,
      recordedBy: who,
      recordedAt: this.now().toISOString(),
    });
  }
  private async latest<T>(
    kind: RecordKind,
    subject?: string,
  ): Promise<{ row: RecordRow; payload: T } | null> {
    const all = await this.store.records(kind, subject);
    const row = all[all.length - 1];
    return row ? { row, payload: row.payload as T } : null;
  }

  // ---- read side
  async overview() {
    if (!(await this.flags.enabled())) return { enabled: false as const };
    const manifest = bm.buildManifest(bm.GOLDEN_TASKS);
    const acceptance = await this.latest<bm.ThresholdAcceptance>(
      'threshold_acceptance',
      'thresholds',
    );
    const budget = await this.latest<bm.BenchmarkBudget>('budget', 'live');
    const security = await this.latest<bm.SecurityReviewRecord>('security_review', 'agent');
    const reviewers = await this.latest<bm.Reviewer[]>('reviewers', 'roster');
    const runs = await this.store.listRuns(20);
    const quals = await this.qualifications();
    return {
      enabled: true as const,
      dataset: {
        version: manifest.datasetVersion,
        hash: manifest.hash,
        tasks: manifest.taskCount,
        perCategory: manifest.perCategory,
        categories: bm.TASK_CATEGORIES,
      },
      thresholds: {
        version: bm.THRESHOLDS_VERSION,
        status:
          acceptance?.payload.version === bm.THRESHOLDS_VERSION
            ? ('ACCEPTED' as const)
            : ('PROPOSED' as const),
        acceptance: acceptance?.payload ?? null,
        items: bm.PROPOSED_THRESHOLDS,
        categoryFloor: bm.CATEGORY_PASS_FLOOR,
        humanAcceptance: bm.HUMAN_ACCEPTANCE_PROPOSAL,
      },
      budget: budget?.payload ?? null,
      securityReview: security?.payload ?? null,
      reviewers: reviewers?.payload ?? [],
      runs: runs.map(summaryOf),
      qualifications: quals,
      live: {
        available: false as const,
        reason:
          'no capture source is wired in this build; the live runner is prepared and gated, never run',
      },
    };
  }
  async getRun(id: string) {
    await this.requireEnabled();
    const r = await this.store.getRun(id);
    if (!r) throw new ProblemException('not_found', 'benchmark run not found');
    return {
      ...summaryOf(r),
      reportFingerprint: r.reportFingerprint,
      datasetHash: r.datasetHash,
      report: r.report,
      markdown: bm.renderReport(r.report as bm.BenchmarkReport),
    };
  }

  // ---- offline runs
  async runOffline(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const source = str(b.source, 'source', 40);
    const profile = source.startsWith('mock:') ? source.slice(5) : null;
    if (source !== 'reference' && !(profile && PROFILES.has(profile)))
      invalid(
        `source must be "reference" or "mock:<profile>" (${[...PROFILES].join(', ')}). Recorded runs come only from the gated live runner.`,
      );
    const tasks = bm.GOLDEN_TASKS;
    const recs = profile
      ? bm.mockSuite(tasks, profile as bm.MockProfile)
      : new Map(tasks.map((t) => [t.id, bm.referenceRecording(t)]));
    const { report, scores } = bm.runSuite(tasks, recs, RATE);
    const row: RunRow = {
      id: uuidv7(),
      label: typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 120) : source,
      datasetVersion: report.datasetVersion,
      datasetHash: report.datasetHash,
      evidenceLabel: report.evidence.label,
      origins: report.origins,
      adapters: report.adapters,
      report,
      scores,
      reportFingerprint: bm.reportFingerprint(report),
      requestId,
      createdBy: who,
      createdAt: this.now().toISOString(),
    };
    const { row: stored, created } = await this.store.insertRun(row);
    if (created)
      await this.log(
        'ai.benchmark.run_recorded',
        who,
        { type: 'ai_benchmark_run', id: stored.id },
        { evidence: stored.evidenceLabel, source, tasks: report.tasks },
      );
    return { created, ...summaryOf(stored) };
  }
  async compare(ids: unknown) {
    await this.requireEnabled();
    if (
      !Array.isArray(ids) ||
      ids.length < 2 ||
      ids.length > 6 ||
      ids.some((i) => typeof i !== 'string')
    )
      return invalid('ids must list 2 to 6 run ids');
    const entries: bm.ComparisonEntry[] = [];
    for (const id of ids as string[]) {
      const r = await this.store.getRun(id);
      if (!r) throw new ProblemException('not_found', `benchmark run ${id} not found`);
      entries.push({
        label: `${r.label} (${id.slice(-6)})`,
        report: r.report as bm.BenchmarkReport,
        scores: r.scores as bm.TaskScore[],
      });
    }
    return bm.compareModels(entries);
  }

  // ---- governance records
  async acceptThresholds(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    if (b.version !== bm.THRESHOLDS_VERSION)
      invalid(
        `the thresholds in force are version ${bm.THRESHOLDS_VERSION}; an acceptance must name exactly that version`,
      );
    const acceptance: bm.ThresholdAcceptance = {
      version: bm.THRESHOLDS_VERSION,
      acceptedBy: who,
      acceptedAt: this.now().toISOString(),
      ...(b.noBaselineAllowed === true ? { noBaselineAllowed: true } : {}),
    };
    const { created } = await this.put(
      'threshold_acceptance',
      'thresholds',
      acceptance,
      who,
      requestId,
    );
    if (created)
      await this.log(
        'ai.benchmark.thresholds_accepted',
        who,
        { type: 'ai_benchmark_thresholds' },
        { version: acceptance.version, noBaselineAllowed: acceptance.noBaselineAllowed === true },
      );
    return { created, acceptance };
  }
  async setBudget(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const budget: bm.BenchmarkBudget = {
      ref: str(b.ref, 'ref'),
      approvedBy: who,
      currency: str(b.currency, 'currency', 3),
      maxCostMinor: str(b.maxCostMinor, 'maxCostMinor', 20),
      maxTokens: Number(b.maxTokens),
      maxRequests: Number(b.maxRequests),
    };
    const v = bm.validateBudget(budget);
    if (!v.ok) invalid(v.reasons.join('; '));
    const { created } = await this.put('budget', 'live', budget, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.budget_set',
        who,
        { type: 'ai_benchmark_budget' },
        {
          ref: budget.ref,
          currency: budget.currency,
          maxCostMinor: budget.maxCostMinor,
          maxTokens: budget.maxTokens,
          maxRequests: budget.maxRequests,
        },
      );
    return { created, budget };
  }
  async recordSecurityReview(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const rec: bm.SecurityReviewRecord = {
      ref: str(b.ref, 'ref'),
      reviewedBy: str(b.reviewedBy, 'reviewedBy', 120),
      completedAt: this.now().toISOString(),
      passed: b.passed === true,
    };
    const { created } = await this.put('security_review', 'agent', rec, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.security_review_recorded',
        who,
        { type: 'ai_benchmark_security_review' },
        { ref: rec.ref, passed: rec.passed },
      );
    return { created, securityReview: rec };
  }
  async setReviewers(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    if (!Array.isArray(b.reviewers) || b.reviewers.length > 20)
      return invalid('reviewers must be a list of {id, name}');
    const list: bm.Reviewer[] = (b.reviewers as Record<string, unknown>[]).map((r) => ({
      id: str(r?.id, 'reviewer id', 80),
      name: str(r?.name, 'reviewer name', 120),
    }));
    if (new Set(list.map((r) => r.id)).size !== list.length) invalid('reviewer ids must be unique');
    const { created } = await this.put('reviewers', 'roster', list, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.reviewers_named',
        who,
        { type: 'ai_benchmark_reviewers' },
        { count: list.length },
      );
    return { created, reviewers: list };
  }

  // ---- reviewer workflow
  async createReviewPlan(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const run = await this.store.getRun(str(b.runId, 'runId', 80));
    if (!run) throw new ProblemException('not_found', 'benchmark run not found');
    const roster = (await this.latest<bm.Reviewer[]>('reviewers', 'roster'))?.payload ?? [];
    const made = bm.createReviewPlan({
      runRef: run.reportFingerprint,
      seed: str(b.seed ?? run.reportFingerprint.slice(0, 16), 'seed', 80),
      reviewers: roster,
      taskIds: (run.scores as bm.TaskScore[]).map((s) => s.taskId),
      ...(typeof b.sampleSize === 'number' ? { sampleSize: b.sampleSize } : {}),
    });
    if (!made.ok) return invalid(made.errors.join('; '));
    const { created } = await this.put('review_plan', made.plan.planId, made.plan, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.review_plan_created',
        who,
        { type: 'ai_benchmark_review_plan', id: made.plan.planId },
        { items: made.plan.items.length, runId: run.id },
      );
    // the reviewer view hides the model identity: blind ids only
    return {
      created,
      planId: made.plan.planId,
      items: made.plan.items.map((i) => ({
        blindId: i.blindId,
        taskId: i.taskId,
        reviewerIds: i.reviewerIds,
      })),
    };
  }
  async submitReview(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const planId = str(b.planId, 'planId', 80);
    const plan = (await this.latest<bm.ReviewPlan>('review_plan', planId))?.payload;
    if (!plan) throw new ProblemException('not_found', 'review plan not found');
    const s = (b.scores ?? {}) as Record<string, unknown>;
    const review: bm.Review = {
      planId,
      taskId: str(b.taskId, 'taskId', 120),
      reviewerId: str(b.reviewerId, 'reviewerId', 80),
      scores: {
        correctness: Number(s.correctness),
        quality: Number(s.quality),
        ui: Number(s.ui),
        security: Number(s.security),
      },
      accept: b.accept === true,
      ...(b.adjudication === true ? { adjudication: true } : {}),
      ...(typeof b.notes === 'string' ? { notes: b.notes } : {}),
    };
    const existing = (await this.store.records('review', planId)).map(
      (r) => r.payload as bm.Review,
    );
    const problems = bm.validateReview(plan, existing, review);
    if (problems.length > 0) return invalid(problems.join('; '));
    const { created } = await this.put('review', planId, review, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.review_submitted',
        who,
        { type: 'ai_benchmark_review', id: planId },
        { taskId: review.taskId, reviewerId: review.reviewerId, accept: review.accept },
      );
    return { created, summary: await this.reviewSummary(planId) };
  }
  async reviewSummary(planId: string): Promise<bm.HumanAcceptanceResult> {
    const plan = (await this.latest<bm.ReviewPlan>('review_plan', planId))?.payload ?? null;
    const reviews = (await this.store.records('review', planId)).map((r) => r.payload as bm.Review);
    return bm.summarizeReviews(plan, reviews);
  }

  // ---- the gate
  async evaluateGate(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const run = await this.store.getRun(str(b.runId, 'runId', 80));
    if (!run) throw new ProblemException('not_found', 'benchmark run not found');
    const baseline =
      typeof b.baselineRunId === 'string' ? await this.store.getRun(b.baselineRunId) : null;
    if (typeof b.baselineRunId === 'string' && !baseline)
      throw new ProblemException('not_found', 'baseline run not found');
    const acceptance =
      (await this.latest<bm.ThresholdAcceptance>('threshold_acceptance', 'thresholds'))?.payload ??
      null;
    const security =
      (await this.latest<bm.SecurityReviewRecord>('security_review', 'agent'))?.payload ?? null;
    let human: bm.HumanAcceptanceResult | null = null;
    for (const p of await this.store.records('review_plan'))
      if ((p.payload as bm.ReviewPlan).runRef === run.reportFingerprint)
        human = await this.reviewSummary(p.subject);
    const decision = bm.evaluateRolloutGate({
      report: run.report as bm.BenchmarkReport,
      baseline: baseline ? (baseline.report as bm.BenchmarkReport) : null,
      acceptance,
      humanReview: human,
      securityReview: security,
    });
    await this.log(
      'ai.benchmark.gate_evaluated',
      who,
      { type: 'ai_benchmark_run', id: run.id },
      {
        allowed: decision.allowed,
        status: decision.status,
        failed: decision.checks.filter((c) => !c.ok).map((c) => c.id),
      },
      decision.allowed,
    );
    return { runId: run.id, evidence: run.evidenceLabel, decision, humanReview: human };
  }

  // ---- qualification
  async qualifications() {
    const all = await this.store.records('qualification');
    const latest = new Map<string, bm.QualificationRecord>();
    for (const r of all) latest.set(r.subject, r.payload as bm.QualificationRecord);
    return [...latest.values()].map((q) => ({ ...q, effectiveState: bm.effectiveState(q) }));
  }
  async proposeQualification(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const q = bm.proposeQualification({
      id: uuidv7(),
      adapterId: str(b.adapterId, 'adapterId', 80),
      model: str(b.model, 'model', 80),
      proposedBy: who,
      at: this.now().toISOString(),
    });
    const { row, created } = await this.put('qualification', q.id, q, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.qualification_proposed',
        who,
        { type: 'ai_benchmark_qualification', id: q.id },
        { adapterId: q.adapterId, model: q.model },
      );
    return { created, qualification: row.payload as bm.QualificationRecord };
  }
  /** Events: attach_evidence (from a stored run and its gate), record_reviews (from the stored plan summary and security review), approve, reject, suspend, reinstate. */
  async qualificationEvent(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const id = str(b.qualificationId, 'qualificationId', 80);
    const q = (await this.latest<bm.QualificationRecord>('qualification', id))?.payload;
    if (!q) throw new ProblemException('not_found', 'qualification not found');
    const at = this.now().toISOString();
    const type = str(b.type, 'type', 40);
    let event: bm.QualificationEvent;
    if (type === 'attach_evidence' || type === 'reinstate') {
      const g = await this.evaluateGate(who, b);
      const run = await this.store.getRun(g.runId);
      event = {
        type,
        by: who,
        at,
        evidence: {
          reportFingerprint: run!.reportFingerprint,
          evidenceLabel: run!.evidenceLabel,
          datasetVersion: run!.datasetVersion,
          gate: { allowed: g.decision.allowed, status: g.decision.status },
        },
      };
    } else if (type === 'record_reviews') {
      const security = (await this.latest<bm.SecurityReviewRecord>('security_review', 'agent'))
        ?.payload;
      const planId = str(b.planId, 'planId', 80);
      if (!security) return invalid('no security review is recorded');
      event = {
        type,
        by: who,
        at,
        humanReview: await this.reviewSummary(planId),
        securityReview: security,
      };
    } else if (type === 'approve') event = { type, by: who, at };
    else if (type === 'reject' || type === 'suspend')
      event = { type, by: who, at, reason: str(b.reason, 'reason', 300) };
    else
      return invalid(
        'type must be attach_evidence, record_reviews, approve, reject, suspend or reinstate',
      );
    const step = bm.stepQualification(q, event);
    if (!step.ok) {
      await this.log(
        'ai.benchmark.qualification_refused',
        who,
        { type: 'ai_benchmark_qualification', id },
        { event: type, error: step.error },
        false,
      );
      throw new ProblemException('validation_failed', step.error);
    }
    const { created } = await this.put('qualification', id, step.record, who, requestId);
    if (created)
      await this.log(
        'ai.benchmark.qualification_changed',
        who,
        { type: 'ai_benchmark_qualification', id },
        { event: type, state: step.record.state },
      );
    return {
      created,
      qualification: { ...step.record, effectiveState: bm.effectiveState(step.record) },
    };
  }

  // ---- the live runner preflight (never runs)
  async attemptLiveRun(who: string, b: Record<string, unknown>) {
    await this.requireEnabled();
    const requestId = requestIdOf(b);
    const env = this.env();
    const acceptance =
      (await this.latest<bm.ThresholdAcceptance>('threshold_acceptance', 'thresholds'))?.payload ??
      null;
    const budget = (await this.latest<bm.BenchmarkBudget>('budget', 'live'))?.payload ?? null;
    const security =
      (await this.latest<bm.SecurityReviewRecord>('security_review', 'agent'))?.payload ?? null;
    const reviewers = (await this.latest<bm.Reviewer[]>('reviewers', 'roster'))?.payload ?? [];
    const price: bm.PriceCard = {
      currency: budget?.currency ?? 'USD',
      minorPerMillionInput: '0',
      minorPerMillionOutput: '0',
    };
    const pre: bm.LivePreconditions = {
      flagEnabled: env.liveEnabled,
      liveProviderGateOpen: env.liveProvidersConfigured,
      environment: env.environmentName
        ? { name: env.environmentName, production: env.production }
        : null,
      // provider verification evidence comes from the provider module (S-AG4); none is read here, so this stays null until that integration exists
      providerVerified: null,
      thresholdsAccepted: acceptance,
      budget,
      reviewers,
      securityReview: security,
    };
    const pf = bm.livePreflight(pre, bm.GOLDEN_TASKS, price);
    const refusals = [
      ...pf.refusals,
      {
        code: 'NO_CAPTURE_SOURCE',
        detail: 'no capture source is wired in this build; a live benchmark cannot start',
      },
    ];
    await this.put(
      'live_attempt',
      'live',
      { refusals, at: this.now().toISOString() },
      who,
      requestId,
    );
    await this.log(
      'ai.benchmark.live_run_refused',
      who,
      { type: 'ai_benchmark_live_run' },
      { refusals: refusals.map((r) => r.code) },
      false,
    );
    return { started: false as const, refusals };
  }
}
