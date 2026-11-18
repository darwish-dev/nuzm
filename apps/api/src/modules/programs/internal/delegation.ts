/**
 * Pure rules of delegated access (M11 S54). An agency gets scoped, time-boxed ACCESS to a client organization; it never gets a client USER's identity (there is no impersonation here).
 *   effective permissions = intersection(the agency MEMBER's role permissions, the grant's scopes)
 * and a grant may only carry scopes from the DELEGABLE catalogue AND that the accepting client administrator holds themselves (a grant never exceeds its granter).
 */
export const DELEGABLE_SCOPES = [
  'automation:read',
  'automation:write',
  'automation:run',
  'hosting:site:read',
  'hosting:site:create',
  'hosting:site:update',
  'hosting:backup:read',
  'hosting:backup:create',
  'hosting:domain:manage',
  'hosting:ssl:manage',
  'hosting:plan:read',
  'domain:read',
  'domain:search',
  'dns:read',
  'dns:write',
  'project:read',
  'workspace:read',
  'resource:read',
  'usage:read',
  'email:read',
  'offers:read',
  'quote:read',
  'marketplace:read',
  'operation:read',
] as const;
/** Permissions that can NEVER be delegated (documented so the exclusion is a decision, not an omission). */
export const NEVER_DELEGABLE_PREFIXES = [
  'billing:',
  'member:',
  'apikey:',
  'org:',
  'privacy:',
  'audit:',
  'agency:',
  'reseller:',
  'partners:',
  'marketplace:buy',
  'marketplace:publish',
  'spend:',
  'data:',
  'compute:',
  'connector:',
  'webhook:',
] as const;
export const MAX_GRANT_DAYS = 365;
export const DEFAULT_GRANT_DAYS = 90;
export const MIN_GRANT_MINUTES = 15;

export interface GrantRequest {
  scopes: unknown;
  expiresAt: unknown;
}
export type GrantCheck =
  | { ok: true; scopes: string[]; expiresAt: Date }
  | {
      ok: false;
      code:
        | 'scopes_invalid'
        | 'scopes_not_delegable'
        | 'scopes_exceed_grantable'
        | 'expiry_missing'
        | 'expiry_invalid'
        | 'expiry_too_far';
      detail: string;
    };

export function validateGrant(
  req: GrantRequest,
  now: Date,
  grantable?: ReadonlySet<string>,
): GrantCheck {
  if (
    !Array.isArray(req.scopes) ||
    req.scopes.length < 1 ||
    req.scopes.length > 60 ||
    req.scopes.some((s) => typeof s !== 'string')
  )
    return { ok: false, code: 'scopes_invalid', detail: 'scopes must be 1..60 permission names' };
  const scopes = [...new Set(req.scopes as string[])];
  const notDelegable = scopes.filter((s) => !(DELEGABLE_SCOPES as readonly string[]).includes(s));
  if (notDelegable.length > 0)
    return {
      ok: false,
      code: 'scopes_not_delegable',
      detail: `not delegable: ${notDelegable.join(', ')}`,
    };
  if (grantable) {
    const over = scopes.filter(
      (s) => !(grantable.has(s) || grantable.has('*') || grantable.has(`${s.split(':')[0]}:*`)),
    );
    if (over.length > 0)
      return {
        ok: false,
        code: 'scopes_exceed_grantable',
        detail: `the client administrator does not hold: ${over.join(', ')}`,
      };
  }
  if (req.expiresAt === undefined || req.expiresAt === null || req.expiresAt === '')
    return { ok: false, code: 'expiry_missing', detail: 'expiresAt is mandatory' };
  const t = new Date(String(req.expiresAt));
  if (typeof req.expiresAt !== 'string' || Number.isNaN(t.getTime()))
    return { ok: false, code: 'expiry_invalid', detail: 'expiresAt must be an RFC 3339 timestamp' };
  if (t.getTime() < now.getTime() + MIN_GRANT_MINUTES * 60_000)
    return {
      ok: false,
      code: 'expiry_invalid',
      detail: `expiresAt must be at least ${MIN_GRANT_MINUTES} minutes in the future`,
    };
  if (t.getTime() > now.getTime() + MAX_GRANT_DAYS * 86_400_000)
    return {
      ok: false,
      code: 'expiry_too_far',
      detail: `expiresAt is at most ${MAX_GRANT_DAYS} days away`,
    };
  return { ok: true, scopes, expiresAt: t };
}

const covers = (set: ReadonlySet<string> | readonly string[], needed: string) => {
  const s = set instanceof Set ? set : new Set(set as readonly string[]);
  const i = needed.indexOf(':');
  return s.has(needed) || s.has('*') || (i > 0 && s.has(`${needed.slice(0, i)}:*`));
};
/** The effective permission set of an agency member acting under a grant. Anything outside either side is absent. */
export function effectivePermissions(
  memberPermissions: ReadonlySet<string>,
  grantScopes: readonly string[],
): Set<string> {
  return new Set(grantScopes.filter((s) => covers(memberPermissions, s)));
}
export const permitted = (effective: ReadonlySet<string>, needed: string) =>
  covers(effective, needed);
