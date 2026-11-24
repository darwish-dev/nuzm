import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { RealmOnly } from '../identity';
import { ProviderInsightsService, type UsageGroupBy } from './internal/provider-insights.service';

/** `GET /v1/admin/ai/usage` (platform permission `admin:ai:read`): provider usage aggregated from the append-only usage rows. Read-only. */
@RealmOnly('admin')
@Controller('v1/admin/ai/usage')
export class AdminAiUsageController {
  constructor(private readonly insights: ProviderInsightsService) {}

  @RequirePlatformPermission('admin:ai:read')
  @Get()
  report(@Query() q: Record<string, string | undefined>) {
    const date = (v: string | undefined, name: string): Date => {
      const d = v ? new Date(v) : new Date(Number.NaN);
      if (Number.isNaN(d.getTime()))
        throw new ProblemException('validation_failed', `${name} must be an ISO date-time`);
      return d;
    };
    return this.insights.usageReport({
      from: date(q.from, 'from'),
      to: date(q.to, 'to'),
      groupBy: (q.groupBy ?? 'provider') as UsageGroupBy,
      ...(q.providerCode ? { providerCode: q.providerCode } : {}),
      ...(q.orgId ? { orgId: q.orgId } : {}),
    });
  }
}
