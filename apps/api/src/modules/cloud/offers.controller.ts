import { Controller, Get, Param, Query } from '@nestjs/common';
import { Org, RequirePermission } from '../../common/access';
import { ProblemException } from '../../common/errors';
import { parseLimit } from '../../common/pagination';
import { CloudFlags } from './internal/flags';
import { ImageCatalog } from './internal/images';
import { OfferService, parseOfferFilters } from './internal/offer.service';

/**
 * `GET /v1/offers` (docs/04 §2.5): ONLY eligible inventory — account healthy ∧ region verified (fresh, with evidence) ∧ plan available ∧ capability
 * supported ∧ residency allows ∧ entitlement/quota allows ∧ price present. Provider identity, provider region ids and provider cost are never returned.
 */
@Controller('v1/offers')
export class OffersController {
  constructor(
    private readonly offers: OfferService,
    private readonly flags: CloudFlags,
    private readonly images: ImageCatalog,
  ) {}

  @RequirePermission('offers:read')
  @Get()
  async list(@Org() orgId: string, @Query() q: Record<string, string>) {
    if (!(await this.flags.enabled(orgId)))
      throw new ProblemException('not_found', 'compute is not enabled for this organization');
    const filters = parseOfferFilters(q, false);
    const limit = parseLimit(q.limit, 50);
    const eligible = OfferService.sort(
      this.offers.filter(await this.offers.eligible(orgId), filters),
    );
    const views = eligible.map((c) => this.offers.customerView(c));
    return OfferService.page(views, q.cursor, limit);
  }

  /**
   * The operating systems of one offer, so a server is picked by name. Only for an offer that is eligible for this organization today (the same
   * rule as the list): anything else is 404, which also hides whether the id exists. No provider image reference is returned.
   */
  @RequirePermission('offers:read')
  @Get(':offerId/images')
  async imagesOf(@Org() orgId: string, @Param('offerId') offerId: string) {
    if (!(await this.flags.enabled(orgId)))
      throw new ProblemException('not_found', 'compute is not enabled for this organization');
    if (!/^[0-9a-f-]{36}$/i.test(offerId))
      throw new ProblemException('not_found', 'offer not found');
    const [offer] = await this.offers.eligible(orgId, { planId: offerId.toLowerCase() });
    if (!offer) throw new ProblemException('not_found', 'offer not found');
    return { items: await this.images.forOffer(offer.accountId, offer.providerRegionId) };
  }
}
