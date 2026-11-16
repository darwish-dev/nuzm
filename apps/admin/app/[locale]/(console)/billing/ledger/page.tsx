import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

export default async function AdminLedger({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () => ({
      accounts: await unwrap(
        s.api.GET('/v1/admin/billing/ledger-accounts', { params: { query: { limit: 100 } } }),
      ),
      txs: await unwrap(
        s.api.GET('/v1/admin/billing/ledger-transactions', {
          params: { query: { limit: 25, cursor: q.cursor || undefined } },
        }),
      ),
    }),
    ({ accounts, txs }) => (
      <>
        {accounts.items.length === 0 ? (
          <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'abill.ledger.accounts')}
            rows={accounts.items}
            rowKey={(a) => a.id}
            columns={[
              { key: 'c', header: t(locale, 'abill.f.code'), render: (a) => <Ltr>{a.code}</Ltr> },
              { key: 'n', header: t(locale, 'field.name'), render: (a) => a.name },
              {
                key: 'o',
                header: t(locale, 'abill.f.org'),
                render: (a) =>
                  a.orgId ? <Ltr>{a.orgId.slice(0, 8)}</Ltr> : t(locale, 'abill.f.platform'),
              },
              {
                key: 's',
                header: t(locale, 'abill.f.normal'),
                render: (a) => tDynamic(locale, `bill.dir.${a.normalSide}`, a.normalSide),
              },
              {
                key: 'b',
                header: t(locale, 'bill.f.balance'),
                render: (a) => <Ltr>{formatMinor(a.balanceMinor, a.currency, locale)}</Ltr>,
              },
            ]}
          />
        )}
        <Table
          caption={t(locale, 'abill.ledger.transactions')}
          rows={txs.items}
          rowKey={(x) => x.id}
          columns={[
            {
              key: 'w',
              header: t(locale, 'field.when'),
              render: (x) => formatDateTime(x.occurredAt, locale),
            },
            { key: 'k', header: t(locale, 'bill.ledger.kind'), render: (x) => <Ltr>{x.kind}</Ltr> },
            { key: 'd', header: t(locale, 'bill.f.description'), render: (x) => x.description },
            {
              key: 'p',
              header: t(locale, 'abill.f.postings'),
              render: (x) => (
                <ul>
                  {x.postings.map((p, i) => (
                    <li key={i}>
                      <Ltr>{p.accountCode}</Ltr>{' '}
                      <Badge tone={p.direction === 'credit' ? 'success' : undefined}>
                        {tDynamic(locale, `bill.dir.${p.direction}`, p.direction)}
                      </Badge>{' '}
                      <Ltr>{formatMinor(p.amountMinor, p.currency, locale)}</Ltr>
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              key: 'r',
              header: t(locale, 'abill.f.reverses'),
              render: (x) => (x.reversesId ? <Ltr>{x.reversesId.slice(0, 8)}</Ltr> : '—'),
            },
          ]}
        />
        {txs.nextCursor && (
          <p>
            <ButtonLink variant="secondary" href={`?cursor=${encodeURIComponent(txs.nextCursor)}`}>
              {t(locale, 'action.loadMore')}
            </ButtonLink>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'abill.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="ledger" can={s.can} />
      {body}
    </>
  );
}
