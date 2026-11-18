import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { UUID, type Row } from './common';
import type { DnsService } from './dns.service';
import type { DomainService } from './domain.service';
import type { DomainOrderService } from './orders.service';

export const OP_RECONCILE = 'domains.reconcile';

/**
 * Technical reconciliation (M07 S31 task 4; the forced variant is `POST /v1/admin/domains/{id}/reconciliations`): finish orders parked in
 * `needs_reconcile`/`provider_pending` after looking at the registrar, then bring the domain row in line with the registrar's state.
 */
export class DomainReconcilerService {
  constructor(
    private readonly db: Db,
    private readonly ops: OperationsService,
    private readonly orders: DomainOrderService,
    private readonly domains: DomainService,
    private readonly audit: AuditSink,
    private readonly dns?: DnsService,
  ) {}

  async force(adminUserId: string, domainId: string, traceId: string) {
    if (!UUID.test(domainId)) throw new ProblemException('not_found');
    const d = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT id, org_id FROM domains.domains WHERE id = $1`, [domainId]))
          .rows[0] as Row | undefined,
    );
    if (!d) throw new ProblemException('not_found');
    const orgId = d.org_id as string;
    const op = await this.ops.create(orgId, {
      kind: OP_RECONCILE,
      input: { domainId },
      resourceKind: 'domain',
      resourceId: domainId,
      createdBy: adminUserId,
      traceId,
    });
    const worker = `admin-${adminUserId.slice(0, 8)}`;
    const claimed = await this.ops.claimById(orgId, op.id, worker);
    const results: string[] = [];
    if (claimed) {
      const orders = await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT id FROM domains.domain_orders WHERE domain_id = $1 AND state IN ('needs_reconcile','provider_pending','authorized')`,
              [domainId],
            )
          ).rows as Row[],
      );
      for (const o of orders)
        results.push(await this.orders.reconcileOrder(orgId, o.id as string, worker));
      const s = await this.domains.sync(orgId, domainId, traceId);
      results.push(
        s.absent ? 'domain_absent_at_registrar' : s.changed ? 'state_synced' : 'in_sync',
      );
      const zone = await this.db.withOrg(
        orgId,
        async (c) =>
          (await c.query(`SELECT id FROM domains.dns_zones WHERE domain_id = $1`, [domainId]))
            .rows[0] as Row | undefined,
      );
      if (zone && this.dns)
        results.push(`dns_${await this.dns.reconcileZone(orgId, zone.id as string, traceId)}`);
      await this.ops.succeed(orgId, op.id, worker, { results });
    }
    await this.audit.record({
      action: 'domain.order.reconciled',
      orgId,
      actorUserId: adminUserId,
      resource: { type: 'domain', id: domainId },
      outcome: 'success',
      detail: { forced: true, results },
    });
    return { operationId: op.id, results };
  }
}
