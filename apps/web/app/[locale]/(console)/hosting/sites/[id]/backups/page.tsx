import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table, Icon } from '@nuzm/ui';
import { requireSession } from '../../../../../../../lib/server';
import { view } from '../../../../../../../lib/view';

/** UI-M06-08: backups (size, checksum, expiry). Creating and restoring from the screen is NOT BUILT yet; the API has both. */
export default async function Backups({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites/{id}/backups', { params: { path: { id } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.backups')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.tab.backups')}
          rows={data.items}
          rowKey={(b) => b.id}
          columns={[
            {
              key: 'k',
              icon: 'code',
              header: t(locale, 'host.col.kind'),
              render: (b) => <Ltr>{b.kind}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              icon: 'pulse',
              render: (b) => (
                <Badge
                  tone={
                    b.status === 'available'
                      ? 'success'
                      : b.status === 'creating'
                        ? 'warn'
                        : 'danger'
                  }
                >
                  {b.status}
                </Badge>
              ),
            },
            {
              key: 'z',
              header: t(locale, 'host.col.size'),
              icon: 'globe',
              render: (b) =>
                b.sizeBytes === null || b.sizeBytes === undefined ? (
                  '—'
                ) : (
                  <Ltr>{`${b.sizeBytes} B`}</Ltr>
                ),
            },
            {
              key: 'c',
              header: t(locale, 'host.col.checksum'),
              icon: 'globe',
              render: (b) => (b.checksum ? <Ltr>{b.checksum.slice(0, 16)}…</Ltr> : '—'),
            },
            {
              key: 'e',
              header: t(locale, 'host.col.expires'),
              icon: 'calendar',
              render: (b) => (b.expiresAt ? <Ltr>{b.expiresAt.slice(0, 10)}</Ltr> : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.tab.backups')}</PageTitle>
      <a className="nzc-back" href={`/hosting/sites/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'host.tab.overview')}
      </a>
      {body}
    </>
  );
}
