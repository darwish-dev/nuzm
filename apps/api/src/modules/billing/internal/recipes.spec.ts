import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adjustment,
  assertBalanced,
  creditGrant,
  creditNote,
  invoiceIssued,
  parseMinor,
  paymentCaptured,
  providerCostAccrual,
  refund,
  reversal,
  usageChargeWallet,
  walletConsume,
  walletTopUp,
  type PostingLine,
} from './recipes';

/** ProblemException keeps the human text in `.detail` (the Error message is the registry title). */
const problem = (fn: () => unknown, code: string, detail: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toMatchObject({ code });
    expect((e as { detail?: string }).detail).toMatch(detail);
    return;
  }
  throw new Error('expected a ProblemException');
};

const ORG = '00000000-0000-7000-8000-00000000000a';
const money = fc.bigInt({ min: 1n, max: 10n ** 15n });
const currency = fc.constantFrom('SAR', 'USD', 'EUR');
const net = (b: { postings: PostingLine[] }, cur: string) =>
  b.postings
    .filter((p) => p.currency === cur)
    .reduce(
      (s, p) => s + (p.direction === 'debit' ? BigInt(p.amountMinor) : -BigInt(p.amountMinor)),
      0n,
    );
const line = (code: string, direction: 'debit' | 'credit', amountMinor: string): PostingLine => ({
  account: { code, org: code === '2100' },
  direction,
  amountMinor,
  currency: 'SAR',
});

describe('ledger_tx_always_balanced (property)', () => {
  it('credit grants balance for any amount', () =>
    fc.assert(
      fc.property(money, currency, (a, c) => {
        const b = creditGrant({ orgId: ORG, amountMinor: a, currency: c, reason: 'promo' });
        expect(net(b, c)).toBe(0n);
        expect(() => assertBalanced(b.postings)).not.toThrow();
      }),
    ));

  it('wallet consumes balance for any net/VAT split, and the wallet is debited gross', () =>
    fc.assert(
      fc.property(money, fc.bigInt({ min: 0n, max: 10n ** 14n }), currency, (n, v, c) => {
        const b = walletConsume({
          orgId: ORG,
          netMinor: n,
          vatMinor: v,
          currency: c,
          meterId: 'compute.vcpu_hours',
        });
        expect(net(b, c)).toBe(0n);
        const wallet = b.postings.find((p) => p.account.code === '2100')!;
        expect(wallet).toMatchObject({ direction: 'debit', nonNegative: true });
        expect(BigInt(wallet.amountMinor)).toBe(n + v);
        expect(b.postings.some((p) => p.account.code === '2300')).toBe(v > 0n);
      }),
    ));

  it('provider cost accruals balance on one sub-ledger', () =>
    fc.assert(
      fc.property(money, currency, fc.stringMatching(/^[a-z0-9-]{3,20}$/), (a, c, sub) => {
        const b = providerCostAccrual({ providerAccountId: sub, amountMinor: a, currency: c });
        expect(net(b, c)).toBe(0n);
        expect(b.orgId).toBeNull();
        expect(new Set(b.postings.map((p) => p.account.subledger))).toEqual(new Set([sub]));
      }),
    ));

  it('a reversal flips every posting, balances, and reversing twice returns the original directions', () =>
    fc.assert(
      fc.property(money, fc.bigInt({ min: 0n, max: 10n ** 14n }), (n, v) => {
        const original = walletConsume({ orgId: ORG, netMinor: n, vatMinor: v, currency: 'SAR' });
        const r1 = reversal({
          orgId: ORG,
          originalId: 'tx-1',
          original: original.postings,
          reason: 'mistake',
        });
        expect(net(r1, 'SAR')).toBe(0n);
        r1.postings.forEach((p, i) =>
          expect(p.direction).not.toBe(original.postings[i]!.direction),
        );
        const r2 = reversal({
          orgId: ORG,
          originalId: 'tx-2',
          original: r1.postings,
          reason: 'undo',
        });
        expect(r2.postings.map((p) => p.direction)).toEqual(
          original.postings.map((p) => p.direction),
        );
        expect(r1.reversesId).toBe('tx-1');
      }),
    ));
});

describe('amount discipline: integer minor units only', () => {
  it.each([
    0,
    -5,
    1.5,
    NaN,
    Infinity,
    2 ** 53,
    '1e3',
    '1.0',
    '-1',
    ' 12',
    '',
    '0x10',
    '12345678901234567890',
  ])('rejects %j', (bad) =>
    problem(() => parseMinor(bad as never), 'validation_failed', /minor units|positive integer/),
  );

  it('accepts safe integers, bigints and digit strings as the same exact decimal string', () => {
    expect(parseMinor(12345)).toBe('12345');
    expect(parseMinor(12345n)).toBe('12345');
    expect(parseMinor('9007199254740993')).toBe('9007199254740993'); // beyond Number precision, exact as a string
  });

  it('rejects a bad currency code', () =>
    problem(
      () => creditGrant({ orgId: ORG, amountMinor: 1, currency: 'sar', reason: 'x' }),
      'validation_failed',
      /ISO 4217/,
    ));
});

describe('recipe specifics (docs/11 §3.1)', () => {
  it('credit grant: Dr 4900 (platform) / Cr 2100 (org wallet)', () => {
    const b = creditGrant({
      orgId: ORG,
      amountMinor: 5000,
      currency: 'SAR',
      reason: 'Welcome credit',
      expiresAt: '2027-01-01T00:00:00Z',
    });
    expect(b.postings.map((p) => [p.account.code, p.account.org, p.direction])).toEqual([
      ['4900', false, 'debit'],
      ['2100', true, 'credit'],
    ]);
    expect(b.affectsWallet).toBe(true);
    expect(b.postings[1]!.dimensions).toMatchObject({ expires_at: '2027-01-01T00:00:00Z' });
  });

  it('usage charge keeps its meter dimensions', () => {
    const b = usageChargeWallet({
      orgId: ORG,
      netMinor: 250,
      currency: 'SAR',
      meterId: 'ai.credits_consumed',
      resourceId: 'run-1',
    });
    expect(b.kind).toBe('usage_charge_wallet');
    expect(b.postings[0]!.dimensions).toMatchObject({
      meter_id: 'ai.credits_consumed',
      resource_id: 'run-1',
    });
  });

  it('adjustments must balance and need a reason and two lines', () => {
    problem(
      () =>
        adjustment({
          orgId: ORG,
          reason: 'fix',
          lines: [line('4900', 'debit', '10'), line('2100', 'credit', '11')],
        }),
      'validation_failed',
      /do not balance/,
    );
    problem(
      () =>
        adjustment({
          orgId: ORG,
          reason: '  ',
          lines: [line('4900', 'debit', '10'), line('2100', 'credit', '10')],
        }),
      'validation_failed',
      /reason/,
    );
    problem(
      () => adjustment({ orgId: ORG, reason: 'fix', lines: [line('4900', 'debit', '10')] }),
      'validation_failed',
      /at least two/,
    );
    expect(
      adjustment({
        orgId: ORG,
        reason: 'fix',
        lines: [line('4900', 'debit', '10'), line('2100', 'credit', '10')],
      }).affectsWallet,
    ).toBe(true);
  });

  it('a reversal that debits the customer wallet keeps the overdraw guard', () => {
    const grant = creditGrant({ orgId: ORG, amountMinor: 100, currency: 'SAR', reason: 'x' });
    const rev = reversal({
      orgId: ORG,
      originalId: 't',
      original: grant.postings,
      reason: 'oops',
    });
    expect(rev.postings.find((p) => p.account.code === '2100')).toMatchObject({
      direction: 'debit',
      nonNegative: true,
    });
  });

  it('M03-owned recipes fail loudly instead of improvising', () => {
    for (const r of [invoiceIssued, paymentCaptured, refund, creditNote, walletTopUp])
      problem(r, 'recipe_not_implemented', /M03/);
  });
});
