import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { productionPricing, toRatingItem } from '../../../common/pricing';
import { formatDec, parseDec, rateSegment } from '../../../common/rating';
import type { PriceBookService } from '../../billing';
import type { PricerResult, PriceContext, QuotePricer } from '../../commerce';
import { planRow } from './plans.service';

/**
 * `hosting` quotes (docs/04): ONE item `{planId, runtime}`. Priced from the price book version effective now for meter `hosting.site_months`
 * (exact decimal rating, like every other kind). A plan whose price is still a PLACEHOLDER and a book without a price for the meter mean NO quote
 * (`kind_not_available`): prices are never invented (CLAUDE.md §4). A non-placeholder plan price is used only when the book has no entry (owner-approved price on the plan).
 */
export class HostingQuotePricer implements QuotePricer {
  readonly kind = 'hosting' as const;
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
  ) {}
  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'a hosting quote has exactly one item: {planId, runtime}',
      );
    const it = (items[0] ?? {}) as { planId?: unknown; runtime?: unknown };
    if (typeof it.planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(it.planId))
      throw new ProblemException('validation_failed', 'planId must be a plan id');
    if (typeof it.runtime !== 'string' || it.runtime.length > 40)
      throw new ProblemException('validation_failed', 'runtime is required');
    const plan = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.plan_definitions WHERE id = $1 AND status = 'active'`,
            [it.planId],
          )
        ).rows[0],
    );
    if (!plan) throw new ProblemException('not_found', 'hosting plan not found');
    const p = planRow(plan);
    const book = await this.db.withOrg(ctx.orgId, (c) =>
      this.prices.resolveForRating(c, ctx.currency, { production: productionPricing() }),
    );
    const version = [...book.versions]
      .filter((v) => Date.parse(v.effectiveFrom) <= ctx.now.getTime())
      .pop();
    const item = version?.items.find((i) => i.meterId === 'hosting.site_months');
    let unit: string | null;
    let amount: bigint;
    let tier = 'flat';
    let allowance = '0';
    if (version && item) {
      const rated = rateSegment(parseDec('1'), toRatingItem(item));
      amount = rated.amountMinor;
      unit = item.tierModel === 'flat' ? item.unitPriceMinor : null;
      tier = item.tierModel;
      allowance = formatDec(rated.allowanceApplied);
    } else if (!p.placeholder && p.priceMinor !== null && p.currency === ctx.currency) {
      amount = BigInt(p.priceMinor);
      unit = p.priceMinor;
    } else
      throw new ProblemException(
        'kind_not_available',
        'no price is published for this hosting plan',
      );
    return {
      priceBookVersionId: version?.id ?? null,
      items: [
        {
          description: `Hosting plan ${p.nameEn} (site-month)`,
          meterId: 'hosting.site_months',
          meterGroup: 'hosting',
          quantity: '1',
          unit: 'site_month',
          unitPriceMinor: unit,
          amountMinor: amount,
          details: {
            planId: p.id,
            runtime: it.runtime,
            tierModel: tier,
            allowanceApplied: allowance,
          },
        },
      ],
    };
  }
}
