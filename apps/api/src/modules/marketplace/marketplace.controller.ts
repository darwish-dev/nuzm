import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { InstallService } from './internal/install.service';
import { ListingService } from './internal/listing.service';
import { PurchaseService } from './internal/purchase.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({
  limit: parseLimit(q.limit),
  cursor: q.cursor,
});

/** Marketplace (docs/04 §2.11). Browsing needs `marketplace:read`; publishing `marketplace:publish` AND a verified publisher account. */
@Controller('v1/marketplace')
export class MarketplaceController {
  constructor(
    private readonly listings: ListingService,
    private readonly purchases: PurchaseService,
    private readonly installs: InstallService,
  ) {}

  @RequirePermission('marketplace:publish')
  @Idempotent()
  @Post('listings')
  @HttpCode(201)
  createListing(@Org() orgId: string, @Access() a: AccessContext, @Body() body: Body_) {
    return this.listings.create(orgId, a.actor.userId, b(body));
  }
  /** `?mine=true` the publisher's own listings in every state; otherwise browse. `filter[id]` returns one listing with its versions (the detail view). */
  @RequirePermission('marketplace:read')
  @Get('listings')
  listListings(
    @Org() orgId: string,
    @Query()
    q: {
      limit?: string;
      cursor?: string;
      mine?: string;
      type?: string;
      q?: string;
      'filter[id]'?: string;
    },
  ) {
    return this.listings.list(orgId, {
      ...page(q),
      mine: q.mine === 'true',
      type: q.type,
      q: q.q,
      id: q['filter[id]'],
    });
  }
  @RequirePermission('marketplace:publish')
  @Idempotent()
  @Post('listings/:id/versions')
  @HttpCode(201)
  createVersion(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Body() body: Body_,
  ) {
    return this.listings.createVersion(orgId, a.actor.userId, id.toLowerCase(), b(body));
  }

  @RequirePermission('marketplace:buy')
  @Idempotent()
  @Post('purchases')
  @HttpCode(202)
  async purchase(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.purchases.create(orgId, a.actor.userId, b(body));
    void reply.status(r.http);
    return r.purchase;
  }
  @RequirePermission('marketplace:read')
  @Get('purchases/:id')
  getPurchase(@Org() orgId: string, @Param('id') id: string) {
    return this.purchases.get(orgId, id.toLowerCase());
  }

  @RequirePermission('marketplace:install')
  @Idempotent()
  @Post('installations')
  @HttpCode(202)
  install(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Body() body: Body_,
    @Req() req: FastifyRequest,
  ) {
    return this.installs.create(
      orgId,
      a.actor.userId,
      String(req.headers['idempotency-key'] ?? ''),
      b(body),
    );
  }
  @RequirePermission('marketplace:read')
  @Get('installations')
  listInstallations(@Org() orgId: string, @Query() q: { limit?: string; cursor?: string }) {
    return this.installs.list(orgId, page(q));
  }
}
