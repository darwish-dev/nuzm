import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Db } from '@nuzm/platform';
import { productionPricing } from '../../common/pricing';
import { DB } from '../../common/tokens';
import { Public } from '../identity';
import { PriceBookService, type PriceItemDto } from './internal/price-book.service';

/** The usage prices the public website shows on the email, data and AI pages. A meter not in this list is never published here. */
const PUBLIC_METERS = [
  'email.transactional_messages',
  'storage.object_gb_months',
  'network.egress_gb',
  'ai.credits_consumed',
] as const;

/**
 * `GET /v1/public/usage-prices`: the pay-as-you-use rates of the price book version in force, for a short fixed list of meters. Same book and same production
 * refusal as rating (the DRAFT-NOT-APPROVED placeholder book is never published in production: the list is empty then). No sign-in, nothing organization
 * specific (a reseller or custom price is applied when an organization is rated, not here). Off in production until `PUBLIC_PLANS_ENABLED=true`.
 */
@Controller('v1/public/usage-prices')
export class PublicUsagePricesController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly prices: PriceBookService,
  ) {}

  @Public()
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  async list() {
    const on =
      process.env.NODE_ENV === 'production'
        ? process.env.PUBLIC_PLANS_ENABLED === 'true'
        : process.env.PUBLIC_PLANS_ENABLED !== 'false';
    if (!on) return { currency: 'SAR', items: [] };
    try {
      const book = await this.db.withPlatformScope((c) =>
        this.prices.resolveForRating(c, 'SAR', { production: productionPricing() }),
      );
      const now = Date.now();
      const version = [...book.versions].filter((v) => Date.parse(v.effectiveFrom) <= now).pop();
      const items = (version?.items ?? [])
        .filter((i: PriceItemDto) => (PUBLIC_METERS as readonly string[]).includes(i.meterId))
        .map((i: PriceItemDto) => ({
          meterId: i.meterId,
          model: i.tierModel,
          unitPriceMinor: i.unitPriceMinor,
          tiers: i.tiers,
          includedAllowance: i.includedAllowance,
        }));
      return { currency: 'SAR', items };
    } catch {
      return { currency: 'SAR', items: [] };
    }
  }
}
