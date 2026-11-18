import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, parseLimit } from '../../../common/pagination';
import { UUID, iso, type Row } from './common';
import type { ReconcilerService } from './reconciler.service';

const toDto = (r: Row) => ({
  id: r.id as string,
  orgId: r.org_id as string,
  kind: r.kind as string,
  providerAccountId: r.provider_account_id as string,
  providerKey: (r.provider_key as string | undefined) ?? null,
  providerRef: (r.provider_ref as string | null) ?? null,
  state: r.state as string,
  dataRegion: r.data_region as string,
  country: (r.country as string).trim(),
  providerRegionId: r.provider_region_id as string,
  driftState: r.drift_state as string,
  lastSeenAt: iso(r.last_seen_at),
  caseOpenedAt: iso(r.case_opened_at),
  caseDetail: r.case_detail ?? null,
  createdAt: iso(r.created_at)!,
});

/** Admin view of the cross-organization resource inventory and forced reconciliation (UI-M05-12 data). Cross-org reads are AUDITED. */
export class AdminResourceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly reconciler: Pick<ReconcilerService, 'reconcileResource'>,
  ) {}

  async list(
    actorUserId: string,
    q: {
      orgId?: string;
      state?: string;
      driftState?: string;
      accountId?: string;
      cursor?: string;
      limit?: string;
    },
  ) {
    const limit = parseLimit(q.limit);
    const after = decodeCursor(q.cursor);
    for (const [k, v] of [
      ['orgId', q.orgId],
      ['accountId', q.accountId],
    ] as const)
      if (v !== undefined && !UUID.test(v))
        throw new ProblemException('invalid_filter', `${k} must be a UUID`);
    if (
      q.state !== undefined &&
      ![
        'DRAFT',
        'QUOTED',
        'AWAITING_PAYMENT',
        'PROVISIONING',
        'ACTIVE',
        'FAILED',
        'DELETING',
        'DELETED',
        'UNKNOWN',
      ].includes(q.state)
    )
      throw new ProblemException('invalid_filter', 'state must be a canonical resource state');
    if (
      q.driftState !== undefined &&
      !['in_sync', 'drift', 'orphan_suspected', 'missing'].includes(q.driftState)
    )
      throw new ProblemException('invalid_filter', 'driftState is invalid');
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT r.*, p.key AS provider_key FROM cloud.resources r JOIN cloud.provider_accounts a ON a.id = r.provider_account_id JOIN cloud.providers p ON p.id = a.provider_id
              WHERE ($1::uuid IS NULL OR r.org_id = $1) AND ($2::text IS NULL OR r.state = $2) AND ($3::text IS NULL OR r.drift_state = $3) AND ($4::uuid IS NULL OR r.provider_account_id = $4) AND ($5::uuid IS NULL OR r.id < $5)
              ORDER BY r.id DESC LIMIT $6`,
            [
              q.orgId ?? null,
              q.state ?? null,
              q.driftState ?? null,
              q.accountId ?? null,
              after,
              limit + 1,
            ],
          )
        ).rows as Row[],
    );
    await this.audit.record({
      action: 'admin.resources.listed',
      actorUserId,
      outcome: 'success',
      detail: {
        filters: {
          orgId: q.orgId ?? null,
          state: q.state ?? null,
          driftState: q.driftState ?? null,
          accountId: q.accountId ?? null,
        },
        returned: Math.min(rows.length, limit),
      },
    });
    return pageOf(rows.map(toDto), limit);
  }

  /** 202: a platform job runs one reconciliation of the resource (trigger on_demand, audited with the actor). */
  async force(actorUserId: string, resourceId: string, traceId?: string) {
    if (!UUID.test(resourceId)) throw new ProblemException('not_found');
    const res = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, provider_account_id, org_id FROM cloud.resources WHERE id = $1`,
            [resourceId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!res) throw new ProblemException('not_found');
    const id = uuidv7();
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO cloud.provider_jobs (id, account_id, kind, subject_id, trace_id, requested_by) VALUES ($1,$2,'reconcile',$3,$4,$5)`,
        [id, res.provider_account_id, resourceId, traceId ?? null, actorUserId],
      );
      await this.audit.record({
        action: 'cloud.reconcile.requested',
        actorUserId,
        orgId: res.org_id as string,
        resource: { type: 'cloud_resource', id: resourceId },
        outcome: 'success',
        detail: { jobId: id },
      });
    });
    setImmediate(
      () =>
        void this.runJob(id, resourceId, actorUserId).catch((e) =>
          console.error(JSON.stringify({ cloud_reconcile_job_error: (e as Error).message })),
        ),
    );
    return { operationId: id, resourceId };
  }

  async runJob(jobId: string, resourceId: string, actorUserId: string): Promise<void> {
    const set = (state: string, result: unknown, error: unknown) =>
      this.db.withPlatformScope((c) =>
        c.query(
          `UPDATE cloud.provider_jobs SET state = $2, result = $3, error = $4, attempts = attempts + 1, updated_at = now() WHERE id = $1`,
          [
            jobId,
            state,
            result === null ? null : JSON.stringify(result),
            error === null ? null : JSON.stringify(error),
          ],
        ),
      );
    await this.db.withPlatformScope((c) =>
      c.query(
        `UPDATE cloud.provider_jobs SET state = 'running', updated_at = now() WHERE id = $1 AND state = 'pending'`,
        [jobId],
      ),
    );
    try {
      const out = await this.reconciler.reconcileResource(resourceId, {
        trigger: 'on_demand',
        actorUserId,
      });
      await set('succeeded', out, null);
    } catch (e) {
      await set('failed', null, {
        code: 'reconcile_failed',
        message: (e as Error).message.slice(0, 200),
      });
    }
  }
}
