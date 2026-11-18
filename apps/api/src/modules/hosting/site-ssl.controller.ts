import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { SslService } from './internal/ssl.service';

/** TLS certificates of a site. A custom private key is accepted ONLY here, goes straight to the vault, and is never echoed, stored or logged. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteSslController {
  constructor(private readonly ssl: SslService) {}

  @RequirePermission('hosting:ssl:manage')
  @Idempotent()
  @Post(':id/ssl-certificates')
  @HttpCode(202)
  request(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
  ) {
    return this.ssl.request(orgId, { userId: a.actor.userId }, id, body ?? {});
  }

  @RequirePermission('hosting:site:read')
  @Get(':id/ssl-certificates')
  list(@Org() orgId: string, @Param('id') id: string) {
    return this.ssl.list(orgId, id);
  }
}
