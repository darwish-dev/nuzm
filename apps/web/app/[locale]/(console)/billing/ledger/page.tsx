import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Table,
} from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

const day = (v: string | undefined, end = false) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : undefined;

export default async function Ledger({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string; from?: string; to?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/billing/ledger', {
          params: {
            query: {
              limit: 25,
              kind: q.kind || undefined,
              from: day(q.from),
              to: day(q.to, true),
              cursor: q.cursor || undefined,
            },
          },
        }),
      ),
    (page) => (
      <>
        {page.items.length === 0 ? (
          <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'bill.ledger.title')}
            rows={page.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'w',
                header: t(locale, 'field.when'),
                icon: 'calendar',
                render: (r) => formatDateTime(r.occurredAt, locale),
              },
              {
                key: 'k',
                header: t(locale, 'bill.ledger.kind'),
                icon: 'code',
                render: (r) => <Ltr>{r.kind}</Ltr>,
              },
              { key: 'd', header: t(locale, 'bill.f.description'), render: (r) => r.description },
              {
                key: 'dir',
                header: t(locale, 'bill.f.direction'),
                render: (r) => (
                  <Badge tone={r.direction === 'credit' ? 'success' : undefined}>
                    {tDynamic(locale, `bill.dir.${r.direction}`, r.direction)}
                  </Badge>
                ),
              },
              {
                key: 'a',
                header: t(locale, 'bill.f.amount'),
                icon: 'tag',
                render: (r) => <Ltr>{formatMinor(r.amountMinor, r.currency, locale)}</Ltr>,
              },
              {
                key: 'b',
                header: t(locale, 'bill.f.balance'),
                icon: 'tag',
                render: (r) => <Ltr>{formatMinor(r.balanceMinor, r.currency, locale)}</Ltr>,
              },
            ]}
          />
        )}
        {page.nextCursor && (
          <p>
            <ButtonLink
              variant="secondary"
              href={`?${new URLSearchParams({ ...(q.kind ? { kind: q.kind } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), cursor: page.nextCursor })}`}
            >
              {t(locale, 'action.loadMore')}
            </ButtonLink>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.ledger.title')}</PageTitle>
      <BillingTabs locale={locale} current="ledger" can={s.can} />
      <form method="get" className="nz-row" role="search">
        <Field id="kind" label={t(locale, 'bill.ledger.kind')}>
          {(a) => <Input name="kind" defaultValue={q.kind} dir="ltr" {...a} />}
        </Field>
        <Field id="from" label={t(locale, 'bill.f.from')}>
          {(a) => <Input name="from" type="date" defaultValue={q.from} {...a} />}
        </Field>
        <Field id="to" label={t(locale, 'bill.f.to')}>
          {(a) => <Input name="to" type="date" defaultValue={q.to} {...a} />}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
