import { describe, expect, it } from 'vitest';
import {
  contactBody,
  countdown,
  daysLeft,
  domainTone,
  emptyContact,
  expiringSoon,
  money,
  parseRecordValue,
  reasonKey,
  showValue,
} from './domains';

describe('domain screen helpers', () => {
  it('tones', () => {
    expect(domainTone('active')).toBe('success');
    expect(domainTone('renewal_at_risk')).toBe('danger');
    expect(domainTone('pending')).toBe('warn');
    expect(domainTone('x')).toBeUndefined();
  });
  it('reason keys: known rules get their sentence, everything else the generic one', () => {
    expect(reasonKey('policy.saudi_absent')).toBe('dom.search.reason.policy.saudi_absent');
    expect(reasonKey('registrar.not_listed')).toBe('dom.search.reason.registrar.not_listed');
    expect(reasonKey('policy.disabled')).toBe('dom.search.reason.other');
  });
  it('days left and expiry window', () => {
    const now = Date.parse('2027-01-01T00:00:00Z');
    expect(daysLeft('2027-01-11T00:00:00Z', now)).toBe(10);
    expect(daysLeft(null, now)).toBeNull();
    expect(expiringSoon('2027-02-01T00:00:00Z', now)).toBe(true);
    expect(expiringSoon('2028-02-01T00:00:00Z', now)).toBe(false);
  });
  it('money never uses floats', () => {
    expect(money('3686', 'SAR')).toBe('36.86 SAR');
    expect(money('5', 'SAR')).toBe('0.05 SAR');
    expect(money('100000000000000007', 'SAR')).toBe('1000000000000000.07 SAR');
    expect(money('0', 'SAR')).toBe('0.00 SAR');
  });
  it('countdown', () => {
    const now = Date.parse('2027-01-01T00:00:00Z');
    expect(countdown('2027-01-01T00:14:05Z', now)).toBe('14:05');
    expect(countdown('2027-01-01T00:00:00Z', now)).toBeNull();
  });
  it('contact body trims and upper-cases the country', () => {
    const c = {
      ...emptyContact(),
      firstName: ' A ',
      lastName: 'B',
      email: 'a@b.sa',
      phone: '+966500000000',
      street: 'S',
      city: 'C',
      postalCode: '1',
      country: 'sa',
    };
    expect(contactBody(c)).toEqual({
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.sa',
      phone: '+966500000000',
      address: { street: 'S', city: 'C', postalCode: '1', country: 'SA' },
    });
  });
  it('record values: JSON only for structured types', () => {
    expect(parseRecordValue('A', ' 192.0.2.1 ')).toBe('192.0.2.1');
    expect(parseRecordValue('A', '')).toBeNull();
    expect(parseRecordValue('MX', '{"priority":10,"host":"m.example.net"}')).toEqual({
      priority: 10,
      host: 'm.example.net',
    });
    expect(parseRecordValue('MX', 'not json')).toBeNull();
    expect(showValue({ a: 1 })).toBe('{"a":1}');
  });
});
