import { Controller, Get, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { AuditQueryService, type AuditFilter } from './internal/audit-query.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the shared audit filter query string (also used by the admin controller). */
export function parseAuditFilter(q: Record<string, string | undefined>): AuditFilter {
  const bad = (m: string) => new ProblemException('validation_failed', m);
  const date = (k: string) => {
    if (q[k] === undefined) return undefined;
    const d = new Date(q[k]!);
    if (Number.isNaN(d.getTime())) throw bad(`${k} must be an ISO-8601 timestamp`);
    return d;
  };
  const uuid = (k: string) => {
    if (q[k] === undefined) return undefined;
    if (!UUID.test(q[k]!)) throw bad(`${k} must be a UUID`);
    return q[k]!.toLowerCase();
  };
  if (
    q.action !== undefined &&
    !/^[a-z0-9_]+(\.[a-z0-9_]+){0,2}(\.\*)?$|^[a-z0-9_]+\.\*$/.test(q.action)
  )
    throw bad('action must look like domain.resource.action or domain.*');
  if (q.outcome !== undefined && q.outcome !== 'success' && q.outcome !== 'failure')
    throw bad('outcome must be success or failure');
  const n = q.limit === undefined ? 50 : Number(q.limit);
  return {
    actorUserId: uuid('actorUserId'),
    resourceType: q.resourceType,
    resourceId: q.resourceId,
    action: q.action,
    outcome: q.outcome as AuditFilter['outcome'],
    from: date('from'),
    to: date('to'),
    orgId: uuid('orgId'),
    limit: Number.isInteger(n) ? Math.min(Math.max(n, 1), 200) : 50,
    cursor: q.cursor,
  };
}

@Controller('v1')
export class AuditController {
  constructor(private readonly query: AuditQueryService) {}

  /** Org-scoped audit log. billing_admin (no `audit:read_all`) sees billing-domain events only. */
  @RequirePermission('audit:read')
  @Get('audit-logs')
  list(
    @Org() orgId: string,
    @Access() access: AccessContext,
    @Query() q: Record<string, string | undefined>,
  ) {
    return this.query.listForOrg(orgId, {
      ...parseAuditFilter(q),
      billingOnly: !access.permissions.has('audit:read_all'),
    });
  }
}
