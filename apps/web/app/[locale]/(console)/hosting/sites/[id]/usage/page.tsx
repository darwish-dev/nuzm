import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { HostingTabs } from '../../../../../../../components/HostingTabs';
import { requireSession } from '../../../../../../../lib/server';
import { view } from '../../../../../../../lib/view';

/** UI-M06-09: usage against every quota with the soft/hard threshold state. */
export default async function Usage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites/{id}/usage', { params: { path: { id } } })),
    (u) => (
      <>
        <p>
          <Ltr>{`${u.period} · ${t(locale, 'host.usage.disk')}: ${u.diskMb} MB · ${t(locale, 'host.usage.inodes')}: ${u.inodes} · ${t(locale, 'host.usage.bandwidth')}: ${u.bandwidthGbMonth} GB`}</Ltr>
        </p>
        <Table
          caption={t(locale, 'host.usage.title')}
          rows={u.quotas}
          rowKey={(q) => q.dim}
          columns={[
            { key: 'd', header: t(locale, 'host.col.dim'), render: (q) => <Ltr>{q.dim}</Ltr> },
            {
              key: 'u',
              header: t(locale, 'host.tab.usage'),
              render: (q) => <Ltr>{`${q.used} / ${q.limit}`}</Ltr>,
            },
            {
              key: 'g',
              header: t(locale, 'host.col.quota'),
              render: (q) => (
                <Meter
                  label={t(locale, 'host.usage.meter', { dim: q.dim })}
                  percent={q.limit > 0 ? (q.used / q.limit) * 100 : 0}
                />
              ),
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              render: (q) => (
                <Badge tone={q.state === 'ok' ? 'success' : q.state === 'soft' ? 'warn' : 'danger'}>
                  {tDynamic(locale, `host.state.${q.state}`, q.state)}
                </Badge>
              ),
            },
          ]}
        />
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.tab.usage')}</PageTitle>
      <HostingTabs locale={locale} siteId={id} current="usage" />
      {body}
    </>
  );
}
