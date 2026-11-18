import { unwrap } from '@nuzm/sdk';
import { t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, PageTitle, Table } from '@nuzm/ui';
import { StatusBadge } from '../../../../components/DataParts';
import { databaseTone, isBusyStatus } from '../../../../lib/data';
import { gate } from '../../../../lib/gate';
import { view } from '../../../../lib/view';

/** UI-M08-01: managed databases. A row that is still being provisioned (or reconciled) shows an "operation in progress" badge. */
export default async function Databases({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'data:db:read', 'm8.db.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/databases', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'm8.db.empty')} body={t(locale, 'm8.db.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm8.db.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          cardIcon="data"
          rowHref={(r) => `/${locale}/databases/${r.id}`}
          manageLabel={t(locale, 'action.manage')}
          columns={[
            {
              key: 'n',
              card: 'title',
              header: t(locale, 'field.name'),
              render: (r) => <a href={`/${locale}/databases/${r.id}`}>{r.name}</a>,
            },
            {
              key: 'e',
              card: 'subtitle',
              header: t(locale, 'm8.db.col.engine'),
              icon: 'code',
              render: (r) => tDynamic(locale, `m8.engine.${r.engine}`, r.engine),
            },
            {
              key: 'v',
              card: 'chip',
              header: t(locale, 'm8.db.col.version'),
              render: (r) => r.version,
            },
            {
              key: 's',
              card: 'badge',
              header: t(locale, 'field.status'),
              icon: 'pulse',
              render: (r) => (
                <>
                  <StatusBadge
                    locale={locale}
                    prefix="m8.db.status"
                    value={r.status}
                    tone={databaseTone(r.status)}
                  />
                  {isBusyStatus(r.status) && (
                    <>
                      {' '}
                      <Badge tone="warn">{t(locale, 'm8.c.opInProgress')}</Badge>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'r',
              card: 'chip',
              header: t(locale, 'field.region'),
              render: (r) => r.dataRegion,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.db.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm8.db.help')}</p>
      {s.can('data:db:write') && (
        <p>
          <ButtonLink href={`/${locale}/databases/new`}>{t(locale, 'm8.db.new')}</ButtonLink>
        </p>
      )}
      {body}
    </>
  );
}
