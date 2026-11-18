import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { RetentionService, type PolicyDto } from '../compliance';

/**
 * GET/PUT /v1/admin/audit-retention (docs/04 §2.12): retention per AUDIT CLASS, applied through M04's versioned `audit.retention_policies`
 * (dataset `audit.audit_logs`; the class is the policy's data class) and `audit.legal_holds`. The dry-run reports what a policy WOULD archive, minus
 * anything under an active legal hold. NOTHING is archived or deleted here: archival of the hash-chained log is deferred (ADR-055, PROPOSED).
 * The minimum retention is a PROPOSAL (13 months online, docs/10 §5) until counsel's D-34 value is recorded; below it the API answers 422.
 */
export const AUDIT_DATASET = 'audit.audit_logs';
export const AUDIT_RETENTION_MIN_DAYS = Number(process.env.AUDIT_RETENTION_MIN_DAYS ?? 395);

export class AuditRetentionService {
  constructor(
    private readonly db: Db,
    private readonly retention: RetentionService,
    private readonly audit: AuditSink,
  ) {}

  async get(userId: string): Promise<{
    dataset: string;
    minimumRetainDays: number;
    minimumBasis: string;
    policies: PolicyDto[];
    legalHolds: { id: string; orgId: string | null; dataset: string | null; status: string }[];
    archiveTargetRegion: string | null;
    archival: { available: false; reason: string };
    preview: unknown;
  }> {
    const page = await this.retention.list({ dataset: AUDIT_DATASET, limit: 200 });
    const holds = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, org_id, dataset, status FROM audit.legal_holds WHERE status IN ('active','pending_approval') AND (dataset IS NULL OR dataset = $1) ORDER BY created_at DESC LIMIT 100`,
            [AUDIT_DATASET],
          )
        ).rows,
    );
    const pv = await this.retention.preview(userId);
    return {
      dataset: AUDIT_DATASET,
      minimumRetainDays: AUDIT_RETENTION_MIN_DAYS,
      minimumBasis: 'PROPOSAL (docs/10 §5): D-34 and HG-04-01 decide the legal minimum',
      policies: page.items,
      legalHolds: holds.map((h) => ({
        id: h.id as string,
        orgId: (h.org_id as string | null) ?? null,
        dataset: (h.dataset as string | null) ?? null,
        status: h.status as string,
      })),
      archiveTargetRegion: process.env.AUDIT_ARCHIVE_REGION ?? null,
      archival: {
        available: false,
        reason:
          'partition archival of the hash-chained audit log is deferred (ADR-055 PROPOSED); only a dry run exists',
      },
      preview: pv.targets.find((t) => t.dataset === AUDIT_DATASET) ?? null,
    };
  }

  async put(
    userId: string,
    body: Record<string, unknown>,
  ): Promise<{ policy: PolicyDto; created: boolean }> {
    if (body.dataset !== undefined && body.dataset !== AUDIT_DATASET)
      throw new ProblemException('validation_failed', `dataset must be ${AUDIT_DATASET}`, [
        { field: 'dataset', message: `only ${AUDIT_DATASET}` },
      ]);
    const retain = body.retainDays;
    if (typeof retain === 'number' && Number.isInteger(retain) && retain < AUDIT_RETENTION_MIN_DAYS)
      throw new ProblemException(
        'below_minimum_retention',
        `retainDays ${retain} is below the minimum of ${AUDIT_RETENTION_MIN_DAYS} days`,
        [{ field: 'retainDays', message: `minimum ${AUDIT_RETENTION_MIN_DAYS}` }],
      );
    const r = await this.retention.put(userId, { ...body, dataset: AUDIT_DATASET });
    if (r.created)
      await this.audit.record({
        action: 'audit.retention.changed',
        actorUserId: userId,
        resource: { type: 'retention_policy', id: r.policy.id },
        outcome: 'success',
        after: {
          dataClass: r.policy.dataClass,
          version: r.policy.version,
          retainDays: r.policy.retainDays,
          archiveAfterDays: r.policy.archiveAfterDays,
          status: r.policy.status,
        },
      });
    return r;
  }
}
