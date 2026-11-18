import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';

export interface PolicyVersionDto {
  id: string;
  policyKey: string;
  version: number;
  title: string;
  bodyRef: string;
  effectiveFrom: string;
  approvedBy: string | null;
  approvalRef: string | null;
  changeNote: string | null;
  createdBy: string;
  createdAt: string;
  status: 'draft' | 'approved';
}
type Row = Record<string, unknown>;
const dto = (r: Row): PolicyVersionDto => ({
  id: r.id as string,
  policyKey: r.policy_key as string,
  version: r.version as number,
  title: r.title as string,
  bodyRef: r.body_ref as string,
  effectiveFrom:
    typeof r.effective_from === 'string'
      ? r.effective_from
      : (r.effective_from as Date).toISOString().slice(0, 10),
  approvedBy: (r.approved_by as string | null) ?? null,
  approvalRef: (r.approval_ref as string | null) ?? null,
  changeNote: (r.change_note as string | null) ?? null,
  createdBy: r.created_by as string,
  createdAt: (r.created_at as Date).toISOString(),
  status: r.approved_by ? 'approved' : 'draft',
});

/** Versioned policy documents (security, privacy, AUP): PUT publishes version n+1 for a key; the ETag of a key is its current version. */
export class PolicyVersionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  async list(q: { policyKey?: string; history: boolean }): Promise<{ items: PolicyVersionDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<Row>(
            q.history
              ? `SELECT * FROM compliance.policy_versions WHERE ($1::text IS NULL OR policy_key = $1) ORDER BY policy_key, version DESC`
              : `SELECT DISTINCT ON (policy_key) * FROM compliance.policy_versions WHERE ($1::text IS NULL OR policy_key = $1) ORDER BY policy_key, version DESC`,
            [q.policyKey ?? null],
          )
        ).rows,
    );
    return { items: rows.map(dto) };
  }

  async currentVersion(policyKey: string): Promise<number> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query<{ v: number | null }>(
            `SELECT max(version) AS v FROM compliance.policy_versions WHERE policy_key = $1`,
            [policyKey],
          )
        ).rows[0],
    );
    return r?.v ?? 0;
  }

  /** `expected` = the version the caller's If-Match carried (0 for a new key). Mismatch: `etag_mismatch`. */
  async publish(
    by: string,
    expected: number,
    body: Record<string, unknown>,
  ): Promise<PolicyVersionDto> {
    const errors: { field: string; message: string }[] = [];
    const str = (k: string, min: number, max: number) =>
      typeof body[k] === 'string' &&
      (body[k] as string).trim().length >= min &&
      (body[k] as string).trim().length <= max
        ? (body[k] as string).trim()
        : (errors.push({ field: k, message: `${min}-${max} characters` }), '');
    const policyKey = /^[a-z][a-z0-9_-]{2,40}$/.test(String(body.policyKey))
      ? (body.policyKey as string)
      : (errors.push({ field: 'policyKey', message: 'lowercase key, 3-41 characters' }), '');
    const title = str('title', 3, 200);
    const bodyRef = str('bodyRef', 3, 300);
    const eff =
      typeof body.effectiveFrom === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom) &&
      !Number.isNaN(Date.parse(body.effectiveFrom))
        ? body.effectiveFrom
        : (errors.push({ field: 'effectiveFrom', message: 'YYYY-MM-DD' }), '');
    const approvedBy =
      body.approvedBy === undefined || body.approvedBy === null
        ? null
        : typeof body.approvedBy === 'string' && /^[0-9a-f-]{36}$/i.test(body.approvedBy)
          ? body.approvedBy
          : (errors.push({ field: 'approvedBy', message: 'a platform user id' }), null);
    const approvalRef =
      body.approvalRef === undefined || body.approvalRef === null
        ? null
        : typeof body.approvalRef === 'string' &&
            body.approvalRef.length >= 3 &&
            body.approvalRef.length <= 300
          ? body.approvalRef
          : (errors.push({ field: 'approvalRef', message: '3-300 characters' }), null);
    if (approvedBy && !approvalRef)
      errors.push({
        field: 'approvalRef',
        message: 'an approval needs the document that records it',
      });
    if (errors.length)
      throw new ProblemException('validation_failed', 'invalid policy version', errors);
    if (approvedBy === by)
      throw new ProblemException(
        'validation_failed',
        'the publisher cannot approve their own policy',
        [{ field: 'approvedBy', message: 'a different person must approve' }],
      );

    const row = await this.db.withPlatformScope(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`policy:${policyKey}`]);
      const cur =
        (
          await c.query<{ v: number | null }>(
            `SELECT max(version) AS v FROM compliance.policy_versions WHERE policy_key = $1`,
            [policyKey],
          )
        ).rows[0]!.v ?? 0;
      if (cur !== expected)
        throw new ProblemException('etag_mismatch', `the current version is ${cur}`);
      if (
        approvedBy &&
        !(
          await c.query(
            `SELECT 1 FROM identity.users WHERE id = $1 AND is_platform_user AND status = 'active'`,
            [approvedBy],
          )
        ).rowCount
      )
        throw new ProblemException(
          'validation_failed',
          'the approver must be an active platform user',
          [{ field: 'approvedBy', message: 'unknown approver' }],
        );
      return (
        await c.query<Row>(
          `INSERT INTO compliance.policy_versions (id, policy_key, version, title, body_ref, effective_from, approved_by, approval_ref, change_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            uuidv7(),
            policyKey,
            cur + 1,
            title,
            bodyRef,
            eff,
            approvedBy,
            approvalRef,
            typeof body.changeNote === 'string' ? body.changeNote.slice(0, 500) : null,
            by,
          ],
        )
      ).rows[0]!;
    });
    await this.audit.record({
      action: 'policy.version.published',
      actorUserId: by,
      resource: { type: 'policy', id: policyKey },
      outcome: 'success',
      after: { version: row.version, effectiveFrom: eff, approved: Boolean(approvedBy) },
    });
    return dto(row);
  }
}
