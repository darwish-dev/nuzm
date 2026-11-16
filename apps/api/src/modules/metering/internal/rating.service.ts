import { productionPricing, toRatingItem } from '../../../common/pricing';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { formatDec, parseDec, rateSegment } from '../../../common/rating';
import type { PriceBookService, PriceItemDto, PriceVersionDto } from '../../billing';

export interface RatedRow {
  meterId: string;
  resourceKey: string;
  periodStart: string;
  segmentStart: string;
  priceBookVersionId: string;
  priceItemMeter: string;
  tierModel: string;
  quantity: string;
  allowanceApplied: string;
  billableQuantity: string;
  amountMinor: string;
  currency: string;
}
export interface RatingRun {
  runId: string;
  orgId: string;
  periodStart: string;
  currency: string;
  priceBookId: string;
  placeholderBook: boolean;
  rows: RatedRow[];
  totalMinor: string;
  /** Usage that could not be priced (no item for the meter in the effective version): reported, never silently dropped. */
  unpriced: { meterId: string; resourceKey: string; quantity: string }[];
}

const toItem = toRatingItem;
const production = productionPricing;

/**
 * Rating (docs/12 §4–§5): aggregates of one billing period × the price book version effective at each bucket's time.
 * Quantity is split into segments by version; the included allowance is POOLED across a period's segments (taken from the
 * first priced segment's item) so a mid-period price change cannot grant the allowance twice. Rows are appended under a
 * new `rating_run_id`; a re-run records each key's delta against the previous run. Rated usage posts nothing by itself.
 */
export class RatingService {
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
    private readonly audit: AuditSink,
  ) {}

  async rate(
    orgId: string,
    periodStart: string,
    opts: { currency?: string } = {},
  ): Promise<RatingRun> {
    if (!/^\d{4}-\d{2}-01$/.test(periodStart) || Number.isNaN(Date.parse(periodStart)))
      throw new ProblemException(
        'validation_failed',
        'periodStart must be the first day of a month (YYYY-MM-01)',
      );
    const currency = opts.currency ?? 'SAR';
    const runId = uuidv7();
    return this.db.withOrg(orgId, async (c) => {
      const book = await this.prices.resolveForRating(c, currency, { production: production() });
      const agg = (
        await c.query<{
          meter_id: string;
          resource_key: string;
          bucket_start: Date;
          quantity: string;
        }>(
          `SELECT meter_id, resource_key, bucket_start, quantity::text FROM metering.usage_aggregates
            WHERE org_id = $1 AND billing_period_start = $2::date ORDER BY meter_id, resource_key, bucket_start`,
          [orgId, periodStart],
        )
      ).rows;
      const groups = new Map<string, typeof agg>();
      for (const r of agg)
        (
          groups.get(`${r.meter_id}\u0000${r.resource_key}`) ??
          groups
            .set(`${r.meter_id}\u0000${r.resource_key}`, [])
            .get(`${r.meter_id}\u0000${r.resource_key}`)!
        ).push(r);

      const rows: RatedRow[] = [];
      const unpriced: RatingRun['unpriced'] = [];
      const versionAt = (t: Date): PriceVersionDto | undefined => {
        let hit: PriceVersionDto | undefined;
        for (const v of book.versions) if (Date.parse(v.effectiveFrom) <= t.getTime()) hit = v;
        return hit;
      };
      for (const buckets of groups.values()) {
        const { meter_id: meterId, resource_key: resourceKey } = buckets[0]!;
        // segments by version, in time order
        const segs: { v: PriceVersionDto; item: PriceItemDto; start: Date; qty: bigint }[] = [];
        let unpricedQty = 0n;
        for (const b of buckets) {
          const v = versionAt(b.bucket_start);
          const item = v?.items.find((i) => i.meterId === meterId);
          const q = parseSigned(b.quantity);
          if (!v || !item) {
            unpricedQty += q;
            continue;
          }
          const last = segs[segs.length - 1];
          if (last && last.v.id === v.id) last.qty += q;
          else segs.push({ v, item, start: b.bucket_start, qty: q });
        }
        if (unpricedQty > 0n)
          unpriced.push({ meterId, resourceKey, quantity: formatDec(unpricedQty) });
        let remaining = segs[0] ? parseDec(segs[0].item.includedAllowance) : 0n;
        for (const s of segs) {
          const qty = s.qty < 0n ? 0n : s.qty; // net corrections can never produce a negative charge
          const rated = rateSegment(qty, toItem(s.item), remaining);
          remaining -= rated.allowanceApplied;
          rows.push({
            meterId,
            resourceKey,
            periodStart,
            segmentStart: s.start.toISOString(),
            priceBookVersionId: s.v.id,
            priceItemMeter: s.item.meterId,
            tierModel: s.item.tierModel,
            quantity: formatDec(qty),
            allowanceApplied: formatDec(rated.allowanceApplied),
            billableQuantity: formatDec(rated.billable),
            amountMinor: rated.amountMinor.toString(),
            currency,
          });
        }
      }
      if (rows.length) {
        // price_item_id is resolved here so the SQL function stays a dumb, validated writer
        const ids = (
          await c.query<{ id: string; version_id: string; meter_id: string }>(
            `SELECT id, version_id, meter_id FROM billing.price_items WHERE version_id = ANY($1::uuid[])`,
            [[...new Set(rows.map((r) => r.priceBookVersionId))]],
          )
        ).rows;
        const payload = rows.map((r) => ({
          ...r,
          priceItemId: ids.find(
            (i) => i.version_id === r.priceBookVersionId && i.meter_id === r.meterId,
          )!.id,
        }));
        await c.query('SELECT metering.record_rated($1, $2, $3::jsonb)', [
          orgId,
          runId,
          JSON.stringify(payload),
        ]);
      }
      const total = rows.reduce((s, r) => s + BigInt(r.amountMinor), 0n);
      await this.audit.record({
        action: 'metering.rating.completed',
        orgId,
        resource: { type: 'rating_run', id: runId },
        outcome: 'success',
        detail: {
          periodStart,
          rows: rows.length,
          unpriced: unpriced.length,
          totalMinor: total.toString(),
          bookPlaceholder: book.placeholder,
        },
      });
      return {
        runId,
        orgId,
        periodStart,
        currency,
        priceBookId: book.id,
        placeholderBook: book.placeholder,
        rows,
        totalMinor: total.toString(),
        unpriced,
      };
    });
  }
}

/** Aggregate quantities are numeric(24,8) strings and may be negative (net corrections). */
function parseSigned(s: string): bigint {
  return s.startsWith('-') ? -parseDec(s.slice(1)) : parseDec(s);
}
