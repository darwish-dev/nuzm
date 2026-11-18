import { t, type Locale } from '@nuzm/i18n';
import { LinkTabs } from './M11Parts';

/** Section tabs of the marketplace screens: browse, purchases (buyers), publisher dashboard (members who may publish). */
export function MarketplaceTabs({
  locale,
  current,
  publisher,
}: {
  locale: Locale;
  current: 'browse' | 'purchases' | 'publisher';
  publisher: boolean;
}) {
  return (
    <LinkTabs
      locale={locale}
      label={t(locale, 'm11.mkt.tabs')}
      current={current}
      tabs={[
        { id: 'browse', href: '/marketplace', label: 'm11.mkt.title' },
        { id: 'purchases', href: '/marketplace/purchases', label: 'm11.pur.title' },
        ...(publisher
          ? [{ id: 'publisher', href: '/marketplace/publisher', label: 'm11.pub.title' as const }]
          : []),
      ]}
    />
  );
}
