import { t, type Locale } from '@nuzm/i18n';

/** Section links of the hosting admin screens (UI-M06-11..15). */
export function HostingAdminTabs({ locale, current }: { locale: Locale; current: string }) {
  const base = `/${locale}/hosting`;
  const tabs = [
    { key: 'nodes', href: `${base}/nodes` },
    { key: 'sites', href: `${base}/sites` },
    { key: 'abuse', href: `${base}/abuse` },
  ] as const;
  return (
    <nav aria-label={t(locale, 'nav.admin.hosting')} className="nz-row nz-subnav">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `host.admin.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
