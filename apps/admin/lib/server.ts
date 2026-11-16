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
