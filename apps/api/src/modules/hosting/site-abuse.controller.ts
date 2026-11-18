import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { AbuseService } from './internal/abuse.service';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';

/** What the customer sees of the abuse cases of its own site, and the appeal. The evidence references are staff-only. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteAbuseController {
  constructor(private readonly abuse: AbuseService) {}

  @RequirePermission('hosting:site:read')
  @Get(':id/abuse-cases')
  list(@Org() orgId: string, @Param('id') id: string) {
    return this.abuse.listForSite(orgId, id);
  }

  @RequirePermission('hosting:site:update')
  @Idempotent()
  @Post(':id/abuse-cases/:caseId/appeals')
  @HttpCode(200)
  appeal(
    @Org() orgId: string,
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.abuse.appeal(orgId, id, caseId, body?.text);
  }
}
