import { ProblemException } from '../../../common/errors';
import { SegmentSuspend, WorkerCrash, type RunContext, type RunKindHandler } from '../../ai';
import { assembleFiles } from './agents/webapp-agents';
import { WEBAPP_GRAPH } from './graph/dag';
import type { GraphRunner } from './graph/runner';
import { PgRunStore } from './ports/m09-real';
import type { ProjectsPort } from './ports/m09';
import type { TestFixService } from './tests/test-fix.service';
import type { TemplateAdaptRunner } from './studio/template-adapt';

/**
 * The run kinds `webapp` and `test-fix` as handlers of M09's `RunKindRegistry` (M09 contract §3: "M10 registers `webapp|mobile|test-fix` the same way"). M09's segment
 * engine owns the lifecycle around them (operation, lease, checkpoint resume, events, final state); these handlers only drive the M10 graph / debug loop for ONE segment:
 *
 *  - the graph and the debug loop already persist every step (`ai.run_steps`), checkpoint every node and move the run through the state machine themselves
 *    (`PgRunStore` writes `ai.runs`), so a segment that ends because of an approval is resumed by `AppRunService.resume` → `RunService.resumeParked`;
 *  - the outcome is mapped back onto the engine's signals: success → `ctx.succeed`, a wait → `SegmentSuspend`, a stop → a thrown error (the engine records the event;
 *    `ai.runs.error.code` was already written by `PgRunStore` with the precise reason), another worker holding the run → `WorkerCrash` (the lease expires, the next claim resumes).
 */
const OUTCOME_ERROR = (reason: string) => new Error(`run ended: ${reason}`);

abstract class AppRunHandler implements RunKindHandler {
  abstract readonly kind: string;
  readonly toolKind = 'edit' as const;
  readonly requiresProject = true;
  constructor(
    protected readonly store: PgRunStore,
    protected readonly projects: ProjectsPort,
  ) {}
  validateInput(input: Record<string, unknown>): void {
    const m = input.maxMinutes;
    if (m !== undefined && (!Number.isInteger(m) || (m as number) < 1 || (m as number) > 60))
      throw new ProblemException('validation_failed', 'input.maxMinutes must be an integer 1..60');
    const s = input.specRef;
    if (s !== undefined && (typeof s !== 'string' || s.length > 100))
      throw new ProblemException('validation_failed', 'input.specRef must be a short string');
    this.validateKind(input);
  }
  protected abstract validateKind(input: Record<string, unknown>): void;
  protected async webappProject(ctx: RunContext) {
    const p = ctx.run.projectId ? await this.projects.get(ctx.orgId, ctx.run.projectId) : null;
    if (!p || p.type !== 'webapp') {
      await this.store.transition(ctx.orgId, ctx.run.id, 'failed', 'project_not_webapp');
      throw OUTCOME_ERROR('project_not_webapp');
    }
    return p;
  }
  abstract execute(ctx: RunContext): Promise<void>;
}

export class WebappRunHandler extends AppRunHandler {
  readonly kind = 'webapp';
  constructor(
    store: PgRunStore,
    projects: ProjectsPort,
    private readonly graph: GraphRunner,
    /** S-K6: the adaptation of a copied template (`input.templatePlanId`); absent where the knowledge module is not wired */
    private readonly adapt?: TemplateAdaptRunner,
  ) {
    super(store, projects);
  }
  protected validateKind(input: Record<string, unknown>): void {
    const plan = input.templatePlanId;
    if (plan !== undefined) {
      if (typeof plan !== 'string' || !/^[0-9a-f-]{36}$/i.test(plan))
        throw new ProblemException('validation_failed', 'input.templatePlanId must be a plan id');
      if (input.brief !== undefined)
        throw new ProblemException(
          'validation_failed',
          'a template adaptation takes no brief: its requirement is in the plan',
        );
      return;
    }
    const b = input.brief;
    if (b === undefined) return;
    if (typeof b !== 'object' || b === null || Array.isArray(b))
      throw new ProblemException('validation_failed', 'input.brief must be an object');
    const prompt = (b as { prompt?: unknown }).prompt;
    if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 4000))
      throw new ProblemException(
        'validation_failed',
        'input.brief.prompt must be a string of at most 4000 characters',
      );
  }
  async execute(ctx: RunContext): Promise<void> {
    await this.webappProject(ctx);
    if (ctx.run.input.templatePlanId !== undefined) {
      if (!this.adapt)
        throw new ProblemException(
          'unsupported_capability',
          'template adaptation is not available',
        );
      return this.adapt.run(ctx);
    }
    const out = await this.graph.run(
      ctx.orgId,
      ctx.run.id,
      WEBAPP_GRAPH,
      { brief: (ctx.run.input.brief as Record<string, unknown> | undefined) ?? {} },
      {
        emit: ctx.emit,
        // the assembled project becomes the next version of the M09 project BEFORE the run is marked succeeded (idempotent per run: a resumed segment finds its own version)
        finalize: async (artifacts) => {
          const label = `Generated by run ${ctx.run.id}`;
          const versions = await this.projects.listVersions(ctx.orgId, ctx.run.projectId!);
          if (versions.some((v) => v.label === label)) return;
          const head =
            (await this.projects.get(ctx.orgId, ctx.run.projectId!))?.headVersionId ?? null;
          const v = await this.projects.commit(ctx.orgId, ctx.run.projectId!, {
            baseVersionId: head,
            files: assembleFiles(artifacts),
            label,
            source: 'ai',
            createdBy: ctx.userId,
          });
          await ctx.emit('project_committed', {
            versionId: v.id,
            files: Object.keys(v.manifest).length,
          });
        },
      },
    );
    switch (out.status) {
      case 'succeeded': {
        const result = { graph: WEBAPP_GRAPH.name, artifacts: Object.keys(out.artifacts) };
        await this.store.setResult(ctx.orgId, ctx.run.id, result);
        return ctx.succeed(result);
      }
      case 'waiting_approval':
        throw new SegmentSuspend('approval');
      case 'busy':
        throw new WorkerCrash('another worker holds a node of this run');
      case 'budget_exceeded':
        throw new ProblemException('budget_exceeded', `run budget exhausted (${out.dimension})`);
      case 'cancelled':
        throw new ProblemException('conflict', 'cancelled');
      case 'failed':
        throw OUTCOME_ERROR(out.reason);
    }
  }
}

export class TestFixRunHandler extends AppRunHandler {
  readonly kind = 'test-fix';
  constructor(
    store: PgRunStore,
    projects: ProjectsPort,
    private readonly testFix: TestFixService,
  ) {
    super(store, projects);
  }
  protected validateKind(): void {
    /* no further input: the project's head version is what gets tested and fixed */
  }
  async execute(ctx: RunContext): Promise<void> {
    await this.webappProject(ctx);
    const out = await this.testFix.run(ctx.orgId, ctx.userId ?? '', ctx.run.projectId!, ctx.run.id);
    switch (out.status) {
      case 'fixed': {
        const result = { outcome: 'fixed', iterations: out.iterations };
        await this.store.setResult(ctx.orgId, ctx.run.id, result);
        return ctx.succeed(result);
      }
      case 'escalated':
        await this.store.setResult(ctx.orgId, ctx.run.id, {
          outcome: 'escalated',
          reason: out.reason,
          group: out.group,
          iterations: out.iterations,
        });
        throw OUTCOME_ERROR('escalated_to_human');
      case 'budget_exceeded':
        throw new ProblemException('budget_exceeded', `run budget exhausted (${out.dimension})`);
      case 'cancelled':
        throw new ProblemException('conflict', 'cancelled');
      case 'failed':
        throw OUTCOME_ERROR(out.reason);
    }
  }
}
