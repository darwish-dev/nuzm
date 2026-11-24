import type { ExecContext, ExecDecision, ExecRequest } from './policy';

/**
 * S-AG6 (OFFLINE PREPARATION): the `ExecutionPort` of SHARED-CONTRACTS section 2 (version 0.1). Session 05 (builder tools) builds against it; the real runtime port is
 * SECURITY-BLOCKED (D-21, HG-10-02, ADR-067), so the only implementation in this repository is `MockExecutionPort`, which NEVER executes anything.
 *
 * The port is split in two on purpose, mirroring the gateway: `request` is the policy decision (a profile name and typed parameters become a fixed argv, fixed environment,
 * fixed limits and a network class, or a refusal with reasons); `run` carries a decision that was ALLOWED. A port never accepts an argv from a caller: `run` takes only the
 * decision the gateway produced.
 */
export interface ArtifactRef {
  id: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}
export type ExecutionStatus = 'completed' | 'failed' | 'timeout' | 'terminated' | 'refused';
export interface ExecutionOutcome {
  status: ExecutionStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  artifacts: { path: string; bytes: number }[];
}
/** What the caller (the agent loop or a builder task) asserts about one run. The organization and run id come from the verified auth context, never from a model. */
export interface ExecutionRunContext {
  orgId: string;
  runId: string;
  /** a human approved this exact decision (`ApprovalWorkflow` produces it); required when `decision.requiresApproval` */
  approvalId?: string;
  /** emergency termination or caller cancel */
  signal?: AbortSignal;
}
/** Whether an implementation can isolate anything. A mock is `simulated`; nothing in this repository sets `verified`. */
export type PortOrigin = 'MOCK' | 'REAL';
export interface ExecutionPort {
  readonly origin: PortOrigin;
  request(req: ExecRequest): Promise<ExecDecision>;
  run(decision: ExecDecision, ctx: ExecutionRunContext): Promise<ExecutionOutcome>;
}

/** A scripted outcome: fields are optional so a test states only what matters. */
export type ScriptedOutcome = Partial<ExecutionOutcome> & { cpuSeconds?: number };
export type OutcomeScript = ScriptedOutcome | ((call: MockRunCall) => ScriptedOutcome);
export interface MockRunCall {
  decision: Extract<ExecDecision, { allowed: true }>;
  ctx: ExecutionRunContext;
  /** 1-based index of this run among the runs of the same profile */
  attempt: number;
}

const DEFAULT_OUTCOME: ExecutionOutcome = {
  status: 'completed',
  exitCode: 0,
  stdout: '[MOCK] scripted default outcome: nothing was executed\n',
  stderr: '',
  truncated: false,
  durationMs: 1,
  artifacts: [],
};
const refusal = (why: string): ExecutionOutcome => ({
  status: 'refused',
  exitCode: null,
  stdout: '',
  stderr: `[MOCK] refused: ${why}\n`,
  truncated: false,
  durationMs: 0,
  artifacts: [],
});

export type MockDecide = (req: ExecRequest, ctx: ExecContext) => ExecDecision;

/**
 * Scripted, deterministic, in-memory. It starts no process, opens no file and no socket; the "stdout" is whatever a test scripted. The gateway's own `decideExec` is injected so
 * the mock refuses exactly what the policy refuses (`createMockExecutionPort` in `mock-port.ts` wires the real one).
 *
 * A mock cannot prove isolation: every outcome it produces is labelled `origin: 'MOCK'` on the port and is never evidence for a runtime control.
 */
export class MockExecutionPort implements ExecutionPort {
  readonly origin = 'MOCK' as const;
  /** every allowed run the port received (tests assert on it) */
  readonly calls: MockRunCall[] = [];
  private readonly scripts = new Map<string, OutcomeScript[]>();
  private readonly attempts = new Map<string, number>();
  private fallback: OutcomeScript | null = null;
  private readonly terminated = new Set<string>();

  constructor(
    private readonly decide: MockDecide,
    private readonly ctx: ExecContext,
  ) {}

  /** The next run of `profile` produces this outcome; several calls queue several outcomes; when the queue is empty the fallback (or the default) applies. */
  script(profile: string, ...outcomes: OutcomeScript[]): this {
    const q = this.scripts.get(profile) ?? [];
    q.push(...outcomes);
    this.scripts.set(profile, q);
    return this;
  }
  /** the outcome for any run without a queued script (default: a successful empty run) */
  scriptDefault(outcome: OutcomeScript | null): this {
    this.fallback = outcome;
    return this;
  }
  /** Emergency termination of a run id: its next (and any in-flight) run ends `terminated`. */
  terminate(runId: string): void {
    this.terminated.add(runId);
  }

  async request(req: ExecRequest): Promise<ExecDecision> {
    return this.decide(req, this.ctx);
  }

  async run(decision: ExecDecision, ctx: ExecutionRunContext): Promise<ExecutionOutcome> {
    if (!decision.allowed) return refusal(`the request was refused: ${decision.reasons.join(',')}`);
    if (ctx.orgId !== this.ctx.orgId || ctx.runId !== this.ctx.runId)
      return refusal('another_tenant_or_run');
    if (decision.requiresApproval && !ctx.approvalId) return refusal('approval_required');
    if (this.terminated.has(ctx.runId) || ctx.signal?.aborted)
      return { ...refusal('terminated'), status: 'terminated' };
    const attempt = (this.attempts.get(decision.profile) ?? 0) + 1;
    this.attempts.set(decision.profile, attempt);
    const call: MockRunCall = { decision, ctx, attempt };
    this.calls.push(call);
    const q = this.scripts.get(decision.profile);
    const s = q?.shift() ?? this.fallback ?? {};
    const scripted = typeof s === 'function' ? s(call) : s;
    return enforceLimits({ ...DEFAULT_OUTCOME, ...stripCpu(scripted) }, decision, scripted);
  }
}
const stripCpu = (s: ScriptedOutcome): Partial<ExecutionOutcome> => {
  const rest: Partial<ExecutionOutcome> & { cpuSeconds?: number } = { ...s };
  delete rest.cpuSeconds;
  return rest;
};

/** The mock still applies the limits of the decision, so a builder loop sees the same shapes (timeout, truncation) a real runtime would produce. */
function enforceLimits(
  out: ExecutionOutcome,
  d: Extract<ExecDecision, { allowed: true }>,
  scripted: ScriptedOutcome,
): ExecutionOutcome {
  const r = { ...out, artifacts: out.artifacts.map((a) => ({ ...a })) };
  const maxBytes = d.limits.outputKb * 1024;
  if (Buffer.byteLength(r.stdout) > maxBytes) {
    r.stdout = Buffer.from(r.stdout).subarray(0, maxBytes).toString('utf8');
    r.truncated = true;
  }
  if (Buffer.byteLength(r.stderr) > maxBytes) {
    r.stderr = Buffer.from(r.stderr).subarray(0, maxBytes).toString('utf8');
    r.truncated = true;
  }
  const cpu = scripted.cpuSeconds ?? 0;
  if (r.durationMs > d.limits.wallSeconds * 1000 || cpu > d.limits.cpuSeconds) {
    return {
      ...r,
      status: 'timeout',
      exitCode: null,
      durationMs: Math.min(r.durationMs, d.limits.wallSeconds * 1000),
    };
  }
  return r;
}
