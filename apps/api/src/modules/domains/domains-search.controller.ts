import { Controller, Get, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Access, Org, RequirePermission, type AccessContext } from '../../common/access';
import { DomainsFlags } from './internal/flags';
import { SearchService } from './internal/search.service';

/** Domain search (docs/04 §2.7): cached availability with price, premium flag and eligibility; only verified registrar capabilities are used. */
@Controller('v1/domains')
export class DomainsSearchController {
  constructor(
    private readonly flags: DomainsFlags,
    private readonly search: SearchService,
  ) {}

  @RequirePermission('domain:search')
  @Get('search')
  async find(
    @Org() orgId: string,
    @Access() a: AccessContext,
    @Query() q: { q?: string; tlds?: string; country?: string },
    @Req() req: FastifyRequest,
  ) {
    await this.flags.assert(orgId);
    return this.search.search(orgId, a.actor.userId, q, String(req.id ?? 'search'));
  }
}
