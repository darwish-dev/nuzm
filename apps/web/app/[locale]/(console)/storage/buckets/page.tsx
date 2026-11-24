import { StartHero } from '../../../../../components/StartHero';
import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { StatusBadge } from '../../../../../components/DataParts';
import { bucketUsage, formatBytes, usagePercent } from '../../../../../lib/data';
import { gate } from '../../../../../lib/gate';
import { view } from '../../../../../lib/view';

/** UI-M08-06: buckets with their data region, public/private state and usage against the quota ("unavailable" when the provider cannot report it). */
export default async function Buckets({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'data:storage:read', 'm8.st.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/storage/buckets', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'm8.st.empty')} body={t(locale, 'm8.st.emptyBody')} />
      ) : (
        <Table
          caption={t(locale, 'm8.st.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          cardIcon="data"
          rowHref={(r) => `/storage/buckets/${r.id}`}
          manageLabel={t(locale, 'action.manage')}
          columns={[
            {
              key: 'n',
              card: 'title',
              header: t(locale, 'field.name'),
              render: (r) => <a href={`/storage/buckets/${r.id}`}>{r.name}</a>,
            },
            {
              key: 'b',
              card: 'subtitle',
              header: t(locale, 'm8.st.col.bucketName'),
              render: (r) => <Ltr>{r.bucketName}</Ltr>,
            },
            {
              key: 'r',
              card: 'chip',
              header: t(locale, 'field.region'),
              render: (r) => r.dataRegion,
            },
            {
              key: 'p',
              card: 'chip',
              header: t(locale, 'm8.st.col.access'),
              render: (r) => (
                <Badge tone={r.public ? 'danger' : 'success'}>
                  {r.public ? t(locale, 'm8.st.public') : t(locale, 'm8.st.private')}
                </Badge>
              ),
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
                    prefix="m8.st.status"
                    value={r.status}
                    tone={
                      r.status === 'active' ? 'success' : r.status === 'failed' ? 'danger' : 'warn'
                    }
                  />
                  {(r.status === 'provisioning' ||
                    r.status === 'deleting' ||
                    r.status === 'unknown') && (
                    <>
                      {' '}
                      <Badge tone="warn">{t(locale, 'm8.c.opInProgress')}</Badge>
                    </>
                  )}
                </>
              ),
            },
            {
              key: 'u',
              card: 'footer',
              header: t(locale, 'm8.st.col.usage'),
              icon: 'data',
              render: (r) => {
                const used = bucketUsage(r.usage).bytes;
                const f = formatBytes(used);
                if (!f) return t(locale, 'm8.c.unavailable');
                const pct = usagePercent(used, r.quotaBytes);
                return pct === null ? (
                  <>
                    <Ltr>{f}</Ltr> · {t(locale, 'm8.st.noQuota')}
                  </>
                ) : (
                  <>
                    <Ltr>{`${f} / ${formatBytes(r.quotaBytes)}`}</Ltr>
                    <Meter label={t(locale, 'm8.st.usageMeter', { name: r.name })} percent={pct} />
                  </>
                );
              },
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm8.st.title')}</PageTitle>
      <StartHero
        id="storage-hero"
        art="storage"
        title={locale === 'ar' ? 'ملفاتك في مكان واحد' : 'Keep your files in one place'}
        body={t(locale, 'm8.st.help')}
      >
        {s.can('data:storage:write') && (
          <ButtonLink href={`/storage/buckets/new`}>{t(locale, 'm8.st.new')}</ButtonLink>
        )}
      </StartHero>
      {body}
    </>
  );
}
