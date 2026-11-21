import { t, type Locale } from '@nuzm/i18n';

export function DomainTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: 'list' | 'search' | 'transfers';
  can: (p: string) => boolean;
}) {
  const tabs = [
    { key: 'list', href: `/domains`, perm: 'domain:read' },
    { key: 'search', href: `/domains/search`, perm: 'domain:search' },
    { key: 'transfers', href: `/domains/transfers`, perm: 'domain:read' },
  ] as const;
  return (
    <nav aria-label={t(locale, 'dom.nav')} className="nz-row nz-subnav">
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
            {t(locale, `dom.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}
