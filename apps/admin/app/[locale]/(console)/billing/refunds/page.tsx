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
import { RefundForm } from '../../../../../components/FinancePanels';
import {
  filterProblems,
  isUuid,
  pageQuery,
  refundTone,
  REFUND_STATUSES,
  shortId,
} from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Q = { org?: string; paymentId?: string; status?: string; cursor?: string };

/**
 * UI-M03-15: request a refund (step-up, Idempotency-Key, integer minor units) and follow its status (`GET /v1/admin/billing/refunds`,
 * read-only, audited). The form needs `admin:billing:manage`; the history needs `admin:billing:read`.
 */
export default async function Refunds({
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
  const status = REFUND_STATUSES.find((x) => x === q.status);
  const bad = filterProblems(q);
  const filters = { org: q.org, paymentId: q.paymentId, status };
  const list = bad ? (
    <ErrorState title={t(locale, 'af.ref.f.invalid')} body={t(locale, 'af.pay.noneBody')} />
  ) : (
    await view(
      locale,
      () =>
        unwrap(
          s.api.GET('/v1/admin/billing/refunds', {
            params: {
              query: {
                limit: 25,
                org: q.org || undefined,
                paymentId: q.paymentId || undefined,
                status,
                cursor: q.cursor || undefined,
              },
            },
          }),
        ),
      (page) =>
        page.items.length === 0 ? (
          <EmptyState
            title={t(locale, 'af.ref.list.none')}
            body={t(locale, 'af.ref.list.noneBody')}
          />
        ) : (
          <>
            <Table
              caption={t(locale, 'af.ref.list.title')}
              rows={page.items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'i',
                  header: t(locale, 'af.ref.col.id'),
                  render: (r) => (
                    <Ltr>
                      <span title={r.id}>{shortId(r.id)}</span>
                    </Ltr>
                  ),
                },
                {
                  key: 'o',
                  header: t(locale, 'af.ref.col.org'),
                  render: (r) => (
                    <a
                      href={`?${new URLSearchParams({ org: r.orgId }).toString()}`}
                      title={r.orgId}
                    >
                      <Ltr>{shortId(r.orgId)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'p',
                  header: t(locale, 'af.ref.col.payment'),
                  render: (r) => (
                    <a href={`/${locale}/billing/payments/${r.paymentId}`} title={r.paymentId}>
                      <Ltr>{shortId(r.paymentId)}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'a',
                  header: t(locale, 'af.ref.col.amount'),
                  render: (r) => <Ltr>{formatMinor(r.amountMinor, r.currency, locale)}</Ltr>,
                },
                {
                  key: 's',
                  header: t(locale, 'af.ref.col.status'),
                  render: (r) => (
                    <>
                      <Badge tone={refundTone(r.status)}>
                        {tDynamic(locale, `af.ref.status.${r.status}`, r.status)}
                      </Badge>
                      {r.failureCode && (
                        <>
                          <br />
                          <span className="nz-muted">
                            {t(locale, 'af.ref.failedWith', { code: r.failureCode })}
                          </span>
                        </>
                      )}
                    </>
                  ),
                },
                { key: 'r', header: t(locale, 'af.ref.col.reason'), render: (r) => r.reason },
                {
                  key: 'c',
                  header: t(locale, 'af.ref.col.credit'),
                  render: (r) => (r.creditNoteId ? <Ltr>{shortId(r.creditNoteId)}</Ltr> : '—'),
                },
                {
                  key: 't',
                  header: t(locale, 'af.ref.col.created'),
                  render: (r) => formatDateTime(r.createdAt, locale),
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
      <PageTitle>{t(locale, 'af.ref.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="refunds" can={s.can} />
      {s.can('admin:billing:manage') && (
        <RefundForm
          locale={locale}
          mfaFactorId={s.me.mfaFactorId ?? null}
          defaultPaymentId={q.paymentId && isUuid(q.paymentId) ? q.paymentId : undefined}
        />
      )}
      <h2>{t(locale, 'af.ref.list.title')}</h2>
      <form method="get" className="nz-row" aria-label={t(locale, 'af.ref.list.title')}>
        <Field id="rl-org" label={t(locale, 'af.ref.f.org')}>
          {(x) => <Input {...x} name="org" dir="ltr" defaultValue={q.org ?? ''} />}
        </Field>
        <Field id="rl-payment" label={t(locale, 'af.ref.f.payment')}>
          {(x) => <Input {...x} name="paymentId" dir="ltr" defaultValue={q.paymentId ?? ''} />}
        </Field>
        <Field id="rl-status" label={t(locale, 'af.ref.f.status')}>
          {(x) => (
            <Select {...x} name="status" defaultValue={status ?? ''}>
              <option value="">{t(locale, 'af.rc.all')}</option>
              {REFUND_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {t(locale, `af.ref.status.${v}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {list}
    </>
  );
}
