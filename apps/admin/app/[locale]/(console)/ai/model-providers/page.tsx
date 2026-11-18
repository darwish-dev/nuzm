import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { AiAdminTabs } from '../../../../../components/AiAdminTabs';
import { AiProvidersPanel } from '../../../../../components/AiProvidersPanel';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M09-12: model providers. Nothing is seeded and no provider is chosen (decision D-18 is open); enabling needs a human attestation of the data terms
 * (HG-09-01), a registered adapter, a rate card and a second person. Credentials are vault references only. Every mutation asks for a fresh MFA code.
 */
export default async function ModelProviders({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'aia.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/ai/model-providers', {})),
    (data) => (
      <AiProvidersPanel
        locale={locale}
        items={data.items}
        meId={s.me.id}
        canManage={s.can('admin:ai:manage')}
        canApprove={s.can('admin:ai:approve')}
        mfaFactorId={s.me.mfaFactorId ?? null}
      />
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'aia.title')}</PageTitle>
      <AiAdminTabs locale={locale} current="model-providers" />
      <p className="nz-muted">{t(locale, 'aia.help')}</p>
      {body}
    </>
  );
}
