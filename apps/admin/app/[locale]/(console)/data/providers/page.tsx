import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { DataProvidersPanel } from '../../../../../components/DataProvidersPanel';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M08-15: data provider selection and probe evidence. Nothing is enabled by default; enabling needs an accepted ADR, a probe with live evidence and,
 * outside environment=local, a second person. Dev-reference rows are marked "NOT VERIFIED".
 */
export default async function DataProviders({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:data:read'))
    return (
      <>
        <PageTitle>{t(locale, 'm8.adm.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/data-providers', { params: { query: {} } })),
    (data) => (
      <DataProvidersPanel
        locale={locale}
        items={data.items}
        meId={s.me.id}
        canManage={s.can('admin:data:manage')}
        canApprove={s.can('admin:data:approve')}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.adm.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm8.adm.help')}</p>
      {body}
    </>
  );
}
