import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M07-12: support lookup: metadata and order history only; contacts are masked on this screen. */
export default async function DomainLookup({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:domains:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.admin.detail.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/domains/{id}', { params: { path: { id } } })),
    (d) => (
      <>
        <Card>
          <p>
            <Ltr>{d.name}</Ltr> <Badge>{tDynamic(locale, `dom.state.${d.state}`, d.state)}</Badge>
          </p>
          <Banner tone="warn">{t(locale, 'dom.admin.detail.masked')}</Banner>
        </Card>
        <Table
          caption={t(locale, 'dom.admin.detail.orders')}
          rows={
            d.orders as {
              id: string;
              type: string;
              state: string;
              createdAt: string;
              failureCode: string | null;
            }[]
          }
          rowKey={(r) => r.id}
          columns={[
            { key: 't', header: t(locale, 'dom.col.name'), render: (r) => <Ltr>{r.type}</Ltr> },
            {
              key: 's',
              header: t(locale, 'dom.col.state'),
              render: (r) => <Badge>{r.state}</Badge>,
            },
            {
              key: 'f',
              header: '',
              render: (r) => (r.failureCode ? <Ltr>{r.failureCode}</Ltr> : '—'),
            },
            { key: 'c', header: '', render: (r) => formatDateTime(r.createdAt, locale) },
          ]}
        />
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.admin.detail.title')}</PageTitle>
      {body}
    </>
  );
}
