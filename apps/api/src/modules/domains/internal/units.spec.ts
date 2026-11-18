import { describe, expect, it } from 'vitest';
import { toMinorUnits } from '@nuzm/registrar-contracts';
import { maskContact, parseContacts } from './contacts';
import { normalizeDomainName, splitDomain } from './common';
import { customerUnitPrice } from './pricing';
import { AccountGuard } from './registrar-access.service';

const cfg = { currency: 'SAR', fx: { SAR: '1', USD: '3.75', EUR: '4.10' }, markupBps: 0 };
const c = {
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.example',
  phone: '+966500000000',
  address: { street: 's', city: 'c', postalCode: '1', country: 'sa' },
};

describe('pricing (exact, rounded up, no floats)', () => {
  it('converts vendor cost to the platform currency with exact decimals', () => {
    expect(customerUnitPrice({ amountMinor: '899', currency: 'EUR' }, cfg)).toEqual({
      unitMinor: 3686n,
      currency: 'SAR',
    }); // 8.99 × 4.10 = 36.859 → 36.86
    expect(customerUnitPrice({ amountMinor: '850', currency: 'USD' }, cfg)).toEqual({
      unitMinor: 3188n,
      currency: 'SAR',
    }); // 31.875 → 31.88 (up)
    expect(customerUnitPrice({ amountMinor: '1000', currency: 'SAR' }, cfg)).toEqual({
      unitMinor: 1000n,
      currency: 'SAR',
    });
  });
  it('applies the markup in basis points and always rounds up', () => {
    expect(
      customerUnitPrice({ amountMinor: '1000', currency: 'SAR' }, { ...cfg, markupBps: 1500 })
        ?.unitMinor,
    ).toBe(1150n);
    expect(
      customerUnitPrice({ amountMinor: '1001', currency: 'SAR' }, { ...cfg, markupBps: 1 })
        ?.unitMinor,
    ).toBe(1002n);
  });
  it('a currency with no rate, and malformed amounts, are never priced', () => {
    expect(customerUnitPrice({ amountMinor: '100', currency: 'GBP' }, cfg)).toBeNull();
    expect(customerUnitPrice({ amountMinor: '1.5', currency: 'SAR' }, cfg)).toBeNull();
    expect(customerUnitPrice({ amountMinor: '-1', currency: 'SAR' }, cfg)).toBeNull();
  });
  it('vendor doubles become minor units without float drift', () => {
    expect(toMinorUnits(0.1 + 0.2, 'USD')).toBe('30');
    expect(toMinorUnits(8.99, 'EUR')).toBe('899');
    expect(toMinorUnits('8.995', 'EUR')).toBe('900');
  });
});

describe('domain names', () => {
  it('normalizes IDN to punycode and rejects URL-ish input', () => {
    expect(normalizeDomainName('مثال.com')).toBe('xn--mgbh0fb.com');
    expect(normalizeDomainName(' Example.COM. ')).toBe('example.com');
    for (const bad of ['a b.com', 'a/b.com', 'a@b.com', '-a.com', 'a..com', ''])
      expect(normalizeDomainName(bad)).toBeNull();
  });
  it('splits on the longest known TLD', () => {
    expect(splitDomain('shop.co.uk', ['uk', 'co.uk'])).toEqual({ label: 'shop', tld: 'co.uk' });
    expect(splitDomain('a.b.com', ['com'])).toBeNull();
    expect(splitDomain('x.sa', ['com'])).toBeNull();
  });
});

describe('contacts', () => {
  it('defaults the other roles to the registrant and upper-cases the country', () => {
    const s = parseContacts({ registrant: c }, []);
    expect(s.admin).toEqual(s.registrant);
    expect(s.registrant.address.country).toBe('SA');
  });
  it('lists every invalid field and requires TLD-specific extras', () => {
    try {
      parseContacts(
        {
          registrant: {
            ...c,
            email: 'x',
            phone: '0500',
            address: { ...c.address, country: 'KSA' },
          },
        },
        ['idNumber'],
      );
      throw new Error('should fail');
    } catch (e) {
      const fields = ((e as { errors?: { field: string }[] }).errors ?? []).map((x) => x.field);
      expect(fields).toEqual(
        expect.arrayContaining([
          'contacts.registrant.email',
          'contacts.registrant.phone',
          'contacts.registrant.address.country',
          'contacts.registrant.extra.idNumber',
        ]),
      );
    }
  });
  it('rejects control characters and unknown roles', () => {
    expect(() => parseContacts({ registrant: { ...c, firstName: 'A\nB' } }, [])).toThrow();
    expect(() => parseContacts({ registrant: c, owner: c }, [])).toThrow();
  });
  it('masks enough to recognise, never enough to use', () => {
    const m = JSON.stringify(maskContact({ ...c, firstName: 'Salem', lastName: 'Alharbi' }));
    expect(m).not.toContain('Salem');
    expect(m).not.toContain('a@b.example');
    expect(m).toContain('S***');
  });
});

describe('account guard (circuit breaker + token bucket)', () => {
  it('opens after repeated failures, refuses while open, half-opens after the cooldown', () => {
    let now = 0;
    const g = new AccountGuard(() => now, {
      failureThreshold: 3,
      cooldownMs: 1000,
      burst: 100,
      perSecond: 100,
    });
    expect(g.admit()).toBeNull();
    for (let i = 0; i < 3; i++) g.record(false);
    expect(g.state()).toBe('open');
    expect(g.admit()).toBe('circuit_open');
    now = 1500;
    expect(g.state()).toBe('half-open');
    expect(g.admit()).toBeNull();
    g.record(true);
    expect(g.state()).toBe('closed');
  });
  it('rate limits locally and refills', () => {
    let now = 0;
    const g = new AccountGuard(() => now, {
      failureThreshold: 99,
      cooldownMs: 1000,
      burst: 2,
      perSecond: 1,
    });
    expect([g.admit(), g.admit(), g.admit()]).toEqual([null, null, 'local_rate_limit']);
    now = 2000;
    expect(g.admit()).toBeNull();
  });
});
