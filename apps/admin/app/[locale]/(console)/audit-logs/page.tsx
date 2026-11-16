import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  ButtonLink,
  EmptyState,
  Field,
  Input,
  Ltr,
  PageTitle,
  Table,
  Button,
} from '@nuzm/ui';
import { requireStaff } from '../../../../lib/server';
import { view } from '../../../../lib/view';

export default async function AuditLogs({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ action?: string; cursor?: string }>;
}) {
  const { locale } = await params;
  const q = await searchParams;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const body = await view(
    locale,
    async () =>
      await unwrap(
        s.api.GET('/v1/admin/audit-logs', {
          params: {
            query: { limit: 25, action: q.action || undefined, cursor: q.cursor || undefined },
          },
        }),
      ),
    (page) => (
      <>
        {page.items.length === 0 ? (
          <EmptyState title={t(locale, 'state.empty.title')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'admin.audit.title')}
            rows={page.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'when',
                header: t(locale, 'field.when'),
                render: (r) => formatDateTime(r.occurredAt, locale),
              },
              {
                key: 'action',
                header: t(locale, 'field.action'),
                render: (r) => <Ltr>{r.action}</Ltr>,
              },
              {
                key: 'actor',
                header: t(locale, 'field.actor'),
                render: (r) => tDynamic(locale, `actor.${r.actor.type ?? ''}`, r.actor.type ?? ''),
              },
              {
                key: 'resource',
                header: t(locale, 'field.resource'),
                render: (r) =>
                  r.resource.type ? (
                    <Ltr>{`${r.resource.type}${r.resource.id ? `:${r.resource.id.slice(0, 8)}` : ''}`}</Ltr>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'outcome',
                header: t(locale, 'field.outcome'),
                render: (r) => (
                  <Badge tone={r.outcome === 'success' ? 'success' : 'danger'}>
                    {t(locale, `outcome.${r.outcome}`)}
                  </Badge>
                ),
              },
            ]}
          />
        )}
        {page.nextCursor && (
          <p>
            <ButtonLink
              variant="secondary"
              href={`?${new URLSearchParams({ ...(q.action ? { action: q.action } : {}), cursor: page.nextCursor })}`}
            >
              {t(locale, 'action.loadMore')}
            </ButtonLink>
          </p>
        )}
        <p className="nz-muted">{t(locale, 'audit.integrity')}</p>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'admin.audit.title')}</PageTitle>
      <form method="get" className="nz-row" role="search">
        <Field id="action" label={t(locale, 'audit.filter.action')}>
          {(a) => <Input name="action" defaultValue={q.action} dir="ltr" {...a} />}
        </Field>
        <Button type="submit">{t(locale, 'action.search')}</Button>
      </form>
      {body}
    </>
  );
}
