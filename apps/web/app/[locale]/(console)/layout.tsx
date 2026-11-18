import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isLocale, locales, t, formatDateTime } from '@nuzm/i18n';
import { Banner, Ltr, LocaleSwitch, NavList, Shell } from '@nuzm/ui';
import { VerifyEmailBanner } from '../../../components/AuthForms';
import { ActiveOrgCookie, OrgSwitcher, SignOut } from '../../../components/ConsoleChrome';
import { ActingBanner } from '../../../components/ProgramsPanels';
import { CLOUD_FLAG, flagOn } from '../../../lib/compute';
import { FLAGS } from '../../../lib/m11';
import { actingOrgOf } from '../../../lib/m11-server';
import { requireSession } from '../../../lib/server';
import { flagEnabled } from '../../../lib/services';

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
  // M11: the client organization an agency member is acting in (UI-M11-13); the banner below is shown on every page while it is set
  const actingClient = await actingOrgOf(s);
  const on = (flag: string) => flagEnabled(s.me.featureFlags, flag);
  const gated = (perm: string, href: string, key: Parameters<typeof t>[1]) =>
    s.org && s.can(perm) ? [{ href: `${base}${href}`, label: t(locale, key) }] : [];
  const items = [
    { href: base, label: t(locale, 'nav.home') },
    ...(s.org ? [{ href: `${base}/notifications`, label: t(locale, 'nav.notifications') }] : []),
    ...gated('workspace:read', '/workspaces', 'nav.workspaces'),
    ...gated('project:read', '/projects', 'nav.projects'),
    ...gated('operation:read', '/operations', 'nav.operations'),
    ...gated('resource:read', '/resources', 'nav.resources'),
    // hosting is a flagged capability (`hosting.enabled`, default off); the API answers 404 while it is off
    ...(flagEnabled(s.me.featureFlags, 'hosting.enabled')
      ? gated('hosting:site:read', '/hosting/sites', 'nav.hosting')
      : []),
    ...gated('data:db:read', '/databases', 'm8.nav.databases'),
    ...gated('data:storage:read', '/storage/buckets', 'm8.nav.storage'),
    ...gated('email:read', '/email/domains', 'm8.nav.email'),
    // domains is a flagged capability (`domains.enabled`, default off)
    ...(flagEnabled(s.me.featureFlags, 'domains.enabled')
      ? gated('domain:read', '/domains', 'nav.domains')
      : []),
    ...(s.org && (s.can('billing:read') || s.can('usage:read'))
      ? [
          {
            href: `${base}/billing${s.can('billing:read') ? '' : '/usage'}`,
            label: t(locale, 'nav.billing'),
          },
        ]
      : []),
    ...gated('privacy:dsr:self', '/privacy/requests', 'nav.privacy'),
    // M05: compute entries only while `cloud.provisioning` is on for the organization AND the member holds the permission
    ...(flagOn(s.me.featureFlags, CLOUD_FLAG)
      ? [
          ...gated('offers:read', '/compute/offers', 'm05.web.nav.offers'),
          ...gated('compute:instance:read', '/compute/instances', 'm05.web.nav.instances'),
        ]
      : []),
    // M11: each entry is hidden unless its feature flag is on for the organization (as `domains.enabled` drives Domains) AND the member holds the permission
    ...(on(FLAGS.automation)
      ? [
          ...gated('automation:read', '/automation/workflows', 'm11.nav.workflows'),
          ...gated('connector:manage', '/automation/connectors', 'm11.nav.connectors'),
          ...gated('webhook:manage', '/settings/webhooks', 'm11.nav.webhooks'),
        ]
      : []),
    ...(on(FLAGS.marketplace)
      ? gated('marketplace:read', '/marketplace', 'm11.nav.marketplace')
      : []),
    ...(on(FLAGS.agency) || on(FLAGS.reseller)
      ? gated('partners:manage', '/settings/partners', 'm11.nav.partners')
      : []),
    ...gated('audit:read', '/audit-logs', 'nav.audit'),
    ...gated('member:read', '/settings/members', 'nav.members'),
    ...gated('member:invite', '/settings/invitations', 'nav.invitations'),
    ...gated('apikey:read', '/settings/api-keys', 'nav.apiKeys'),
    ...gated('org:update', '/settings/organization', 'nav.orgSettings'),
    { href: `${base}/account/sessions`, label: t(locale, 'nav.sessions') },
    { href: `${base}/account/security/mfa`, label: t(locale, 'nav.security') },
    { href: `${base}/account/security/password`, label: t(locale, 'nav.password') },
    { href: `${base}/account/security/recovery-codes`, label: t(locale, 'nav.recovery') },
    ...(s.org?.type === 'agency' && on(FLAGS.agency)
      ? [{ href: `${base}/agency`, label: t(locale, 'nav.agency') }]
      : []),
    ...(s.org?.type === 'reseller' && on(FLAGS.reseller)
      ? [{ href: `${base}/reseller`, label: t(locale, 'nav.reseller') }]
      : []),
  ].map((i) => ({
    ...i,
    // the Billing entry stays current on every billing sub-page
    current:
      path === i.href ||
      (i.href.includes('/compute/') ? path.startsWith(`${i.href}/`) : false) ||
      (i.href.endsWith('/billing') ? path.startsWith(`${i.href}/`) : false) ||
      (i.href.endsWith('/privacy/requests')
        ? path.includes('/privacy/') || path.endsWith('/settings/data-residency')
        : false) ||
      // managed data and email: every sub-page keeps its section entry current
      (i.href.endsWith('/databases') ? path.startsWith(i.href) : false) ||
      (i.href.endsWith('/storage/buckets') ? path.startsWith(`${base}/storage/`) : false) ||
      (i.href.endsWith('/email/domains') ? path.startsWith(`${base}/email/`) : false) ||
      // M11 sections keep their entry current on every sub-page
      (i.href.endsWith('/automation/workflows')
        ? path.startsWith(`${base}/automation/workflows`) ||
          path.startsWith(`${base}/automation/executions/`)
        : false) ||
      (i.href.endsWith('/marketplace') ? path.startsWith(`${base}/marketplace`) : false) ||
      (i.href.endsWith('/agency') ? path.startsWith(`${base}/agency`) : false) ||
      (i.href.endsWith('/reseller') ? path.startsWith(`${base}/reseller`) : false),
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
          {!s.me.emailVerified && !imp && <VerifyEmailBanner locale={locale} />}
          {s.org?.status === 'suspended' && (
            <Banner tone="warn">{t(locale, 'banner.suspended')}</Banner>
          )}
          {actingClient && <ActingBanner locale={locale} clientOrgId={actingClient} />}
        </>
      }
    >
      {s.org && <ActiveOrgCookie orgId={s.org.orgId} />}
      {children}
    </Shell>
  );
}
