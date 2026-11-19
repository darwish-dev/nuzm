import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import {
  APPROVAL_TTL_HOURS,
  APPROVAL_TYPES,
  hashOf,
  iso,
  newId,
  type ApprovalType,
  type Row,
} from '../core';

/** Who may decide each approval type (M10 §9: "role per type"). `permission` is the org permission that must also be held. */
export const APPROVAL_POLICY: Record<
  ApprovalType,
  { roles: readonly string[]; permission: 'ai:approve' | 'ai:budget' }
> = {
  production_deploy: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  production_rollback: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  data_migration_rollback: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  destructive_migration: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  paid_resource: { roles: ['owner', 'admin', 'billing_admin'], permission: 'ai:approve' },
  egress_or_dependency: { roles: ['owner', 'admin', 'developer'], permission: 'ai:approve' },
  budget_increase: { roles: ['owner', 'admin', 'billing_admin'], permission: 'ai:budget' },
  export_third_party: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  mobile_signing: { roles: ['owner', 'admin'], permission: 'ai:approve' },
  release_owner: { roles: ['owner'], permission: 'ai:approve' },
};

export type SubjectType = 'run' | 'deployment' | 'release' | 'project' | 'sandbox';
export interface ApprovalDto {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  runId: string | null;
  type: ApprovalType;
  action: Record<string, unknown>;
  /** The hash an approver must quote (`scopeHash`): sha256 of the canonical JSON of {type, subject, action}. */
  scopeHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedByKind: 'ai' | 'user' | 'system';
  requestedBy: string | null;
  requiredRoles: string[];
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}
export interface Actor {
  userId: string;
  role: string;
  permissions: ReadonlySet<string>;
}

/** The hash an approval is bound to: type + subject + the exact action. A decision for any other hash is refused (409 `stale_approval_hash`). */
export const scopeHashOf = (
  type: ApprovalType,
  subject: { type: SubjectType; id: string },
  action: Record<string, unknown>,
): string => hashOf({ type, subject, action });

export type DecisionListener = (orgId: string, approval: ApprovalDto) => void | Promise<void>;

/**
 * The approval engine (M10 §4 S42.3, §9). Every gate is a row bound to the exact action hash and expiring after 24 h; a run waits in `waiting_approval` until
 * the row is decided; a stale hash is a 409, an expired approval a 410, a repeated identical decision is idempotent, a conflicting second decision a 409.
 * An approver must hold the role of the type AND be a human member (an AI request never approves itself: the requester of an `ai` request has no user id).
 */
export class ApprovalService {
  private listeners: DecisionListener[] = [];
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}
  onDecision(l: DecisionListener) {
    this.listeners.push(l);
  }

  dto(r: Row): ApprovalDto {
    return {
      id: r.id as string,
      subjectType: r.subject_type as SubjectType,
      subjectId: r.subject_id as string,
      runId: (r.run_id as string | null) ?? null,
      type: r.approval_type as ApprovalType,
      action: r.action as Record<string, unknown>,
      scopeHash: r.action_hash as string,
      status: r.status as ApprovalDto['status'],
      requestedByKind: r.requested_by_kind as ApprovalDto['requestedByKind'],
      requestedBy: (r.requested_by as string | null) ?? null,
      requiredRoles: r.required_roles as string[],
      expiresAt: iso(r.expires_at)!,
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: iso(r.decided_at),
      decisionNote: (r.decision_note as string | null) ?? null,
      createdAt: iso(r.created_at)!,
    };
  }

  /** Create the approval for an exact action, or return the open one (idempotent). */
  async request(
    orgId: string,
    i: {
      subject: { type: SubjectType; id: string };
      type: ApprovalType;
      action: Record<string, unknown>;
      runId?: string | null;
      requestedBy: { kind: 'ai' | 'user' | 'system'; userId?: string | null };
      dataRegion: string;
    },
  ): Promise<ApprovalDto> {
    if (!(APPROVAL_TYPES as readonly string[]).includes(i.type))
      throw new ProblemException('validation_failed', `unknown approval type ${i.type}`);
    const hash = scopeHashOf(i.type, i.subject, i.action);
    const expires = new Date(this.now().getTime() + APPROVAL_TTL_HOURS * 3_600_000);
    const row = await this.db.withOrg(orgId, async (c) => {
      const open = (
        await c.query(
          `SELECT * FROM ai.approval_requests WHERE org_id = $1 AND subject_type = $2 AND subject_id = $3 AND approval_type = $4 AND action_hash = $5 AND status = 'pending'`,
          [orgId, i.subject.type, i.subject.id, i.type, hash],
        )
      ).rows[0] as Row | undefined;
      if (open && (open.expires_at as Date).getTime() > this.now().getTime())
        return { row: open, created: false };
      if (open)
        await c.query(`UPDATE ai.approval_requests SET status = 'expired' WHERE id = $1`, [
          open.id,
        ]);
      const ins = (
        await c.query(
          `INSERT INTO ai.approval_requests (id, org_id, subject_type, subject_id, run_id, approval_type, action, action_hash, requested_by, requested_by_kind, required_roles, expires_at, data_region)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            newId(),
            orgId,
            i.subject.type,
            i.subject.id,
            i.runId ?? null,
            i.type,
            JSON.stringify(i.action),
            hash,
            i.requestedBy.userId ?? null,
            i.requestedBy.kind,
            [...APPROVAL_POLICY[i.type].roles],
            expires,
            i.dataRegion,
          ],
        )
      ).rows[0] as Row;
      return { row: ins, created: true };
    });
    if (row.created)
      await this.audit.record({
        action: 'ai.approval.requested',
        orgId,
        ...(i.requestedBy.userId
          ? { actorUserId: i.requestedBy.userId }
          : { actorType: 'system' as const }),
        resource: { type: 'approval', id: row.row.id as string },
        outcome: 'success',
        after: {
          type: i.type,
          subjectType: i.subject.type,
          subjectId: i.subject.id,
          runId: i.runId ?? null,
          scopeHash: hash,
        },
      });
    return this.dto(row.row);
  }

  async get(orgId: string, id: string): Promise<ApprovalDto> {
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM ai.approval_requests WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0] as Row | undefined,
    );
    if (!r) throw new ProblemException('not_found', 'approval not found');
    return this.dto(r);
  }

  async list(
    orgId: string,
    f: { status?: string; subjectType?: string; runId?: string; limit?: number } = {},
  ): Promise<ApprovalDto[]> {
    const rows = await this.db.withOrg(orgId, async (c) => {
      // pending rows past their expiry are marked first so the inbox never offers an approval that cannot be decided
      await c.query(
        `UPDATE ai.approval_requests SET status = 'expired' WHERE org_id = $1 AND status = 'pending' AND expires_at <= $2`,
        [orgId, this.now()],
      );
      return (
        await c.query(
          `SELECT * FROM ai.approval_requests WHERE org_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR subject_type = $3) AND ($4::uuid IS NULL OR run_id = $4)
           ORDER BY created_at DESC, id LIMIT $5`,
          [
            orgId,
            f.status ?? null,
            f.subjectType ?? null,
            f.runId ?? null,
            Math.min(f.limit ?? 50, 200),
          ],
        )
      ).rows as Row[];
    });
    return rows.map((r) => this.dto(r));
  }

  /** Decide an approval. See the class comment for the error matrix. */
  async decide(
    orgId: string,
    actor: Actor,
    id: string,
    body: { decision: unknown; scopeHash: unknown; note?: unknown },
  ): Promise<ApprovalDto> {
    if (body.decision !== 'approve' && body.decision !== 'reject')
      throw new ProblemException('validation_failed', 'decision must be approve or reject');
    if (typeof body.scopeHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.scopeHash))
      throw new ProblemException('validation_failed', 'scopeHash is required');
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500))
      throw new ProblemException('validation_failed', 'note must be at most 500 characters');
    const cur = await this.get(orgId, id);
    const policy = APPROVAL_POLICY[cur.type];
    if (!policy.roles.includes(actor.role) || !actor.permissions.has(policy.permission))
      throw new ProblemException(
        'forbidden',
        `deciding a ${cur.type} approval needs the role ${policy.roles.join(' or ')}`,
      );
    const decision = body.decision === 'approve' ? 'approved' : 'rejected';
    if (cur.status !== 'pending') {
      // identical decision for the same hash: idempotent; anything else on a finished approval is a conflict
      if (
        cur.status === decision &&
        cur.scopeHash === body.scopeHash &&
        cur.decidedBy === actor.userId
      )
        return cur;
      if (cur.status === 'expired') throw new ProblemException('gone', 'the approval has expired');
      throw new ProblemException('conflict', `the approval is already ${cur.status}`);
    }
    if (new Date(cur.expiresAt).getTime() <= this.now().getTime()) {
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE ai.approval_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
          [id],
        ),
      );
      throw new ProblemException('gone', 'the approval has expired');
    }
    if (body.scopeHash !== cur.scopeHash)
      throw new ProblemException(
        'stale_approval_hash',
        'the approval is bound to a different action than the one you saw',
      );
    const updated = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `UPDATE ai.approval_requests SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE id = $1 AND status = 'pending' RETURNING *`,
            [id, decision, actor.userId, this.now(), (body.note as string | undefined) ?? null],
          )
        ).rows[0] as Row | undefined,
    );
    if (!updated) return this.get(orgId, id); // lost a race with an identical decision: return the winner
    const dto = this.dto(updated);
    await this.audit.record({
      action: 'ai.approval.decided',
      orgId,
      actorUserId: actor.userId,
      resource: { type: 'approval', id },
      outcome: 'success',
      after: {
        decision,
        type: dto.type,
        subjectType: dto.subjectType,
        subjectId: dto.subjectId,
        scopeHash: dto.scopeHash,
      },
    });
    for (const l of this.listeners) await l(orgId, dto);
    return dto;
  }

  /**
   * Marks pending approvals past their expiry as expired and tells the listeners (a parked run then fails with `approval_expired` instead of waiting forever).
   * Housekeeping job (every minute); idempotent.
   */
  async sweepExpired(limit = 200, asOf: Date = this.now()): Promise<number> {
    const due = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id FROM ai.approval_requests WHERE status = 'pending' AND expires_at <= $1 LIMIT $2`,
            [asOf, limit],
          )
        ).rows as { id: string; org_id: string }[],
    );
    let n = 0;
    for (const r of due) {
      const row = await this.db.withOrg(
        r.org_id,
        async (c) =>
          (
            await c.query(
              `UPDATE ai.approval_requests SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING *`,
              [r.id],
            )
          ).rows[0] as Row | undefined,
      );
      if (!row) continue;
      n++;
      for (const l of this.listeners)
        await Promise.resolve(l(r.org_id, this.dto(row))).catch(() => undefined);
    }
    return n;
  }

  /**
   * The execution gate: is there an APPROVED, unexpired approval for exactly this action? Every guarded action (deploy to production, destructive migration, paid resource,
   * egress, budget increase, ...) calls this and refuses to run without it. `null` = not approved; the caller then creates the request and parks.
   */
  async approvedFor(
    orgId: string,
    subject: { type: SubjectType; id: string },
    type: ApprovalType,
    action: Record<string, unknown>,
  ): Promise<ApprovalDto | null> {
    const hash = scopeHashOf(type, subject, action);
    const r = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM ai.approval_requests WHERE org_id = $1 AND subject_type = $2 AND subject_id = $3 AND approval_type = $4 AND action_hash = $5 AND status = 'approved' AND expires_at > $6
           ORDER BY decided_at DESC LIMIT 1`,
            [orgId, subject.type, subject.id, type, hash, this.now()],
          )
        ).rows[0] as Row | undefined,
    );
    return r ? this.dto(r) : null;
  }
}
