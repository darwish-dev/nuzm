import { Controller, Get, UseGuards } from '@nestjs/common';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { Org, RequirePermission } from '../../common/access';
import { PlansService } from './internal/plans.service';

/** Plan catalogue (docs/04 §2.6): only plans with at least one eligible node region AND room; plans without capacity are hidden. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/plans')
export class HostingPlansController {
  constructor(private readonly plans: PlansService) {}
  @RequirePermission('hosting:plan:read')
  @Get()
  async list(@Org() orgId: string) {
    return { items: await this.plans.list(orgId) };
  }
}
