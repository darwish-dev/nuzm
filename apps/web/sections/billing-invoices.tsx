import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingTabs } from '../components/BillingTabs';
import { statusTone } from '../lib/payments';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

const STATUSES = ['open', 'partially_paid', 'paid', 'void', 'uncollectible'] as const;

/** UI-M03-05: invoices with a status filter, download links and the e-invoice badge. */
export default async function Invoices({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const status = STATUSES.find((x) => x === q.status);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/billing/invoices', {
          params: { query: { limit: 25, status, cursor: q.cursor || undefined } },
        }),
      ),
    (page) => (
      <>
        <form
          method="get"
          action="#invoices"
          className="nz-row"
          aria-label={t(locale, 'inv.filter')}
        >
          <Field id="inv-status" label={t(locale, 'inv.filter')}>
            {(x) => (
              <Select {...x} name="status" defaultValue={status ?? ''}>
                <option value="">{t(locale, 'inv.all')}</option>
                {STATUSES.map((v) => (
                  <option key={v} value={v}>
                    {t(locale, `inv.status.${v}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" variant="secondary">
            {t(locale, 'action.search')}
          </Button>
        </form>
        {page.items.length === 0 ? (
          <EmptyState title={t(locale, 'inv.none')} body={t(locale, 'inv.noneBody')} />
        ) : (
          <Table
            caption={t(locale, 'inv.title')}
            rows={page.items}
            rowKey={(i) => i.id}
            rowHref={(i) => `/billing/invoices/${i.id}`}
            manageLabel={t(locale, 'action.manage')}
            columns={[
              {
                key: 'n',
                header: t(locale, 'inv.col.number'),
                render: (i) => (
                  <a href={`/billing/invoices/${i.id}`}>
                    <Ltr>{i.number}</Ltr>
                  </a>
                ),
              },
              {
                key: 'i',
                header: t(locale, 'inv.col.issued'),
                icon: 'calendar',
                render: (i) => formatDateTime(i.issuedAt, locale),
              },
              {
                key: 'd',
                header: t(locale, 'inv.col.due'),
                icon: 'calendar',
                render: (i) => formatDateTime(i.dueAt, locale),
              },
              {
                key: 't',
                header: t(locale, 'inv.col.total'),
                icon: 'tag',
                render: (i) => <Ltr>{formatMinor(i.totalMinor, i.currency, locale)}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'inv.col.status'),
                icon: 'pulse',
                render: (i) => (
                  <Badge tone={statusTone(i.status)}>
                    {tDynamic(locale, `inv.status.${i.status}`, i.status)}
                  </Badge>
                ),
              },
              {
                key: 'z',
                header: t(locale, 'inv.col.einvoice'),
                icon: 'tag',
                render: (i) => (
                  <Badge tone={statusTone(i.zatca.state)}>
                    {tDynamic(locale, `inv.zatca.${i.zatca.state}`, i.zatca.state)}
                  </Badge>
                ),
              },
            ]}
          />
        )}
        {page.nextCursor && (
          <ButtonLink
            variant="secondary"
            href={`?${new URLSearchParams({ ...(status ? { status } : {}), cursor: page.nextCursor })}#invoices`}
          >
            {t(locale, 'action.next')}
          </ButtonLink>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'inv.title')}</PageTitle>
      <BillingTabs locale={locale} current="invoices" can={s.can} />
      {body}
    </>
  );
}
