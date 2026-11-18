import { describe, expect, it } from 'vitest';
import { DELEGABLE_SCOPES, NEVER_DELEGABLE_PREFIXES, effectivePermissions, permitted, validateGrant } from './delegation';

const now = new Date('2026-11-18T00:00:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe('delegated access rules', () => {
  it('accepts delegable scopes with an expiry inside 365 days', () => {
    const r = validateGrant({ scopes: ['hosting:site:read', 'dns:write'], expiresAt: inDays(90) }, now);
    expect(r.ok).toBe(true);
  });
  it('refuses a missing, malformed, past or too-distant expiry', () => {
    for (const [e, code] of [[undefined, 'expiry_missing'], ['', 'expiry_missing'], [null, 'expiry_missing'], ['soon', 'expiry_invalid'], [inDays(-1), 'expiry_invalid'], [new Date(now.getTime() + 60_000).toISOString(), 'expiry_invalid'], [inDays(366), 'expiry_too_far'], [12345, 'expiry_invalid']] as const) {
      const r = validateGrant({ scopes: ['dns:read'], expiresAt: e }, now);
      expect(r.ok, String(e)).toBe(false);
      if (!r.ok) expect(r.code, String(e)).toBe(code);
    }
    expect(validateGrant({ scopes: ['dns:read'], expiresAt: inDays(365) }, now).ok).toBe(true);
  });
  it('refuses scopes outside the delegable catalogue (billing, members, keys, privacy, audit, partner programs, deletion)', () => {
    for (const s of ['billing:manage', 'member:manage', 'apikey:manage', 'org:delete', 'privacy:dsr:manage', 'audit:read_all', 'agency:manage', 'reseller:pricing', 'partners:manage', 'marketplace:buy', 'spend:request', 'data:db:admin', 'compute:instance:delete', 'hosting:site:delete', 'project:delete', '*', 'hosting:*', 'nonsense'])
      expect(validateGrant({ scopes: [s], expiresAt: inDays(30) }, now), s).toMatchObject({ ok: false, code: 'scopes_not_delegable' });
    for (const s of DELEGABLE_SCOPES) expect(NEVER_DELEGABLE_PREFIXES.some((p) => s.startsWith(p)), s).toBe(false);
    for (const bad of [[], 'dns:read', [1], null, undefined, Array(61).fill('dns:read')]) expect(validateGrant({ scopes: bad, expiresAt: inDays(30) }, now), String(bad)).toMatchObject({ ok: false, code: 'scopes_invalid' });
  });
  it('a grant can never exceed what the accepting client administrator holds', () => {
    const admin = new Set(['hosting:site:read', 'dns:*']);
    expect(validateGrant({ scopes: ['hosting:site:read', 'dns:write'], expiresAt: inDays(30) }, now, admin).ok).toBe(true);
    expect(validateGrant({ scopes: ['hosting:site:update'], expiresAt: inDays(30) }, now, admin)).toMatchObject({ ok: false, code: 'scopes_exceed_grantable' });
  });
  it('effective permissions are the intersection of the member role and the grant scopes', () => {
    const member = new Set(['hosting:site:read', 'dns:read', 'dns:write', 'billing:manage']);
    const eff = effectivePermissions(member, ['hosting:site:read', 'hosting:site:update', 'dns:write']);
    expect([...eff].sort()).toEqual(['dns:write', 'hosting:site:read']);
    expect(permitted(eff, 'hosting:site:update')).toBe(false); // in the grant, not in the member's role
    expect(permitted(eff, 'dns:read')).toBe(false); // in the member's role, not in the grant
    expect(permitted(eff, 'billing:manage')).toBe(false);
    expect(permitted(eff, 'dns:write')).toBe(true);
    expect(effectivePermissions(new Set(), ['dns:read']).size).toBe(0);
  });
});
