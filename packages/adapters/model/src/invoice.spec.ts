import { describe, expect, it } from 'vitest';
import { reconcileInvoice } from './invoice';
import { tokenCostNano } from './probe-cost';

const P = { currency: 'USD', inputPerMillion: '4.00', outputPerMillion: '20.00' };
// SYNTHETIC figures: arithmetic only, no invoice exists.
const usage = { inputTokens: 5_000, outputTokens: 1_200 };
const cost = tokenCostNano(usage.inputTokens, usage.outputTokens, P).toString();

describe('invoice reconciliation (arithmetic on operator-supplied figures)', () => {
  it('an invoice equal to our cost and to the vendor tokens at list price verifies both checks', () => {
    const r = reconcileInvoice(cost, P, {
      amountNano: cost,
      currency: 'USD',
      source: 'console, workspace x',
      vendorUsage: usage,
    });
    expect(r.verdict).toBe('LIVE-VERIFIED');
    expect(r.checks.map((c) => [c.id, c.ran, c.ok])).toEqual([
      ['our_cost_vs_invoice', true, true],
      ['list_price_vs_invoice', true, true],
    ]);
  });
  it('without the vendor token counts the price list is NOT checked and the verdict is NOT VERIFIED', () => {
    const r = reconcileInvoice(cost, P, { amountNano: cost, currency: 'USD', source: 'console' });
    expect(r.verdict).toBe('NOT VERIFIED');
    expect(r.checks[1]).toMatchObject({ ran: false, ok: false });
  });
  it('an invoice above our cost is flagged as unseen spend; below, as over-reporting', () => {
    const above = reconcileInvoice(cost, P, {
      amountNano: (BigInt(cost) + 10_000_000n).toString(),
      currency: 'USD',
      source: 'console',
    });
    expect(above.verdict).toBe('FAIL');
    expect(above.checks[0]!.detail).toMatch(/ABOVE our cost: spend we did not see/);
    const below = reconcileInvoice(cost, P, {
      amountNano: (BigInt(cost) - 10_000_000n).toString(),
      currency: 'USD',
      source: 'console',
    });
    expect(below.checks[0]!.detail).toMatch(/BELOW our cost/);
  });
  it('a wrong price list is caught by the vendor tokens even when our own counting matches the invoice', () => {
    const wrong = { ...P, outputPerMillion: '25.00' };
    const r = reconcileInvoice(cost, wrong, {
      amountNano: cost,
      currency: 'USD',
      source: 'console',
      vendorUsage: usage,
    });
    expect(r.checks[1]!.ok).toBe(false);
    expect(r.checks[1]!.detail).toMatch(/price list is WRONG/);
    expect(r.verdict).toBe('FAIL');
  });
  it('a rounded invoice passes only within an explicit tolerance', () => {
    const rounded = (BigInt(cost) + 3_000_000n).toString(); // 0.003 above
    const exact = reconcileInvoice(cost, P, {
      amountNano: rounded,
      currency: 'USD',
      source: 'console',
      vendorUsage: usage,
    });
    expect(exact.verdict).toBe('FAIL');
    const tol = reconcileInvoice(
      cost,
      P,
      { amountNano: rounded, currency: 'USD', source: 'console', vendorUsage: usage },
      5_000_000n,
    );
    expect(tol.verdict).toBe('LIVE-VERIFIED');
  });
  it('refuses (NOT VERIFIED, nothing ran) a currency mismatch, a missing source, malformed money or a negative tolerance', () => {
    for (const r of [
      reconcileInvoice(cost, P, { amountNano: cost, currency: 'EUR', source: 'console' }),
      reconcileInvoice(cost, P, { amountNano: cost, currency: 'USD', source: '' }),
      reconcileInvoice(cost, P, { amountNano: '1.5', currency: 'USD', source: 'console' }),
      reconcileInvoice('-1', P, { amountNano: cost, currency: 'USD', source: 'console' }),
      reconcileInvoice(cost, P, { amountNano: cost, currency: 'USD', source: 'console' }, -1n),
    ]) {
      expect(r.verdict).toBe('NOT VERIFIED');
      expect(r.checks.every((c) => !c.ran)).toBe(true);
    }
  });
});
