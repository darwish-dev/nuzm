/**
 * Card-number detection (PCI scope reduction: a card number must never be accepted, stored or logged by this platform).
 * A 13-19 digit run (spaces and dashes allowed) that passes the Luhn check counts as a card number.
 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
/**
 * Contiguous 13-19 digit runs, or the printed card layouts (4-4-4-4, 4-6-5), that start with 1-9, are not part of a longer token
 * (letters, digits, underscore around them) and are not a repeated digit. UUID segments (at most 12 digits), ISO timestamps and
 * amounts therefore never qualify.
 */
const RUNS = [
  /(?<![0-9A-Za-z_])[1-9][0-9]{12,18}(?![0-9A-Za-z_])/g,
  /(?<![0-9A-Za-z_])[1-9][0-9]{3}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,7}(?![0-9A-Za-z_])/g,
  /(?<![0-9A-Za-z_])[1-9][0-9]{3}([ -])[0-9]{6}\1[0-9]{5}(?![0-9A-Za-z_])/g,
];
export function looksLikeCardNumber(s: string): boolean {
  return RUNS.some((re) =>
    [...s.matchAll(re)].some((m) => {
      const d = m[0].replace(/[ -]/g, '');
      return d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhnValid(d);
    }),
  );
}
const FIELDS =
  /^(pan|number|cardnumber|card_number|cvv|cvc|cvv2|securitycode|security_code|expiry|exp|cardholder)$/i;
/** True when a request body carries card data: a field named like card data, or ANY string value that is a Luhn-valid card number. */
export function containsCardData(v: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof v === 'string') return looksLikeCardNumber(v);
  if (typeof v === 'number') return looksLikeCardNumber(String(v));
  if (Array.isArray(v)) return v.some((x) => containsCardData(x, depth + 1));
  if (v && typeof v === 'object')
    return Object.entries(v as Record<string, unknown>).some(
      ([k, x]) => FIELDS.test(k) || containsCardData(x, depth + 1),
    );
  return false;
}
