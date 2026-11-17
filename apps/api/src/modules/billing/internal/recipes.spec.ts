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
      { numRuns: 10_000 }, // AC-M02-01: 10,000 generated transactions
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
      { numRuns: 10_000 }, // AC-M02-01
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
    for (const r of [refund, walletTopUp]) problem(r, 'recipe_not_implemented', /M03/);
  });
});

const ACCOUNTS = ['4100', '4200', '4300', '4400'] as const;
const docLine = fc.record({
  revenueAccount: fc.constantFrom(...ACCOUNTS),
  netMinor: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  taxMinor: fc.bigInt({ min: 0n, max: 10n ** 11n }),
});
const lines = fc
  .array(docLine, { minLength: 1, maxLength: 10 })
  .filter((ls) => ls.some((l) => l.netMinor + l.taxMinor > 0n));
const doc = (
  ls: { revenueAccount: (typeof ACCOUNTS)[number]; netMinor: bigint; taxMinor: bigint }[],
  cur = 'SAR',
) => ({
  orgId: ORG,
  documentId: 'doc-1',
  invoiceId: 'inv-1',
  entityId: 'ent-1',
  currency: cur,
  number: 'NZM-00000001',
  lines: ls,
});

describe('invoice and credit-note recipes (docs/11 §3.1)', () => {
  it('invoice issued balances for any lines: Dr 1200 = Σ(net+tax) = Σ revenue + VAT (10,000 runs)', () =>
    fc.assert(
      fc.property(lines, currency, (ls, c) => {
        const b = invoiceIssued(doc(ls, c));
        expect(net(b, c)).toBe(0n);
        const gross = ls.reduce((s, l) => s + l.netMinor + l.taxMinor, 0n);
        const ar = b.postings.find((p) => p.account.code === '1200')!;
        expect(ar).toMatchObject({ direction: 'debit', account: { org: true } });
        expect(BigInt(ar.amountMinor)).toBe(gross);
        const vat = ls.reduce((s, l) => s + l.taxMinor, 0n);
        expect(b.postings.some((p) => p.account.code === '2300')).toBe(vat > 0n);
        for (const p of b.postings) expect(BigInt(p.amountMinor) > 0n).toBe(true); // no zero postings
        expect(b).toMatchObject({
          kind: 'invoice_issued',
          affectsWallet: false,
          sourceEventId: 'inv-1',
        });
      }),
      { numRuns: 10_000 },
    ));

  it('credit note is the mirror: Dr revenue + VAT → Cr 1200, balanced, never touches the wallet (10,000 runs)', () =>
    fc.assert(
      fc.property(lines, currency, (ls, c) => {
        const b = creditNote(doc(ls, c));
        expect(net(b, c)).toBe(0n);
        const ar = b.postings.find((p) => p.account.code === '1200')!;
        expect(ar.direction).toBe('credit');
        expect(
          b.postings.filter((p) => p.account.code !== '1200').every((p) => p.direction === 'debit'),
        ).toBe(true);
        expect(b.postings.some((p) => p.account.code === '2100')).toBe(false);
        expect(b.kind).toBe('credit_note');
      }),
      { numRuns: 10_000 },
    ));

  it('an invoice and its full credit note cancel on every account', () =>
    fc.assert(
      fc.property(lines, (ls) => {
        const sum = new Map<string, bigint>();
        for (const b of [invoiceIssued(doc(ls)), creditNote(doc(ls))])
          for (const p of b.postings)
            sum.set(
              p.account.code,
              (sum.get(p.account.code) ?? 0n) +
                (p.direction === 'debit' ? 1n : -1n) * BigInt(p.amountMinor),
            );
        for (const v of sum.values()) expect(v).toBe(0n);
      }),
      { numRuns: 2_000 },
    ));

  it('rejects empty, all-zero, unknown-account and negative documents', () => {
    problem(() => invoiceIssued(doc([])), 'validation_failed', /at least one line/);
    problem(
      () => invoiceIssued(doc([{ revenueAccount: '4100', netMinor: 0n, taxMinor: 0n }])),
      'validation_failed',
      /positive total/,
    );
    problem(
      () => invoiceIssued(doc([{ revenueAccount: '9999' as never, netMinor: 5n, taxMinor: 0n }])),
      'validation_failed',
      /unknown revenue account/,
    );
    problem(
      () => creditNote(doc([{ revenueAccount: '4100', netMinor: -5n as never, taxMinor: 0n }])),
      'validation_failed',
      /./,
    );
  });
});

describe('payment captured recipe (docs/11 §3.1)', () => {
  const pay = (amount: bigint, applied: bigint) =>
    paymentCaptured({
      orgId: ORG,
      paymentId: 'pay-1',
      invoiceId: 'inv-1',
      pspAccountCode: 'mock-sandbox',
      currency: 'SAR',
      amountMinor: amount,
      appliedMinor: applied,
    });
  it('balances for any amount and any applied part, sending the excess to 2500 (10,000 runs)', () =>
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        (amount, a) => {
          const applied = a > amount ? amount : a;
          const b = pay(amount, applied);
          expect(net(b, 'SAR')).toBe(0n);
          const sum = (code: string) =>
            b.postings
              .filter((p) => p.account.code === code)
              .reduce((s, p) => s + BigInt(p.amountMinor), 0n);
          expect(sum('1100')).toBe(amount);
          expect(sum('1200')).toBe(applied);
          expect(sum('2500')).toBe(amount - applied);
          expect(b.postings.find((p) => p.account.code === '1100')).toMatchObject({
            direction: 'debit',
            account: { org: false, subledger: 'mock-sandbox' },
          });
          expect(b.kind).toBe('payment_captured');
        },
      ),
      { numRuns: 10_000 },
    ));
  it('refuses to apply more than was paid', () =>
    problem(() => pay(100n, 101n), 'validation_failed', /cannot exceed/));
});
