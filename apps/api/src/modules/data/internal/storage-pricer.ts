import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import type { PriceBookService } from '../../billing';
import type { PriceContext, PricerResult, QuotePricer } from '../../commerce';
import type { ResidencyService } from '../../compliance';
import type { StorageService } from './storage.service';
import { priceLines } from './pricers';

/**
 * `storage` quotes (docs/04): one item `{estimatedGb, region?}`: the MONTHLY ESTIMATE of stored data (`storage.object_gb_months`), priced from the price book
 * effective now (tiers included). An offer exists only when an enabled object-storage provider reports buckets as supported and the region is offered and
 * allowed by residency. Requests and egress are metered after the fact and are not part of the estimate.
 */
export class StoragePricer implements QuotePricer {
  readonly kind = 'storage' as const;
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
    private readonly storage: StorageService,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
  ) {}
  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'a storage quote has exactly one item: {estimatedGb, region?}',
      );
    const i = items[0] as Record<string, unknown>;
    const gb = String(i.estimatedGb ?? '');
    if (!/^[1-9]\d{0,7}$/.test(gb))
      throw new ProblemException('validation_failed', 'estimatedGb must be a positive integer');
    const p = await this.storage.provider(ctx.orgId);
    if (p.caps['object-storage.bucket'] !== 'supported' || !p.row.probe?.passed)
      throw new ProblemException(
        'unsupported_capability',
        "the provider's probe does not report buckets as supported",
      );
    const cat = await p.adapter.catalog(p.ctx);
    const wanted =
      (typeof i.region === 'string' ? i.region : undefined) ??
      (p.row.config.defaultRegion as string | undefined) ??
      cat.regions[0]?.providerRegionId;
    const region = cat.regions.find((r) => r.providerRegionId === wanted);
    if (!region || (region.verifiedAt === null && p.row.environment !== 'local'))
      throw new ProblemException(
        'unsupported_capability',
        'the region is not offered or not verified for this account',
      );
    const res = await this.residency.evaluate({
      orgId: ctx.orgId,
      dataClass: 'customer-content',
      targetRegion: region.providerRegionId,
      purpose: 'object_storage',
      operation: 'write',
      ...(p.row.family.startsWith('provider-') ? { processorId: p.row.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'placement is not allowed by the residency policy',
      );
    const priced = await priceLines(this.db, this.prices, ctx, [
      {
        meterId: 'storage.object_gb_months',
        quantity: gb,
        unit: 'gib_month',
        description: `${gb} GiB object storage (monthly estimate)`,
        details: {
          providerRegionId: region.providerRegionId,
          providerId: p.row.id,
          estimatedGb: Number(gb),
        },
      },
    ]);
    const meterGroup = 'storage';
    const out: PricerResult & { residency: Record<string, unknown> } = {
      items: priced.items.map((x) => ({ ...x, meterGroup })),
      priceBookVersionId: priced.priceBookVersionId,
      residency: {
        status: 'evaluated',
        decision: res.decision,
        policyVersion: res.policyVersion,
        evidenceRef: res.evidenceRef,
        targetRegion: region.providerRegionId,
      },
    };
    return out;
  }
}
