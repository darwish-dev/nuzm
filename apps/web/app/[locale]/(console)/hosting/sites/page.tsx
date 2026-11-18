import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

const TONE = { active: 'success', failed: 'danger', suspended: 'warn' } as const;

/** UI-M06-03: the site list with status chips. */
export default async function Sites({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.can('hosting:site:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.sites')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.title.sites')}
          rows={data.items}
          rowKey={(x) => x.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'host.col.name'),
              render: (x) => <a href={`/${locale}/hosting/sites/${x.id}`}>{x.name}</a>,
            },
            {
              key: 'p',
              header: t(locale, 'host.col.plan'),
              render: (x) => (locale === 'ar' ? x.plan.name.ar : x.plan.name.en),
            },
            {
              key: 'r',
              header: t(locale, 'host.col.runtime'),
              render: (x) => <Ltr>{x.runtime}</Ltr>,
            },
            {
              key: 'g',
              header: t(locale, 'host.col.region'),
              render: (x) => <Ltr>{x.dataRegion}</Ltr>,
            },
            {
              key: 'd',
              header: t(locale, 'host.col.domain'),
              render: (x) => (x.primaryDomain ? <Ltr>{x.primaryDomain}</Ltr> : '—'),
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              render: (x) => (
                <Badge tone={TONE[x.status as keyof typeof TONE]}>
                  {tDynamic(locale, `host.status.${x.status}`, x.status)}
                </Badge>
              ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.title.sites')}</PageTitle>
      {body}
    </>
  );
}
