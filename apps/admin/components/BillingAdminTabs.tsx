import { t, type Locale } from '@nuzm/i18n';

export function BillingAdminTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (p: string) => boolean;
}) {
  const base = `/${locale}/billing`;
  const tabs = [
    { key: 'ledger', href: `${base}/ledger` },
    { key: 'books', href: `${base}/price-books` },
    { key: 'plans', href: `${base}/plans` },
    { key: 'meters', href: `${base}/meters` },
    { key: 'adjustments', href: `${base}/adjustments` },
  ] as const;
  if (!can('admin:billing:read')) return null;
  return (
    <nav aria-label={t(locale, 'abill.nav')} className="nz-row">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {t(locale, `abill.tab.${x.key}`)}
        </a>
      ))}
    </nav>
  );
}
