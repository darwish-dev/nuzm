import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import { RoutingPanel } from '../../../../../components/ProviderRouting';
import { loose, type RoutingRuleDto } from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M05-11: routing rules (versioned, audited) and the dry-run simulator. */
export default async function Routing({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      () => unwrap(loose(s.api).GET<{ items: RoutingRuleDto[] }>('/v1/admin/routing-rules')),
      ({ items }) => (
        <RoutingPanel
          locale={locale}
          rules={items}
          canManage={s.can('admin:provider:manage')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      ),
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.rt.title')}</PageTitle>
      <ProviderTabs locale={locale} current="routing" can={s.can} />
      {body}
    </>
  );
}
