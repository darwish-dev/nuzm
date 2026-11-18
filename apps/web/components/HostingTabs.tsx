import { t, type Locale } from '@nuzm/i18n';

/** Section links of one hosting site (UI-M06-04..09). */
export function HostingTabs({
  locale,
  siteId,
  current,
}: {
  locale: Locale;
  siteId: string;
  current: string;
}) {
  const base = `/${locale}/hosting/sites/${siteId}`;
  const tabs = [
    { key: 'overview', href: base },
    { key: 'domains', href: `${base}/domains` },
    { key: 'ssl', href: `${base}/ssl` },
    { key: 'databases', href: `${base}/databases` },
    { key: 'backups', href: `${base}/backups` },
    { key: 'usage', href: `${base}/usage` },
  ] as const;
  return (
    <nav aria-label={t(locale, 'host.title.sites')} className="nz-row nzc-subtabs">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `host.tab.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
