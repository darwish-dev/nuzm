import { scaledDecimal } from '@nuzm/domain';
import type { Db } from '@nuzm/platform';
import { productionPricing, toRatingItem } from '../../../common/pricing';
import { formatDec, parseDec, rateSegment } from '../../../common/rating';
import type { PriceBookService } from '../../billing';

/** Hours in a billing month used to price an hourly meter for the first period (PROPOSAL; D-23 pricing/margin policy is OPEN). */
export const HOURS_PER_MONTH = 730;

export interface PlanSpec {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
}
export interface OfferPriceLine {
  meterId: 'compute.vcpu_hours' | 'compute.memory_gb_hours' | 'compute.disk_gb_months';
  meterGroup: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPriceMinor: string | null;
  amountMinor: bigint;
}
export interface OfferPrice {
  currency: string;
  priceBookVersionId: string;
  period: 'month';
  lines: OfferPriceLine[];
  monthlyMinor: bigint;
}
/** Resolves the price book once and prices any number of plans from it. `null` = no Nuzm price for the plan = the offer is hidden. */
export type PlanPricer = (spec: PlanSpec, count: number) => OfferPrice | null;
export interface OfferPriceComposer {
  session(orgId: string, now: Date): Promise<PlanPricer>;
}

/**
 * Customer price from the M02 price book (D-23: offer price = provider cost + margin rules is OPEN, so the price composer reads the price book;
 * a plan whose meters have no price in the effective book version has NO Nuzm price and is never offered). The DRAFT-NOT-APPROVED placeholder book
 * is refused in a production profile by `resolveForRating`.
 */
export class PriceBookComposer implements OfferPriceComposer {
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
    private readonly currency = 'SAR',
  ) {}

  async session(orgId: string, now: Date): Promise<PlanPricer> {
    let version:
      Awaited<ReturnType<PriceBookService['resolveForRating']>>['versions'][number] | undefined;
    try {
      const book = await this.db.withOrg(orgId, (c) =>
        this.prices.resolveForRating(c, this.currency, { production: productionPricing() }),
      );
      version = [...book.versions]
        .filter((v) => Date.parse(v.effectiveFrom) <= now.getTime())
        .pop();
    } catch {
      return () => null; // no usable book: no price
    }
    const items = new Map((version?.items ?? []).map((i) => [i.meterId, i]));
    const need = [
      'compute.vcpu_hours',
      'compute.memory_gb_hours',
      'compute.disk_gb_months',
    ] as const;
    if (!version || need.some((m) => !items.has(m))) return () => null;
    const v = version;
    return (spec, count) => {
      const qty = {
        'compute.vcpu_hours': scaledDecimal(BigInt(spec.vcpu * count * HOURS_PER_MONTH), 1n),
        'compute.memory_gb_hours': scaledDecimal(
          BigInt(spec.memoryMb * count * HOURS_PER_MONTH),
          1024n,
        ),
        'compute.disk_gb_months': scaledDecimal(BigInt(spec.diskGb * count), 1n),
      } as const;
      const meta = {
        'compute.vcpu_hours': {
          unit: 'vcpu_hour',
          group: 'compute',
          text: `vCPU hours (${spec.vcpu} vCPU × ${count} × ${HOURS_PER_MONTH} h)`,
        },
        'compute.memory_gb_hours': {
          unit: 'gib_hour',
          group: null,
          text: `Memory GiB hours (${spec.memoryMb} MB × ${count} × ${HOURS_PER_MONTH} h)`,
        },
        'compute.disk_gb_months': {
          unit: 'gib_month',
          group: null,
          text: `Disk GiB months (${spec.diskGb} GB × ${count})`,
        },
      } as const;
      const lines: OfferPriceLine[] = need.map((m) => {
        const item = items.get(m)!;
        const q = parseDec(qty[m]);
        const rated = rateSegment(q, toRatingItem(item));
        return {
          meterId: m,
          meterGroup: meta[m].group,
          description: meta[m].text,
          quantity: formatDec(q),
          unit: meta[m].unit,
          unitPriceMinor: item.tierModel === 'flat' ? item.unitPriceMinor : null,
          amountMinor: rated.amountMinor,
        };
      });
      return {
        currency: this.currency,
        priceBookVersionId: v.id,
        period: 'month' as const,
        lines,
        monthlyMinor: lines.reduce((s, l) => s + l.amountMinor, 0n),
      };
    };
  }
}
