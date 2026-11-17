import { t, type Locale } from '@nuzm/i18n';

/** Section links shared by the privacy screens; residency is listed for anyone who can read it. */
export function PrivacyTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (permission: string) => boolean;
}) {
  const tabs = [
    { key: 'consents', href: `/${locale}/privacy/consents`, perm: 'privacy:consent:self' },
    { key: 'requests', href: `/${locale}/privacy/requests`, perm: 'privacy:dsr:self' },
    { key: 'exports', href: `/${locale}/privacy/exports`, perm: 'privacy:export:manage' },
    {
      key: 'residency',
      href: `/${locale}/settings/data-residency`,
      perm: 'privacy:residency:read',
    },
  ] as const;
  return (
    <nav aria-label={t(locale, 'pv.nav')} className="nz-row">
      {tabs
        .filter((x) => can(x.perm))
        .map((x) => (
          <a
            key={x.key}
            className="nz-btn"
            data-variant={x.key === current ? 'primary' : 'secondary'}
            href={x.href}
            aria-current={x.key === current ? 'page' : undefined}
          >
            {t(locale, `pv.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}
