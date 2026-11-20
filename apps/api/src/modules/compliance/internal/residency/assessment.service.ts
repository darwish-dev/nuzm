import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../../common/pagination';
import { CLASSES } from './evaluator';
import { UUID } from '@nuzm/domain';

export interface AssessmentDto {
  id: string;
  orgId: string | null;
  dataClass: string;
  region: string;
  processorId: string | null;
  risk: 'low' | 'medium' | 'high';
  mitigations: string;
  status: 'pending' | 'approved' | 'rejected';
  /** Derived: an approved assessment past its expiry. */
  expired: boolean;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresAt: string;
  createdAt: string;
}
type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const dto = (r: Row, now: Date): AssessmentDto => ({
  id: r.id as string,
  orgId: (r.org_id as string | null) ?? null,
  dataClass: r.data_class as string,
  region: r.region as string,
  processorId: (r.processor_id as string | null) ?? null,
  risk: r.risk as AssessmentDto['risk'],
  mitigations: r.mitigations as string,
  status: r.status as AssessmentDto['status'],
  expired: r.status === 'approved' && (r.expires_at as Date).getTime() <= now.getTime(),
  requestedBy: r.requested_by as string,
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: iso(r.decided_at),
  decisionNote: (r.decision_note as string | null) ?? null,
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
});

const REGION = /^([A-Z]{2}|in_kingdom|gcc|eu|other)$/;

export type AssessmentRequest =
  | {
      kind: 'create';
      orgId: string | null;
      dataClass: string;
      region: string;
      processorId: string | null;
      risk: 'low' | 'medium' | 'high';
      mitigations: string;
      expiresAt: Date;
    }
  | { kind: 'decide'; assessmentId: string; decision: 'approve' | 'reject'; note: string | null };

/** One endpoint, two requests: create `{dataClass, region, processorId?, risk, mitigations, expiresAt, orgId?}` or decide `{assessmentId, decision, note?}`. */
export function parseAssessmentRequest(raw: Record<string, unknown>, now: Date): AssessmentRequest {
  const errors: { field: string; message: string }[] = [];
  const bad = (field: string, message: string) => errors.push({ field, message });
  const fail = () => {
    throw new ProblemException('validation_failed', 'invalid transfer assessment request', errors);
  };
  if (raw.assessmentId !== undefined) {
    if (typeof raw.assessmentId !== 'string' || !UUID.test(raw.assessmentId))
      bad('assessmentId', 'must be an assessment id');
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
      assessmentId: (raw.assessmentId as string).toLowerCase(),
      decision: raw.decision as 'approve' | 'reject',
      note: typeof note === 'string' ? note.trim() : null,
    };
  }
  if (typeof raw.dataClass !== 'string' || !(CLASSES as readonly string[]).includes(raw.dataClass))
    bad('dataClass', `must be one of ${CLASSES.join(', ')}`);
  if (raw.dataClass === 'public') bad('dataClass', 'public data needs no transfer assessment');
  if (typeof raw.region !== 'string' || !REGION.test(raw.region))
    bad('region', 'must be an ISO country code (AE) or one of in_kingdom, gcc, eu, other');
  if (raw.region === 'in_kingdom' || raw.region === 'SA')
    bad('region', 'a transfer assessment is for moving data OUT of the Kingdom');
  const pid = raw.processorId;
  if (
    pid !== undefined &&
    pid !== null &&
    (typeof pid !== 'string' || pid.trim().length < 1 || pid.length > 120)
  )
    bad('processorId', 'must be 1..120 characters (a processor named in the ROPA)');
  if (raw.risk !== 'low' && raw.risk !== 'medium' && raw.risk !== 'high')
    bad('risk', "must be 'low', 'medium' or 'high'");
  const m = typeof raw.mitigations === 'string' ? raw.mitigations.trim() : '';
  if (m.length < 10 || m.length > 2000) bad('mitigations', 'is required (10..2000 characters)');
  const exp = typeof raw.expiresAt === 'string' ? new Date(raw.expiresAt) : null;
  if (!exp || Number.isNaN(exp.getTime())) bad('expiresAt', 'must be a date-time');
  else if (exp.getTime() <= now.getTime()) bad('expiresAt', 'must be in the future');
  const org = raw.orgId;
  if (org !== undefined && org !== null && (typeof org !== 'string' || !UUID.test(org)))
    bad('orgId', 'must be an organization id');
  if (errors.length) fail();
  return {
    kind: 'create',
    orgId: typeof org === 'string' ? org.toLowerCase() : null,
    dataClass: raw.dataClass as string,
    region: raw.region as string,
    processorId: typeof pid === 'string' ? pid.trim() : null,
    risk: raw.risk as 'low' | 'medium' | 'high',
    mitigations: m,
    expiresAt: exp!,
  };
}

/**
 * Transfer assessments (M04 §4 task 8): create, then a DIFFERENT person decides (also enforced by a database check); an approved one expires and is
 * valid at most `maxDays` after the decision. Scope = data class × region (country or group) × processor; the organization relies on it by listing its id
 * in its residency policy. Nothing is deleted or edited.
 */
export class AssessmentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly maxDays: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(q: {
    status?: string;
    orgId?: string;
    dataClass?: string;
    expired?: boolean;
    limit: number;
    cursor?: unknown;
  }): Promise<Page<AssessmentDto>> {
    if (q.status !== undefined && !['pending', 'approved', 'rejected'].includes(q.status))
      throw new ProblemException(
        'validation_failed',
        'status must be pending, approved or rejected',
      );
    if (q.orgId !== undefined && !UUID.test(q.orgId))
      throw new ProblemException('validation_failed', 'orgId must be an organization id');
    const cursor = decodeCursor(q.cursor);
    const now = this.clock();
    return this.db.withPlatformScope(async (c) => {
      const args: unknown[] = [];
      const where: string[] = ['true'];
      if (q.status) where.push(`status = $${args.push(q.status)}`);
      if (q.orgId) where.push(`org_id = $${args.push(q.orgId)}`);
      if (q.dataClass) where.push(`data_class = $${args.push(q.dataClass)}`);
      if (q.expired === true)
        where.push(`status = 'approved' AND expires_at <= $${args.push(now)}`);
      if (q.expired === false)
        where.push(`NOT (status = 'approved' AND expires_at <= $${args.push(now)})`);
      if (cursor) where.push(`id < $${args.push(cursor)}`);
      const rows = (
        await c.query(
          `SELECT * FROM compliance.transfer_assessments WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${q.limit + 1}`,
          args,
        )
      ).rows;
      return pageOf(
        rows.map((r) => dto(r, now)),
        q.limit,
      );
    });
  }

  async handle(
    actorUserId: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<{ assessment: AssessmentDto; created: boolean }> {
    const now = this.clock();
    const req = parseAssessmentRequest(body, now);
    return this.db.withPlatformScope(async (c) => {
      if (req.kind === 'create') {
        if (req.expiresAt.getTime() > now.getTime() + this.maxDays * 86_400_000)
          throw new ProblemException(
            'validation_failed',
            `an assessment is valid for at most ${this.maxDays} days`,
            [{ field: 'expiresAt', message: `at most ${this.maxDays} days from now` }],
          );
        if (
          req.orgId &&
          !(await c.query(`SELECT 1 FROM tenancy.organizations WHERE id = $1`, [req.orgId]))
            .rowCount
        )
          throw new ProblemException('validation_failed', 'no such organization', [
            { field: 'orgId', message: 'does not exist' },
          ]);
        const replay = (
          await c.query(
            `SELECT * FROM compliance.transfer_assessments WHERE requested_by = $1 AND idempotency_key = $2`,
            [actorUserId, idempotencyKey],
          )
        ).rows[0];
        if (replay) return { assessment: dto(replay, now), created: false };
        const row = (
          await c.query(
            `INSERT INTO compliance.transfer_assessments (id, org_id, data_class, region, processor_id, risk, mitigations, requested_by, expires_at, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              uuidv7(),
              req.orgId,
              req.dataClass,
              req.region,
              req.processorId,
              req.risk,
              req.mitigations,
              actorUserId,
              req.expiresAt,
              idempotencyKey,
            ],
          )
        ).rows[0]!;
        await this.audit.record({
          action: 'compliance.transfer.assessment_requested',
          actorUserId,
          ...(req.orgId ? { orgId: req.orgId } : {}),
          resource: { type: 'transfer_assessment', id: row.id as string },
          outcome: 'success',
          after: {
            dataClass: req.dataClass,
            region: req.region,
            processorId: req.processorId,
            risk: req.risk,
            expiresAt: req.expiresAt.toISOString(),
          },
        });
        return { assessment: dto(row, now), created: true };
      }
      const cur = (
        await c.query(`SELECT * FROM compliance.transfer_assessments WHERE id = $1 FOR UPDATE`, [
          req.assessmentId,
        ])
      ).rows[0];
      if (!cur) throw new ProblemException('not_found', 'transfer assessment not found');
      if (cur.requested_by === actorUserId)
        throw new ProblemException(
          'forbidden',
          'a different person than the requester must decide',
        );
      const target = req.decision === 'approve' ? 'approved' : 'rejected';
      if (cur.status === target && cur.decided_by === actorUserId)
        return { assessment: dto(cur, now), created: false };
      if (cur.status !== 'pending')
        throw new ProblemException('conflict', `the assessment is already ${cur.status}`);
      if (req.decision === 'approve' && (cur.expires_at as Date).getTime() <= now.getTime())
        throw new ProblemException(
          'assessment_expired',
          'the requested expiry has already passed: request a new assessment',
        );
      const row = (
        await c.query(
          `UPDATE compliance.transfer_assessments SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
          [req.assessmentId, target, actorUserId, req.note],
        )
      ).rows[0]!;
      await this.audit.record({
        action:
          req.decision === 'approve'
            ? 'compliance.transfer.assessment_approved'
            : 'compliance.transfer.assessment_rejected',
        actorUserId,
        ...(cur.org_id ? { orgId: cur.org_id as string } : {}),
        resource: { type: 'transfer_assessment', id: req.assessmentId },
        outcome: 'success',
        after: {
          status: target,
          dataClass: cur.data_class,
          region: cur.region,
          requestedBy: cur.requested_by,
        },
      });
      return { assessment: dto(row, now), created: true };
    });
  }
}
