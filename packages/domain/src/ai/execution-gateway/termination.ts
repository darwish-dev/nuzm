/**
 * S-AG6 (OFFLINE): emergency termination and the execution kill switch (ADR-069 item 8). Two separate switches on top of the existing AI kill switch: `global` (every organization)
 * and per-organization. When engaged, admission refuses and the terminator walks the plan: stop admitting, revoke open approvals, drain the queue, kill every running process
 * group (SIGTERM, then SIGKILL after the grace), destroy the workspaces, audit each step. The terminator is written against ports so the same plan drives the mock now and a
 * real runtime later; a step that fails is recorded and the plan continues (a stuck sandbox must never stop the others from being killed).
 */
export interface KillSwitchState {
  global: boolean;
  orgs: ReadonlySet<string>;
}
export class ExecutionKillSwitch {
  private global = false;
  private readonly orgs = new Set<string>();
  private reason: string | null = null;
  engageGlobal(reason: string) {
    this.global = true;
    this.reason = reason.slice(0, 120);
  }
  engageOrg(orgId: string, reason: string) {
    this.orgs.add(orgId);
    this.reason = reason.slice(0, 120);
  }
  /** Releasing is deliberate and separate; it is never automatic. */
  releaseGlobal() {
    this.global = false;
  }
  releaseOrg(orgId: string) {
    this.orgs.delete(orgId);
  }
  isEngaged(orgId: string): boolean {
    return this.global || this.orgs.has(orgId);
  }
  state(): KillSwitchState & { reason: string | null } {
    return { global: this.global, orgs: new Set(this.orgs), reason: this.reason };
  }
}

export type TerminationScope =
  { kind: 'run'; orgId: string; runId: string } | { kind: 'org'; orgId: string } | { kind: 'all' };
export interface RunningExecution {
  orgId: string;
  runId: string;
  jobId: string;
  handle: string;
}
export interface TerminationPorts {
  listRunning(): Promise<RunningExecution[]>;
  /** signal the whole process group: `soft` = SIGTERM, `hard` = SIGKILL */
  signal(h: RunningExecution, how: 'soft' | 'hard'): Promise<void>;
  /** the process group is gone */
  isGone(h: RunningExecution): Promise<boolean>;
  destroyWorkspace(h: RunningExecution): Promise<void>;
  drainQueue(scope: TerminationScope): Promise<number>;
  revokeApprovals(scope: TerminationScope): Promise<number>;
  markTerminated(h: RunningExecution, cause: string): Promise<void>;
  audit(event: {
    step: string;
    ok: boolean;
    runId?: string;
    orgId?: string;
    count?: number;
  }): Promise<void> | void;
}
export interface TerminationReport {
  scope: TerminationScope;
  queuedDrained: number;
  approvalsRevoked: number;
  killed: number;
  hardKilled: number;
  failed: { runId: string; step: string }[];
}
const inScope = (s: TerminationScope, h: RunningExecution) =>
  s.kind === 'all' ||
  (s.kind === 'org' && h.orgId === s.orgId) ||
  (s.kind === 'run' && h.orgId === s.orgId && h.runId === s.runId);

export async function terminate(
  scope: TerminationScope,
  ports: TerminationPorts,
  opts: { cause: string; graceChecks?: number } = { cause: 'emergency' },
): Promise<TerminationReport> {
  const report: TerminationReport = {
    scope,
    queuedDrained: 0,
    approvalsRevoked: 0,
    killed: 0,
    hardKilled: 0,
    failed: [],
  };
  const step = async <T>(
    name: string,
    fn: () => Promise<T>,
    runId?: string,
    orgId?: string,
  ): Promise<T | undefined> => {
    try {
      const r = await fn();
      await ports.audit({ step: name, ok: true, runId, orgId });
      return r;
    } catch {
      report.failed.push({ runId: runId ?? '*', step: name });
      await ports.audit({ step: name, ok: false, runId, orgId });
      return undefined;
    }
  };
  report.approvalsRevoked =
    (await step('revoke_approvals', () => ports.revokeApprovals(scope))) ?? 0;
  report.queuedDrained = (await step('drain_queue', () => ports.drainQueue(scope))) ?? 0;
  const targets = ((await step('list_running', () => ports.listRunning())) ?? []).filter((h) =>
    inScope(scope, h),
  );
  for (const h of targets) {
    await step('signal_soft', () => ports.signal(h, 'soft'), h.runId, h.orgId);
    let gone = (await step('check_gone', () => ports.isGone(h), h.runId, h.orgId)) === true;
    for (let i = 0; !gone && i < (opts.graceChecks ?? 1); i++)
      gone = (await ports.isGone(h).catch(() => false)) === true;
    if (!gone) {
      await step('signal_hard', () => ports.signal(h, 'hard'), h.runId, h.orgId);
      report.hardKilled++;
      gone =
        (await step('check_gone_after_hard', () => ports.isGone(h), h.runId, h.orgId)) === true;
    }
    if (gone) report.killed++;
    else report.failed.push({ runId: h.runId, step: 'still_running' });
    // the workspace is destroyed and the job marked either way: a zombie must not keep a writable directory or a "running" status
    await step('destroy_workspace', () => ports.destroyWorkspace(h), h.runId, h.orgId);
    await step('mark_terminated', () => ports.markTerminated(h, opts.cause), h.runId, h.orgId);
  }
  return report;
}
