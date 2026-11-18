import { t, type Locale } from '@nuzm/i18n';
import { LinkTabs } from './M11Parts';

/** Section tabs of the automation screens (workflows, connectors, outbound webhooks). */
export function AutomationTabs({
  locale,
  current,
}: {
  locale: Locale;
  current: 'workflows' | 'connectors' | 'webhooks';
}) {
  return (
    <LinkTabs
      locale={locale}
      label={t(locale, 'm11.auto.tabs')}
      current={current}
      tabs={[
        { id: 'workflows', href: '/automation/workflows', label: 'm11.wf.title' },
        { id: 'connectors', href: '/automation/connectors', label: 'm11.cn.title' },
        { id: 'webhooks', href: '/settings/webhooks', label: 'm11.wh.title' },
      ]}
    />
  );
}
