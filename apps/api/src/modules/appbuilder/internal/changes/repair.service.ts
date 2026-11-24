import { builderTools } from '@nuzm/domain';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { ProjectRecord, ProjectsPort } from '../ports/m09';
import type { ChangeResult, ChangeService } from './change.service';

const T = builderTools;

/**
 * Review-and-repair of a project (S-05 priority 3) over a `BuildPort`. The port is injected and is NEVER a real executor in this repository: until the sandbox runtime exists (D-21,
 * HG-10-02, ADR-067) the only implementation is a scripted mock, and `ProjectRepairService` refuses to run without one. Repairs are committed through the ordinary safe-change
 * pipeline as AI changes (the AI branch only, never `main`); a repair that needs a human is returned, not applied. Strategy: the deterministic rule-based repairs first; a
 * model-backed strategy is added by the agent loop later (it needs S-AG4) and plugs into the same `RepairStrategy` interface.
 */
export class ProjectRepairService {
  constructor(
    private readonly projects: ProjectsPort,
    private readonly changes: Pick<ChangeService, 'apply'>,
    private readonly audit: AuditSink,
    /** null = no build port configured (the default): the service answers `unsupported_capability` */
    private readonly build: builderTools.BuildPort | null,
    private readonly strategy: builderTools.RepairStrategy = new T.RuleBasedRepair(),
  ) {}

  async run(
    orgId: string,
    actor: string,
    p: ProjectRecord,
    ctx: { runId: string; profiles?: readonly builderTools.BuildProfile[]; signal?: AbortSignal },
  ) {
    if (p.type !== 'webapp' && p.type !== 'mobile')
      throw new ProblemException('unsupported_capability', 'this applies to web-app and mobile projects');
    if (!this.build)
      throw new ProblemException('unsupported_capability', 'no build service is configured: running builds is blocked until the sandbox runtime is approved');
    if (!p.headVersionId) throw new ProblemException('conflict', 'the project has no version to review');
    const files = await this.projects.readFiles(orgId, p.id, p.headVersionId);
    if (!files) throw new ProblemException('not_found', 'project version not found');
    let head = p;
    const committed: ChangeResult[] = [];
    const io: builderTools.RepairIO = {
      commit: async (ops, label) => {
        const r = await this.changes.apply(orgId, actor, head, { baseVersion: head.headVersionId, patches: ops, source: 'ai', message: label });
        committed.push(r);
        head = { ...head, headVersionId: r.versionId }; // the next repair builds on the version it just made
        return { versionId: r.versionId };
      },
    };
    const report = await T.runRepairLoop({
      orgId,
      runId: ctx.runId,
      projectId: p.id,
      versionId: p.headVersionId,
      files,
      build: this.build,
      io,
      strategy: this.strategy,
      ...(ctx.profiles ? { profiles: ctx.profiles } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await this.audit.record({
      action: 'builder.repair.completed',
      orgId,
      actorUserId: actor,
      resource: { type: 'project', id: p.id },
      outcome: report.status === 'passed' ? 'success' : 'failure',
      after: { status: report.status, reason: report.reason, rounds: report.iterations.length, builds: report.builds, repairs: report.totalOps, origin: report.origin, runId: ctx.runId },
    });
    return {
      status: report.status,
      reason: report.reason,
      origin: report.origin,
      iterations: report.iterations,
      totalOps: report.totalOps,
      builds: report.builds,
      pendingApproval: report.pendingApproval.length,
      versionId: report.versionId,
      note: report.origin === 'MOCK' ? 'simulated: no real build ran; this does not show that the code builds' : null,
    };
  }
}
