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

/** Stream a binary document (PDF/XML) from the API with the caller's customer-realm session, for the download route handlers. */
export async function apiDownload(path: string, orgId: string | undefined): Promise<Response> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .filter((c) => FORWARD.has(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const r = await fetch(`${API_ORIGIN}${path}`, {
    headers: { cookie, 'x-nuzm-realm': 'web', ...(orgId ? { 'x-nuzm-org': orgId } : {}) },
    cache: 'no-store',
  });
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition'])
    if (r.headers.get(h)) headers.set(h, r.headers.get(h)!);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'no-store');
  // an API error (409 awaiting clearance, 404, 503 renderer) is passed through as a plain status, never as an HTML error page
  return new Response(r.ok ? r.body : r.statusText || 'unavailable', {
    status: r.status,
    headers: r.ok ? headers : new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
  });
}
