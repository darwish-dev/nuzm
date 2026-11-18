import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { ConnectorService } from './internal/connector.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({
  limit: parseLimit(q.limit),
  cursor: q.cursor,
});

@Controller('v1/connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorService) {}
  @RequirePermission('connector:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.connectors.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('connector:manage')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.connectors.list(orgId, page(q));
  }
  @RequirePermission('connector:manage')
  @Idempotent()
  @Post(':id/authorization')
  @HttpCode(201)
  authorize(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.connectors.authorize(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }
}
