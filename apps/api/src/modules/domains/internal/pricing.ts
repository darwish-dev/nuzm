import { currencyExponent } from '@nuzm/registrar-contracts';
import type { DomainsConfig } from './ports';

const DEC = /^(\d{1,9})(?:\.(\d{1,9}))?$/;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Registrar COST (per year, vendor currency, integer minor units) → customer price per year in the platform currency, integer minor units, rounded UP
 * (never under-charge). FX is exact decimal arithmetic from an explicit table; a currency without a rate is `null` (no quote, never a guessed rate).
 * Markup is `markupBps` (D-23 margin policy is OPEN: default 0).
 */
export function customerUnitPrice(
  cost: { amountMinor: string; currency: string },
  cfg: Pick<DomainsConfig, 'currency' | 'fx' | 'markupBps'>,
): { unitMinor: bigint; currency: string } | null {
  if (!/^\d{1,18}$/.test(cost.amountMinor)) return null;
  const rate = cost.currency === cfg.currency ? '1' : cfg.fx[cost.currency];
  const m = typeof rate === 'string' ? DEC.exec(rate) : null;
  if (!m) return null;
  const frac = m[2] ?? '';
  const num = BigInt(m[1]! + frac); // rate * 10^frac.length
  const den = 10n ** BigInt(frac.length);
  const e1 = BigInt(currencyExponent(cost.currency));
  const e2 = BigInt(currencyExponent(cfg.currency));
  // minor2 = minor1 * rate * 10^(e2-e1)
  let numer =
    BigInt(cost.amountMinor) * num * (10000n + BigInt(Math.max(0, Math.floor(cfg.markupBps))));
  let denom = den * 10000n;
  if (e2 >= e1) numer *= 10n ** (e2 - e1);
  else denom *= 10n ** (e1 - e2);
  return { unitMinor: ceilDiv(numer, denom), currency: cfg.currency };
}
