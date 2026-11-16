import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly } from '../identity';
import { BillingReadService } from './internal/billing-read.service';
import { PlanService } from './internal/plan.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!UUID.test(v)) throw new ProblemException('validation_failed', `${name} must be a UUID`);
  return v.toLowerCase();
};

/** Finance/admin billing API: MFA-verified admin-realm session + platform permission on every route. */
@RealmOnly('admin')
@Controller('v1/admin/billing')
export class AdminBillingController {
  constructor(
    private readonly read: BillingReadService,
    private readonly plans: PlanService,
  ) {}

  @RequirePlatformPermission('admin:billing:read')
  @Get('ledger-accounts')
  accounts(@Query() q: { limit?: string; cursor?: string; code?: string; orgId?: string }) {
    return this.read.adminAccounts({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      code: q.code && /^\d{4}$/.test(q.code) ? q.code : undefined,
      orgId: uuid(q.orgId, 'orgId'),
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @Get('ledger-transactions')
  transactions(@Query() q: { limit?: string; cursor?: string; orgId?: string; kind?: string }) {
    return this.read.adminTransactions({
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      orgId: uuid(q.orgId, 'orgId'),
      kind: q.kind && /^[a-z_]{1,40}$/.test(q.kind) ? q.kind : undefined,
    });
  }

  @RequirePlatformPermission('admin:billing:read')
  @Get('plans')
  listPlans(@Query() q: { limit?: string; cursor?: string }) {
    return this.plans.adminList({ limit: parseLimit(q.limit), cursor: q.cursor });
  }

  @RequirePlatformPermission('admin:billing:manage')
  @Post('plans')
  @HttpCode(201)
  createPlan(@Platform() who: PlatformContext, @Body() body: Record<string, unknown> | undefined) {
    return this.plans.create(body ?? {}, who.userId);
  }

  @RequirePlatformPermission('admin:billing:manage')
  @Patch('plans/:id')
  updatePlan(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    return this.plans.update(id.toLowerCase(), body ?? {}, who.userId);
  }
}
