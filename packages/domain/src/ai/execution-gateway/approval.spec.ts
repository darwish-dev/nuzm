import { describe, expect, it } from 'vitest';
import {
  ApprovalWorkflow,
  decideExec,
  decisionDigest,
  describeForApproval,
  type AllowedDecision,
  type Approver,
  type ExecContext,
} from './index';

const ctx: ExecContext = {
  orgId: 'org-1',
  runId: 'run-1',
  enabledProfiles: ['typecheck', 'install-deps', 'run-script'],
  projectScripts: ['lint', 'seed'],
};
const decide = (profile: string, params?: unknown): AllowedDecision => {
  const d = decideExec({ orgId: 'org-1', runId: 'run-1', profile, params }, ctx);
  if (!d.allowed) throw new Error(d.reasons.join());
  return d;
};
const human: Approver = { userId: 'u1', orgId: 'org-1', kind: 'user', canApproveExecution: true };
let t = 0;
const wf = () => new ApprovalWorkflow(() => t, 1000);

describe('ApprovalWorkflow', () => {
  it('only a decision that needs a human can be put up for approval', () => {
    t = 0;
    expect(wf().request(decide('typecheck'), 'org-1', 'run-1')).toEqual({
      ok: false,
      reason: 'approval_not_required',
    });
  });
  it('request -> approve -> consume once; the second consume is refused (single use)', () => {
    t = 0;
    const w = wf();
    const d = decide('install-deps');
    const a = w.request(d, 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    expect(w.decide(a.approval.id, human, 'approve', 'looks fine')).toMatchObject({ ok: true });
    expect(w.consume(a.approval.id, d, 'org-1', 'run-1')).toMatchObject({ ok: true });
    expect(w.consume(a.approval.id, d, 'org-1', 'run-1')).toEqual({
      ok: false,
      reason: 'approval_consumed',
    });
  });
  it('is bound to the exact decision: a different script, profile or run does not match', () => {
    t = 0;
    const w = wf();
    const d = decide('run-script', { script: 'lint' });
    const a = w.request(d, 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    w.decide(a.approval.id, human, 'approve');
    expect(
      w.consume(a.approval.id, decide('run-script', { script: 'seed' }), 'org-1', 'run-1'),
    ).toEqual({
      ok: false,
      reason: 'decision_changed_since_approval',
    });
    expect(w.consume(a.approval.id, d, 'org-1', 'run-2')).toEqual({
      ok: false,
      reason: 'unknown_approval',
    });
    expect(w.consume(a.approval.id, d, 'org-1', 'run-1')).toMatchObject({ ok: true });
  });
  it('digest ignores key order but changes with any member', () => {
    const d = decide('install-deps');
    const reordered = {
      ...d,
      limits: Object.fromEntries(Object.entries(d.limits).reverse()),
    } as AllowedDecision;
    expect(decisionDigest(reordered, 'org-1', 'run-1')).toBe(decisionDigest(d, 'org-1', 'run-1'));
    expect(decisionDigest({ ...d, network: 'none' }, 'org-1', 'run-1')).not.toBe(
      decisionDigest(d, 'org-1', 'run-1'),
    );
    expect(decisionDigest({ ...d, argv: [...d.argv, '--x'] }, 'org-1', 'run-1')).not.toBe(
      decisionDigest(d, 'org-1', 'run-1'),
    );
  });
  it.each([
    ['a model', { ...human, kind: 'model' as const }],
    ['an api key', { ...human, kind: 'api_key' as const }],
    ['the system', { ...human, kind: 'system' as const }],
  ])('%s is never an approver', (_n, who) => {
    t = 0;
    const w = wf();
    const a = w.request(decide('install-deps'), 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    expect(w.decide(a.approval.id, who, 'approve')).toEqual({
      ok: false,
      reason: 'approver_must_be_a_human_user',
    });
    expect(w.get(a.approval.id)!.state).toBe('pending');
  });
  it('requires the permission and the same organization (another tenant sees "unknown")', () => {
    t = 0;
    const w = wf();
    const a = w.request(decide('install-deps'), 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    expect(w.decide(a.approval.id, { ...human, canApproveExecution: false }, 'approve')).toEqual({
      ok: false,
      reason: 'approver_lacks_permission',
    });
    expect(w.decide(a.approval.id, { ...human, orgId: 'org-2' }, 'approve')).toEqual({
      ok: false,
      reason: 'unknown_approval',
    });
  });
  it('expires: an approval cannot be decided or consumed after its time', () => {
    t = 0;
    const w = wf();
    const d = decide('install-deps');
    const a = w.request(d, 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    t = 1000;
    expect(w.decide(a.approval.id, human, 'approve')).toEqual({
      ok: false,
      reason: 'approval_expired',
    });
    t = 0;
    const b = w.request(d, 'org-1', 'run-1');
    if (!b.ok) throw new Error('request');
    w.decide(b.approval.id, human, 'approve');
    t = 5000;
    expect(w.consume(b.approval.id, d, 'org-1', 'run-1')).toEqual({
      ok: false,
      reason: 'approval_expired',
    });
  });
  it('rejected and revoked approvals cannot be consumed; revokeAll serves emergency termination', () => {
    t = 0;
    const w = wf();
    const d = decide('install-deps');
    const r1 = w.request(d, 'org-1', 'run-1');
    const r2 = w.request(d, 'org-1', 'run-1');
    const r3 = w.request(d, 'org-1', 'run-9');
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('request');
    w.decide(r1.approval.id, human, 'reject');
    expect(w.consume(r1.approval.id, d, 'org-1', 'run-1')).toEqual({
      ok: false,
      reason: 'approval_rejected',
    });
    w.decide(r2.approval.id, human, 'approve');
    expect(w.revokeAll({ orgId: 'org-1', runId: 'run-1' })).toBe(1);
    expect(w.consume(r2.approval.id, d, 'org-1', 'run-1')).toEqual({
      ok: false,
      reason: 'approval_revoked',
    });
    expect(w.get(r3.approval.id)!.state).toBe('pending');
    expect(w.revokeAll({ orgId: 'org-2' })).toBe(0);
  });
  it('lists pending approvals per organization and bounds the reason text', () => {
    t = 0;
    const w = wf();
    const a = w.request(decide('install-deps'), 'org-1', 'run-1');
    if (!a.ok) throw new Error('request');
    expect(w.pending('org-1')).toHaveLength(1);
    expect(w.pending('org-2')).toHaveLength(0);
    const done = w.decide(a.approval.id, human, 'approve', 'x'.repeat(5000));
    if (done.ok) expect(done.approval.reason).toHaveLength(200);
  });
  it('the approval screen shows structure and the network, never content', () => {
    const s = describeForApproval(decide('install-deps'));
    expect(s).toMatchObject({
      profile: 'install-deps',
      network: 'registry-only',
      reachesNetwork: true,
      command: 'npm ci --ignore-scripts',
      cwd: '.',
    });
  });
});
