import { describe, expect, it } from 'vitest';
import { ipAllowed, permissionCovers, scopesExceeding } from './api-key.service';
import { derivePepper, newRecoveryCode } from './mfa.service';
import { safeReturnTo } from './return-to';

describe('api_key_scope_subset', () => {
  const creator = new Set(['project:read', 'project:write', 'billing:*']);
  it('allows scopes the creator holds, including wildcard coverage', () => {
    expect(scopesExceeding(['project:read', 'billing:read', 'billing:manage'], creator)).toEqual(
      [],
    );
  });
  it('flags scopes beyond the creator permissions', () => {
    expect(scopesExceeding(['project:read', 'member:manage', 'project:delete'], creator)).toEqual([
      'member:manage',
      'project:delete',
    ]);
  });
  it('a wildcard is only honoured on the allowed side, never when requested', () => {
    expect(permissionCovers(new Set(['project:read']), 'project:*')).toBe(false);
    expect(permissionCovers(new Set(['*']), 'anything:else')).toBe(true);
  });
});

describe('ip allow-list', () => {
  it('empty list allows any address', () => expect(ipAllowed('203.0.113.9', [])).toBe(true));
  it('matches exact addresses and CIDR ranges, incl. IPv4-mapped IPv6', () => {
    expect(ipAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
    expect(ipAllowed('203.0.113.200', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.200', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
  });
  it('rejects garbage input', () => expect(ipAllowed('not-an-ip', ['203.0.113.0/24'])).toBe(false));
});

describe('recovery codes', () => {
  it('have 50 bits of entropy in an unambiguous format and do not repeat', () => {
    const codes = Array.from({ length: 2000 }, newRecoveryCode);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it('derives a stable 32-byte pepper per key and different peppers for different keys', () => {
    const a = derivePepper(new Uint8Array(32).fill(1));
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(derivePepper(new Uint8Array(32).fill(1))))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(derivePepper(new Uint8Array(32).fill(2))))).toBe(
      false,
    );
  });
});

describe('returnTo allow-list', () => {
  const origins = ['https://app.nuzm.test'];
  it.each([
    ['/projects?x=1', '/projects?x=1'],
    [undefined, '/'],
    ['https://app.nuzm.test/home', 'https://app.nuzm.test/home'],
  ])('accepts %s', (raw, out) => expect(safeReturnTo(raw, origins, '/')).toBe(out));
  it.each([
    '//evil.test',
    'https://evil.test',
    'javascript:alert(1)',
    '/a\\b',
    '/a\nb',
    'data:text/html,x',
    'https://app.nuzm.test.evil.test/',
  ])('rejects %s', (raw) => expect(safeReturnTo(raw, origins, '/')).toBeNull());
});
