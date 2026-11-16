import type { PriceItemDto } from '../modules/billing';
import { parseDec, type RatingItem } from './rating';

/** Price item (as stored) → the exact-decimal item the rating math consumes. Shared by rating and quotes: one pricing path. */
export const toRatingItem = (i: PriceItemDto): RatingItem => {
  const allowance = parseDec(i.includedAllowance);
  if (i.tierModel === 'flat')
    return {
      model: 'flat',
      unitPrice: parseDec(i.unitPriceMinor!),
      allowance,
      rounding: i.rounding,
    };
  return {
    model: i.tierModel,
    tiers: i.tiers!.map((t) => ({
      upTo: t.upTo === null ? null : parseDec(t.upTo),
      unitPrice: parseDec(t.unitPriceMinor),
    })),
    allowance,
    rounding: i.rounding,
  };
};

/** The DRAFT-NOT-APPROVED placeholder book (HG-02-01) must never price real money in a production profile. */
export const productionPricing = () =>
  process.env.NODE_ENV === 'production' && process.env.PRICEBOOK_ALLOW_PLACEHOLDER !== 'true';
