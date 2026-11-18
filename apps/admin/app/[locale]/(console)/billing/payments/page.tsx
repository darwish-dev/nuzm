import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import {
  dayEndIso,
  dayStartIso,
  filterProblems,
  pageQuery,
  PAYMENT_STATUSES,
  paymentTone,
  shortId,
} from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Q = {
  org?: string;
  invoiceId?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

/** UI-M03-14: payments across organizations; each row opens its redacted PSP events (`GET /v1/admin/billing/payments`, read-only, audited). */
export default async function Payments({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Q>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const status = PAYMENT_STATUSES.find((x) => x === q.status);
  const bad = filterProblems(q);
  const filters = { org: q.org, invoiceId: q.invoiceId, status, from: q.from, to: q.to };
  const body = bad ? (
    <ErrorState title={t(locale, 'af.pay.f.invalid')} body={t(locale, 'af.pay.noneBody')} />
  ) : (
    await view(
      locale,
      () =>
        unwrap(
          s.api.GET('/v1/admin/billing/payments', {
            params: {
              query: {
                limit: 25,
                org: q.org || undefined,
                invoiceId: q.invoiceId || undefined,
                status,
                from: dayStartIso(q.from),
                to: dayEndIso(q.to),
                cursor: q.cursor || undefined,
              },
            },
          }),
        ),
      (page) =>
        page.items.length === 0 ? (
          <EmptyState title={t(locale, 'af.pay.none')} body={t(locale, 'af.pay.noneBody')} />
        ) : (
          <>
            <Table
              caption={t(locale, 'af.pay.title')}
              rows={page.items}
              rowKey={(p) => p.id}
              columns={[
                {
                  key: 'i',
                  header: t(locale, 'af.pay.col.id'),
                  render: (p) => (
                    <a
                      href={`/${locale}/billing/payments/${p.id}`}
                      title={p.id}
                      aria-label={`${t(locale, 'af.pay.view')} ${shortId(p.id)}`}
                    >
                      <Ltr>{shortId(p.id)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'o',
                  header: t(locale, 'af.pay.col.org'),
                  icon: 'user',
                  render: (p) => (
                    <a
                      href={`?${new URLSearchParams({ org: p.orgId }).toString()}`}
                      title={p.orgId}
                    >
                      <Ltr>{shortId(p.orgId)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'g',
                  header: t(locale, 'af.pay.col.target'),
                  render: (p) =>
                    p.invoiceId ? (
                      <a
                        href={`?${new URLSearchParams({ invoiceId: p.invoiceId }).toString()}`}
                        title={p.invoiceId}
                      >
                        <Ltr>{shortId(p.invoiceId)}</Ltr>
                      </a>
                    ) : (
                      t(locale, 'af.pay.topup')
                    ),
                },
                {
                  key: 'v',
                  header: t(locale, 'af.pay.col.provider'),
                  render: (p) => <Ltr>{p.provider}</Ltr>,
                },
                {
                  key: 'a',
                  header: t(locale, 'af.pay.col.amount'),
                  icon: 'tag',
                  render: (p) => <Ltr>{formatMinor(p.amountMinor, p.currency, locale)}</Ltr>,
                },
                {
                  key: 'c',
                  header: t(locale, 'af.pay.col.captured'),
                  render: (p) => <Ltr>{formatMinor(p.capturedMinor, p.currency, locale)}</Ltr>,
                },
                {
                  key: 'r',
                  header: t(locale, 'af.pay.col.refunded'),
                  render: (p) => <Ltr>{formatMinor(p.refundedMinor, p.currency, locale)}</Ltr>,
                },
                {
                  key: 's',
                  header: t(locale, 'af.pay.col.status'),
                  icon: 'pulse',
                  render: (p) => (
                    <Badge tone={paymentTone(p.status)}>
                      {tDynamic(locale, `af.pay.status.${p.status}`, p.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'e',
                  header: t(locale, 'af.pay.col.events'),
                  render: (p) => <Ltr>{p.eventCount}</Ltr>,
                },
                {
                  key: 't',
                  header: t(locale, 'af.pay.col.created'),
                  icon: 'calendar',
                  render: (p) => formatDateTime(p.createdAt, locale),
                },
              ]}
            />
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
  return (
    <>
      <PageTitle>{t(locale, 'af.pay.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="payments" can={s.can} />
      <p className="nz-muted">{t(locale, 'af.pay.help')}</p>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.pay.title')}>
        <Field id="pay-org" label={t(locale, 'af.pay.f.org')}>
          {(x) => <Input {...x} name="org" dir="ltr" defaultValue={q.org ?? ''} />}
        </Field>
        <Field id="pay-invoice" label={t(locale, 'af.pay.f.invoice')}>
          {(x) => <Input {...x} name="invoiceId" dir="ltr" defaultValue={q.invoiceId ?? ''} />}
        </Field>
        <Field id="pay-status" label={t(locale, 'af.pay.f.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {PAYMENT_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.pay.status.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="pay-from" label={t(locale, 'af.pay.f.from')}>
          {(x) => <Input {...x} name="from" type="date" defaultValue={q.from ?? ''} />}
        </Field>
        <Field id="pay-to" label={t(locale, 'af.pay.f.to')}>
          {(x) => <Input {...x} name="to" type="date" defaultValue={q.to ?? ''} />}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
    </>
  );
}
