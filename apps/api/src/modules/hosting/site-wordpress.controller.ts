import { Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { Idempotent } from '../../common/idempotency';
import { HostingEnabledGuard } from './internal/hosting-flag.guard';
import { WordPressService } from './internal/wordpress.service';

/** Managed WordPress of a site: its installation state, retry, a new admin password, and the ONE-TIME handover of the admin access. Another organization's site is 404. */
@UseGuards(HostingEnabledGuard)
@Controller('v1/hosting/sites')
export class SiteWordPressController {
  constructor(private readonly wp: WordPressService) {}

  @RequirePermission('hosting:site:read')
  @Get(':id/wordpress')
  get(@Org() orgId: string, @Param('id') id: string) {
    return this.wp.get(orgId, id);
  }

  @RequirePermission('hosting:site:update')
  @Idempotent()
  @Post(':id/wordpress/retry')
  @HttpCode(202)
  retry(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.wp.retry(orgId, { userId: a.actor.userId }, id);
  }

  @RequirePermission('hosting:site:update')
  @Idempotent()
  @Post(':id/wordpress/admin-resets')
  @HttpCode(202)
  reset(@Org() orgId: string, @Access() a: AccessContext, @Param('id') id: string) {
    return this.wp.resetAdmin(orgId, { userId: a.actor.userId }, id);
  }

  /**
   * Reads the admin access exactly once. Deliberately NOT `@Idempotent()`: the idempotency store would keep the response (the password) for replay, which is the opposite of a
   * one-time handover. A repeated call is `409 conflict` (already used), not a replay. The answer is never cacheable.
   */
  @RequirePermission('hosting:site:update')
  @Post(':id/wordpress/handover')
  @HttpCode(200)
  async handover(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const r = await this.wp.handover(orgId, { userId: a.actor.userId }, id);
    void reply.header('cache-control', 'no-store');
    void reply.header('pragma', 'no-cache');
    return r;
  }
}
