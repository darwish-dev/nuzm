import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, Button, Field, ForbiddenState, PageTitle, Select } from '@nuzm/ui';
import { AccountsTable, AddAccountForm } from '../../../../../components/ProviderAccounts';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import { isUuid } from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M05-09: provider accounts. Credentials are vault references; verification starts a job (202) that is followed to its end. */
export default async function Accounts({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ providerId?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const providerId = q.providerId && isUuid(q.providerId) ? q.providerId : undefined;
  const manage = s.can('admin:provider:manage');
  const mfa = s.me.mfaFactorId ?? null;
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
          unwrap(s.api.GET('/v1/admin/provider-accounts', { params: { query: { providerId } } })),
        ]);
        return { providers: providers.items, accounts: accounts.items };
      },
      ({ providers, accounts }) => (
        <>
          <form method="get" className="nz-row" aria-label={t(locale, 'm05.adm.acc.title')}>
            <Field id="acc-f-provider" label={t(locale, 'm05.adm.col.provider')}>
              {(x) => (
                <Select {...x} name="providerId" defaultValue={providerId ?? ''}>
                  <option value="">{t(locale, 'm05.adm.all')}</option>
                  {providers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.key}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="secondary">
              {t(locale, 'action.search')}
            </Button>
          </form>
          <AccountsTable locale={locale} rows={accounts} canManage={manage} mfaFactorId={mfa} />
          {manage && <AddAccountForm locale={locale} providers={providers} mfaFactorId={mfa} />}
        </>
      ),
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.acc.title')}</PageTitle>
      <ProviderTabs locale={locale} current="accounts" can={s.can} />
      <Banner tone="warn">{t(locale, 'm05.adm.acc.vaultOnly')}</Banner>
      {body}
    </>
  );
}
