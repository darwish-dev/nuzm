import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';

export interface HoldDto {
  id: string;
  orgId: string | null;
  dataset: string | null;
  reason: string;
  status: 'pending_approval' | 'active' | 'rejected' | 'released';
  requestedBy: string;
  approverId: string;
  decidedAt: string | null;
  decisionNote: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
}
type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const dto = (r: Row): HoldDto => ({
  id: r.id as string,
  orgId: (r.org_id as string | null) ?? null,
  dataset: (r.dataset as string | null) ?? null,
  reason: r.reason as string,
  status: r.status as HoldDto['status'],
  requestedBy: r.requested_by as string,
  approverId: r.approver_id as string,
  decidedAt: iso(r.decided_at),
  decisionNote: (r.decision_note as string | null) ?? null,
  releasedBy: (r.released_by as string | null) ?? null,
  releasedAt: iso(r.released_at),
  releaseReason: (r.release_reason as string | null) ?? null,
  createdAt: iso(r.created_at)!,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATASET = /^[a-z_]+\.[a-z_]+$/;

export type HoldRequest =
  | {
      kind: 'create';
      orgId: string | null;
      dataset: string | null;
      reason: string;
      approvers: [string, string];
    }
  | { kind: 'decide'; holdId: string; decision: 'approve' | 'reject'; note: string | null }
  | { kind: 'release'; holdId: string; reason: string };

/** One endpoint, three requests (as the ZATCA onboarding endpoint does): create `{scope, reason, approvers}`, decide `{holdId, decision}`, release `{holdId, action: 'release', reason}`. */
export function parseHoldRequest(raw: Record<string, unknown>): HoldRequest {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const fail = () => {
    throw new ProblemException('validation_failed', 'invalid legal hold request', errors);
  };
  if (raw.holdId !== undefined) {
    if (typeof raw.holdId !== 'string' || !UUID.test(raw.holdId))
      bad('holdId', 'must be a legal hold id');
    if (raw.action === 'release') {
      const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
      if (reason.length < 10 || reason.length > 500)
        bad('reason', 'is required (10..500 characters)');
      if (errors.length) fail();
      return { kind: 'release', holdId: (raw.holdId as string).toLowerCase(), reason };
    }
    if (raw.decision !== 'approve' && raw.decision !== 'reject')
      bad('decision', "must be 'approve' or 'reject'");
    const note = raw.note;
    if (
      note !== undefined &&
      note !== null &&
      (typeof note !== 'string' || note.trim().length < 1 || note.length > 500)
    )
      bad('note', 'must be 1..500 characters');
    if (errors.length) fail();
    return {
      kind: 'decide',
      holdId: (raw.holdId as string).toLowerCase(),
      decision: raw.decision as 'approve' | 'reject',
      note: typeof note === 'string' ? note.trim() : null,
    };
  }
  const scope = (raw.scope ?? {}) as { orgId?: unknown; dataset?: unknown };
  const orgId = scope.orgId === undefined ? null : scope.orgId;
  const dataset = scope.dataset === undefined ? null : scope.dataset;
  if (orgId !== null && (typeof orgId !== 'string' || !UUID.test(orgId)))
    bad('scope.orgId', 'must be an organization id');
  if (dataset !== null && (typeof dataset !== 'string' || !DATASET.test(dataset)))
    bad('scope.dataset', 'must look like schema.table');
  if (orgId === null && dataset === null)
    bad('scope', 'needs an organization (scope.orgId) and/or a dataset (scope.dataset)');
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) bad('reason', 'is required (10..500 characters)');
  const ap = raw.approvers;
  if (
    !Array.isArray(ap) ||
    ap.length !== 2 ||
    ap.some((x) => typeof x !== 'string' || !UUID.test(x))
  )
    bad('approvers', 'must be exactly two staff user ids');
  else if (ap[0] === ap[1]) bad('approvers', 'must be two DIFFERENT people');
  if (errors.length) fail();
  return {
    kind: 'create',
    orgId: orgId as string | null,
    dataset: dataset as string | null,
    reason,
    approvers: [(ap as string[])[0]!.toLowerCase(), (ap as string[])[1]!.toLowerCase()],
  };
}

/**
 * Legal holds (M04 §4 task 5, docs/10 §5). Dual approval is real: the requester names a DIFFERENT approver, the hold is `pending_approval` and has no
 * effect until that person approves it. A hold ends only by an explicit release (a different person than the requester lifts it, with a reason).
 * Nothing is deleted; scope and people are immutable.
 */
export class LegalHoldService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async handle(
    actorUserId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<{ hold: HoldDto; created: boolean }> {
    const req = parseHoldRequest(body);
    return this.db.withPlatformScope(async (c) => {
      if (req.kind === 'create') {
        if (!req.approvers.includes(actorUserId))
          throw new ProblemException(
            'forbidden',
            'the requester must be one of the two named people',
          );
        const approver = req.approvers.find((x) => x !== actorUserId)!;
        const ok = (
          await c.query(
            `SELECT 1 FROM identity.users u WHERE u.id = $1 AND u.is_platform_user
               AND EXISTS (SELECT 1 FROM tenancy.platform_roles r WHERE r.user_id = u.id AND r.role IN ('compliance_officer','platform_admin'))`,
            [approver],
          )
        ).rowCount;
        if (!ok)
          throw new ProblemException(
            'validation_failed',
            'the second approver must be a compliance officer or platform admin',
            [{ field: 'approvers', message: 'is not eligible' }],
          );
        if (
          req.orgId &&
          !(await c.query(`SELECT 1 FROM tenancy.organizations WHERE id = $1`, [req.orgId]))
            .rowCount
        )
          throw new ProblemException('validation_failed', 'no such organization', [
            { field: 'scope.orgId', message: 'does not exist' },
          ]);
        if (
          req.dataset &&
          !(
            await c.query(
              `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname || '.' || c.relname = $1 AND c.relkind IN ('r','p')`,
              [req.dataset],
            )
          ).rowCount
        )
          throw new ProblemException('validation_failed', 'no such dataset', [
            { field: 'scope.dataset', message: 'does not exist' },
          ]);
        const replay = (
          await c.query(
            `SELECT * FROM audit.legal_holds WHERE requested_by = $1 AND idempotency_key = $2`,
            [actorUserId, idempotencyKey],
          )
        ).rows[0];
        if (replay) return { hold: dto(replay), created: false };
        let row: Row;
        try {
          row = (
            await c.query(
              `INSERT INTO audit.legal_holds (id, org_id, dataset, reason, status, requested_by, approver_id, idempotency_key) VALUES ($1,$2,$3,$4,'pending_approval',$5,$6,$7) RETURNING *`,
              [uuidv7(), req.orgId, req.dataset, req.reason, actorUserId, approver, idempotencyKey],
            )
          ).rows[0]!;
        } catch (e) {
          if ((e as { code?: string }).code === '23505')
            throw new ProblemException('conflict', 'an open legal hold already covers this scope');
          throw e;
        }
        await this.audit.record({
          action: 'compliance.legalhold.requested',
          actorUserId,
          ...(req.orgId ? { orgId: req.orgId } : {}),
          resource: { type: 'legal_hold', id: row.id as string },
          outcome: 'success',
          after: { orgId: req.orgId, dataset: req.dataset, approverId: approver },
        });
        return { hold: dto(row), created: true };
      }
      const cur = (
        await c.query(`SELECT * FROM audit.legal_holds WHERE id = $1 FOR UPDATE`, [req.holdId])
      ).rows[0];
      if (!cur) throw new ProblemException('not_found', 'legal hold not found');
      if (req.kind === 'decide') {
        if (cur.approver_id !== actorUserId)
          throw new ProblemException(
            'forbidden',
            'only the named second approver can decide this hold',
          );
        const target = req.decision === 'approve' ? 'active' : 'rejected';
        if (cur.status === target) return { hold: dto(cur), created: false }; // the same decision again
        if (cur.status !== 'pending_approval')
          throw new ProblemException('conflict', `the hold is ${cur.status}`);
        const row = (
          await c.query(
            `UPDATE audit.legal_holds SET status = $2, decided_at = now(), decision_note = $3 WHERE id = $1 RETURNING *`,
            [req.holdId, target, req.note],
          )
        ).rows[0]!;
        await this.audit.record({
          action:
            req.decision === 'approve'
              ? 'compliance.legalhold.created'
              : 'compliance.legalhold.rejected',
          actorUserId,
          ...(cur.org_id ? { orgId: cur.org_id as string } : {}),
          resource: { type: 'legal_hold', id: req.holdId },
          outcome: 'success',
          after: {
            status: target,
            orgId: cur.org_id,
            dataset: cur.dataset,
            requestedBy: cur.requested_by,
          },
        });
        return { hold: dto(row), created: true };
      }
      // release
      if (cur.status === 'released') return { hold: dto(cur), created: false };
      if (cur.status !== 'active')
        throw new ProblemException(
          'conflict',
          `only an active hold can be released (it is ${cur.status})`,
        );
      if (cur.requested_by === actorUserId)
        throw new ProblemException(
          'forbidden',
          'a different person than the requester must release the hold',
        );
      const row = (
        await c.query(
          `UPDATE audit.legal_holds SET status = 'released', released_by = $2, released_at = now(), release_reason = $3 WHERE id = $1 RETURNING *`,
          [req.holdId, actorUserId, req.reason],
        )
      ).rows[0]!;
      await this.audit.record({
        action: 'compliance.legalhold.released',
        actorUserId,
        ...(cur.org_id ? { orgId: cur.org_id as string } : {}),
        resource: { type: 'legal_hold', id: req.holdId },
        outcome: 'success',
        after: { orgId: cur.org_id, dataset: cur.dataset, reason: req.reason },
      });
      return { hold: dto(row), created: true };
    });
  }
}
