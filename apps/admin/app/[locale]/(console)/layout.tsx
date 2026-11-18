import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isLocale, locales, t } from '@nuzm/i18n';
import { ForbiddenState, Ltr, LocaleSwitch, NavList, Shell } from '@nuzm/ui';
import { SignOut } from '../../../components/SignOut';
import { requireStaff } from '../../../lib/server';

export default async function ConsoleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const path = (await headers()).get('x-pathname') ?? '';
  const base = `/${locale}`;
  const items = [
    ...(s.can('admin:org:read')
      ? [{ href: `${base}/organizations`, label: t(locale, 'nav.admin.orgs') }]
      : []),
    ...(s.can('admin:user:read')
      ? [{ href: `${base}/users`, label: t(locale, 'nav.admin.users') }]
      : []),
    ...(s.can('admin:audit:read')
      ? [{ href: `${base}/audit-logs`, label: t(locale, 'nav.admin.audit') }]
      : []),
    ...(s.can('admin:billing:read')
      ? [{ href: `${base}/billing/ledger`, label: t(locale, 'nav.admin.billing') }]
      : []),
    ...(s.can('admin:compliance:read')
      ? [{ href: `${base}/compliance/controls`, label: t(locale, 'nav.admin.compliance') }]
      : []),
    ...(s.can('admin:hosting:read')
      ? [{ href: `${base}/hosting/nodes`, label: t(locale, 'nav.admin.hosting') }]
      : []),
    ...(s.can('admin:data:read')
      ? [{ href: `${base}/data/providers`, label: t(locale, 'm8.nav.admin.providers') }]
      : []),
    ...(s.can('admin:domains:read')
      ? [{ href: `${base}/domains/registrars`, label: t(locale, 'nav.admin.domains') }]
      : []),
    // M11: marketplace moderation, agencies and resellers, automation abuse (BLOCKED states where the list routes are not approved yet: SCR-M11-05)
    ...(s.can('admin:marketplace')
      ? [{ href: `${base}/marketplace/moderation`, label: t(locale, 'm11.nav.admin.moderation') }]
      : []),
    ...(s.can('admin:org:read') || s.can('admin:programs')
      ? [{ href: `${base}/programs`, label: t(locale, 'm11.nav.admin.programs') }]
      : []),
    ...(s.can('admin:automation') || s.can('admin:ops')
      ? [{ href: `${base}/automation/abuse`, label: t(locale, 'm11.nav.admin.abuse') }]
      : []),
    ...(s.can('admin:flags:manage')
      ? [{ href: `${base}/feature-flags`, label: t(locale, 'nav.admin.flags') }]
      : []),
    // M05: providers, routing, cloud inventory and provider costs (the sections are reachable from the provider tabs)
    ...(s.can('admin:provider:read')
      ? [{ href: `${base}/providers`, label: t(locale, 'nav.admin.providers') }]
      : []),
  ].map((i) => ({
    ...i,
    current:
      path === i.href ||
      (i.href.endsWith('/billing/ledger') && path.includes('/billing/')) ||
      (i.href.endsWith('/compliance/controls') && path.includes('/compliance/')) ||
      (i.href.endsWith('/domains/registrars') && path.includes('/domains/')) ||
      (i.href.endsWith('/providers') &&
        (path.startsWith(`${i.href}/`) ||
          path.startsWith(`${base}/cloud/`) ||
          path.startsWith(`${base}/finance/`))) ||
      (i.href.endsWith('/hosting/nodes') && path.includes('/hosting/')),
  }));
  return (
    <Shell
      brand={
        <a className="nz-brand" href={base}>
          {t(locale, 'app.admin.title')}
        </a>
      }
      topbar={
        <>
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
    >
      {s.roles.length === 0 ? (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      ) : (
        children
      )}
    </Shell>
  );
}
