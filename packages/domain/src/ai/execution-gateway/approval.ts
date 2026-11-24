import { createHash } from 'node:crypto';
import type { ExecDecision } from './policy';

/**
 * S-AG6 (OFFLINE): the human approval workflow for execution (ADR-069 item 3; `requiresApproval` in the decision). An approval is bound to ONE decision by a digest of everything
 * that will run (profile, argv, cwd, network, limits, org, run) so what a human approved is exactly what runs; it is single-use, expires, and can only be decided by a human
 * user of the same organization who holds the approve permission (the API layer resolves the permission; a model, a worker or an API key without it is never an approver).
 *
 * States: pending -> approved | rejected | expired | revoked;  approved -> consumed | expired | revoked.  `consumed`, `rejected`, `expired`, `revoked` are final.
 */
export type ApprovalState =
  'pending' | 'approved' | 'rejected' | 'expired' | 'revoked' | 'consumed';
export interface ExecApproval {
  id: string;
  orgId: string;
  runId: string;
  profile: string;
  digest: string;
  requestedAt: number;
  expiresAt: number;
  state: ApprovalState;
  decidedBy: string | null;
  decidedAt: number | null;
  /** a short human-entered reason; never model text, never shown to a model */
  reason: string | null;
}
export interface Approver {
  userId: string;
  orgId: string;
  /** a signed-in person; anything else is refused */
  kind: 'user' | 'api_key' | 'system' | 'model';
  canApproveExecution: boolean;
}
export type AllowedDecision = Extract<ExecDecision, { allowed: true }>;

/** Canonical JSON: keys sorted at every level, so the digest does not depend on object construction order. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
export function decisionDigest(d: AllowedDecision, orgId: string, runId: string): string {
  const { argv, cwd, env, limits, network, profile } = d;
  return createHash('sha256')
    .update(canon({ argv, cwd, env, limits, network, profile, orgId, runId }))
    .digest('hex');
}
/** What the approval screen shows: structure only, no file content, no model text. */
export function describeForApproval(d: AllowedDecision) {
  return {
    profile: d.profile,
    command: d.argv.join(' '),
    cwd: d.cwd === '' ? '.' : d.cwd,
    network: d.network,
    reachesNetwork: d.network !== 'none',
    limits: d.limits,
  };
}

export type ApprovalOutcome<T = ExecApproval> =
  { ok: true; approval: T } | { ok: false; reason: string };

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
export class ApprovalWorkflow {
  private readonly items = new Map<string, ExecApproval>();
  private seq = 0;
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ) {}
  private refresh(a: ExecApproval): ExecApproval {
    if ((a.state === 'pending' || a.state === 'approved') && this.now() >= a.expiresAt)
      a.state = 'expired';
    return a;
  }
  /** Only a decision that needs a human gets an approval; asking for one for anything else is a bug and is refused. */
  request(d: AllowedDecision, orgId: string, runId: string): ApprovalOutcome {
    if (!d.requiresApproval) return { ok: false, reason: 'approval_not_required' };
    const t = this.now();
    const a: ExecApproval = {
      id: `apr-${++this.seq}`,
      orgId,
      runId,
      profile: d.profile,
      digest: decisionDigest(d, orgId, runId),
      requestedAt: t,
      expiresAt: t + this.ttlMs,
      state: 'pending',
      decidedBy: null,
      decidedAt: null,
      reason: null,
    };
    this.items.set(a.id, a);
    return { ok: true, approval: a };
  }
  get(id: string): ExecApproval | undefined {
    const a = this.items.get(id);
    return a ? this.refresh(a) : undefined;
  }
  pending(orgId: string): ExecApproval[] {
    return [...this.items.values()]
      .map((a) => this.refresh(a))
      .filter((a) => a.orgId === orgId && a.state === 'pending');
  }
  decide(
    id: string,
    by: Approver,
    verdict: 'approve' | 'reject',
    reason?: string,
  ): ApprovalOutcome {
    const a = this.items.get(id);
    if (!a || a.orgId !== by.orgId) return { ok: false, reason: 'unknown_approval' }; // another tenant's id looks the same as a missing one
    this.refresh(a);
    if (by.kind !== 'user') return { ok: false, reason: 'approver_must_be_a_human_user' };
    if (!by.canApproveExecution) return { ok: false, reason: 'approver_lacks_permission' };
    if (a.state !== 'pending') return { ok: false, reason: `approval_${a.state}` };
    a.state = verdict === 'approve' ? 'approved' : 'rejected';
    a.decidedBy = by.userId;
    a.decidedAt = this.now();
    a.reason = reason ? reason.slice(0, 200) : null;
    return { ok: true, approval: a };
  }
  revoke(id: string, orgId: string): boolean {
    const a = this.items.get(id);
    if (!a || a.orgId !== orgId) return false;
    this.refresh(a);
    if (a.state !== 'pending' && a.state !== 'approved') return false;
    a.state = 'revoked';
    return true;
  }
  /** Revoke every open approval of a run (or of an organization): used by emergency termination. */
  revokeAll(match: { orgId: string; runId?: string }): number {
    let n = 0;
    for (const a of this.items.values())
      if (a.orgId === match.orgId && (match.runId === undefined || a.runId === match.runId))
        if (this.revoke(a.id, a.orgId)) n++;
    return n;
  }
  /** Spend an approval for exactly this decision. Single use: a second call, another run, another organization or a changed decision is refused. */
  consume(id: string, d: AllowedDecision, orgId: string, runId: string): ApprovalOutcome {
    const a = this.items.get(id);
    if (!a || a.orgId !== orgId || a.runId !== runId)
      return { ok: false, reason: 'unknown_approval' };
    this.refresh(a);
    if (a.state !== 'approved') return { ok: false, reason: `approval_${a.state}` };
    if (a.digest !== decisionDigest(d, orgId, runId))
      return { ok: false, reason: 'decision_changed_since_approval' };
    a.state = 'consumed';
    return { ok: true, approval: a };
  }
}
