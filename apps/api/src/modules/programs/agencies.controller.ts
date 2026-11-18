import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { AgencyService } from './internal/agency.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};

/**
 * Agency program (docs/04 §2.11). The org-level permission on the route is the floor (`org:read`: any member); each handler then enforces the side-specific permission
 * (`agency:manage` for the agency's own organization, `partners:manage` for the client answering). Revocation routes are SCR-M11-01 and do NOT exist.
 */
@Controller('v1/agencies')
export class AgenciesController {
  constructor(private readonly agencies: AgencyService) {}
  @RequirePermission('agency:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.agencies.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('org:read')
  @Get()
  list(@Org() orgId: string) {
    return this.agencies.list(orgId);
  }
  @RequirePermission('org:read')
  @Idempotent()
  @Post(':id/clients')
  @HttpCode(201)
  postClient(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.agencies.postClient(orgId, a.actor.userId, a.permissions, id, b(body));
  }
  @RequirePermission('org:read')
  @Get(':id/clients')
  listClients(@Org() orgId: string, @Param('id') id: string) {
    return this.agencies.listClients(orgId, id);
  }
  @RequirePermission('org:read')
  @Idempotent()
  @Post(':id/delegated-access')
  @HttpCode(201)
  postGrant(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.agencies.postGrant(orgId, a.actor.userId, a.permissions, id, b(body));
  }
  @RequirePermission('org:read')
  @Get(':id/delegated-access')
  listGrants(@Org() orgId: string, @Param('id') id: string) {
    return this.agencies.listGrants(orgId, id);
  }
}
