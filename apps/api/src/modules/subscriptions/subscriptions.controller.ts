import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { etag, parseIfMatch } from '../../common/etag';
import { ProblemException } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { SubscriptionService } from '../billing';

/** Subscriptions of the active organization (docs/04 §2.3). Reads need `billing:read`, writes `billing:manage`; changes need If-Match. */
@Controller('v1/billing/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionService) {}

  @RequirePermission('billing:manage')
  @Idempotent()
  @Post()
  async create(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const s = await this.subs.create(orgId, a.actor.userId, body ?? {});
    void reply.status(201);
    void reply.header('etag', etag(s.version));
    return s;
  }

  @RequirePermission('billing:read')
  @Get()
  list(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string; status?: string }) {
    return this.subs.list(orgId, {
      limit: parseLimit(q.limit),
      cursor: q.cursor,
      status: q.status,
    });
  }

  @RequirePermission('billing:read')
  @Get(':id')
  async get(
    @Org() orgId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const s = await this.subs.get(orgId, id);
    void reply.header('etag', etag(s.version));
    return s;
  }

  /** Change plan, quantity or payment method. `preview: true` returns the proration without changing anything. */
  @RequirePermission('billing:manage')
  @Patch(':id')
  async change(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = req.headers['if-match'];
    const expected = parseIfMatch(raw);
    if (raw !== undefined && expected === null)
      throw new ProblemException('validation_failed', "If-Match must be the subscription's ETag");
    const r = await this.subs.change(orgId, a.actor.userId, id, body ?? {}, expected);
    void reply.header('etag', etag(r.subscription.version));
    return r;
  }

  /** Cancel at the end of the paid period. */
  @RequirePermission('billing:manage')
  @Post(':id/cancellation')
  async cancel(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown> | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const s = await this.subs.cancel(orgId, a.actor.userId, id, body ?? {});
    void reply.status(200);
    void reply.header('etag', etag(s.version));
    return s;
  }
}
