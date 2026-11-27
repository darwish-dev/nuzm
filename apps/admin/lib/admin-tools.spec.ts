import { describe, expect, it } from 'vitest';
import { creditLines, creditRequest, sarToMinor } from './admin-tools';

describe('sarToMinor', () => {
  it('turns typed SAR into integer halalas without floating point', () => {
    expect(sarToMinor('50')).toBe('5000');
    expect(sarToMinor('12.5')).toBe('1250');
    expect(sarToMinor('12.34')).toBe('1234');
    expect(sarToMinor(' 1,250.75 ')).toBe('125075');
    expect(sarToMinor('0.01')).toBe('1');
    expect(sarToMinor('1000000')).toBe('100000000');
  });
  it('refuses zero, negatives, more than two decimals, words, and more than SAR 1,000,000', () => {
    for (const bad of ['', '0', '0.00', '-5', '1.234', 'ten', '1e3', '1000000.01', '.5', '5.'])
      expect(sarToMinor(bad)).toBeNull();
  });
});

describe('credit request', () => {
  it('is a balanced promotional credit: 4900 debit (platform), 2100 credit (organization wallet)', () => {
    const lines = creditLines('5000');
    expect(lines).toEqual([
      {
        account: { code: '4900', org: false },
        direction: 'debit',
        amountMinor: '5000',
        currency: 'SAR',
      },
      {
        account: { code: '2100', org: true },
        direction: 'credit',
        amountMinor: '5000',
        currency: 'SAR',
      },
    ]);
  });
  it('builds the adjustment body, or says why it cannot', () => {
    expect(creditRequest('org-1', { amount: '25', reason: ' welcome credit ' })).toEqual({
      body: { orgId: 'org-1', reason: 'welcome credit', lines: creditLines('2500') },
    });
    expect(creditRequest('org-1', { amount: '0', reason: 'welcome' })).toEqual({
      error: 'invalid',
    });
    expect(creditRequest('org-1', { amount: '10', reason: 'ab' })).toEqual({ error: 'invalid' });
  });
});
