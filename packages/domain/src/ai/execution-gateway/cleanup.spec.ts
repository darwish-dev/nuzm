import { describe, expect, it } from 'vitest';
import { DEFAULT_CLEANUP_POLICY as P, planCleanup, type WorkspaceRecord } from './index';

const NOW = 10_000_000;
const ws = (over: Partial<WorkspaceRecord>): WorkspaceRecord => ({
  id: 'w',
  orgId: 'o',
  runId: 'r',
  state: 'ready',
  createdAt: NOW - 1000,
  lastActivityAt: NOW - 1000,
  jobId: 'j',
  jobState: 'running',
  jobEndedAt: null,
  ...over,
});
const reasons = (...w: WorkspaceRecord[]) => planCleanup(w, NOW).map((a) => a.reason);

describe('planCleanup', () => {
  it('keeps a fresh workspace of a running job', () =>
    expect(reasons(ws({ state: 'in_use' }))).toEqual([]));
  it('destroys after the job ended and the artifact grace passed, not before', () => {
    expect(reasons(ws({ jobState: 'succeeded', jobEndedAt: NOW - P.afterJobEndMs + 1 }))).toEqual(
      [],
    );
    expect(reasons(ws({ jobState: 'succeeded', jobEndedAt: NOW - P.afterJobEndMs }))).toEqual([
      'job_ended',
    ]);
    expect(reasons(ws({ jobState: 'failed', jobEndedAt: NOW - P.afterJobEndMs }))).toEqual([
      'job_ended',
    ]);
  });
  it('destroys a terminated job immediately (no grace after emergency termination)', () => {
    expect(reasons(ws({ jobState: 'terminated', jobEndedAt: NOW }))).toEqual(['terminated']);
  });
  it('reaps orphans after the grace', () => {
    expect(reasons(ws({ jobId: null, jobState: null, createdAt: NOW - 1000 }))).toEqual([]);
    expect(reasons(ws({ jobId: null, jobState: null, createdAt: NOW - P.orphanGraceMs }))).toEqual([
      'orphan',
    ]);
  });
  it('reaps on lifetime and idle, but an in_use workspace is only reaped by lifetime', () => {
    expect(reasons(ws({ createdAt: NOW - P.maxLifetimeMs, lastActivityAt: NOW }))).toEqual([
      'max_lifetime',
    ]);
    expect(reasons(ws({ lastActivityAt: NOW - P.idleMs }))).toEqual(['idle']);
    expect(reasons(ws({ state: 'in_use', lastActivityAt: NOW - P.idleMs }))).toEqual([]);
  });
  it('always reaps failed workspaces and skips destroyed ones', () => {
    expect(reasons(ws({ state: 'failed' }))).toEqual(['failed']);
    expect(reasons(ws({ state: 'destroyed', jobState: 'succeeded', jobEndedAt: 0 }))).toEqual([]);
  });
  it('carries the tenant ids so cleanup is audited per organization', () => {
    expect(planCleanup([ws({ id: 'w9', orgId: 'o9', runId: 'r9', state: 'failed' })], NOW)).toEqual(
      [{ workspaceId: 'w9', orgId: 'o9', runId: 'r9', reason: 'failed' }],
    );
  });
});
