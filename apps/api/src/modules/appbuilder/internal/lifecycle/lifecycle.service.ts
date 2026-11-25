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
import {
  BUILDER_LIFECYCLE_REAL_PATH_FLAG,
  BUILDER_LIFECYCLE_REPAIR_ENGINE_FLAG,
  decideRealPath,
  flagValue,
} from './lifecycle.flags';
import { readRunUsage, reconcile } from './reconcile';
import type {
  ExecutionBudgetPort,
  FileGenerator,
  FileOp,
  LifecycleEnv,
  Usage,
} from './lifecycle.types';

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
  /** generators of product types supplied by other tracks (website, full-stack, mobile), keyed by product type; the default generator serves every other type */
  generators?: ReadonlyMap<string, FileGenerator>;
}

const BUDGET_CODES = new Set(['tokens_exceeded', 'credits_exceeded']);

/**
 * The builder agent loop as a mode of the `webapp` run kind (`input.builderLifecycle: true`, like S-AG3's `input.agentic`): validates the preconditions, builds the run's environment
 * from the verified context and hands it to the lifecycle runner; then maps the outcome back onto the run engine's signals. The lifecycle itself has no power beyond its tools.
 */
export class BuilderLifecycleService {
  /** test hook (like `AgentLoopRunner.limits`): replaces the build port of a run, e.g. a scripted one that fails, cancels or crashes; production never sets it */
  buildPortOverride: ((orgId: string, runId: string) => builderTools.BuildPort | null) | null =
    null;
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
    const port = (this.buildPortOverride ?? this.d.buildPort)(ctx.orgId, ctx.run.id);
    // the REAL path (default off): every missing piece is a refusal with its own code, never a silent fallback to placeholders or the mock
    const realFlag = await flagValue(this.d.db, ctx.orgId, BUILDER_LIFECYCLE_REAL_PATH_FLAG);
    const realRequested =
      realFlag === true ||
      (typeof realFlag === 'object' &&
        realFlag !== null &&
        (realFlag as { enabled?: unknown }).enabled === true);
    if (realRequested) {
      const decision = decideRealPath({
        flag: realFlag,
        modelFlagOn: await flagOn(this.d.db, ctx.orgId, BUILDER_LIFECYCLE_MODEL_FLAG),
        gatewayPresent: this.d.gateway !== null,
        buildPort: port ? { origin: port.origin } : null,
      });
      await host.audit(
        'builder.lifecycle.real_path_decided',
        decision.ok ? 'success' : 'failure',
        decision.ok ? { gates: decision.gates } : { code: decision.code, missing: decision.detail },
      );
      if (!decision.ok) {
        await this.d.store.transition(ctx.orgId, ctx.run.id, 'failed', decision.code);
        throw new Error(`run ended: ${decision.code}`);
      }
    }
    const env = await this.env(ctx, port);
    const out = await new LifecycleRunner().run(host, env);
    const L = T.lifecycle;
    const settledNow = out.status !== 'running';
    const settled = settledNow ? await this.evidenceOf(ctx, host, out) : null;
    const evidence = settled?.evidence ?? null;
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
      repair: evidence?.repair.metrics ?? null,
      evidence: evidence
        ? {
            claim: evidence.claim,
            label: evidence.label,
            reconciliation: evidence.reconciliation,
            artifactId: settled?.artifactId ?? null,
          }
        : null,
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

  /** Reads what the gateway recorded for the run, reconciles it with the lifecycle's own accounting, stores the evidence record as a run artifact and emits it. Never throws into the run. */
  private async evidenceOf(
    ctx: RunContext,
    host: RunContextHost,
    out: Awaited<ReturnType<LifecycleRunner['run']>>,
  ): Promise<{ evidence: builderTools.lifecycle.RunEvidence; artifactId: string | null } | null> {
    try {
      const { usage, run, reservations } = await readRunUsage(this.d.db, ctx.orgId, ctx.run.id);
      const rec = reconcile(out.state, usage, run, reservations);
      const evidence = T.lifecycle.buildRunEvidence({
        runId: ctx.run.id,
        projectId: ctx.run.projectId!,
        state: out.state,
        generator: out.artifacts.generator ?? null,
        generatedFiles: out.artifacts.generatedFiles ?? 0,
        builds: out.artifacts.builds ?? [],
        executionOrigin: out.artifacts.executionOrigin ?? null,
        repairRecords: out.artifacts.repairRecords ?? [],
        finishedAt: host.now(),
        usage: {
          modelRefs: usage.modelRefs,
          tokensIn: Number(usage.tokensIn),
          tokensOut: Number(usage.tokensOut),
          credits: usage.credits.toString(),
          costMinor: usage.costMinor === null ? null : usage.costMinor.toString(),
          calls: usage.calls,
          realProvider: usage.realProvider,
        },
      });
      const artifactId = await host.storeArtifact('evaluation_report', {
        evidence,
        reconciliation: rec,
      });
      await host.audit('builder.lifecycle.reconciled', rec.ok ? 'success' : 'failure', {
        status: out.status,
        claim: evidence.claim,
        failed: rec.checks.filter((c) => !c.ok).map((c) => c.name),
      });
      await host.emit('lifecycle_evidence', {
        claim: evidence.claim,
        models: evidence.model.refs,
        tokens: evidence.tokens,
        credits: evidence.credits,
        repairRounds: evidence.repair.rounds,
        reconciled: rec.ok,
      });
      return { evidence, artifactId };
    } catch {
      await host.audit('builder.lifecycle.reconciled', 'failure', {
        status: out.status,
        failed: ['evidence_unavailable'],
      });
      return null;
    }
  }

  private async env(
    ctx: RunContext,
    // optional: callers (and the Phase 2 engine specs that wrap `env`) pass only the context; the port is then resolved the same way `execute` does
    port: builderTools.BuildPort | null = (this.buildPortOverride ?? this.d.buildPort)(
      ctx.orgId,
      ctx.run.id,
    ),
  ): Promise<LifecycleEnv> {
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
    const engineOn = await flagOn(this.d.db, orgId, BUILDER_LIFECYCLE_REPAIR_ENGINE_FLAG);
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
    let repairTokens = 0;
    // the repair engine (flag `builder_lifecycle.repair_engine`): error classes, deterministic fixers first, guards on every proposal; its model turns go through the same metered gateway
    const engine = engineOn
      ? new T.AutoRepairStrategy({
          fence,
          complete: modelOn
            ? async (m) => {
                const r = await complete(m);
                onUsage(r.usage);
                repairTokens += (r.usage.tokensIn ?? 0) + (r.usage.tokensOut ?? 0);
                return r.text;
              }
            : null,
        })
      : null;
    const repair: builderTools.RepairStrategy = engine
      ? new T.FirstOf([rules, engine])
      : modelOn
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
      build: port,
      ...(this.d.generators ? { generators: this.d.generators } : {}),
      ...(engine ? { stepEstimates: { repair: 9000 } } : {}),
      takeRepairTokens: () => {
        const n = repairTokens;
        repairTokens = 0;
        return n;
      },
      ...(engine
        ? {
            repairReport: () => {
              const l = engine.last;
              return l
                ? { strategy: l.strategy, classes: l.classes, asks: l.asks, refused: l.refused }
                : null;
            },
          }
        : {}),
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
