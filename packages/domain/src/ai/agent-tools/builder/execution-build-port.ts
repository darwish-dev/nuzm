import type {
  ArtifactRef,
  BuildPort,
  BuildRequest,
  BuildResult,
  BuildStatus,
  Preflight,
} from './build-port';

/**
 * Adapter from Session 04's `ExecutionPort` (S-AG6, `executionGateway.ExecutionPort`) to the `BuildPort` the repair loop consumes. The port types are declared STRUCTURALLY here, so
 * this file compiles before Session 04's branch is merged and accepts `MockExecutionPort` (or, once D-21 allows, a real port) unchanged. The adapter never supplies a command line: it
 * names one of the closed profiles (`typecheck`, `unit-tests`, `build`) and the gateway's policy decides everything else. A refusal, or a decision that needs a human approval (these
 * three profiles never do), is returned as `refused` and nothing is run.
 */
export interface ExecDecisionLike {
  allowed: boolean;
  reasons?: string[];
  requiresApproval?: boolean;
}
export interface ExecOutcomeLike {
  status: BuildStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  artifacts: { path: string; bytes: number; sha256?: string }[];
}
export interface ExecutionPortLike {
  readonly origin: 'MOCK' | 'REAL';
  request(req: { orgId: string; runId: string; profile: string }): Promise<ExecDecisionLike>;
  run(
    decision: never,
    ctx: { orgId: string; runId: string; approvalId?: string },
  ): Promise<ExecOutcomeLike>;
}

export class ExecutionBuildPort implements BuildPort {
  constructor(
    private readonly port: ExecutionPortLike,
    /** the timestamp for artifact references (the domain reads no clock) */
    private readonly now: () => string,
  ) {}
  get origin(): 'MOCK' | 'REAL' {
    return this.port.origin;
  }

  /** the gateway's own decision, without running anything */
  async preflight(req: BuildRequest): Promise<Preflight> {
    const d = await this.port.request({ orgId: req.orgId, runId: req.runId, profile: req.profile });
    return {
      allowed: d.allowed,
      reasons: [...(d.reasons ?? [])],
      requiresApproval: d.requiresApproval === true,
    };
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    const refused = (why: string): BuildResult => ({
      status: 'refused',
      logs: `refused: ${why}\n`,
      artifacts: [],
      durationMs: 0,
    });
    const decision = await this.port.request({
      orgId: req.orgId,
      runId: req.runId,
      profile: req.profile,
    });
    if (!decision.allowed) return refused((decision.reasons ?? []).join(',') || 'not_allowed');
    if (decision.requiresApproval) return refused('approval_required');
    const out = await this.port.run(decision as never, { orgId: req.orgId, runId: req.runId });
    // a run that "completed" with a non-zero exit code is a failed build
    const status: BuildStatus =
      out.status === 'completed' && out.exitCode !== 0 ? 'failed' : out.status;
    const artifacts: ArtifactRef[] = out.artifacts
      .filter((a) => typeof a.sha256 === 'string')
      .map((a) => ({
        id: a.sha256!,
        path: a.path,
        bytes: a.bytes,
        sha256: a.sha256!,
        createdAt: this.now(),
      }));
    return { status, logs: `${out.stdout}${out.stderr}`, artifacts, durationMs: out.durationMs };
  }
}
