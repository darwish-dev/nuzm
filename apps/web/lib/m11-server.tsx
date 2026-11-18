import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { EmptyState, ErrorState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { FeatureOff } from '../components/M11Parts';
import { ACTING_COOKIE, isUuid, itemsOf, type AgencyDto, type ResellerDto } from './m11';
import { requireSession, type Session } from './server';
import { flagEnabled } from './services';

/**
 * The client organization an agency member is acting in (UI-M11-13), from the `nuzm_acting_org` cookie. The cookie is only a hint: the API re-validates the link, the grant and its
 * expiry on every request that carries `X-Nuzm-Acting-Org`, and answers 403 otherwise. Only an agency organization can be acting.
 */
export async function actingOrgOf(s: Session): Promise<string | undefined> {
  if (s.org?.type !== 'agency') return undefined;
  const v = (await cookies()).get(ACTING_COOKIE)?.value;
  return v && isUuid(v) ? v.toLowerCase() : undefined;
}

export interface GateOptions {
  /** Any one of these permissions opens the page. */
  permission: string | string[];
  title: MessageKey;
  /** The page shows its "feature is off" state while none of these flags is on for the organization. */
  flag?: string | string[];
  /** Agency or reseller screens: the active organization must be of this type. */
  orgType?: 'agency' | 'reseller';
}

/** Page entry of the M11 screens: locale, session, permission, organization type and feature flag. Anything missing is a state (forbidden / feature off), never a blank page. */
export async function gateM11(
  params: Promise<{ locale: string }>,
  o: GateOptions,
): Promise<{ ok: true; locale: Locale; s: Session } | { ok: false; node: ReactNode }> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const perms = Array.isArray(o.permission) ? o.permission : [o.permission];
  const wrap = (node: ReactNode) => (
    <>
      <PageTitle>{t(locale, o.title)}</PageTitle>
      {node}
    </>
  );
  if (!s.org || !perms.some((p) => s.can(p)) || (o.orgType && s.org.type !== o.orgType))
    return {
      ok: false,
      node: wrap(
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />,
      ),
    };
  const flags = o.flag === undefined ? [] : Array.isArray(o.flag) ? o.flag : [o.flag];
  if (flags.length > 0 && !flags.some((f) => flagEnabled(s.me.featureFlags, f)))
    return { ok: false, node: wrap(<FeatureOff locale={locale} />) };
  return { ok: true, locale, s };
}

/** Like `view`, plus the M11 states: feature off (403 `feature_disabled`) and not found (404). */
export async function m11View<T>(
  locale: Locale,
  load: () => Promise<T>,
  render: (data: T) => ReactNode,
): Promise<ReactNode> {
  try {
    return render(await load());
  } catch (e) {
    if (e instanceof ApiError && e.code === 'feature_disabled')
      return <FeatureOff locale={locale} />;
    if (e instanceof ApiError && e.code === 'org_suspended')
      return (
        <ForbiddenState
          title={t(locale, 'state.suspended.title')}
          body={t(locale, 'state.suspended.body')}
        />
      );
    if (e instanceof ApiError && e.isForbidden)
      return (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      );
    if (e instanceof ApiError && e.isNotFound)
      return (
        <EmptyState
          title={t(locale, 'm11.state.notFound.title')}
          body={t(locale, 'm11.state.notFound.body')}
        />
      );
    const trace = e instanceof ApiError ? e.traceId : undefined;
    return (
      <ErrorState
        title={t(locale, 'state.error.title')}
        body={t(locale, 'state.error.body')}
        detail={trace ? t(locale, 'state.error.trace', { traceId: trace }) : undefined}
      />
    );
  }
}

/** The `header` parameter that makes a delegable call act in the client organization (undefined = the caller's own organization). */
export const actingHeader = (acting: string | undefined) => ({ 'X-Nuzm-Acting-Org': acting });

/** The agency profile of the active organization (`role: agency`), or null when the organization has none yet. */
export async function agencyOf(s: Session): Promise<AgencyDto | null> {
  const page = await unwrap(s.api.GET('/v1/agencies', {}));
  return itemsOf<AgencyDto>(page).find((a) => a.role === 'agency') ?? null;
}
/** The reseller profile of the active organization (`role: reseller`), or null when it has none yet. */
export async function resellerOf(s: Session): Promise<ResellerDto | null> {
  const page = await unwrap(s.api.GET('/v1/resellers', {}));
  return itemsOf<ResellerDto>(page).find((r) => r.role === 'reseller') ?? null;
}
