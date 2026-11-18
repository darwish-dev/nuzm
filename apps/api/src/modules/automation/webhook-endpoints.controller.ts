import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { WebhookEndpointService } from './internal/webhook-endpoint.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({
  limit: parseLimit(q.limit),
  cursor: q.cursor,
});

@Controller('v1/webhook-endpoints')
export class WebhookEndpointsController {
  constructor(private readonly endpoints: WebhookEndpointService) {}
  /** 201 with the signing secret (shown ONCE). With `secretRotation` for an existing URL: 201 with the NEW secret; the old one signs too until the overlap ends. */
  @RequirePermission('webhook:manage')
  @Idempotent()
  @Post()
  @HttpCode(201)
  create(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.endpoints.create(orgId, a.actor.userId, b(body));
  }
  @RequirePermission('webhook:manage')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.endpoints.list(orgId, page(q));
  }
}
