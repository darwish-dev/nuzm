import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ApiError, createApi, unwrap, type Schemas } from '@nuzm/sdk';
import type { Locale } from '@nuzm/i18n';

export type Me = Schemas['Me'];
export const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

/** Only the admin realm's cookies are forwarded; web-realm cookies on a shared host never reach the admin API calls. */
const FORWARD = new Set(['nuzm_admin_session', 'nuzm_admin_csrf']);

export async function serverApi() {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .filter((c) => FORWARD.has(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return createApi({
    baseUrl: API_ORIGIN,
    getHeaders: () => ({ cookie }),
    credentials: 'omit',
    realm: 'admin',
  });
}

export interface Staff {
  me: Me;
  roles: string[];
  can: (permission: string) => boolean;
  api: Awaited<ReturnType<typeof serverApi>>;
}

/** Admin-realm gate: signed in (admin cookie) → MFA verified → holds at least one platform role. */
export async function requireStaff(locale: Locale): Promise<Staff> {
  const api = await serverApi();
  let me: Me;
  try {
    me = await unwrap(api.GET('/v1/me', {}));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect(`/${locale}/login`);
    if (e instanceof ApiError && e.code === 'mfa_required') redirect(`/${locale}/mfa-setup`);
    throw e;
  }
  const perms = new Set(me.platform?.permissions ?? []);
  return { me, roles: me.platform?.roles ?? [], can: (p) => perms.has(p), api };
}

/** Stream a file (CSV) from the API with the admin-realm session, for the download route handlers. API errors pass through as plain text. */
export async function apiDownload(path: string): Promise<Response> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .filter((c) => FORWARD.has(c.name))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const r = await fetch(`${API_ORIGIN}${path}`, {
    headers: { cookie, 'x-nuzm-realm': 'admin' },
    cache: 'no-store',
  });
  const headers = new Headers();
  for (const h of ['content-type', 'content-disposition'])
    if (r.headers.get(h)) headers.set(h, r.headers.get(h)!);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('cache-control', 'no-store');
  return new Response(r.ok ? r.body : r.statusText || 'unavailable', {
    status: r.status,
    headers: r.ok ? headers : new Headers({ 'content-type': 'text/plain; charset=utf-8' }),
  });
}
