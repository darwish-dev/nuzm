import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingTabs } from '../../../../../../components/BillingTabs';
import { trimDec } from '../../../../../../lib/billing';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** Per-resource drill-down for one meter, with a note about late events (visible to `usage:events:read` holders). */
export default async function UsageMeter({
  params,
}: {
  params: Promise<{ locale: string; meter: string }>;
}) {
  const { locale, meter: raw } = await params;
  const meter = decodeURIComponent(raw);
  if (!isLocale(locale)) notFound();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(meter)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    async () => {
      const page = await unwrap(
        s.api.GET('/v1/usage', { params: { query: { meter, granularity: 'month', limit: 100 } } }),
      );
      let late: number | null = null;
      if (s.can('usage:events:read')) {
        try {
          const ev = await unwrap(
            s.api.GET('/v1/usage/events', { params: { query: { meter, limit: 200 } } }),
          );
          late = ev.items.filter((e) => e.late).length;
        } catch {
          late = null; // the note is optional; never block the drill-down on it
        }
      }
      return { page, late };
    },
    ({ page, late }) => (
      <>
        {late !== null && late > 0 && (
          <p role="status">{t(locale, 'bill.usage.late', { count: late })}</p>
        )}
        {page.items.length === 0 ? (
          <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'bill.usage.drill', { meter })}
            rows={page.items}
            rowKey={(p) => `${p.resourceId ?? ''}|${p.bucketStart}`}
            columns={[
              {
                key: 'r',
                header: t(locale, 'bill.f.resource'),
                render: (p) => (p.resourceId ? <Ltr>{p.resourceId}</Ltr> : '—'),
              },
              {
                key: 'p',
                header: t(locale, 'bill.f.period'),
                icon: 'calendar',
                render: (p) => formatDateTime(p.bucketStart, locale),
              },
              {
                key: 'q',
                header: t(locale, 'bill.f.quantity'),
                icon: 'data',
                render: (p) => <Ltr>{`${trimDec(p.quantity)} ${p.unit}`}</Ltr>,
              },
              { key: 'e', header: t(locale, 'bill.f.events'), render: (p) => p.eventCount },
              {
                key: 'g',
                header: t(locale, 'bill.f.region'),
                icon: 'pin',
                render: (p) => <Ltr>{p.dataRegion}</Ltr>,
              },
            ]}
          />
        )}
        <p>
          <ButtonLink variant="secondary" href={`/billing/usage`}>
            {t(locale, 'bill.usage.back')}
          </ButtonLink>
        </p>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'bill.usage.drill', { meter })}</PageTitle>
      <BillingTabs locale={locale} current="usage" can={s.can} />
      {body}
    </>
  );
}
