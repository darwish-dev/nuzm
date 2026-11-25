import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProblemException } from '../../common/errors';
import { Public } from '../identity';
import { DomainsFlags } from './internal/flags';
import { SearchService } from './internal/search.service';

/**
 * `GET /v1/public/domains/search`: the website's domain checker. The same answer and the same rules as the dashboard's search (verified registrar accounts only,
 * unknown never "available", price from the same sales policy), without an organization: no sign-in, a per-address rate limit, nothing recorded about the
 * caller. Buying always happens in the dashboard. Off in production until `PUBLIC_DOMAIN_SEARCH_ENABLED=true`, and only while the domains feature is on.
 */
@Controller('v1/public/domains')
export class DomainsPublicSearchController {
  constructor(
    private readonly flags: DomainsFlags,
    private readonly search: SearchService,
  ) {}

  @Public()
  @Get('search')
  @Header('Cache-Control', 'no-store')
  async find(
    @Query() q: { q?: string; tlds?: string; country?: string },
    @Req() req: FastifyRequest,
  ) {
    const on =
      process.env.NODE_ENV === 'production'
        ? process.env.PUBLIC_DOMAIN_SEARCH_ENABLED === 'true'
        : process.env.PUBLIC_DOMAIN_SEARCH_ENABLED !== 'false';
    if (!on || !(await this.flags.enabledGlobally())) throw new ProblemException('not_found');
    return this.search.searchPublic(req.ip ?? 'unknown', q, String(req.id ?? 'public-search'));
  }
}
