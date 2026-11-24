/**
 * The build port the review/repair loop consumes (SHARED-CONTRACTS §2, version 0.1 sketch). Session 04 owns the real contract and `MockBuildPort` (built on its `MockExecutionPort`);
 * until that lands on this branch this file is the STAND-IN matching the sketch, and the loop depends only on the `BuildPort` interface, so swapping in Session 04's mock (or a real
 * runtime, once D-21 allows) changes nothing here. `ScriptedBuildPort` never executes anything: its "logs" are whatever a test scripted.
 */
export interface ArtifactRef {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}
export type BuildProfile = 'typecheck' | 'unit-tests' | 'build';
export interface BuildRequest {
  projectId: string;
  versionId: string;
  profile: BuildProfile;
  /** from the verified auth context, never from a model */
  orgId: string;
  runId: string;
}
export type BuildStatus = 'completed' | 'failed' | 'timeout' | 'terminated' | 'refused';
export interface BuildResult {
  status: BuildStatus;
  logs: string;
  artifacts: ArtifactRef[];
  durationMs: number;
}
export interface Preflight {
  allowed: boolean;
  reasons: string[];
  requiresApproval: boolean;
}
export interface BuildPort {
  /** 'MOCK' results are plumbing evidence only: never evidence that code builds */
  readonly origin: 'MOCK' | 'REAL';
  build(req: BuildRequest): Promise<BuildResult>;
  /**
   * OPTIONAL dry decision: would the gateway's policy allow this profile for this organization, and would it need a person's approval? Nothing runs. The lifecycle's
   * `execution_request` step uses it so a refusal shows up BEFORE the build step, not as a failed build. A port without it is treated as "no early answer".
   */
  preflight?(req: BuildRequest): Promise<Preflight>;
}

export type BuildScript =
  Partial<BuildResult> | ((req: BuildRequest, attempt: number) => Partial<BuildResult>);

const DEFAULT: BuildResult = {
  status: 'completed',
  logs: '[MOCK] scripted default: nothing was built\n',
  artifacts: [],
  durationMs: 1,
};
const MAX_LOG = 64 * 1024;

export class ScriptedBuildPort implements BuildPort {
  readonly origin = 'MOCK' as const;
  readonly calls: BuildRequest[] = [];
  private readonly queues = new Map<BuildProfile, BuildScript[]>();
  private fallback: BuildScript | null = null;
  private readonly attempts = new Map<BuildProfile, number>();

  /** The next build of `profile` produces this result; several calls queue several. */
  script(profile: BuildProfile, ...results: BuildScript[]): this {
    this.queues.set(profile, [...(this.queues.get(profile) ?? []), ...results]);
    return this;
  }
  scriptDefault(r: BuildScript | null): this {
    this.fallback = r;
    return this;
  }
  /** scripted ports allow everything: the policy is the real port's business */
  async preflight(): Promise<Preflight> {
    return { allowed: true, reasons: [], requiresApproval: false };
  }
  async build(req: BuildRequest): Promise<BuildResult> {
    this.calls.push(req);
    const attempt = (this.attempts.get(req.profile) ?? 0) + 1;
    this.attempts.set(req.profile, attempt);
    const s = this.queues.get(req.profile)?.shift() ?? this.fallback ?? {};
    const r = typeof s === 'function' ? s(req, attempt) : s;
    const out = { ...DEFAULT, ...r };
    // the same bound a real runtime applies to captured output
    if (out.logs.length > MAX_LOG) out.logs = out.logs.slice(0, MAX_LOG);
    return out;
  }
}
