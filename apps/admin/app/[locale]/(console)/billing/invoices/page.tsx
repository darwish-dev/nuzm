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
  EINVOICE_STATES,
  filterProblems,
  INVOICE_STATUSES,
  invoiceTone,
  pageQuery,
  shortId,
  submissionTone,
} from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Q = {
  org?: string;
  status?: string;
  number?: string;
  einvoice?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

/**
 * UI-M03-13: cross-organization invoice search with the e-invoice state of each invoice (`GET /v1/admin/billing/invoices`, read-only,
 * audited). An issued invoice cannot be edited, so the screen only explains the correction path: a credit note, then a new invoice.
 */
export default async function Invoices({
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
  const status = INVOICE_STATUSES.find((x) => x === q.status);
  const einvoice = EINVOICE_STATES.find((x) => x === q.einvoice);
  const number = q.number?.trim().slice(0, 40) || undefined;
  const bad = filterProblems(q);
  const filters = { org: q.org, status, number, einvoice, from: q.from, to: q.to };
  const body = bad ? (
    <ErrorState title={t(locale, 'af.inv.f.invalid')} body={t(locale, 'af.inv.noneBody')} />
  ) : (
    await view(
      locale,
      () =>
        unwrap(
          s.api.GET('/v1/admin/billing/invoices', {
            params: {
              query: {
                limit: 25,
                org: q.org || undefined,
                status,
                number,
                einvoiceState: einvoice,
                from: dayStartIso(q.from),
                to: dayEndIso(q.to),
                cursor: q.cursor || undefined,
              },
            },
          }),
        ),
      (page) =>
        page.items.length === 0 ? (
          <EmptyState title={t(locale, 'af.inv.none')} body={t(locale, 'af.inv.noneBody')} />
        ) : (
          <>
            <Table
              caption={t(locale, 'af.inv.title')}
              rows={page.items}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: 'n',
                  header: t(locale, 'af.inv.col.number'),
                  render: (i) => (
                    <>
                      <Ltr>{i.number}</Ltr>
                      {i.taxReviewRequired && (
                        <>
                          <br />
                          <Badge tone="warn">{t(locale, 'af.inv.taxReview')}</Badge>
                        </>
                      )}
                    </>
                  ),
                },
                {
                  key: 'o',
                  header: t(locale, 'af.inv.col.org'),
                  icon: 'user',
                  render: (i) => (
                    <a
                      href={`?${new URLSearchParams({ org: i.orgId }).toString()}`}
                      title={i.orgId}
                    >
                      <Ltr>{shortId(i.orgId)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'b',
                  header: t(locale, 'af.inv.col.buyer'),
                  render: (i) => (
                    <>
                      {(locale === 'ar' ? i.buyerName.ar : i.buyerName.en) || i.buyerName.en || '—'}
                      {i.buyerVatNumber && (
                        <>
                          <br />
                          <Ltr>{i.buyerVatNumber}</Ltr>
                        </>
                      )}
                    </>
                  ),
                },
                {
                  key: 's',
                  header: t(locale, 'af.inv.col.status'),
                  icon: 'pulse',
                  render: (i) => (
                    <Badge tone={invoiceTone(i.status)}>
                      {tDynamic(locale, `af.inv.status.${i.status}`, i.status)}
                    </Badge>
                  ),
                },
                {
                  key: 't',
                  header: t(locale, 'af.inv.col.total'),
                  icon: 'tag',
                  render: (i) => <Ltr>{formatMinor(i.totalMinor, i.currency, locale)}</Ltr>,
                },
                {
                  key: 'p',
                  header: t(locale, 'af.inv.col.paid'),
                  render: (i) => <Ltr>{formatMinor(i.paidMinor, i.currency, locale)}</Ltr>,
                },
                {
                  key: 'e',
                  header: t(locale, 'af.inv.col.einvoice'),
                  icon: 'tag',
                  render: (i) => (
                    <>
                      <Badge tone={submissionTone(i.einvoice.state, false)}>
                        {tDynamic(locale, `af.inv.ei.${i.einvoice.state}`, i.einvoice.state)}
                      </Badge>
                      {i.einvoice.environment && (
                        <>
                          <br />
                          <span className="nz-muted">
                            {t(locale, 'af.inv.ei.env', { env: i.einvoice.environment })}
                          </span>
                        </>
                      )}
                    </>
                  ),
                },
                {
                  key: 'i',
                  header: t(locale, 'af.inv.col.issued'),
                  icon: 'calendar',
                  render: (i) => formatDateTime(i.issuedAt, locale),
                },
                {
                  key: 'd',
                  header: t(locale, 'af.inv.col.due'),
                  icon: 'calendar',
                  render: (i) => formatDateTime(i.dueAt, locale),
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
      <PageTitle>{t(locale, 'af.inv.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="invoices" can={s.can} />
      <p className="nz-muted">{t(locale, 'af.inv.help')}</p>
      <section className="nz-card" aria-labelledby="inv-guide">
        <h2 id="inv-guide">{t(locale, 'af.inv.guide.title')}</h2>
        <p>{t(locale, 'af.inv.guide.body')}</p>
      </section>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.inv.title')}>
        <Field id="inv-org" label={t(locale, 'af.inv.f.org')}>
          {(x) => <Input {...x} name="org" dir="ltr" defaultValue={q.org ?? ''} />}
        </Field>
        <Field id="inv-number" label={t(locale, 'af.inv.f.number')}>
          {(x) => (
            <Input {...x} name="number" dir="ltr" maxLength={40} defaultValue={number ?? ''} />
          )}
        </Field>
        <Field id="inv-status" label={t(locale, 'af.inv.f.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {INVOICE_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.inv.status.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="inv-ei" label={t(locale, 'af.inv.f.einvoice')}>
          {(x) => (
            <Select {...x} name="einvoice" defaultValue={einvoice ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {EINVOICE_STATES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.inv.ei.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="inv-from" label={t(locale, 'af.inv.f.from')}>
          {(x) => <Input {...x} name="from" type="date" defaultValue={q.from ?? ''} />}
        </Field>
        <Field id="inv-to" label={t(locale, 'af.inv.f.to')}>
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
