import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { DomainsService } from './internal/domains.service';

/** Domain bindings of a site: the response carries the verification challenge while the binding is pending. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteDomainsController {
  constructor(private readonly domains: DomainsService) {}

  @RequirePermission('hosting:domain:manage')
  @Idempotent()
  @Post(':id/domains')
  async add(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.domains.add(orgId, { userId: a.actor.userId }, id, body ?? {});
    void reply.status(r.operationId ? 202 : r.created ? 201 : 200);
    return { binding: r.binding, operationId: r.operationId };
  }

  @RequirePermission('hosting:site:read')
  @Get(':id/domains')
  list(@Org() orgId: string, @Param('id') id: string) {
    return this.domains.list(orgId, id);
  }
}
