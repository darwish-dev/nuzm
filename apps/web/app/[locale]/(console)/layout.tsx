import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, locales, t, tDynamic } from '@nuzm/i18n';
import {
  Banner,
  SectionTabs,
  Icon,
  PrimaryRail,
  type IconName,
  type RailItem,
  type SideGroup,
  type SideItem,
} from '@nuzm/ui';
import { BrandMark, BrandWordmark } from '../../../components/BrandLogo';
import { VerifyEmailPill } from '../../../components/AuthForms';
import { ActiveOrgCookie, OrgSwitcher } from '../../../components/ConsoleChrome';
import { ConsoleFrame, ProfileMenu, SupportToggle } from '../../../components/ConsoleShell';
import {
  SupportPanel,
  type SupportDocs,
  type SupportTopic,
} from '../../../components/SupportPanel';
import { StudioTransition } from '../../../components/StudioTransition';
import { GUIDES } from '../../../lib/docs-content';
import { REF } from '../../../lib/api-docs';
import { pick } from '../../../lib/site-content';
import { guideIcon } from '../../../lib/docs-icons';
import { FloatingCart } from '../../../components/FloatingCart';
import { NotificationsMenu } from '../../../components/NotificationsMenu';
import {
  buildNav,
  currentCategory,
  currentItemId,
  stripLocale,
  type ResolvedItem,
} from '../../../lib/nav';
import { ActingBanner } from '../../../components/ProgramsPanels';
import { actingOrgOf } from '../../../lib/m11-server';
import { requireSession } from '../../../lib/server';
import { flagEnabled } from '../../../lib/services';

const MENU_ICONS: Record<string, IconName> = {
  team: 'user',
  organization: 'organization',
  privacy: 'shield',
  agency: 'globe',
  reseller: 'globe',
};

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
  // M11: the client organization an agency member is acting in (UI-M11-13); the banner is shown on every page while it is set
  const actingClient = await actingOrgOf(s);
  const base = ''; // routes carry no language (the proxy rewrites to /<locale>/…)
  const path = stripLocale((await headers()).get('x-pathname') ?? '/console', locale);
  const theme = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';

  const cats = buildNav({
    can: s.can,
    flag: (k) => flagEnabled(s.me.featureFlags, k),
    hasOrg: Boolean(s.org),
    orgType: s.org?.type,
  });
  const active = currentCategory(cats, path);
  const activeCat = cats.find((c) => c.id === active) ?? cats[0]!;

  // wallet (needs billing:read), AI credits (needs ai:read and the AI flag) and the latest notifications: optional extras of the top bar
  const aiOn = Boolean(s.org) && s.can('ai:read') && flagEnabled(s.me.featureFlags, 'ai.enabled');
  const [balance, aiCredits, notifications] = await Promise.all([
    s.org && s.can('billing:read') ? safe(unwrap(s.api.GET('/v1/billing/balance', {}))) : null,
    aiOn ? safe(unwrap(s.api.GET('/v1/ai/credits', {}))) : null,
    s.org
      ? safe(unwrap(s.api.GET('/v1/notifications', { params: { query: { limit: 8 } } })))
      : null,
  ]);
  // an organization with no wallet movement yet has a zero balance: show the number, not a bare word
  const wallet = balance?.balances[0] ?? { balanceMinor: '0', currency: 'SAR' };
  const walletText = formatMinor(wallet.balanceMinor, wallet.currency, locale);
  // credits are a whole number that can exceed 2^53: format the digit string as BigInt, with the same digits as the wallet figure
  const aiRaw = aiCredits ? String(aiCredits.availableCredits) : null;
  const aiText =
    aiRaw !== null && /^-?\d+$/.test(aiRaw)
      ? new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US').format(BigInt(aiRaw))
      : null;

  // categories reached from the account menu (the account, the organization) are not on the rail
  const railItems: RailItem[] = cats
    .filter((c) => !c.menu && !c.noRail)
    .map((c) => ({
      id: c.id,
      href: c.home === '/' ? '/console' : c.home,
      label: t(locale, c.label),
      icon: c.icon,
      current: c.id === active,
    }));
  const toSide = (i: ResolvedItem, current: string | null): SideItem => ({
    id: i.id,
    label: t(locale, i.label),
    href: i.href ? (i.href === '/' ? '/console' : i.href) : undefined,
    current: i.id === current,
    children: i.children?.map((c) => toSide(c, current)),
  });
  const currentId = currentItemId(activeCat, path);
  const groups: SideGroup[] = (activeCat.menu || activeCat.noTabs ? [] : activeCat.groups).map(
    (g) => ({
      id: g.id,
      title: g.title ? t(locale, g.title) : undefined,
      items: g.items.map((i) => toSide(i, currentId)),
    }),
  );

  // the organization's pages, listed in the account menu
  const menuLinks = (cats.find((c) => c.id === 'organization')?.groups ?? [])
    .flatMap((g) => g.items)
    .filter((i) => i.href)
    .map((i) => ({
      href: i.href === '/' ? '/console' : (i.href ?? ''),
      label: t(locale, i.label),
      icon: MENU_ICONS[i.id] ?? ('organization' as const),
      current: currentId === i.id && activeCat.id === 'organization',
    }));

  // quick links of the support panel: the areas of the console this member can reach
  const topics: SupportTopic[] = cats
    .filter((c) => ['hosting', 'domains', 'cloud', 'email', 'finance', 'build'].includes(c.id))
    .map((c) => ({
      id: c.id,
      label: t(locale, c.label),
      href: c.home === '/' ? '/console' : c.home,
      icon: c.icon,
    }));
  // the support panel's Documentation tab: the website documentation's guides and API areas, opening their copy inside the console
  const supportDocs: SupportDocs = {
    home: '/documentation',
    guides: GUIDES.map((g) => ({
      href: `/documentation/guides/${g.slug}`,
      title: pick(g.title, locale),
      summary: pick(g.summary, locale),
      icon: guideIcon(g.slug),
    })),
    reference: REF.tags.map((x) => ({
      href: `/documentation/reference/${x.name}`,
      title: x.title,
    })),
    referenceHome: '/documentation/reference',
    endpoints: REF.counts.operations,
  };
  const imp = s.me.impersonation;
  const brand = (
    <a className="nzc-brandlink" href="/console" aria-label="Nuzm">
      <BrandWordmark className="nzc-logo-full" />
      <BrandMark className="nzc-logo-mark" />
    </a>
  );
  return (
    <>
      <ConsoleFrame
        labels={{
          openMenu: t(locale, 'nc.top.menu'),
          closeMenu: t(locale, 'nc.top.close'),
        }}
        brand={brand}
        support={{
          label: t(locale, 'sup.title'),
          content: <SupportPanel locale={locale} topics={topics} docs={supportDocs} />,
        }}
        rail={<PrimaryRail label={t(locale, 'nc.nav.rail')} items={railItems} />}
        tabs={<SectionTabs label={t(locale, 'nc.nav.side')} groups={groups} />}
        topbar={
          <>
            <span className="nzc-grow" />
            {!s.me.emailVerified && !imp && <VerifyEmailPill locale={locale} />}
            <span className="nzc-grow" />
            {s.org && (
              <OrgSwitcher
                label={t(locale, 'field.orgSwitcher')}
                current={s.org.orgId}
                orgs={s.me.memberships.map((m) => ({ orgId: m.orgId, name: m.name }))}
                workspacesHref={`${base}/settings/organization`}
                workspacesLabel={t(locale, 'nc.grp.organization')}
              />
            )}
            {s.org && s.can('billing:read') && (
              <a
                className="nzc-chip"
                href={`${base}/billing/payments#wallet`}
                aria-label={`${t(locale, 'nc.wallet')}: ${walletText}`}
                title={t(locale, 'nc.wallet')}
              >
                <Icon name="wallet" size={18} />
                <span className="nzc-num" dir="ltr">
                  {walletText}
                </span>
              </a>
            )}
            {aiText !== null && (
              <a
                className="nzc-chip"
                href={`${base}/ai/usage`}
                aria-label={`${t(locale, 'nc.aiCredits')}: ${aiText}`}
                title={t(locale, 'nc.aiCredits')}
              >
                <Icon name="sparkle" size={18} />
                <span className="nzc-num" dir="ltr">
                  {aiText}
                </span>
              </a>
            )}
            {s.org && notifications && (
              <NotificationsMenu
                viewAllHref={`${base}/notifications`}
                unreadCount={notifications.unreadCount}
                items={notifications.items.map((n) => ({
                  id: n.id,
                  text: tDynamic(
                    locale,
                    `notif.kind.${n.kind}`,
                    t(locale, 'notif.kind.unknown', { kind: n.kind }),
                    n.params as Record<string, string | number>,
                  ),
                  when: formatDateTime(n.createdAt, locale),
                  read: n.readAt !== null,
                }))}
                labels={{
                  menu: t(locale, 'nav.notifications'),
                  title: t(locale, 'notifications.title'),
                  empty: t(locale, 'state.empty.title'),
                  read: t(locale, 'action.markRead'),
                  unread: t(locale, 'action.markUnread'),
                  viewAll: t(locale, 'nc.notif.viewAll'),
                  error: t(locale, 'state.error.title'),
                }}
              />
            )}
            <SupportToggle label={t(locale, 'sup.open')} />
            <ProfileMenu
              initials={initialsOf(s.me.displayName, s.me.email)}
              name={s.me.displayName ?? s.me.email}
              email={s.me.email}
              locale={locale}
              languages={locales.map((l) => ({
                code: l,
                label: l === 'ar' ? 'العربية' : 'English',
              }))}
              theme={theme}
              labels={{
                menu: t(locale, 'nc.profile.menu'),
                profile: t(locale, 'nc.profile.open'),
                language: t(locale, 'nc.menu.language'),
                darkMode: t(locale, 'nc.menu.darkMode'),
                signOut: t(locale, 'action.signout'),
              }}
              profileHref={`${base}/account`}
              links={menuLinks}
              linksTitle={s.org ? s.org.name : undefined}
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
            {actingClient && <ActingBanner locale={locale} clientOrgId={actingClient} />}
          </>
        }
      >
        {s.org && <ActiveOrgCookie orgId={s.org.orgId} />}
        {children}
      </ConsoleFrame>
      <StudioTransition />
      {s.org && s.can('hosting:site:create') && (
        <FloatingCart locale={locale} orgId={s.org.orgId} />
      )}
    </>
  );
}
