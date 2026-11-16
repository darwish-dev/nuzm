import { ProblemException } from '../../../common/errors';

/**
 * Pure tax engine (docs/11 §4). Integer minor units and basis points only; no floats. Rates are data (`invoicing.tax_rates`),
 * never constants in this file. Everything the tax advisor must confirm (HG-03-04) is surfaced as `reviewRequired` + reasons.
 */
export type BuyerType = 'b2b' | 'b2c';
export type TaxScope = 'domestic' | 'export' | 'exempt' | 'zero';
export type RoundingMode = 'half_up' | 'half_even';

export interface TaxRate {
  code: string;
  rateBps: number;
  scope: TaxScope;
  jurisdiction: string;
  /** ISO date (inclusive). */
  validFrom: string;
  /** ISO date (exclusive); null = open ended. */
  validTo: string | null;
  verify: boolean;
}
export interface TaxContext {
  /** The supply/issue date (UTC). */
  on: Date;
  buyerType: BuyerType;
  /** ISO country of the buyer, when known. */
  buyerCountry?: string | null;
  /** Advisor-configured scope for the service; unknown cases default to `domestic` + a review flag. */
  scope?: TaxScope | null;
  jurisdiction?: string;
}
export interface RateResolution {
  rate: TaxRate;
  reviewRequired: boolean;
  reasons: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Pick the rate in force on `ctx.on` for the scope. Unknown cases (no scope configured for the service, a buyer outside the
 * jurisdiction) use the standard domestic rate AND are flagged for review: they never silently become zero-rated.
 */
export function resolveRate(rates: readonly TaxRate[], ctx: TaxContext): RateResolution {
  const jurisdiction = ctx.jurisdiction ?? 'SA';
  const reasons: string[] = [];
  let scope: TaxScope = ctx.scope ?? 'domestic';
  if (!ctx.scope) reasons.push('scope_not_configured');
  if (ctx.buyerCountry && ctx.buyerCountry !== jurisdiction && scope === 'domestic')
    reasons.push('buyer_outside_jurisdiction');
  const on = iso(ctx.on);
  const find = (s: TaxScope) =>
    rates.find(
      (r) =>
        r.jurisdiction === jurisdiction &&
        r.scope === s &&
        r.validFrom <= on &&
        (r.validTo === null || on < r.validTo),
    );
  let rate = find(scope);
  if (!rate && scope !== 'domestic') {
    reasons.push(`no_rate_for_scope_${scope}`);
    scope = 'domestic';
    rate = find('domestic');
  }
  if (!rate)
    throw new ProblemException(
      'service_unavailable',
      `no tax rate is configured for ${jurisdiction}/${scope} on ${on}`,
    );
  if (rate.verify) reasons.push('rate_unverified');
  return { rate, reviewRequired: reasons.some((r) => r !== 'rate_unverified'), reasons };
}

/** Integer division with rounding of a non-negative numerator. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  if (n < 0n || d <= 0n) throw new RangeError('divRound needs n >= 0 and d > 0');
  const q = n / d;
  const r2 = (n % d) * 2n;
  if (r2 > d) return q + 1n;
  if (r2 < d) return q;
  return mode === 'half_up' ? q + 1n : q % 2n === 0n ? q : q + 1n; // exactly half
}

export interface TaxedLine {
  netMinor: bigint;
  taxMinor: bigint;
  grossMinor: bigint;
}
export interface TaxResult {
  lines: TaxedLine[];
  netMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

/**
 * Tax per line at minor-unit precision; the document totals are the SUM of the line values, so
 * total = Σnet + Σtax holds with zero difference and the result does not depend on line order (docs/11 §4).
 */
export function computeTax(
  netMinor: readonly bigint[],
  rateBps: number,
  mode: RoundingMode = 'half_up',
): TaxResult {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000)
    throw new RangeError('rateBps must be an integer in 0..10000');
  const lines = netMinor.map((net) => {
    if (net < 0n)
      throw new RangeError('line net must not be negative (credits are separate documents)');
    const tax = divRound(net * BigInt(rateBps), 10_000n, mode);
    return { netMinor: net, taxMinor: tax, grossMinor: net + tax };
  });
  const sum = (f: (l: TaxedLine) => bigint) => lines.reduce((s, l) => s + f(l), 0n);
  return {
    lines,
    netMinor: sum((l) => l.netMinor),
    taxMinor: sum((l) => l.taxMinor),
    totalMinor: sum((l) => l.grossMinor),
  };
}
