import { ProblemException } from '../../../../common/errors';
import type { AuditSink } from '../../../../common/audit';
import { ChangeService, type Patch } from '../changes/change.service';
import { BudgetLedger, clampBudget, BudgetExceeded } from '../graph/budget';
import { GuardedModel, RunCancelled, ArtifactInvalid } from '../graph/guarded-model';
import type { Schema } from '../schema';
import {
  ModelNoCapacityError,
  ModelTimeoutError,
  type ModelGatewayPort,
  type OrgBudgetPort,
  type ProjectsPort,
  type RunStorePort,
} from '../ports/m09';
import { DEBUG_LIMITS, DebugLoopGuard, type StopReason } from './debug-loop';
import { groupOf, type TestCase } from './parsers';
import type { TestRunService } from './test-run.service';

export type FixOutcome =
  | { status: 'fixed'; iterations: number }
  | {
      status: 'escalated';
      reason: StopReason | 'no_progress';
      group: string | null;
      iterations: number;
    }
  | { status: 'budget_exceeded'; dimension: string; iterations: number }
  | { status: 'cancelled' | 'failed'; reason: string; iterations: number };

const FIX_SCHEMA: Schema = {
  type: 'object',
  required: ['patches'],
  additionalProperties: false,
  properties: {
    explanation: { type: 'string', maxLength: 2000 },
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['op', 'path'],
        additionalProperties: false,
        properties: {
          op: { enum: ['add', 'modify', 'delete', 'rename'] },
          path: { type: 'string' },
          content: { type: 'string' },
          from: { type: 'string' },
          expectedHash: { type: 'string' },
        },
      },
    },
  },
};

/**
 * `test-fix` run (S46.4): run the tests; for each failing group ask the model for a patch, apply it through the SAME checked changes pipeline (source `ai`), run the tests
 * again. Bounded by DEBUG_LIMITS (5 consecutive per group, 15 per run, 3 identical failure signatures) and by the run budget; the end of the budget or of the limits
 * escalates to a human, it never loops.
 */
export class TestFixService {
  constructor(
    private readonly audit: AuditSink,
    private readonly runs: RunStorePort,
    private readonly gateway: ModelGatewayPort,
    private readonly orgBudget: OrgBudgetPort,
    private readonly tests: TestRunService,
    private readonly changes: ChangeService,
    private readonly projects: ProjectsPort,
    private readonly modelTimeoutMs = 120_000,
  ) {}

  async run(orgId: string, actor: string, projectId: string, runId: string): Promise<FixOutcome> {
    let run = await this.runs.get(orgId, runId);
    if (!run) return { status: 'failed', reason: 'run_not_found', iterations: 0 };
    if (run.kind !== 'test-fix')
      return { status: 'failed', reason: 'wrong_run_kind', iterations: 0 };
    if (run.state === 'queued') run = await this.runs.transition(orgId, runId, 'running');
    const ledger = new BudgetLedger(
      clampBudget(run.budget),
      run.usage,
      run.startedAt ? Date.parse(run.startedAt) : Date.now(),
    );
    const cancelled = async () => {
      const r = await this.runs.get(orgId, runId);
      return r?.state === 'cancelled' || r?.cancelRequested === true;
    };
    const model = new GuardedModel(
      this.gateway,
      this.runs,
      ledger,
      this.orgBudget,
      { orgId, runId, dataRegion: run.dataRegion },
      cancelled,
      { timeoutMs: this.modelTimeoutMs },
    );
    const guard = new DebugLoopGuard();
    let iterations = 0;
    const finish = async (
      o: FixOutcome,
      to: 'succeeded' | 'failed' | 'budget_exceeded' | 'cancelled',
      reason?: string,
    ): Promise<FixOutcome> => {
      await this.runs.transition(orgId, runId, to, reason ?? null).catch(() => undefined);
      await this.audit.record({
        action: 'ai.run.completed',
        orgId,
        resource: { type: 'run', id: runId },
        outcome: to === 'succeeded' ? 'success' : 'failure',
        actorType: 'system',
        after: { kind: 'test-fix', iterations, outcome: o.status },
      });
      return o;
    };
    try {
      for (let guardRound = 0; guardRound < DEBUG_LIMITS.perRun + 2; guardRound++) {
        if (await cancelled()) return { status: 'cancelled', reason: 'cancelled', iterations };
        const project = (await this.projects.get(orgId, projectId))!;
        const tr = await this.tests.execute(
          orgId,
          actor,
          project,
          (await this.tests.create(orgId, actor, project, { suite: 'all' }, { runId })).id,
        );
        if (tr.status === 'passed') return finish({ status: 'fixed', iterations }, 'succeeded');
        if (tr.status === 'errored')
          return finish(
            { status: 'escalated', reason: 'no_progress', group: null, iterations },
            'failed',
            'escalated_to_human',
          );
        const failing: TestCase[] = (tr.summary['suites'] as { cases: TestCase[] }[]).flatMap((s) =>
          s.cases.filter((c) => c.status === 'failed'),
        );
        const byGroup = new Map<string, TestCase[]>();
        for (const c of failing) byGroup.set(groupOf(c), [...(byGroup.get(groupOf(c)) ?? []), c]);
        // every group that no longer fails is reset (consecutive limit)
        let attempted = false;
        for (const [group, cases] of byGroup) {
          const signature = cases
            .map((c) => `${c.name}::${c.failure ?? ''}`)
            .sort()
            .join('|')
            .replace(/\d+/g, 'N');
          const verdict = guard.attempt(group, signature);
          if (!verdict.proceed)
            return finish(
              { status: 'escalated', reason: verdict.reason!, group, iterations },
              'failed',
              'escalated_to_human',
            );
          attempted = true;
          iterations++;
          const files = await this.projects.readFiles(orgId, projectId, project.headVersionId!);
          const relevant = Object.fromEntries(
            [...(files ?? [])]
              .filter(([p]) => p === group || cases.some((c) => c.name.includes(p)))
              .map(([p, c]) => [p, c.slice(0, 20_000)]),
          );
          const fix = await model.ask<{ patches: Patch[] }>({
            agent: 'test-fix',
            purpose: 'test_fix',
            input: {
              data: { group, failures: cases.slice(0, 10), files: relevant },
              task: 'fix_failing_tests',
            },
            schema: FIX_SCHEMA,
            maxTokens: 12_000,
          });
          try {
            await this.changes.apply(orgId, actor, (await this.projects.get(orgId, projectId))!, {
              baseVersion: project.headVersionId,
              patches: fix.patches,
              source: 'ai',
              message: `test-fix: ${group}`,
            });
          } catch (e) {
            if (!(e instanceof ProblemException)) throw e; // a refused patch is a failed attempt; the signature repeats and the guard stops the loop
          }
        }
        for (const g of [...Object.keys(guard.used.perGroup)]) if (!byGroup.has(g)) guard.fixed(g);
        if (!attempted)
          return finish(
            { status: 'escalated', reason: 'no_progress', group: null, iterations },
            'failed',
            'escalated_to_human',
          );
      }
      return finish(
        { status: 'escalated', reason: 'run_limit', group: null, iterations },
        'failed',
        'escalated_to_human',
      );
    } catch (e) {
      if (e instanceof BudgetExceeded)
        return finish(
          { status: 'budget_exceeded', dimension: e.dimension, iterations },
          'budget_exceeded',
          e.dimension,
        );
      if (e instanceof RunCancelled)
        return { status: 'cancelled', reason: 'cancelled', iterations };
      const reason =
        e instanceof ArtifactInvalid
          ? 'artifact_invalid'
          : e instanceof ModelTimeoutError
            ? 'model_timeout'
            : e instanceof ModelNoCapacityError
              ? 'no_capacity'
              : 'agent_error';
      return finish({ status: 'failed', reason, iterations }, 'failed', reason);
    }
  }
}
