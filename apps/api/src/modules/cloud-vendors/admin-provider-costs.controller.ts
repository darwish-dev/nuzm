import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { RealmOnly } from '../identity';
import { ProviderCostCapture } from './provider-cost-capture.service';

/** UI-M05-14 data: provider cost records (platform only, never shown to customers). Capture itself runs from the worker/scheduler and on demand in code; no customer-facing route. */
@RealmOnly('admin')
@Controller('v1/admin/provider-costs')
export class AdminProviderCostsController {
  constructor(private readonly capture: ProviderCostCapture) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  list(@Query() q: Record<string, string>) {
    return this.capture.list({
      ...(q.providerAccountId ? { providerAccountId: q.providerAccountId } : {}),
      ...(q.period ? { period: q.period } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
  }
}
