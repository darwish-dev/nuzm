import { t, type Locale } from '@nuzm/i18n';
import { LinkTabs } from './M11Parts';

/** Section tabs of the agency portal. */
export function AgencyTabs({
  locale,
  current,
}: {
  locale: Locale;
  current: 'dashboard' | 'clients' | 'billing';
}) {
  return (
    <LinkTabs
      locale={locale}
      label={t(locale, 'm11.ag.tabs')}
      current={current}
      tabs={[
        { id: 'dashboard', href: '/agency', label: 'm11.ag.title' },
        { id: 'clients', href: '/agency/clients', label: 'm11.ag.clients.title' },
        { id: 'billing', href: '/agency/billing', label: 'm11.ag.billing.title' },
      ]}
    />
  );
}

/** Section tabs of the reseller portal. */
export function ResellerTabs({
  locale,
  current,
}: {
  locale: Locale;
  current: 'dashboard' | 'subs' | 'pricing' | 'statements';
}) {
  return (
    <LinkTabs
      locale={locale}
      label={t(locale, 'm11.rs.tabs')}
      current={current}
      tabs={[
        { id: 'dashboard', href: '/reseller', label: 'm11.rs.title' },
        { id: 'subs', href: '/reseller/sub-organizations', label: 'm11.rs.subs.title' },
        { id: 'pricing', href: '/reseller/pricing', label: 'm11.pr.title' },
        { id: 'statements', href: '/reseller/statements', label: 'm11.st.title' },
      ]}
    />
  );
}
