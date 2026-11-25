import type { JobState, WorkspaceState } from './lifecycle';
import { isJobTerminal } from './lifecycle';

/**
 * S-AG6 (OFFLINE): temporary workspace cleanup, as a pure planner. Given what exists, it says what to destroy and why; the caller executes the plan (and audits each step). A
 * workspace is destroyed when its job ended (after a short grace so artifacts can be collected), when it exceeded its lifetime or idle time, when it has no job at all
 * (an orphan from a crash), or when it failed. Nothing is ever kept for reuse by another run or organization.
 */
export interface WorkspaceRecord {
  id: string;
  orgId: string;
  runId: string;
  state: WorkspaceState;
  createdAt: number;
  lastActivityAt: number;
  /** the job that owns it, if any */
  jobId: string | null;
  jobState: JobState | null;
  jobEndedAt: number | null;
}
export interface CleanupPolicy {
  afterJobEndMs: number;
  maxLifetimeMs: number;
  idleMs: number;
  /** an orphan (no job) is given this long before it is reaped, so a workspace being created is not killed mid-way */
  orphanGraceMs: number;
}
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  afterJobEndMs: 5 * 60_000,
  maxLifetimeMs: 30 * 60_000,
  idleMs: 10 * 60_000,
  orphanGraceMs: 2 * 60_000,
};
export type CleanupReason =
  'job_ended' | 'max_lifetime' | 'idle' | 'orphan' | 'failed' | 'terminated';
export interface CleanupAction {
  workspaceId: string;
  orgId: string;
  runId: string;
  reason: CleanupReason;
}
export function planCleanup(
  all: readonly WorkspaceRecord[],
  now: number,
  p: CleanupPolicy = DEFAULT_CLEANUP_POLICY,
): CleanupAction[] {
  const out: CleanupAction[] = [];
  for (const w of all) {
    if (w.state === 'destroyed') continue;
    const act = (reason: CleanupReason) =>
      out.push({ workspaceId: w.id, orgId: w.orgId, runId: w.runId, reason });
    if (w.state === 'failed') act('failed');
    else if (w.jobState === 'terminated') act('terminated');
    else if (
      w.jobState !== null &&
      isJobTerminal(w.jobState) &&
      now - (w.jobEndedAt ?? w.lastActivityAt) >= p.afterJobEndMs
    )
      act('job_ended');
    else if (w.jobId === null && now - w.createdAt >= p.orphanGraceMs) act('orphan');
    else if (now - w.createdAt >= p.maxLifetimeMs) act('max_lifetime');
    else if (w.state !== 'in_use' && now - w.lastActivityAt >= p.idleMs) act('idle');
    else if (w.state === 'destroying') act('failed');
  }
  return out;
}
