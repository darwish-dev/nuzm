import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, createApi, unwrap, type Schemas } from '@nuzm/sdk';
import type { Locale } from '@nuzm/i18n';

export type Me = Schemas['Me'];
export const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';
export const ORG_COOKIE = 'nuzm_org';

/** Only the customer realm's cookies are forwarded: an admin-realm cookie on a shared host must never reach this app's API calls. */
const FORWARD = new Set(['nuzm_session', 'nuzm_csrf']);

export async function serverApi(orgId?: string) {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .filter((c) => FORWARD.has(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return createApi({
    baseUrl: API_ORIGIN,
    getHeaders: () => ({ cookie }),
    getOrg: () => orgId,
    credentials: 'omit',
    realm: 'web',
  });
}

export interface Session {
  me: Me;
  /** Active organization membership, or null when the user belongs to none yet. */
  org: Me['memberships'][number] | null;
  permissions: ReadonlySet<string>;
  can: (permission: string) => boolean;
  api: Awaited<ReturnType<typeof serverApi>>;
}

/**
 * The signed-in user plus the active organization. The org cookie is only a hint: it is honoured when it names
 * one of the user's memberships (the API re-verifies membership on every call anyway).
 */
export async function requireSession(locale: Locale, returnTo?: string): Promise<Session> {
  const jar = await cookies();
  const hint = jar.get(ORG_COOKIE)?.value;
  const anon = await serverApi();
  let me: Me;
  try {
    me = await unwrap(anon.GET('/v1/me', {}));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401)
      redirect(`/${locale}/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
    throw e;
  }
  const org =
    me.memberships.find((m) => m.orgId === hint) ??
    me.memberships.find((m) => m.status === 'active') ??
    me.memberships[0] ??
    null;
  const api = await serverApi(org?.orgId);
  const scoped = org ? await unwrap(api.GET('/v1/me', {})) : me;
  const permissions = new Set(scoped.permissions);
  return { me: scoped, org, permissions, can: (p) => permissions.has(p), api };
}
