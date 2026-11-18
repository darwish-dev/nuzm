import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { AccessReviewService } from './access-reviews.service';
import { idemKey } from './idem';

@RealmOnly('admin')
@Controller('v1/admin/access-reviews')
export class AccessReviewsController {
  constructor(private readonly reviews: AccessReviewService) {}

  @RequirePlatformPermission('admin:security:manage')
  @Get()
  list(@Query() q: Record<string, string>) {
    return this.reviews.list({
      orgId: q.orgId,
      status: q.status,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
  }

  @RequirePlatformPermission('admin:security:manage')
  @StepUp()
  @Post()
  async create(
    @Platform() who: PlatformContext,
    @Body() b: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.reviews.create(who.userId, idemKey(req), b ?? {});
    void reply.status(r.created ? 201 : 200);
    return r.review;
  }

  @RequirePlatformPermission('admin:security:manage')
  @StepUp()
  @HttpCode(200)
  @Post(':id/decisions')
  decide(
    @Platform() who: PlatformContext,
    @Param('id') id: string,
    @Body() b: Record<string, unknown> | undefined,
    @Req() req: FastifyRequest,
  ) {
    idemKey(req); // a repeated decision is a no-op by construction; the key is required by the contract
    return this.reviews.decide(id, who.userId, b ?? {});
  }
}
