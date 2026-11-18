import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, ForbiddenState, PageTitle } from '@nuzm/ui';
import { AccountHealthTable, ProvidersTable } from '../../../../components/ProviderRegistry';
import { ProviderTabs } from '../../../../components/ProviderTabs';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/** UI-M05-08: provider registry and health, with the circuit-breaker state of every account. */
export default async function Providers({ params }: { params: Promise<{ locale: string }> }) {
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
      async () => {
        const [providers, accounts] = await Promise.all([
          unwrap(s.api.GET('/v1/admin/providers', {})),
          unwrap(s.api.GET('/v1/admin/provider-accounts', { params: { query: {} } })),
        ]);
        return { providers: providers.items, accounts: accounts.items };
      },
      ({ providers, accounts }) => (
        <>
          <ProvidersTable locale={locale} providers={providers} accounts={accounts} />
          <h2 className="nz-h2">{t(locale, 'm05.adm.reg.health')}</h2>
          <AccountHealthTable locale={locale} accounts={accounts} />
        </>
      ),
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.reg.title')}</PageTitle>
      <ProviderTabs locale={locale} current="registry" can={s.can} />
      <Banner tone="warn">{t(locale, 'm05.adm.notVerified')}</Banner>
      {body}
    </>
  );
}
