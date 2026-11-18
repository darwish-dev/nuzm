import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isLocale, locales, t, formatDateTime } from '@nuzm/i18n';
import { Banner, Ltr, LocaleSwitch, NavList, Shell } from '@nuzm/ui';
import { ActiveOrgCookie, OrgSwitcher, SignOut } from '../../../components/ConsoleChrome';
import { requireSession } from '../../../lib/server';

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
  const path = (await headers()).get('x-pathname') ?? '';
  const base = `/${locale}`;
  const gated = (perm: string, href: string, key: Parameters<typeof t>[1]) =>
    s.org && s.can(perm) ? [{ href: `${base}${href}`, label: t(locale, key) }] : [];
  const items = [
    { href: base, label: t(locale, 'nav.home') },
    ...(s.org ? [{ href: `${base}/notifications`, label: t(locale, 'nav.notifications') }] : []),
    ...gated('workspace:read', '/workspaces', 'nav.workspaces'),
    ...gated('project:read', '/projects', 'nav.projects'),
    ...gated('operation:read', '/operations', 'nav.operations'),
    ...gated('resource:read', '/resources', 'nav.resources'),
    ...gated('domain:read', '/domains', 'nav.domains'),
    ...(s.org && (s.can('billing:read') || s.can('usage:read'))
      ? [
          {
            href: `${base}/billing${s.can('billing:read') ? '' : '/usage'}`,
            label: t(locale, 'nav.billing'),
          },
        ]
      : []),
    ...gated('privacy:dsr:self', '/privacy/requests', 'nav.privacy'),
    ...gated('audit:read', '/audit-logs', 'nav.audit'),
    ...gated('member:read', '/settings/members', 'nav.members'),
    ...gated('member:invite', '/settings/invitations', 'nav.invitations'),
    ...gated('apikey:read', '/settings/api-keys', 'nav.apiKeys'),
    ...gated('org:update', '/settings/organization', 'nav.orgSettings'),
    { href: `${base}/account/sessions`, label: t(locale, 'nav.sessions') },
    { href: `${base}/account/security/mfa`, label: t(locale, 'nav.security') },
    { href: `${base}/account/security/recovery-codes`, label: t(locale, 'nav.recovery') },
    ...(s.org?.type === 'agency'
      ? [{ href: `${base}/agency`, label: t(locale, 'nav.agency') }]
      : []),
    ...(s.org?.type === 'reseller'
      ? [{ href: `${base}/reseller`, label: t(locale, 'nav.reseller') }]
      : []),
  ].map((i) => ({
    ...i,
    // the Billing entry stays current on every billing sub-page
    current:
      path === i.href ||
      (i.href.endsWith('/billing') ? path.startsWith(`${i.href}/`) : false) ||
      (i.href.endsWith('/privacy/requests')
        ? path.includes('/privacy/') || path.endsWith('/settings/data-residency')
        : false),
  }));
  const imp = s.me.impersonation;
  return (
    <Shell
      brand={
        <a className="nz-brand" href={base}>
          {locale === 'ar' ? 'نظم' : 'Nuzm'}
        </a>
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
          <LocaleSwitch
            current={locale}
            locales={[...locales]}
            labels={{ ar: 'العربية', en: 'English' }}
          />
          <Ltr>{s.me.email}</Ltr>
          <SignOut label={t(locale, 'action.signout')} to={`/${locale}/login`} />
        </>
      }
      nav={<NavList items={items} />}
      navLabel={t(locale, 'nav.primary')}
      skipLabel={t(locale, 'app.skip')}
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
    </Shell>
  );
}
