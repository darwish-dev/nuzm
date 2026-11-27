/**
 * Pure helpers of the admin tools (create customer, create organization, add credit). No I/O: tested on their own.
 */

/** The largest credit one request may add: SAR 1,000,000 (a typo guard, not a business limit; the second approver still decides). */
export const MAX_CREDIT_MINOR = 100_000_000n;

/**
 * A typed SAR amount ("50", "12.5", "1,250.75") as integer minor units (halalas), by string arithmetic only (money is never a float).
 * null when it is not a positive amount with at most two decimals, or above {@link MAX_CREDIT_MINOR}.
 */
export function sarToMinor(input: string): string | null {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (minor <= 0n || minor > MAX_CREDIT_MINOR) return null;
  return minor.toString();
}

/**
 * The balanced ledger lines of a promotional credit to an organization's wallet: debit 4900 "Discounts & promotional credits" (contra revenue,
 * platform account), credit 2100 "Customer wallet / prepaid credits" (the organization's account). Filed as an adjustment request; a different
 * staff member approves it before anything is posted.
 */
export function creditLines(amountMinor: string, currency = 'SAR') {
  return [
    { account: { code: '4900', org: false }, direction: 'debit' as const, amountMinor, currency },
    { account: { code: '2100', org: true }, direction: 'credit' as const, amountMinor, currency },
  ];
}

/** The request body of "add credit", or the reason it cannot be sent. */
export function creditRequest(
  orgId: string,
  f: { amount: string; reason: string },
):
  | { body: { orgId: string; reason: string; lines: ReturnType<typeof creditLines> } }
  | { error: 'invalid' } {
  const minor = sarToMinor(f.amount);
  const reason = f.reason.trim();
  if (!minor || reason.length < 3 || reason.length > 500) return { error: 'invalid' };
  return { body: { orgId, reason, lines: creditLines(minor) } };
}
