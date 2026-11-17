import { daysBetween } from './subscription-period';

/**
 * Proration of a mid-period plan or quantity change (docs/11 §2). Integer minor units only. Given the amounts for a FULL period under the
 * old and the new terms and the change date inside the current period [start, end):
 *   unused credit of the old terms = old × daysLeft / daysTotal      (half-up)
 *   charge for the new terms       = new × daysLeft / daysTotal      (half-up)
 *   net                            = charge − credit                 (positive: charge now; negative: credit towards the next renewal)
 * Rounding each side separately keeps both numbers explainable on the document.
 */
export interface Proration {
  daysTotal: number;
  daysLeft: number;
  unusedCreditMinor: bigint;
  newChargeMinor: bigint;
  netMinor: bigint;
}

const mulDivHalfUp = (a: bigint, num: number, den: number): bigint =>
  (a * BigInt(num) + BigInt(den) / 2n) / BigInt(den);

export function prorate(p: {
  oldAmountMinor: bigint;
  newAmountMinor: bigint;
  periodStart: string;
  periodEnd: string;
  changeDate: string;
}): Proration {
  if (p.oldAmountMinor < 0n || p.newAmountMinor < 0n) throw new Error('amounts cannot be negative');
  const daysTotal = daysBetween(p.periodStart, p.periodEnd);
  const daysLeft = daysBetween(p.changeDate, p.periodEnd);
  if (daysTotal < 1) throw new Error('the period is empty');
  if (daysLeft < 1 || daysLeft > daysTotal)
    throw new Error('the change date is outside the period');
  const unused = mulDivHalfUp(p.oldAmountMinor, daysLeft, daysTotal);
  const charge = mulDivHalfUp(p.newAmountMinor, daysLeft, daysTotal);
  return {
    daysTotal,
    daysLeft,
    unusedCreditMinor: unused,
    newChargeMinor: charge,
    netMinor: charge - unused,
  };
}
