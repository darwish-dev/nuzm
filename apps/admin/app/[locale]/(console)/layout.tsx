import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { isLocale, locales, t } from '@nuzm/i18n';
import {
  SectionTabs,
  ForbiddenState,
  PrimaryRail,
  type RailItem,
  type SideGroup,
  type SideItem,
} from '@nuzm/ui';
import { BrandMark, BrandWordmark } from '../../../components/BrandLogo';
import { ConsoleFrame, ProfileMenu } from '../../../components/ConsoleShell';
import {
  buildAdminNav,
  currentAdminCategory,
  currentItemId,
  stripLocale,
  type ResolvedAdminCategory,
} from '../../../lib/nav';
import { requireStaff } from '../../../lib/server';

const initialsOf = (name: string | null | undefined, email: string) => {
  const src = (name ?? '').trim() || email;
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '')).toUpperCase();
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
  const s = await requireStaff(locale);
  const base = `/${locale}`;
  const path = stripLocale((await headers()).get('x-pathname') ?? base, locale);
  const theme = (await cookies()).get('nuzm_theme')?.value === 'light' ? 'light' : 'dark';

  const cats = buildAdminNav(s.can);
  const active = cats.length > 0 ? currentAdminCategory(cats, path) : null;
  const activeCat: ResolvedAdminCategory | undefined = cats.find((c) => c.id === active) ?? cats[0];

  const railItems: RailItem[] = cats.map((c) => ({
    id: c.id,
    href: `${base}${c.home}`,
    label: t(locale, c.label),
    icon: c.icon,
    current: c.id === active,
  }));
  const toSide = (
    i: ResolvedAdminCategory['groups'][number]['items'][number],
    current: string | null,
  ): SideItem => ({
    id: i.id,
    label: t(locale, i.label),
    href: i.href ? `${base}${i.href}` : undefined,
    current: i.id === current,
    children: i.children?.map((c) => toSide(c, current)),
  });
  const currentId = activeCat ? currentItemId(activeCat, path) : null;
  const groups: SideGroup[] = (activeCat?.groups ?? []).map((g) => ({
    id: g.id,
    title: g.title ? t(locale, g.title) : undefined,
    items: g.items.map((i) => toSide(i, currentId)),
  }));

  const brand = (
    <a className="nzc-brandlink" href={base} aria-label="Nuzm">
      <BrandWordmark className="nzc-logo-full" />
      <BrandMark className="nzc-logo-mark" />
    </a>
  );
  return (
    <ConsoleFrame
      labels={{
        openMenu: t(locale, 'nc.top.menu'),
        closeMenu: t(locale, 'nc.top.close'),
      }}
      brand={brand}
      rail={<PrimaryRail label={t(locale, 'nc.nav.rail')} items={railItems} />}
      tabs={<SectionTabs label={t(locale, 'nc.nav.side')} groups={groups} />}
      topbar={
        <>
          <span className="nzc-chip" aria-label={t(locale, 'anc.staff')}>
            {t(locale, 'anc.staff')}
          </span>
          <span className="nzc-grow" />
          <ProfileMenu
            initials={initialsOf(s.me.displayName, s.me.email)}
            name={s.me.displayName ?? s.me.email}
            email={s.me.email}
            locale={locale}
            languages={locales.map((l) => ({ code: l, label: l === 'ar' ? 'العربية' : 'English' }))}
            theme={theme}
            labels={{
              menu: t(locale, 'nc.profile.menu'),
              language: t(locale, 'nc.menu.language'),
              darkMode: t(locale, 'nc.menu.darkMode'),
              signOut: t(locale, 'action.signout'),
            }}
            signedOutTo={`${base}/login`}
          />
        </>
      }
    >
      {s.roles.length === 0 ? (
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      ) : (
        children
      )}
    </ConsoleFrame>
  );
}
