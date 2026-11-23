import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, Button, Field, ForbiddenState, PageTitle, Select } from '@nuzm/ui';
import { AccountActions } from '../../../../../../components/ProviderAccounts';
import {
  AccountSummary,
  CapabilityTable,
  PlansTable,
  RegionsTable,
} from '../../../../../../components/ProviderAccountDetail';
import { ReplaceCredentialsForm } from '../../../../../../components/ProviderConnect';
import { ProviderTabs } from '../../../../../../components/ProviderTabs';
import { isUuid } from '../../../../../../lib/providers';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M05-10: one account: capability matrix (unknown = unsupported), regions with their evidence, catalog sync, plans. */
export default async function AccountDetail({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ region?: string }>;
}) {
  const { locale, id } = await params;
  const q = await searchParams;
  if (!isLocale(locale) || !isUuid(id)) notFound();
  const s = await requireStaff(locale);
  const manage = s.can('admin:provider:manage');
  const region = q.region?.trim() ? q.region.trim() : undefined;
  const body = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : (
    await view(
      locale,
      async () => {
        const path = { id };
        const [account, caps, regions, plans] = await Promise.all([
          unwrap(s.api.GET('/v1/admin/provider-accounts/{id}', { params: { path } })),
          unwrap(s.api.GET('/v1/admin/provider-accounts/{id}/capabilities', { params: { path } })),
          unwrap(s.api.GET('/v1/admin/provider-accounts/{id}/regions', { params: { path } })),
          unwrap(
            s.api.GET('/v1/admin/provider-accounts/{id}/plans', {
              params: { path, query: { region } },
            }),
          ),
        ]);
        return { account, caps: caps.items, regions: regions.items, plans: plans.items };
      },
      ({ account, caps, regions, plans }) => (
        <>
          <h2 className="nz-h2">{account.name}</h2>
          <AccountSummary locale={locale} a={account} />
          <AccountActions
            locale={locale}
            accountId={account.id}
            mfaFactorId={s.me.mfaFactorId ?? null}
            canManage={manage}
            catalog
          />
          {manage && (
            <ReplaceCredentialsForm
              locale={locale}
              accountId={account.id}
              providerKey={account.providerKey}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          )}
          <h2 className="nz-h2">{t(locale, 'm05.adm.cap.title')}</h2>
          <p className="nz-muted">{t(locale, 'm05.adm.cap.unknownNote')}</p>
          <CapabilityTable locale={locale} rows={caps} />
          <h2 className="nz-h2">{t(locale, 'm05.adm.reg2.title')}</h2>
          <p className="nz-muted">{t(locale, 'm05.adm.reg2.note')}</p>
          <RegionsTable locale={locale} rows={regions} />
          <h2 className="nz-h2">{t(locale, 'm05.adm.plan.title')}</h2>
          <form method="get" className="nz-row" aria-label={t(locale, 'm05.adm.plan.title')}>
            <Field id="plan-f-region" label={t(locale, 'm05.adm.reg2.col.region')}>
              {(x) => (
                <Select {...x} name="region" defaultValue={region ?? ''}>
                  <option value="">{t(locale, 'm05.adm.all')}</option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.providerRegionId}>
                      {r.providerRegionId}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="secondary">
              {t(locale, 'action.search')}
            </Button>
          </form>
          <PlansTable locale={locale} rows={plans} />
        </>
      ),
    )
  );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.acc.detail')}</PageTitle>
      <ProviderTabs locale={locale} current="accounts" can={s.can} />
      <Banner tone="warn">{t(locale, 'm05.adm.notVerified')}</Banner>
      {body}
    </>
  );
}
