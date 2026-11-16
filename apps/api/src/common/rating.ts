import { ProblemException } from './errors';

/**
 * Exact decimal arithmetic for rating (docs/12 §3: quantities and unit prices have up to 8 decimals). Everything is a
 * bigint scaled by 10^8; there are no floats anywhere. A price × quantity product is scaled by 10^16 and converted to
 * integer minor units ONCE per segment with the price item's rounding rule.
 */
export const SCALE = 100_000_000n; // 10^8
const SCALE2 = SCALE * SCALE; // 10^16

export type Dec = bigint;

/** Parse "123.45678901" (max 8 decimals, no sign/exponent) into a scaled bigint. Throws validation_failed otherwise. */
export function parseDec(v: string | number | bigint, what = 'value'): Dec {
  const s = typeof v === 'string' ? v : String(v);
  const m = /^(\d{1,16})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m)
    throw new ProblemException(
      'validation_failed',
      `${what} must be a non-negative decimal with at most 8 decimals`,
    );
  return BigInt(m[1]!) * SCALE + BigInt((m[2] ?? '').padEnd(8, '0'));
}
export function formatDec(d: Dec): string {
  const neg = d < 0n;
  const a = neg ? -d : d;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export type Rounding = 'half_up' | 'up' | 'down';
export interface Tier {
  /** Upper bound of the tier (inclusive of the quantity up to it); null = unbounded (must be the last tier). */
  upTo: Dec | null;
  unitPrice: Dec;
}
export type RatingItem =
  | { model: 'flat'; unitPrice: Dec; allowance: Dec; rounding: Rounding }
  | { model: 'graduated' | 'volume'; tiers: Tier[]; allowance: Dec; rounding: Rounding };

/** Parse and validate the JSON tiers of a price item. */
export function parseTiers(raw: unknown): Tier[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20)
    throw new ProblemException('validation_failed', 'tiers must be 1..20 entries');
  const tiers = raw.map((t, i) => {
    const o = t as { upTo?: unknown; unitPriceMinor?: unknown };
    if (!t || typeof t !== 'object')
      throw new ProblemException('validation_failed', `tiers[${i}] must be an object`);
    return {
      upTo:
        o.upTo === null || o.upTo === undefined
          ? null
          : parseDec(o.upTo as string, `tiers[${i}].upTo`),
      unitPrice: parseDec(o.unitPriceMinor as string, `tiers[${i}].unitPriceMinor`),
    };
  });
  tiers.forEach((t, i) => {
    const last = i === tiers.length - 1;
    if (last && t.upTo !== null)
      throw new ProblemException(
        'validation_failed',
        'the last tier must be unbounded (upTo null)',
      );
    if (!last && (t.upTo === null || t.upTo <= (tiers[i - 1]?.upTo ?? 0n)))
      throw new ProblemException(
        'validation_failed',
        'tier upper bounds must be strictly increasing',
      );
  });
  return tiers;
}

function roundToMinor(scaled2: bigint, rule: Rounding): bigint {
  const q = scaled2 / SCALE2;
  const r = scaled2 % SCALE2;
  if (r === 0n) return q;
  if (rule === 'down') return q;
  if (rule === 'up') return q + 1n;
  return r * 2n >= SCALE2 ? q + 1n : q;
}

export interface Rated {
  allowanceApplied: Dec;
  billable: Dec;
  amountMinor: bigint;
}

/**
 * Rate ONE segment (the quantity consumed under one price book version): the included allowance is consumed first, the
 * remainder is priced by the item's tier model and rounded once. `allowance` is the allowance still available to this
 * segment (pooled across a period's segments by the caller).
 */
export function rateSegment(
  quantity: Dec,
  item: RatingItem,
  allowanceAvailable: Dec = item.allowance,
): Rated {
  if (quantity < 0n)
    throw new ProblemException('validation_failed', 'quantity must not be negative');
  const applied = quantity < allowanceAvailable ? quantity : allowanceAvailable;
  const billable = quantity - applied;
  let scaled2 = 0n;
  if (billable > 0n) {
    if (item.model === 'flat') scaled2 = billable * item.unitPrice;
    else if (item.model === 'volume') {
      const tier = item.tiers.find((t) => t.upTo === null || billable <= t.upTo)!;
      scaled2 = billable * tier.unitPrice;
    } else {
      let floor = 0n;
      for (const t of item.tiers) {
        const top = t.upTo === null || billable < t.upTo ? billable : t.upTo;
        if (top > floor) scaled2 += (top - floor) * t.unitPrice;
        if (t.upTo === null || billable <= t.upTo) break;
        floor = t.upTo;
      }
    }
  }
  return { allowanceApplied: applied, billable, amountMinor: roundToMinor(scaled2, item.rounding) };
}
