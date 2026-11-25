import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';
import { RANGES, helpfulShare, rangeOf } from '../../../../lib/docs-feedback';

/** Ratings of the public documentation ("Was this helpful?"): counts per page. Nothing identifying about a visitor exists to show. */
export default async function DocsFeedback({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:reports:read'))
    return (
      <>
        <PageTitle>{t(locale, 'admin.docsFeedback.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const days = rangeOf(q.days);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/docs-feedback', { params: { query: { days } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'state.empty.title')}
          body={t(locale, 'admin.docsFeedback.empty')}
        />
      ) : (
        <>
          <p className="nz-muted">
            {t(locale, 'admin.docsFeedback.totals', {
              total: data.totals.total,
              good: data.totals.good,
            })}
          </p>
          <Table
            caption={t(locale, 'admin.docsFeedback.range', { days })}
            rows={data.items}
            rowKey={(r) => r.page}
            columns={[
              {
                key: 'page',
                header: t(locale, 'admin.docsFeedback.col.page'),
                render: (r) => <Ltr>{r.page}</Ltr>,
              },
              {
                key: 'good',
                header: t(locale, 'admin.docsFeedback.col.good'),
                render: (r) => r.good,
              },
              {
                key: 'okay',
                header: t(locale, 'admin.docsFeedback.col.okay'),
                render: (r) => r.okay,
              },
              { key: 'bad', header: t(locale, 'admin.docsFeedback.col.bad'), render: (r) => r.bad },
              {
                key: 'total',
                header: t(locale, 'admin.docsFeedback.col.total'),
                render: (r) => r.total,
              },
              {
                key: 'share',
                header: t(locale, 'admin.docsFeedback.col.share'),
                render: (r) => {
                  const share = helpfulShare(r);
                  return share === null ? (
                    '—'
                  ) : (
                    <Badge tone={share >= 70 ? 'success' : share >= 40 ? 'warn' : 'danger'}>
                      {share}%
                    </Badge>
                  );
                },
              },
            ]}
          />
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'admin.docsFeedback.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'admin.docsFeedback.intro')}</p>
      <p className="nz-row">
        {RANGES.map((d) => (
          <ButtonLink key={d} variant={d === days ? 'primary' : 'secondary'} href={`?days=${d}`}>
            {t(locale, 'admin.docsFeedback.range', { days: d })}
          </ButtonLink>
        ))}
      </p>
      {body}
    </>
  );
}
