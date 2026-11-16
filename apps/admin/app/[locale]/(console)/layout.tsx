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
    ...(s.can('admin:flags:manage')
      ? [{ href: `${base}/feature-flags`, label: t(locale, 'nav.admin.flags') }]
      : []),
  ].map((i) => ({ ...i, current: path === i.href }));
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
