import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ForbiddenState, PageTitle } from '@nuzm/ui';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';
import { DnetSettings } from '../../../../../../components/DnetSettings';

/** Admin → Domains → Registrars → DNet: the connection settings (owner request 2026-11-21; D-50, HG-07-03). */
export default async function DnetRegistrar({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:domains:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.dnet.title')}</PageTitle>
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
      const a = data.accounts.find((x) => x.providerCode === 'dnet') ?? null;
      return (
        <DnetSettings
          locale={locale}
          account={
            a && {
              label: a.label,
              environment: a.environment,
              settings: a.settings ?? {},
              credentialStored: a.credentialStored ?? false,
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
      <PageTitle>{t(locale, 'dom.dnet.title')}</PageTitle>
      {body}
    </>
  );
}
