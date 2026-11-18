import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Button, ButtonLink, Field, ForbiddenState, Input, PageTitle } from '@nuzm/ui';
import {
  CostTotals,
  CostsTable,
  MarginPanel,
  Rc04Table,
  type MarginReport,
  type Rc04Run,
} from '../../../../../components/ProviderCosts';
import { ProviderTabs } from '../../../../../components/ProviderTabs';
import {
  isPeriod,
  isUuid,
  loose,
  pageQuery,
  type ProviderCostPage,
} from '../../../../../lib/providers';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** First and last calendar day (UTC) of a `YYYY-MM` period. */
function monthRange(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: day(new Date(Date.UTC(y, m - 1, 1))),
    to: day(new Date(Date.UTC(y, m, 0))),
  };
}

const notAllowed = (locale: 'ar' | 'en') => (
  <p className="nz-muted">{t(locale, 'm05.adm.cost.notForRole')}</p>
);

/** UI-M05-14: provider cost records, RC-04 results and the margin view for one period. Each block is gated by its own permission. */
export default async function ProviderCosts({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ providerAccountId?: string; period?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const period = q.period && isPeriod(q.period) ? q.period : new Date().toISOString().slice(0, 7);
  const accountId = q.providerAccountId?.trim() ? q.providerAccountId.trim() : undefined;
  const badFilter = (!!q.period && !isPeriod(q.period)) || (!!accountId && !isUuid(accountId));
  const filters = { providerAccountId: accountId, period };
  const range = monthRange(period);

  const costs = !s.can('admin:provider:read') ? (
    <ForbiddenState
      title={t(locale, 'state.forbidden.title')}
      body={t(locale, 'state.forbidden.body')}
    />
  ) : badFilter ? (
    <p role="alert" className="nz-error-text">
      {t(locale, 'm05.adm.cost.invalidFilter')}
    </p>
  ) : (
    await view(
      locale,
      () =>
        unwrap(
          loose(s.api).GET<ProviderCostPage>('/v1/admin/provider-costs', {
            params: { query: { ...filters, limit: 25, cursor: q.cursor || undefined } },
          }),
        ),
      (page) => (
        <>
          <CostTotals locale={locale} totals={page.totals} />
          <CostsTable locale={locale} rows={page.items} />
          {page.nextCursor && (
            <p>
              <ButtonLink variant="secondary" href={pageQuery(filters, page.nextCursor)}>
                {t(locale, 'action.loadMore')}
              </ButtonLink>
            </p>
          )}
        </>
      ),
    )
  );
  const rc04 = !s.can('admin:billing:read')
    ? notAllowed(locale)
    : await view(
        locale,
        () =>
          unwrap(
            s.api.GET('/v1/admin/billing/reconciliations', {
              params: { query: { type: 'RC-04', limit: 10 } },
            }),
          ),
        (page) => <Rc04Table locale={locale} rows={page.items as Rc04Run[]} linkRuns />,
      );
  const margin = !s.can('admin:reports:read')
    ? notAllowed(locale)
    : await view(
        locale,
        () =>
          unwrap(
            s.api.GET('/v1/admin/billing/revenue-reports', {
              params: {
                query: { report: 'margin', from: range.from, to: range.to, format: 'json' },
              },
            }),
          ),
        (r) => <MarginPanel locale={locale} r={r as unknown as MarginReport} />,
      );
  return (
    <>
      <PageTitle>{t(locale, 'm05.adm.cost.title')}</PageTitle>
      <ProviderTabs locale={locale} current="costs" can={s.can} />
      <form method="get" className="nz-row" aria-label={t(locale, 'm05.adm.cost.title')}>
        <Field id="cost-f-period" label={t(locale, 'm05.adm.cost.f.period')}>
          {(x) => <Input {...x} dir="ltr" type="month" name="period" defaultValue={period} />}
        </Field>
        <Field id="cost-f-account" label={t(locale, 'm05.adm.col.account')}>
          {(x) => (
            <Input {...x} dir="ltr" name="providerAccountId" defaultValue={accountId ?? ''} />
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {costs}
      <h2 className="nz-h2">{t(locale, 'm05.adm.rc4.title')}</h2>
      <p className="nz-muted">{t(locale, 'm05.adm.rc4.note')}</p>
      {rc04}
      <h2 className="nz-h2">{t(locale, 'm05.adm.margin.title')}</h2>
      {margin}
    </>
  );
}
