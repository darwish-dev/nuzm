import { describe, expect, it } from 'vitest';
import { UUID, isUuid } from './ids';

describe('shared UUID check', () => {
  it('accepts canonical UUIDs of any version, in either case', () => {
    expect(isUuid('01a1f444-2b63-76c9-9eac-788bdccc7efc')).toBe(true);
    expect(isUuid('01A1F444-2B63-76C9-9EAC-788BDCCC7EFC')).toBe(true);
    expect(UUID.test('00000000-0000-4000-8000-000000000000')).toBe(true);
  });
  it('rejects anything else, including non-strings and padded text', () => {
    for (const v of [
      null,
      undefined,
      42,
      {},
      '',
      'abc',
      ' 01a1f444-2b63-76c9-9eac-788bdccc7efc',
      '01a1f4442b6376c99eac788bdccc7efc',
    ])
      expect(isUuid(v)).toBe(false);
  });

  it('is exactly the pattern the ZATCA validator used before it imported this one (spec/zatca pin: changing it changes e-invoice validation)', () => {
    expect(UUID.source).toBe('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
    expect(UUID.flags).toBe('i');
  });
});
