import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Platform, RequirePlatformPermission, type PlatformContext } from '../../common/access';
import { parseIfMatch } from '../../common/etag';
import { Idempotent } from '../../common/idempotency';
import { parseLimit } from '../../common/pagination';
import { RealmOnly, StepUp } from '../identity';
import { ModerationService } from './internal/moderation.service';

type Body_ = Record<string, unknown> | undefined;
const b = (x: Body_) => x ?? {};
const page = (q: { limit?: string; cursor?: string }) => ({ limit: parseLimit(q.limit), cursor: q.cursor });

/**
 * Admin moderation decision (docs/04 §2.11). `If-Match` (the case version) is optional; a decision on a version that is no longer in the right state is 409. Idempotent by that rule:
 * repeating a decision finds the version already decided and answers 409, never a second effect (admin routes have no organization, so the Idempotency-Key store does not apply).
 */
@Controller('v1/admin/marketplace')
@RealmOnly('admin')
export class AdminMarketplaceController {
  constructor(private readonly moderation: ModerationService) {}
  @RequirePlatformPermission('admin:marketplace')
  @StepUp()
  @Post('listings/:id/moderation')
  @HttpCode(200)
  decide(@Platform() p: PlatformContext, @Param('id') id: string, @Body() body: Body_, @Req() req: FastifyRequest) {
    return this.moderation.decide(p.userId, id.toLowerCase(), b(body), parseIfMatch(req.headers['if-match']));
  }
}
