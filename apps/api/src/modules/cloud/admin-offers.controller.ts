import { Controller, Get, Query } from '@nestjs/common';
import { RequirePlatformPermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { RealmOnly } from '../identity';
import { OfferService, parseOfferFilters } from './internal/offer.service';

/** Admin view of offers for ONE organization: includes ineligible plans with the failing conditions (the data of the routing dry-run). */
@RealmOnly('admin')
@Controller('v1/admin/offers')
export class AdminOffersController {
  constructor(private readonly offers: OfferService) {}

  @RequirePlatformPermission('admin:provider:read')
  @Get()
  async list(@Query() q: Record<string, string>) {
    if (typeof q.orgId !== 'string' || !/^[0-9a-f-]{36}$/i.test(q.orgId))
      throw new ProblemException(
        'invalid_filter',
        'orgId (the organization to evaluate for) is required',
      );
    const filters = parseOfferFilters(q, true);
    const limit = parseLimit(q.limit, 50);
    const all = OfferService.sort(
      this.offers.filter(await this.offers.candidates(q.orgId.toLowerCase()), filters),
    );
    const shown =
      q.includeIneligible === 'true'
        ? all
        : all.filter((c) => c.failures.length === 0 && c.price !== null);
    return OfferService.page(
      shown.map((c) => this.offers.adminView(c)),
      q.cursor,
      limit,
    );
  }
}
