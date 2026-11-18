import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M06-01: plans that have capacity (a plan without capacity is never listed). */
export default async function Plans({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.can('hosting:plan:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.title.plans')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/plans', {})),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.plans')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.title.plans')}
          rows={data.items}
          rowKey={(p) => p.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'host.col.name'),
              render: (p) => (locale === 'ar' ? p.name.ar : p.name.en),
            },
            {
              key: 'q',
              header: t(locale, 'host.col.quota'),
              icon: 'globe',
              render: (p) => (
                <Ltr>{`${p.quotas.diskMb} MB · ${p.quotas.bandwidthGb} GB · ${p.quotas.dbCount} DB`}</Ltr>
              ),
            },
            {
              key: 'r',
              header: t(locale, 'host.col.runtime'),
              icon: 'calendar',
              render: (p) => <Ltr>{p.runtimes.join(', ')}</Ltr>,
            },
            {
              key: 'g',
              header: t(locale, 'host.col.region'),
              icon: 'pin',
              render: (p) => <Ltr>{p.regions.join(', ')}</Ltr>,
            },
            {
              key: 'p',
              header: t(locale, 'host.col.price'),
              icon: 'tag',
              render: (p) =>
                p.price ? (
                  <Ltr>{`${p.price.amountMinor} ${p.price.currency}${p.price.placeholder ? ' *' : ''}`}</Ltr>
                ) : (
                  <Badge tone="warn">—</Badge>
                ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.title.plans')}</PageTitle>
      {body}
    </>
  );
}
