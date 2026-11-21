import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table, Icon } from '@nuzm/ui';
import { requireSession } from '../../../../../../../lib/server';
import { view } from '../../../../../../../lib/view';

/** UI-M06-05: bound domains with the verification record while a binding is pending. */
export default async function Domains({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/hosting/sites/{id}/domains', { params: { path: { id } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'host.none.domains')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'host.tab.domains')}
          rows={data.items}
          rowKey={(d) => d.id}
          columns={[
            {
              key: 'd',
              header: t(locale, 'host.col.domain'),
              icon: 'globe',
              render: (d) => <Ltr>{d.domain}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'host.col.status'),
              icon: 'pulse',
              render: (d) => (
                <Badge tone={d.state === 'active' ? 'success' : 'warn'}>
                  {tDynamic(locale, `host.status.${d.state}`, d.state)}
                </Badge>
              ),
            },
            {
              key: 'v',
              header: t(locale, 'host.dom.pending').slice(0, 24),
              render: (d) => {
                const rec = d.verification?.record as
                  { type?: string; name?: string; value?: string } | undefined;
                return rec ? (
                  <Ltr>
                    {t(locale, 'host.dom.record', {
                      type: rec.type ?? '',
                      name: rec.name ?? '',
                      value: rec.value ?? '',
                    })}
                  </Ltr>
                ) : (
                  '—'
                );
              },
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.tab.domains')}</PageTitle>
      <a className="nzc-back" href={`/hosting/sites/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'host.tab.overview')}
      </a>
      {body}
    </>
  );
}
