import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';
import { productionPricing, toRatingItem } from '../../../common/pricing';
import { formatDec, parseDec, rateSegment } from '../../../common/rating';
import type { PriceBookService } from '../../billing';

export const QUOTE_KINDS = [
  'compute',
  'hosting',
  'domain',
  'database',
  'storage',
  'email',
  'ai-credit',
  'plan',
  'marketplace',
] as const;
export type QuoteKind = (typeof QUOTE_KINDS)[number];

export interface PricedItem {
  description: string;
  meterId: string | null;
  /** Quota group the item consumes from (null = not quota-bound). */
  meterGroup: string | null;
  /** Exact decimal string (the metering scale). */
  quantity: string;
  unit: string;
  unitPriceMinor: string | null;
  amountMinor: bigint;
  details: Record<string, unknown>;
}
export interface PriceContext {
  orgId: string;
  currency: string;
  now: Date;
  actorUserId?: string;
}
export interface PricerResult {
  items: PricedItem[];
  priceBookVersionId: string | null;
  /** The kind's own residency evaluation (M04 hook), stored in the immutable quote. Absent = `{status:'not_evaluated'}`. */
  residency?: Record<string, unknown>;
  /** Internal, admin-visible decisions stored with the quote (e.g. the compute routing decision); NEVER returned to customers. */
  preferences?: Record<string, unknown>;
}
/** One pricer per quote kind. The owning milestone registers it (compute M05, hosting M06, domain M07, ...). */
export interface QuotePricer {
  readonly kind: QuoteKind;
  price(ctx: PriceContext, items: unknown[]): Promise<PricerResult>;
  /**
   * Kinds whose request is not an `items` list (compute: `{offerId | routing, spec, term}`, docs/04) map the request body to the pricer's
   * items here. Absent = the body must carry `items` (the M02 shape).
   */
  itemsFrom?(input: Record<string, unknown>): unknown[];
}

/** Registry of quote pricers: a kind with no registered pricer is `kind_not_available` (never invented prices). */
export class QuotePricerRegistry {
  private readonly pricers = new Map<QuoteKind, QuotePricer>();
  register(p: QuotePricer): void {
    if (this.pricers.has(p.kind)) throw new Error(`a pricer for ${p.kind} is already registered`);
    this.pricers.set(p.kind, p);
  }
  get(kind: QuoteKind): QuotePricer {
    const p = this.pricers.get(kind);
    if (!p)
      throw new ProblemException(
        'kind_not_available',
        `quotes of kind '${kind}' are not available yet`,
      );
    return p;
  }
  kinds(): QuoteKind[] {
    return [...this.pricers.keys()];
  }
}

/**
 * AI credits (docs/04 `ai-credit`): priced from the price book version effective now, for meter `ai.credits_consumed`,
 * with the same exact rating math as billing. A book with no price for the meter, or only the DRAFT-NOT-APPROVED placeholder
 * in a production profile, means no quote (never a guessed price).
 */
export class AiCreditPricer implements QuotePricer {
  readonly kind = 'ai-credit' as const;
  constructor(
    private readonly db: Db,
    private readonly prices: PriceBookService,
  ) {}

  async price(ctx: PriceContext, items: unknown[]): Promise<PricerResult> {
    if (items.length !== 1)
      throw new ProblemException(
        'validation_failed',
        'an ai-credit quote has exactly one item: {credits}',
      );
    const credits = (items[0] as { credits?: unknown } | null)?.credits;
    if (typeof credits !== 'string' || !/^[1-9]\d{0,11}$/.test(credits))
      throw new ProblemException('validation_failed', 'credits must be a positive integer string');
    const book = await this.db.withOrg(ctx.orgId, (c) =>
      this.prices.resolveForRating(c, ctx.currency, { production: productionPricing() }),
    );
    const version = [...book.versions]
      .filter((v) => Date.parse(v.effectiveFrom) <= ctx.now.getTime())
      .pop();
    const item = version?.items.find((i) => i.meterId === 'ai.credits_consumed');
    if (!version || !item)
      throw new ProblemException('kind_not_available', 'no price is published for AI credits');
    const q = parseDec(credits);
    const rated = rateSegment(q, toRatingItem(item));
    return {
      priceBookVersionId: version.id,
      items: [
        {
          description: `AI credits × ${credits}`,
          meterId: 'ai.credits_consumed',
          meterGroup: 'ai',
          quantity: formatDec(q),
          unit: 'credit',
          unitPriceMinor: item.tierModel === 'flat' ? item.unitPriceMinor : null,
          amountMinor: rated.amountMinor,
          details: {
            tierModel: item.tierModel,
            allowanceApplied: formatDec(rated.allowanceApplied),
          },
        },
      ],
    };
  }
}

/**
 * `plan`: plans carry NO price before M03 subscriptions (docs/05; price books are per meter). Registered so the kind exists
 * and answers honestly instead of quoting an invented plan fee. DEVIATION from the M02 prompt (which lists `plan` as
 * available), recorded in the S07b report for the owner.
 */
export class PlanPricer implements QuotePricer {
  readonly kind = 'plan' as const;
  price(): Promise<PricerResult> {
    return Promise.reject(
      new ProblemException(
        'kind_not_available',
        'plan prices are defined with subscriptions (M03); no plan fee exists to quote yet',
      ),
    );
  }
}
