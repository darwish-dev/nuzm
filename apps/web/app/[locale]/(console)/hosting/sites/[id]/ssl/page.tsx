import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { HostingTabs } from '../../../../../../../components/HostingTabs';
import { requireSession } from '../../../../../../../lib/server';
import { view } from '../../../../../../../lib/view';

/** UI-M06-06: certificates with expiry warnings (the private key of a custom certificate is never shown). */
export default async function Ssl({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    () =>
      unwrap(s.api.GET('/v1/hosting/sites/{id}/ssl-certificates', { params: { path: { id } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.certs')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          {data.items.some(
            (c) =>
              c.status === 'issued' &&
              c.expiresInDays !== null &&
              c.expiresInDays !== undefined &&
              c.expiresInDays < 30,
          ) && <Banner tone="warn">{t(locale, 'host.ssl.expiring')}</Banner>}
          <Table
            caption={t(locale, 'host.tab.ssl')}
            rows={data.items}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'd',
                header: t(locale, 'host.col.domain'),
                render: (c) => <Ltr>{c.domains.join(', ')}</Ltr>,
              },
              { key: 'm', header: t(locale, 'host.col.mode'), render: (c) => c.mode },
              {
                key: 's',
                header: t(locale, 'host.col.status'),
                render: (c) => (
                  <Badge
                    tone={
                      c.status === 'issued' ? 'success' : c.status === 'failed' ? 'danger' : 'warn'
                    }
                  >
                    {tDynamic(locale, `host.status.${c.status}`, c.status)}
                  </Badge>
                ),
              },
              {
                key: 'e',
                header: t(locale, 'host.col.expires'),
                render: (c) =>
                  c.expiresInDays === null || c.expiresInDays === undefined
                    ? '—'
                    : t(locale, 'host.ssl.expires', { days: c.expiresInDays }),
              },
              { key: 'a', header: t(locale, 'host.col.attempts'), render: (c) => c.attempts },
            ]}
          />
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.tab.ssl')}</PageTitle>
      <HostingTabs locale={locale} siteId={id} current="ssl" />
      {body}
    </>
  );
}
