import { Controller, Get } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { QuotaService } from './internal/quota.service';

/** Current quotas and consumption (docs/12 §7). Reading refreshes the projection and announces new thresholds once. */
@Controller('v1/quotas')
export class QuotasController {
  constructor(private readonly quotas: QuotaService) {}

  @RequirePermission('usage:read')
  @Get()
  get(@Org() orgId: string) {
    return this.quotas.evaluate(orgId);
  }
}
