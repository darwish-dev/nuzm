import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, locales, t } from '@nuzm/i18n';
import {
  Banner,
  ContextSidebar,
  Icon,
  PrimaryRail,
  type RailItem,
  type SideGroup,
  type SideItem,
} from '@nuzm/ui';
import { BrandMark, BrandWordmark } from '../../../components/BrandLogo';
import { VerifyEmailPill } from '../../../components/AuthForms';
import { ActiveOrgCookie, OrgSwitcher } from '../../../components/ConsoleChrome';
import { ConsoleFrame, ProfileMenu } from '../../../components/ConsoleShell';
import {
  buildNav,
  currentCategory,
  currentItemId,
  stripLocale,
  type ResolvedItem,
} from '../../../lib/nav';
import { requireSession } from '../../../lib/server';
import { flagEnabled } from '../../../lib/services';

const initialsOf = (name: string | null | undefined, email: string) => {
  const src = (name ?? '').trim() || email;
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '')).toUpperCase();
};

/** A figure that is unavailable to this role or fails to load is left out of the top bar, never faked. */
const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const base = `/${locale}`;
  const path = stripLocale((await headers()).get('x-pathname') ?? base, locale);
  const theme = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';

  const cats = buildNav({
    can: s.can,
    flag: (k) => flagEnabled(s.me.featureFlags, k),
    hasOrg: Boolean(s.org),
    orgType: s.org?.type,
  });
  const active = currentCategory(cats, path);
  const activeCat = cats.find((c) => c.id === active) ?? cats[0]!;

  // wallet (needs billing:read) and unread notifications, both optional extras of the top bar
  const [balance, unread] = await Promise.all([
    s.org && s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/balance', {}))) : null,
    s.org
      ? safe(unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 1 } } })))
      : null,
  ]);
  const wallet = balance?.balances[0] ?? null;

  const railItems: RailItem[] = cats
    .filter((c) => c.id !== 'account')
    .map((c) => ({
      id: c.id,
      href: `${base}${c.home === '/' ? '' : c.home}`,
      label: t(locale, c.label),
      icon: c.icon,
      current: c.id === active,
    }));
  const toSide = (i: ResolvedItem, current: string | null): SideItem => ({
    id: i.id,
    label: t(locale, i.label),
    href: i.href ? `${base}${i.href === '/' ? '' : i.href}` : undefined,
    current: i.id === current,
    children: i.children?.map((c) => toSide(c, current)),
  });
  const currentId = currentItemId(activeCat, path);
  const groups: SideGroup[] = activeCat.groups.map((g) => ({
    id: g.id,
    title: g.title ? t(locale, g.title) : undefined,
    items: g.items.map((i) => toSide(i, currentId)),
  }));

  const imp = s.me.impersonation;
  const brand = (
    <a className="nzc-brandlink" href={base} aria-label="Nuzm">
      <BrandWordmark className="nzc-logo-full" />
      <BrandMark className="nzc-logo-mark" />
    </a>
  );
  const unreadCount = unread?.unreadCount ?? 0;
  return (
    <ConsoleFrame
      labels={{
        toggle: t(locale, 'nc.top.toggle'),
        openMenu: t(locale, 'nc.top.menu'),
        closeMenu: t(locale, 'nc.top.close'),
      }}
      brand={brand}
      rail={<PrimaryRail label={t(locale, 'nc.nav.rail')} items={railItems} />}
      side={
        <ContextSidebar
          title={t(locale, activeCat.title)}
          label={t(locale, 'nc.nav.side')}
          groups={groups}
        />
      }
      topbar={
        <>
          {s.org && (
            <OrgSwitcher
              label={t(locale, 'field.orgSwitcher')}
              current={s.org.orgId}
              orgs={s.me.memberships.map((m) => ({ orgId: m.orgId, name: m.name }))}
            />
          )}
          <span className="nzc-grow" />
          {!s.me.emailVerified && !imp && <VerifyEmailPill locale={locale} />}
          <span className="nzc-grow" />
          {s.org && s.can('billing:read') && (
            <a
              className="nzc-chip"
              href={`${base}/billing/wallet`}
              aria-label={
                wallet
                  ? `${t(locale, 'nc.wallet')}: ${formatMinor(wallet.balanceMinor, wallet.currency, locale)}`
                  : t(locale, 'nc.wallet')
              }
            >
              <Icon name="wallet" size={18} />
              <span className="nzc-num" dir="ltr">
                {wallet
                  ? formatMinor(wallet.balanceMinor, wallet.currency, locale)
                  : t(locale, 'nc.wallet.empty')}
              </span>
            </a>
          )}
          {s.org && (
            <a
              className="nzc-icon-btn"
              href={`${base}/notifications`}
              aria-label={
                unreadCount > 0
                  ? `${t(locale, 'nav.notifications')} (${unreadCount})`
                  : t(locale, 'nav.notifications')
              }
              aria-current={path === '/notifications' ? 'page' : undefined}
            >
              <Icon name="bell" />
              {unreadCount > 0 && (
                <span className="nzc-dot" aria-hidden="true">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </a>
          )}
          <ProfileMenu
            initials={initialsOf(s.me.displayName, s.me.email)}
            name={s.me.displayName ?? s.me.email}
            email={s.me.email}
            locale={locale}
            languages={locales.map((l) => ({ code: l, label: l === 'ar' ? 'العربية' : 'English' }))}
            theme={theme}
            labels={{
              menu: t(locale, 'nc.profile.menu'),
              profile: t(locale, 'nc.profile.open'),
              language: t(locale, 'nc.menu.language'),
              darkMode: t(locale, 'nc.menu.darkMode'),
              signOut: t(locale, 'action.signout'),
            }}
            profileHref={`${base}/account`}
            signedOutTo={`${base}/login`}
          />
        </>
      }
      banner={
        <>
          {imp && (
            <Banner tone="danger">
              {t(locale, 'banner.impersonating', {
                email: s.me.email,
                time: imp.expiresAt ? formatDateTime(imp.expiresAt, locale) : '',
              })}
            </Banner>
          )}
          {s.org?.status === 'suspended' && (
            <Banner tone="warn">{t(locale, 'banner.suspended')}</Banner>
          )}
        </>
      }
    >
      {s.org && <ActiveOrgCookie orgId={s.org.orgId} />}
      {children}
    </ConsoleFrame>
  );
}
