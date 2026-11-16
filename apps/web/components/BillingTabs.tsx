import { t, type Locale } from '@nuzm/i18n';

/** Section links shared by every billing screen; only the sections the caller may open are listed. */
export function BillingTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: string;
  can: (permission: string) => boolean;
}) {
  const base = `/${locale}/billing`;
  const tabs = [
    { key: 'overview', href: base, perm: 'billing:read' },
    { key: 'plans', href: `${base}/plans`, perm: 'org:read' },
    { key: 'usage', href: `${base}/usage`, perm: 'usage:read' },
    { key: 'quotas', href: `${base}/quotas`, perm: 'usage:read' },
    { key: 'ledger', href: `${base}/ledger`, perm: 'billing:read' },
    { key: 'limits', href: `${base}/spending-limits`, perm: 'billing:read' },
    { key: 'approvals', href: `${base}/approvals`, perm: 'spend:request' },
  ] as const;
  return (
    <nav aria-label={t(locale, 'bill.nav')} className="nz-row">
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
            {t(locale, `bill.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}
