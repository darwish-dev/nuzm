import { executionGateway as eg } from '@nuzm/domain';
import { checkRunEnvOk, quotaFromLimits } from './execution-mapping';
import type { SandboxRuntime } from './runtime';

/**
 * S-AG6 (OFFLINE): `ExecutionPort` over the M10 `SandboxRuntime` boundary. It is the seam where a real isolating runtime will plug in; today the only runtimes are the in-memory
 * `mock` (starts nothing) and the `local-dev` runner (starts real processes on a developer's machine, isolation NONE).
 *  - `local-dev` is REFUSED unconditionally: agent-driven execution never runs non-isolated processes, not even in development.
 *  - `origin` is `REAL` only for a runtime that reports `isolation: 'verified'`; the orchestrator then also requires the open gate. Nothing in this repository reports `verified`.
 *  - one sandbox per run, created for the run and destroyed in `finally` (success, failure, timeout and exception alike); the handle never leaves this class.
 *  - the argv and the environment are exactly the decision's (checked again here); no request member reaches the runtime.
 */
export interface SandboxPortConfig {
  /** the organization and run this port instance serves (a port is per run) */
  ctx: eg.ExecContext;
  projectId: string;
  sandboxIdFor: (runId: string) => string;
  egressProfile: string;
  /** files to seed into the workspace (already a snapshot of the project at a version); screened for secrets before they are written */
  seedFiles: () => ReadonlyMap<string, string>;
  canaries: () => readonly string[];
}
export class SandboxRuntimeExecutionPort implements eg.ExecutionPort {
  constructor(
    private readonly runtime: SandboxRuntime,
    private readonly cfg: SandboxPortConfig,
  ) {}
  get origin(): eg.PortOrigin {
    return this.runtime.isolation === 'verified' ? 'REAL' : 'MOCK';
  }
  private readonly issued = new eg.IssuedDecisions();
  async request(req: eg.ExecRequest): Promise<eg.ExecDecision> {
    const d = eg.decideExec(req, this.cfg.ctx);
    this.issued.record(d, this.cfg.ctx.orgId, this.cfg.ctx.runId);
    return d;
  }
  private refuse(why: string): eg.ExecutionOutcome {
    return {
      status: 'refused',
      exitCode: null,
      stdout: '',
      stderr: `refused: ${why}\n`,
      truncated: false,
      durationMs: 0,
      artifacts: [],
    };
  }
  async run(decision: eg.ExecDecision, ctx: eg.ExecutionRunContext): Promise<eg.ExecutionOutcome> {
    if (!decision.allowed) return this.refuse(`request refused: ${decision.reasons.join(',')}`);
    if (this.runtime.kind === 'local-dev')
      return this.refuse('local_dev_runtime_never_runs_agent_execution');
    if (ctx.orgId !== this.cfg.ctx.orgId || ctx.runId !== this.cfg.ctx.runId)
      return this.refuse('another_tenant_or_run');
    if (!this.issued.has(decision, this.cfg.ctx.orgId, this.cfg.ctx.runId))
      return this.refuse('decision_not_issued_by_gateway');
    if (decision.requiresApproval && !ctx.approvalId) return this.refuse('approval_required');
    if (ctx.signal?.aborted) return { ...this.refuse('terminated'), status: 'terminated' };
    if (!checkRunEnvOk(decision.env)) return this.refuse('environment_not_the_constant');
    const files = this.cfg.seedFiles();
    const screened = eg.checkWorkspaceFiles(
      [...files].map(([path, content]) => ({ path, content })),
      this.cfg.canaries(),
    );
    if (!screened.ok)
      return this.refuse(`workspace_refused:${screened.refused.map((r) => r.reason).join(',')}`);
    let handle: string | null = null;
    try {
      handle = await this.runtime.create({
        sandboxId: this.cfg.sandboxIdFor(ctx.runId),
        orgId: ctx.orgId,
        projectId: this.cfg.projectId,
        quota: quotaFromLimits(decision.limits),
        egressProfile: decision.network === 'none' ? 'none' : this.cfg.egressProfile,
      });
      await this.runtime.writeFiles(handle, files);
      const t = eg.runTimeouts(decision.limits);
      const r = await this.runtime.exec(handle, {
        argv: [...decision.argv],
        cwd: decision.cwd === '' ? undefined : decision.cwd,
        env: { ...decision.env },
        timeoutMs: t.softMs,
      });
      const status: eg.ExecutionStatus = r.timedOut
        ? 'timeout'
        : r.exitCode === 0
          ? 'completed'
          : 'failed';
      return {
        status,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        truncated: r.truncated,
        durationMs: r.durationMs,
        artifacts: [],
      };
    } catch (e) {
      return this.refuse(`runtime_error:${(e as Error).name}`);
    } finally {
      if (handle) await this.runtime.destroy(handle).catch(() => undefined);
    }
  }
}
