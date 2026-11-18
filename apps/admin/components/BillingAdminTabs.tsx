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
  const read = can('admin:billing:read');
  const tabs = [
    { key: 'ledger', href: `${base}/ledger`, show: read },
    { key: 'books', href: `${base}/price-books`, show: read },
    { key: 'plans', href: `${base}/plans`, show: read },
    { key: 'meters', href: `${base}/meters`, show: read },
    { key: 'adjustments', href: `${base}/adjustments`, show: read },
    { key: 'invoices', href: `${base}/invoices`, show: read },
    { key: 'payments', href: `${base}/payments`, show: read },
    { key: 'refunds', href: `${base}/refunds`, show: read },
    { key: 'reconciliations', href: `${base}/reconciliations`, show: read },
    { key: 'zatca', href: `${base}/zatca`, show: read },
    { key: 'submissions', href: `${base}/zatca/submissions`, show: read },
    { key: 'dunning', href: `${base}/dunning`, show: read },
    { key: 'reports', href: `${base}/revenue-reports`, show: can('admin:reports:read') },
  ] as const;
  const shown = tabs.filter((x) => x.show);
  if (shown.length === 0) return null;
  return (
    <nav aria-label={t(locale, 'abill.nav')} className="nz-row nz-subnav">
      {shown.map((x) => (
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
