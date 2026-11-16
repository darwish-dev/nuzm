import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, formatMinor, isLocale, t } from '@nuzm/i18n';
import {
  Bars,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Select,
  Table,
} from '@nuzm/ui';
import { BillingTabs } from '../../../../../components/BillingTabs';
import { trimDec } from '../../../../../lib/billing';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

type Q = { meter?: string; granularity?: string; from?: string; to?: string; cursor?: string };
const day = (v: string | undefined, end = false) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${end ? '23:59:59' : '00:00:00'}Z` : undefined;
const GRAN = ['hour', 'day', 'month'] as const;

export default async function Usage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Q>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const granularity = (GRAN as readonly string[]).includes(q.granularity ?? '')
    ? (q.granularity as (typeof GRAN)[number])
    : 'day';
  const body = await view(
    locale,
    async () => ({
      summary: await unwrap(s.api.GET('/v1/usage/summary', {})),
      page: await unwrap(
        s.api.GET('/v1/usage', {
          params: {
            query: {
              limit: 50,
              granularity,
              meter: q.meter || undefined,
              from: day(q.from),
              to: day(q.to, true),
              cursor: q.cursor || undefined,
            },
          },
        }),
      ),
    }),
    ({ summary, page }) => {
      const exportQuery = new URLSearchParams({
        granularity,
        ...(q.meter ? { meter: q.meter } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
      });
      const max = Math.max(1, ...page.items.map((p) => Number(p.quantity)));
      return (
        <>
          <form method="get" className="nz-row" role="search">
            <Field id="meter" label={t(locale, 'bill.f.meter')}>
              {(a) => (
                <Select name="meter" defaultValue={q.meter ?? ''} {...a}>
                  <option value="">—</option>
                  {summary.items.map((i) => (
                    <option key={i.meterId} value={i.meterId}>
                      {i.meterId}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="granularity" label={t(locale, 'bill.f.granularity')}>
              {(a) => (
                <Select name="granularity" defaultValue={granularity} {...a}>
                  {GRAN.map((g) => (
                    <option key={g} value={g}>
                      {t(locale, `bill.gran.${g}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="from" label={t(locale, 'bill.f.from')}>
              {(a) => <Input name="from" type="date" defaultValue={q.from} {...a} />}
            </Field>
            <Field id="to" label={t(locale, 'bill.f.to')}>
              {(a) => <Input name="to" type="date" defaultValue={q.to} {...a} />}
            </Field>
            <Button type="submit">{t(locale, 'action.search')}</Button>
            <ButtonLink variant="secondary" href={`/${locale}/billing/usage/export?${exportQuery}`}>
              {t(locale, 'bill.usage.export')}
            </ButtonLink>
          </form>
          {summary.items.length > 0 && (
            <Table
              caption={t(locale, 'bill.usage.summary')}
              rows={summary.items}
              rowKey={(i) => i.meterId}
              columns={[
                {
                  key: 'm',
                  header: t(locale, 'bill.f.meter'),
                  render: (i) => (
                    <a href={`/${locale}/billing/usage/${encodeURIComponent(i.meterId)}`}>
                      <Ltr>{i.meterId}</Ltr>
                    </a>
                  ),
                },
                {
                  key: 'q',
                  header: t(locale, 'bill.f.quantity'),
                  render: (i) => <Ltr>{`${trimDec(i.quantity)} ${i.unit}`}</Ltr>,
                },
                {
                  key: 'a',
                  header: t(locale, 'bill.f.allowance'),
                  render: (i) =>
                    i.allowanceApplied ? <Ltr>{trimDec(i.allowanceApplied)}</Ltr> : '—',
                },
                {
                  key: 'r',
                  header: t(locale, 'bill.f.rated'),
                  render: (i) =>
                    i.amountMinor && i.currency ? (
                      <Ltr>{formatMinor(i.amountMinor, i.currency, locale)}</Ltr>
                    ) : (
                      t(locale, 'bill.mtd.unrated')
                    ),
                },
                {
                  key: 'g',
                  header: t(locale, 'bill.f.region'),
                  render: (i) => <Ltr>{i.dataRegions.join(', ')}</Ltr>,
                },
              ]}
            />
          )}
          {page.items.length === 0 ? (
            <EmptyState
              title={t(locale, 'state.empty.title')}
              body={t(locale, 'state.empty.body')}
            />
          ) : (
            <>
              {q.meter && (
                <Bars
                  label={t(locale, 'bill.usage.chart')}
                  rows={page.items.slice(0, 12).map((p) => ({
                    key: `${p.bucketStart}${p.resourceId ?? ''}`,
                    label: formatDateTime(p.bucketStart, locale),
                    value: <Ltr>{`${trimDec(p.quantity)} ${p.unit}`}</Ltr>,
                    ratio: Number(p.quantity) / max,
                  }))}
                />
              )}
              <Table
                caption={t(locale, 'bill.usage.title')}
                rows={page.items}
                rowKey={(p) => `${p.meterId}|${p.resourceId ?? ''}|${p.bucketStart}`}
                columns={[
                  {
                    key: 'b',
                    header: t(locale, 'bill.f.bucket'),
                    render: (p) => formatDateTime(p.bucketStart, locale),
                  },
                  {
                    key: 'm',
                    header: t(locale, 'bill.f.meter'),
                    render: (p) => <Ltr>{p.meterId}</Ltr>,
                  },
                  {
                    key: 'r',
                    header: t(locale, 'bill.f.resource'),
                    render: (p) => (p.resourceId ? <Ltr>{p.resourceId.slice(0, 8)}</Ltr> : '—'),
                  },
                  {
                    key: 'q',
                    header: t(locale, 'bill.f.quantity'),
                    render: (p) => <Ltr>{`${trimDec(p.quantity)} ${p.unit}`}</Ltr>,
                  },
                  { key: 'e', header: t(locale, 'bill.f.events'), render: (p) => p.eventCount },
                  {
                    key: 'p',
                    header: t(locale, 'bill.f.period'),
                    render: (p) => <Ltr>{p.billingPeriodStart}</Ltr>,
                  },
                  {
                    key: 'g',
                    header: t(locale, 'bill.f.region'),
                    render: (p) => <Ltr>{p.dataRegion}</Ltr>,
                  },
                ]}
              />
            </>
          )}
          {page.nextCursor && (
            <p>
              <ButtonLink
                variant="secondary"
                href={`?${new URLSearchParams({ ...Object.fromEntries(exportQuery), cursor: page.nextCursor })}`}
              >
                {t(locale, 'action.loadMore')}
              </ButtonLink>
            </p>
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.usage.title')}</PageTitle>
      <BillingTabs locale={locale} current="usage" can={s.can} />
      {body}
    </>
  );
}
