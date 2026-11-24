import { createHash } from 'node:crypto';
import { builderTools, executionGateway, dataFence } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { SegmentSuspend, type GatewayService, type RunContext } from '../../../ai';
import { BUILDER_TOOLS_FLAG } from '../changes/builder-tools-flag';
import type { ChangeService } from '../changes/change.service';
import type { ApprovalService } from '../approvals/approval.service';
import { flagOn } from '../flag.guard';
import type { PgRunStore } from '../ports/m09-real';
import type { ProjectsPort } from '../ports/m09';
import { ModelFileGenerator, SkeletonGenerator } from './file-generators';
import { LifecycleRunner } from './lifecycle.runner';
import { RunContextHost } from './lifecycle.host';
import type { ExecutionBudgetPort, FileOp, LifecycleEnv, Usage } from './lifecycle.types';

const T = builderTools;

/** Default OFF. The lifecycle needs this AND `builder_tools.enabled` (an organization row beats the global row). */
export const BUILDER_LIFECYCLE_FLAG = 'builder_lifecycle.enabled';
/** Default OFF: let a model write the files and the repairs. Off = deterministic placeholders and rule-based repairs (no tokens). */
export const BUILDER_LIFECYCLE_MODEL_FLAG = 'builder_lifecycle.model_generation';

export interface LifecycleDeps {
  db: Db;
  audit: AuditSink;
  store: PgRunStore;
  projects: ProjectsPort;
  changes: Pick<ChangeService, 'apply'>;
  approvals: Pick<ApprovalService, 'request' | 'get'>;
  budget: ExecutionBudgetPort;
  /** the permissions the run's user holds right now (the verified membership), empty for none */
  permissions: (userId: string, orgId: string) => Promise<ReadonlySet<string>>;
  /** null in an environment without a build service: the execution steps then refuse. Only a mock exists until the sandbox runtime is approved (D-21, HG-10-02). */
  buildPort: (orgId: string, runId: string) => builderTools.BuildPort | null;
  /** null where no model gateway is wired */
  gateway: GatewayService | null;
}

const BUDGET_CODES = new Set(['tokens_exceeded', 'credits_exceeded']);

/**
 * The builder agent loop as a mode of the `webapp` run kind (`input.builderLifecycle: true`, like S-AG3's `input.agentic`): validates the preconditions, builds the run's environment
 * from the verified context and hands it to the lifecycle runner; then maps the outcome back onto the run engine's signals. The lifecycle itself has no power beyond its tools.
 */
export class BuilderLifecycleService {
  constructor(private readonly d: LifecycleDeps) {}

  async run(ctx: RunContext): Promise<void> {
    // the flags are checked again here: a run can be created through the generic run endpoint, which cannot know them
    if (
      !(await flagOn(this.d.db, ctx.orgId, BUILDER_TOOLS_FLAG)) ||
      !(await flagOn(this.d.db, ctx.orgId, BUILDER_LIFECYCLE_FLAG))
    )
      throw new ProblemException(
        'unsupported_capability',
        'the builder lifecycle is not enabled for this organization',
      );
    const project = ctx.run.projectId
      ? await this.d.projects.get(ctx.orgId, ctx.run.projectId)
      : null;
    if (!project || (project.type !== 'webapp' && project.type !== 'mobile')) {
      await this.d.store.transition(ctx.orgId, ctx.run.id, 'failed', 'project_not_buildable');
      throw new Error('run ended: project_not_buildable');
    }
    // no user, no authority: a run without a verified user can use no tool that needs a permission
    const permissions = ctx.userId
      ? await this.d.permissions(ctx.userId, ctx.orgId)
      : new Set<string>();
    const host = new RunContextHost(
      ctx,
      { db: this.d.db, audit: this.d.audit, store: this.d.store },
      permissions,
    );
    const env = await this.env(ctx);
    const out = await new LifecycleRunner().run(host, env);
    const L = T.lifecycle;
    const result = {
      outcome: 'lifecycle',
      status: out.status,
      progress: L.progress(out.state),
      repairRounds: out.state.repairRound,
      versionId: out.artifacts.appliedVersionId ?? null,
      deployment: out.artifacts.deployment
        ? {
            target: out.artifacts.deployment.target,
            readiness: out.artifacts.deployment.readiness,
            blockers: out.artifacts.deployment.blockers,
          }
        : null,
      simulated: out.artifacts.executionOrigin !== 'REAL',
      note: 'model quality and the result of building it are NOT VERIFIED; a simulated build proves nothing about the code',
    };
    switch (out.status) {
      case 'waiting_approval':
        throw new SegmentSuspend('approval');
      case 'succeeded':
        await this.d.store.setResult(ctx.orgId, ctx.run.id, result);
        return ctx.succeed(result);
      case 'cancelled':
        throw new ProblemException('conflict', 'cancelled');
      case 'failed': {
        const code = out.state.failure?.code ?? 'failed';
        await this.d.store.setResult(ctx.orgId, ctx.run.id, result);
        await this.d.store.transition(
          ctx.orgId,
          ctx.run.id,
          BUDGET_CODES.has(code) ? 'budget_exceeded' : 'failed',
          code,
        );
        throw new Error(`run ended: ${code}`);
      }
      case 'running':
        throw new Error('run ended: lifecycle_incomplete'); // unreachable: the runner returns only settled statuses
    }
  }

  private async env(ctx: RunContext): Promise<LifecycleEnv> {
    const { orgId } = ctx;
    const projectId = ctx.run.projectId!;
    const usage = { in: 0, out: 0, credits: 0n };
    const takeUsage = (): Usage => {
      const u: Usage = {
        tokensIn: usage.in,
        tokensOut: usage.out,
        credits: usage.credits.toString(),
      };
      usage.in = 0;
      usage.out = 0;
      usage.credits = 0n;
      return u;
    };
    const modelOn =
      this.d.gateway !== null && (await flagOn(this.d.db, orgId, BUILDER_LIFECYCLE_MODEL_FLAG));
    const fence = dataFence();
    // a call id is stable for the same message (a resumed run asks the same thing and the gateway settles it once) and distinct for a retry of it
    const seen = new Map<string, number>();
    const complete = async (message: string, signal?: AbortSignal) => {
      const h = createHash('sha256').update(message).digest('hex').slice(0, 24);
      const n = (seen.get(h) ?? 0) + 1;
      seen.set(h, n);
      const r = await this.d.gateway!.invoke({
        orgId,
        runId: ctx.run.id,
        projectId,
        runKind: 'webapp',
        task: 'edit',
        capability: 'chat',
        dataClass: 'customer-content',
        messages: [{ role: 'user', content: message }],
        maxTokens: 8000,
        callId: `${ctx.run.id}:lc:${h}:${n}`,
        runBudget: ctx.run.budget,
        ...(signal ? { signal } : {}),
        ...(ctx.userId ? { actorUserId: ctx.userId } : {}),
      });
      return {
        text: r.text,
        usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut, credits: r.credits.toString() },
      };
    };
    const onUsage = (u: Usage) => {
      usage.in += u.tokensIn ?? 0;
      usage.out += u.tokensOut ?? 0;
      usage.credits += BigInt(u.credits ?? '0');
    };
    const rules = new T.RuleBasedRepair();
    const repair: builderTools.RepairStrategy = modelOn
      ? new T.FirstOf([
          rules,
          T.modelRepairStrategy(fence, async (m) => {
            const r = await complete(m);
            onUsage(r.usage);
            return r.text;
          }),
        ])
      : rules;
    const headOf = async () => {
      const p = await this.d.projects.get(orgId, projectId);
      if (!p) throw new ProblemException('not_found', 'project not found');
      const files = p.headVersionId
        ? ((await this.d.projects.readFiles(orgId, projectId, p.headVersionId)) ?? new Map())
        : new Map<string, string>();
      return { project: p, versionId: p.headVersionId, files: new Map(files) };
    };
    return {
      head: async () => {
        const h = await headOf();
        return { versionId: h.versionId, files: h.files };
      },
      apply: async (ops: FileOp[], label: string) => {
        const { project } = await headOf();
        const r = await this.d.changes.apply(orgId, ctx.userId ?? '', project, {
          baseVersion: project.headVersionId,
          patches: ops,
          source: 'ai',
          message: label.slice(0, 120),
        });
        return { versionId: r.versionId };
      },
      generator: modelOn
        ? new ModelFileGenerator(fence, complete, onUsage)
        : new SkeletonGenerator(),
      repair,
      modelBacked: { file_generation: modelOn, repair: modelOn },
      build: this.d.buildPort(orgId, ctx.run.id),
      budget: this.d.budget,
      requestDeployApproval: async (summary) => {
        const a = await this.d.approvals.request(orgId, {
          subject: { type: 'run', id: ctx.run.id },
          type: 'production_deploy',
          action: summary,
          runId: ctx.run.id,
          requestedBy: { kind: 'ai' },
          dataRegion: ctx.run.dataRegion,
        });
        return { id: a.id, scopeHash: a.scopeHash };
      },
      deployApprovalStatus: async (id) => (await this.d.approvals.get(orgId, id)).status,
      takeUsage,
    };
  }
}

/**
 * The build service of an environment that has none of the real one: the mock Execution Gateway port (it executes NOTHING; every outcome is the default scripted success) behind the
 * `BuildPort` the lifecycle uses. Returned only in the local reference mode; elsewhere `null`, so the execution steps refuse until the sandbox runtime is approved.
 */
export const mockBuildPortFor =
  (localReference: boolean, now: () => string = () => new Date().toISOString()) =>
  (orgId: string, runId: string): builderTools.BuildPort | null =>
    localReference
      ? new T.ExecutionBuildPort(
          executionGateway.createMockExecutionPort({
            orgId,
            runId,
            enabledProfiles: ['typecheck', 'unit-tests', 'build'],
            projectScripts: [],
          }),
          now,
        )
      : null;
