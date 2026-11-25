/**
 * P3-S05 generation options of the full-stack scaffold. They are options of the GENERATOR (not fields of the approved application spec, which belongs to the builder core), and they are
 * recorded in `nuzm.app.json` so that a rebuild produces the same bytes. The defaults reproduce the Phase 2 scaffold exactly (single tenant, no public sign-up).
 */
export interface FullStackOptions {
  /** `multi`: tenant column + PostgreSQL row-level security on every table, sign-up creates an organisation. Default `single`. */
  tenancy?: 'single' | 'multi';
  /**
   * Role given to a self-registered user. `undefined` = public sign-up off (Phase 2 behaviour). `'auto'` = the least-privileged non-administrator role (single tenant) or the first
   * administrator role (multi-tenant: the person who registers an organisation administers it). A named role must exist; in a single-tenant app it must not be an administrator role.
   */
  signupRole?: string | 'auto';
}
import type { AppSpec } from '../spec/app-spec';

export interface ResolvedAuth {
  signupRole: string | null;
  tenancy: 'single' | 'multi';
}

/** Applies the options to a spec: picks the sign-up role and refuses unsafe combinations. Pure. */
export function resolveAuth(spec: AppSpec, o: FullStackOptions = {}): ResolvedAuth {
  const tenancy = o.tenancy ?? 'single';
  if (tenancy !== 'single' && tenancy !== 'multi')
    throw new Error('tenancy must be single or multi');
  if (tenancy === 'multi')
    for (const e of spec.entities)
      for (const f of e.fields)
        if (f.name === 'tenantId' || f.name === 'tenant')
          throw new Error(
            `${e.name}.${f.name} collides with the tenant column of a multi-tenant app`,
          );
  if (o.signupRole === undefined) {
    if (tenancy === 'multi')
      throw new Error(
        'a multi-tenant app needs public sign-up (an organisation is created by registering): set signupRole',
      );
    return { signupRole: null, tenancy };
  }
  const admins = spec.roles.filter((r) => r.admin);
  if (o.signupRole === 'auto') {
    if (tenancy === 'multi') {
      const first = admins[0];
      if (!first) throw new Error('the spec has no administrator role');
      return { signupRole: first.name, tenancy };
    }
    // least privilege: no administrator, narrowest scope (own < team < all), then the fewest permissions
    const rank = { own: 0, team: 1, all: 2 } as const;
    const count = (r: AppSpec['roles'][number]) =>
      Object.values(r.permissions).reduce((n, a) => n + a.length, 0);
    const pick = spec.roles
      .filter((r) => !r.admin)
      .sort(
        (a, b) =>
          rank[a.scope] - rank[b.scope] || count(a) - count(b) || a.name.localeCompare(b.name),
      )[0];
    if (!pick)
      throw new Error('the spec has no non-administrator role to give to a self-registered user');
    return { signupRole: pick.name, tenancy };
  }
  const role = spec.roles.find((r) => r.name === o.signupRole);
  if (!role) throw new Error('signupRole is not a role of the spec');
  if (tenancy === 'single' && role.admin)
    throw new Error(
      'a single-tenant app must not give self-registered users an administrator role',
    );
  if (tenancy === 'multi' && !role.admin)
    throw new Error(
      'in a multi-tenant app the person who registers an organisation administers it: signupRole must be an administrator role',
    );
  return { signupRole: role.name, tenancy };
}
