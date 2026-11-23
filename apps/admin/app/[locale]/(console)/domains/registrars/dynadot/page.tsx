import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';
import { DynadotSettings } from '../../../../../../components/DynadotSettings';

/** Admin → Domains → Registrars → Dynadot: the connection settings and the connection test (owner request 2026-11-24). */
export default async function DynadotRegistrar({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:domains:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.dynadot.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/registrars', {})),
    (data) => {
      const a = data.accounts.find((x) => x.providerCode === 'dynadot') ?? null;
      return (
        <DynadotSettings
          locale={locale}
          account={
            a && {
              id: a.id,
              label: a.label,
              environment: a.environment,
              dataRegion: a.dataRegion ?? 'US',
              currency: a.currency ?? 'USD',
              settings: a.settings ?? {},
              credentialStored: a.credentialStored ?? false,
              enabled: a.enabled,
            }
          }
          canManage={s.can('admin:domains:manage')}
          mfaFactorId={s.me.mfaFactorId ?? null}
        />
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.dynadot.title')}</PageTitle>
      {body}
    </>
  );
}
