import { formatNano, tokenCostNano } from './probe-cost';
import type { ProviderPricing } from './types';

/**
 * COST RECONCILIATION AGAINST THE VENDOR INVOICE (P3-S01, plan item 7). Pure arithmetic on figures the OPERATOR reads from the vendor console / invoice for the dedicated workspace and
 * the run's window; nothing is sent, no key is read. Two independent questions:
 *   our_cost_vs_invoice   the cost we computed from the usage the provider REPORTED (at the adapter's list price) against the amount invoiced: a vendor figure ABOVE ours means spend we did not
 *                         see (an unreported request, a stream that was cut); BELOW means we over-reported (an estimate charged at its ceiling) or the invoice rounds down.
 *   list_price_vs_invoice the vendor's own token counts for the window at OUR list price against the amount invoiced: this checks the RATE CARD (the price in the adapter / the S-AG4 pricing
 *                         note) independently of our own token counting. Needs the vendor's token figure; without it the check is NOT run (NOT VERIFIED).
 * Money is in nano units (integers); the tolerance is explicit (an invoice is usually rounded to the cent): default 0 = exact.
 */
export interface InvoiceFigures {
  /** the amount invoiced for the workspace and window, nano units of the price currency, integer string */
  amountNano: string;
  currency: string;
  /** where the figure was read (a console page, an invoice id): a person must be able to find it again */
  source: string;
  /** the vendor's token counts for the same window, when the console shows them */
  vendorUsage?: { inputTokens: number; outputTokens: number };
}
export interface InvoiceCheck {
  id: 'our_cost_vs_invoice' | 'list_price_vs_invoice';
  ran: boolean;
  ok: boolean;
  /** a fixed sentence plus figures; never content */
  detail: string;
}
export interface InvoiceReconciliation {
  checks: InvoiceCheck[];
  /** `LIVE-VERIFIED` only when both checks ran and passed; `FAIL` when a check ran and failed; else `NOT VERIFIED` */
  verdict: 'LIVE-VERIFIED' | 'FAIL' | 'NOT VERIFIED';
  currency: string;
  ourCostNano: string;
  invoiceNano: string;
  toleranceNano: string;
}

const abs = (n: bigint) => (n < 0n ? -n : n);
const NANO = /^\d{1,18}$/;

export function reconcileInvoice(
  ourCostNano: string,
  pricing: ProviderPricing,
  inv: InvoiceFigures,
  toleranceNano: bigint | string = 0n,
): InvoiceReconciliation {
  const tol = typeof toleranceNano === 'string' ? BigInt(toleranceNano) : toleranceNano;
  const checks: InvoiceCheck[] = [];
  const bad = (d: string): InvoiceReconciliation => ({
    checks: [
      { id: 'our_cost_vs_invoice', ran: false, ok: false, detail: d },
      { id: 'list_price_vs_invoice', ran: false, ok: false, detail: d },
    ],
    verdict: 'NOT VERIFIED',
    currency: pricing.currency,
    ourCostNano,
    invoiceNano: NANO.test(inv.amountNano) ? inv.amountNano : '0',
    toleranceNano: tol.toString(),
  });
  if (!NANO.test(ourCostNano) || !NANO.test(inv.amountNano))
    return bad('a money figure is not a non-negative integer of nano units');
  if (inv.currency !== pricing.currency)
    return bad(
      `the invoice is in ${inv.currency} but the price list is in ${pricing.currency}: no conversion is attempted`,
    );
  if (typeof inv.source !== 'string' || inv.source.trim().length < 3)
    return bad('the invoice figure needs a source a person can find again');
  if (tol < 0n) return bad('the tolerance must not be negative');
  const ours = BigInt(ourCostNano);
  const invoiced = BigInt(inv.amountNano);
  const d1 = invoiced - ours;
  checks.push({
    id: 'our_cost_vs_invoice',
    ran: true,
    ok: abs(d1) <= tol,
    detail:
      abs(d1) <= tol
        ? `our cost ${formatNano(ours)} and the invoice ${formatNano(invoiced)} ${pricing.currency} agree within ${formatNano(tol)}`
        : d1 > 0n
          ? `the invoice is ${formatNano(d1)} ${pricing.currency} ABOVE our cost: spend we did not see`
          : `the invoice is ${formatNano(-d1)} ${pricing.currency} BELOW our cost: we over-reported (an estimate) or the invoice rounds down`,
  });
  const u = inv.vendorUsage;
  if (
    !u ||
    !Number.isInteger(u.inputTokens) ||
    !Number.isInteger(u.outputTokens) ||
    u.inputTokens < 0 ||
    u.outputTokens < 0
  )
    checks.push({
      id: 'list_price_vs_invoice',
      ran: false,
      ok: false,
      detail:
        'not run: the vendor token counts for the window were not supplied, so the price list cannot be checked on its own',
    });
  else {
    const expected = tokenCostNano(u.inputTokens, u.outputTokens, pricing);
    const d2 = invoiced - expected;
    checks.push({
      id: 'list_price_vs_invoice',
      ran: true,
      ok: abs(d2) <= tol,
      detail:
        abs(d2) <= tol
          ? `the vendor's own tokens at our list price (${formatNano(expected)}) match the invoice within ${formatNano(tol)} ${pricing.currency}: the price list holds`
          : `the vendor's own tokens at our list price give ${formatNano(expected)} but the invoice is ${formatNano(invoiced)} ${pricing.currency}: the price list is WRONG or the window differs`,
    });
  }
  const anyFail = checks.some((c) => c.ran && !c.ok);
  const allOk = checks.every((c) => c.ran && c.ok);
  return {
    checks,
    verdict: anyFail ? 'FAIL' : allOk ? 'LIVE-VERIFIED' : 'NOT VERIFIED',
    currency: pricing.currency,
    ourCostNano,
    invoiceNano: inv.amountNano,
    toleranceNano: tol.toString(),
  };
}
