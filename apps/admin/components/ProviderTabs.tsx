import { t, type Locale } from '@nuzm/i18n';

/** Section links shared by the provider and cloud screens; only the sections the caller may open are listed. */
export function ProviderTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (permission: string) => boolean;
}) {
  const read = can('admin:provider:read');
  const tabs = [
    { key: 'registry', href: `/${locale}/providers`, show: read },
    { key: 'accounts', href: `/${locale}/providers/accounts`, show: read },
    { key: 'routing', href: `/${locale}/providers/routing`, show: read },
    { key: 'liveVerification', href: `/${locale}/providers/live-verification`, show: read },
    { key: 'resources', href: `/${locale}/cloud/resources`, show: read },
    { key: 'operations', href: `/${locale}/cloud/operations`, show: read },
    { key: 'costs', href: `/${locale}/finance/provider-costs`, show: read },
  ] as const;
  const shown = tabs.filter((x) => x.show);
  if (shown.length === 0) return null;
  return (
    <nav aria-label={t(locale, 'm05.adm.nav')} className="nz-row">
      {shown.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `m05.adm.tab.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
