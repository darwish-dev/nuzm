import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, PageTitle, Table } from '@nuzm/ui';
import { OpsTabs } from '../../../../components/M12Tabs';
import { gate } from '../../../../lib/gate';
import { shortId } from '../../../../lib/ops';
import { view } from '../../../../lib/view';

/** UI-M12-08: provider status events linked to platform incidents. Read-only: they are written by feed ingestion; there is no write endpoint. */
export default async function ProviderIncidents({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ providerKey?: string; status?: string; cursor?: string }>;
}) {
  const g = await gate(params, 'admin:ops:read', 'm12.pi.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const providerKey = q.providerKey?.trim() || undefined;
  const status = q.status?.trim() || undefined;
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/provider-incidents', {
          params: { query: { limit: 50, providerKey, status, cursor: q.cursor || undefined } },
        }),
      ),
    (data) => (
      <>
        {data.items.length === 0 ? (
          <EmptyState title={t(locale, 'm12.pi.none')} body={t(locale, 'm12.pi.noneBody')} />
        ) : (
          <Table
            caption={t(locale, 'm12.pi.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'p',
                header: t(locale, 'm12.pi.col.provider'),
                render: (r) => <Ltr>{r.providerKey}</Ltr>,
              },
              {
                key: 't',
                header: t(locale, 'm12.pi.col.title'),
                render: (r) => r.title ?? '—',
              },
              {
                key: 'st',
                header: t(locale, 'field.status'),
                render: (r) => (
                  <Badge tone={r.resolvedAt ? 'success' : 'warn'}>
                    {tDynamic(locale, `m12.pi.status.${r.status}`, r.status)}
                  </Badge>
                ),
              },
              {
                key: 'ref',
                header: t(locale, 'm12.pi.col.ref'),
                render: (r) => (r.externalRef ? <Ltr>{r.externalRef}</Ltr> : '—'),
              },
              {
                key: 'sa',
                header: t(locale, 'm12.pi.col.started'),
                render: (r) => (r.startedAt ? formatDateTime(r.startedAt, locale) : '—'),
              },
              {
                key: 'ra',
                header: t(locale, 'm12.pi.col.resolved'),
                render: (r) =>
                  r.resolvedAt ? formatDateTime(r.resolvedAt, locale) : t(locale, 'm12.pi.ongoing'),
              },
              {
                key: 'rel',
                header: t(locale, 'm12.pi.col.related'),
                render: (r) =>
                  r.relatedIncidentId ? (
                    <a href={`/${locale}/incidents/${r.relatedIncidentId}`}>
                      <Ltr>{shortId(r.relatedIncidentId)}</Ltr>
                    </a>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'src',
                header: t(locale, 'm12.pi.col.source'),
                render: (r) => (r.source ? <Ltr>{r.source}</Ltr> : '—'),
              },
            ]}
          />
        )}
        {data.nextCursor && (
          <p>
            <a
              href={`/${locale}/provider-incidents?${new URLSearchParams({
                ...(providerKey ? { providerKey } : {}),
                ...(status ? { status } : {}),
                cursor: data.nextCursor,
              }).toString()}`}
            >
              {t(locale, 'action.loadMore')}
            </a>
          </p>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.pi.title')}</PageTitle>
      <OpsTabs locale={locale} current="providerIncidents" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.pi.help')}</Banner>
      <form method="get" className="nz-row" aria-label={t(locale, 'm12.pi.filter')}>
        <Field id="pf-provider" label={t(locale, 'm12.pi.col.provider')}>
          {(x) => <Input {...x} name="providerKey" dir="ltr" defaultValue={providerKey ?? ''} />}
        </Field>
        <Field id="pf-status" label={t(locale, 'field.status')}>
          {(x) => <Input {...x} name="status" dir="ltr" defaultValue={status ?? ''} />}
        </Field>
        <Button type="submit" variant="secondary">
          {t(locale, 'action.search')}
        </Button>
      </form>
      {body}
    </>
  );
}
