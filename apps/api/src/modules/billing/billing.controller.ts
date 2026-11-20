import { Controller, Get, Param, Query } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { BillingReadService } from './internal/billing-read.service';
import { EntitlementService } from './internal/entitlement.service';
import { PlanService } from './internal/plan.service';
import { UUID } from '@nuzm/domain';

const date = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new ProblemException('validation_failed', `${name} must be an ISO-8601 timestamp`);
  return d;
};

/** Customer-facing billing reads. Plans are one global catalogue; the ledger and balance are the caller's organization only. */
@Controller('v1/billing')
export class BillingController {
  constructor(
    private readonly plans: PlanService,
    private readonly entitlements: EntitlementService,
    private readonly read: BillingReadService,
  ) {}

  @RequirePermission('org:read')
  @Get('plans')
  listPlans(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.plans.listPublic(orgId, { limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePermission('org:read')
  @Get('plans/:id')
  getPlan(@Org() orgId: string, @Param('id') id: string) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.plans.getPublic(orgId, id.toLowerCase());
  }

  @RequirePermission('org:read')
  @Get('entitlements')
  getEntitlements(@Org() orgId: string) {
    return this.entitlements.resolve(orgId);
  }

  @RequirePermission('billing:read')
  @Get('ledger')
  listLedger(
    @Org() orgId: string,
    @Query() q: { limit?: string; cursor?: string; from?: string; to?: string; kind?: string },
  ) {
    return this.read.statement(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      from: date('from', q.from),
      to: date('to', q.to),
      kind: q.kind && /^[a-z_]{1,40}$/.test(q.kind) ? q.kind : undefined,
    });
  }

  @RequirePermission('billing:read')
  @Get('balance')
  getBalance(@Org() orgId: string) {
    return this.read.balance(orgId);
  }
}
