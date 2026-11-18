import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { productionPricing, toRatingItem } from '../../../common/pricing';
import { formatDec, parseDec, rateSegment } from '../../../common/rating';
import type { PriceBookService } from '../../billing';
import type { PriceContext, PricedItem, PricerResult, QuotePricer } from '../../commerce';
import type { ResidencyService } from '../../compliance';
import type { DataProviderService } from './provider.service';
import { serviceOfEngine, type Engine, ENGINES } from './model';
import type { DatabaseCatalog } from './catalog';

export interface PriceLine {
  meterId: string;
  quantity: string;
  unit: string;
  description: string;
  details: Record<string, unknown>;
}

/** Rate lines from the price book effective now. A meter with no price is `kind_not_available` (never an invented price). */
export async function priceLines(
  db: Db,
  prices: PriceBookService,
  ctx: PriceContext,
  lines: PriceLine[],
): Promise<{ items: PricedItem[]; priceBookVersionId: string }> {
  const book = await db.withOrg(ctx.orgId, (c) =>
    prices.resolveForRating(c, ctx.currency, { production: productionPricing() }),
  );
  const version = [...book.versions]
    .filter((v) => Date.parse(v.effectiveFrom) <= ctx.now.getTime())
    .pop();
  if (!version)
    throw new ProblemException('kind_not_available', 'no price book version is effective');
  const items: PricedItem[] = [];
  for (const l of lines) {
    const item = version.items.find((i) => i.meterId === l.meterId);
    if (!item)
      throw new ProblemException('kind_not_available', `no price is published for ${l.meterId}`);
    const q = parseDec(l.quantity);
    const rated = rateSegment(q, toRatingItem(item));
    items.push({
      description: l.description,
      meterId: l.meterId,
      meterGroup: null,
      quantity: formatDec(q),
      unit: l.unit,
      unitPriceMinor: item.tierModel === 'flat' ? item.unitPriceMinor : null,
      amountMinor: rated.amountMinor,
      details: {
        ...l.details,
        tierModel: item.tierModel,
        allowanceApplied: formatDec(rated.allowanceApplied),
      },
    });
  }
  return { items, priceBookVersionId: version.id };
}

const POS_INT = /^[1-9]\d{0,5}$/;
const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);

/**
 * `database` quotes (docs/04): one item `{engine, version, planRef, storageGb, region?}` priced as a MONTHLY ESTIMATE from the price book (instance hours ×
 * hours per month, provisioned storage GiB-months, plus the declared backup storage). An offer exists only when an enabled provider for the engine's
 * service lists the plan as available in a region it reports, that region passes the residency check and every meter has a price.
 */
export class DatabasePricer implements QuotePricer {
  readonly kind = 'database' as const;
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
    private readonly providers: DataProviderService,
    private readonly catalog: DatabaseCatalog,
    private readonly residency: Pick<ResidencyService, 'evaluate'>,
    private readonly hoursPerMonth: number,
  ) {}

  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'a database quote has exactly one item: {engine, version, planRef, storageGb, region?}',
      );
    const i = items[0] as Record<string, unknown>;
    const engine = i.engine as Engine;
    if (!(ENGINES as readonly string[]).includes(engine))
      throw new ProblemException(
        'validation_failed',
        `engine must be one of ${ENGINES.join(', ')}`,
      );
    const version = str(i.version, /^\d{1,3}(\.\d{1,3}){0,2}$/);
    const planRef = str(i.planRef, /^[A-Za-z0-9._-]{1,100}$/);
    const storage = str(String(i.storageGb ?? ''), POS_INT);
    if (!version || !planRef || !storage)
      throw new ProblemException(
        'validation_failed',
        'version, planRef and storageGb (a positive integer) are required',
      );
    const o = await this.catalog.offer(ctx.orgId, engine, {
      version,
      planRef,
      region: typeof i.region === 'string' ? i.region : undefined,
    });
    // residency: placement of customer content in the provider region (M04 hook; fail-closed)
    const res = await this.residency.evaluate({
      orgId: ctx.orgId,
      dataClass: 'customer-content',
      targetRegion: o.providerRegionId,
      purpose: 'managed_database',
      operation: 'write',
      ...(o.family.startsWith('provider-') ? { processorId: o.providerCode } : {}),
    });
    if (res.decision !== 'allow')
      throw new ProblemException(
        'residency_denied',
        res.reasons.map((r) => r.message.en).join('; ') ||
          'placement is not allowed by the residency policy',
      );
    const hours = String(this.hoursPerMonth);
    const meter = engine === 'redis' ? 'cache.instance_hours' : 'database.instance_hours';
    const lines: PriceLine[] = [
      {
        meterId: meter,
        quantity: hours,
        unit: 'instance_hour',
        description: `${engine} ${version} × ${hours} instance hours (monthly estimate)`,
        details: {
          engine,
          version,
          planRef,
          storageGb: Number(storage),
          providerRegionId: o.providerRegionId,
          providerId: o.providerId,
          service: serviceOfEngine(engine),
        },
      },
    ];
    if (engine !== 'redis') {
      lines.push({
        meterId: 'database.storage_gb_months',
        quantity: storage,
        unit: 'gib_month',
        description: `${storage} GiB provisioned storage (monthly estimate)`,
        details: { engine },
      });
    }
    const priced = await priceLines(this.db, this.prices, ctx, lines);
    // `residency` is the field M05 adds to `PricerResult` (assumptions doc U-07); on a base without it the quote keeps `not_evaluated`, and the
    // placement check above has ALREADY refused a denied region, so nothing depends on the stored copy.
    const out: PricerResult & { residency: Record<string, unknown> } = {
      items: priced.items,
      priceBookVersionId: priced.priceBookVersionId,
      residency: {
        status: 'evaluated',
        decision: res.decision,
        policyVersion: res.policyVersion,
        floorVersion: res.floorVersion,
        evidenceRef: res.evidenceRef,
        targetRegion: o.providerRegionId,
      },
    };
    return out;
  }
}
