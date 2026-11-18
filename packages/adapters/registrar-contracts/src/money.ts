const EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
};
export const currencyExponent = (currency: string): number => EXPONENT[currency.toUpperCase()] ?? 2;

/**
 * Converts a vendor decimal (they send JSON doubles or decimal strings) to integer minor units WITHOUT float arithmetic: the number is formatted to a decimal
 * string and parsed digit by digit. More fraction digits than the currency allows are rounded half up. Returns null for anything that is not a finite, non-negative amount.
 */
export function toMinorUnits(value: unknown, currency: string): string | null {
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    s = value.toFixed(8);
  } else if (typeof value === 'string') s = value.trim();
  else return null;
  const m = /^(\d{1,15})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) return null;
  const exp = currencyExponent(currency);
  const frac = (m[2] ?? '').padEnd(exp + 1, '0');
  let n = BigInt(m[1]! + frac.slice(0, exp));
  if (frac.length > exp && frac.charCodeAt(exp) >= 53) n += 1n; // '5'..'9' rounds up
  return n.toString();
}
