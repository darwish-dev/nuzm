import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';
import { ReconcileButton } from '../../../../../components/DomainAdminPanels';

/** UI-M07-10: domains with their latest order; the queue of orders waiting on the registrar (needs_reconcile / provider_pending) with a forced reconcile. */
export default async function Orders({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ queue?: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const sp = await searchParams;
  const s = await requireStaff(locale);
  if (!s.can('admin:domains:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.admin.orders.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const queue = sp.queue === '1';
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/domains', {
          params: { query: { limit: 100, ...(queue ? { needsReconcile: true } : {}) } },
        }),
      ),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'dom.admin.orders.empty')}
          body={t(locale, 'state.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'dom.admin.orders.title')}
          rows={
            data.items as {
              id: string;
              orgId: string;
              name: string;
              state: string;
              registrar: string;
              lastOrder: { type: string; state: string } | null;
            }[]
          }
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'n',
              header: t(locale, 'dom.col.name'),
              render: (r) => (
                <a href={`/${locale}/domains/${r.id}`}>
                  <Ltr>{r.name}</Ltr>
                </a>
              ),
            },
            {
              key: 'o',
              header: t(locale, 'dom.admin.orders.col.org'),
              render: (r) => <Ltr>{r.orgId.slice(0, 8)}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'dom.col.state'),
              render: (r) => <Badge>{tDynamic(locale, `dom.state.${r.state}`, r.state)}</Badge>,
            },
            {
              key: 'l',
              header: t(locale, 'dom.admin.orders.col.order'),
              render: (r) =>
                r.lastOrder ? <Ltr>{`${r.lastOrder.type}: ${r.lastOrder.state}`}</Ltr> : '—',
            },
            {
              key: 'a',
              header: '',
              render: (r) =>
                s.can('admin:domains:manage') ? (
                  <ReconcileButton
                    locale={locale}
                    id={r.id}
                    mfaFactorId={s.me.mfaFactorId ?? null}
                  />
                ) : null,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.admin.orders.title')}</PageTitle>
      <nav className="nz-row" aria-label={t(locale, 'dom.admin.orders.title')}>
        <a
          className="nz-btn"
          data-variant={queue ? 'secondary' : 'primary'}
          href={`/${locale}/domains/orders`}
        >
          {t(locale, 'dom.admin.orders.title')}
        </a>
        <a
          className="nz-btn"
          data-variant={queue ? 'primary' : 'secondary'}
          href={`/${locale}/domains/orders?queue=1`}
        >
          {t(locale, 'dom.admin.orders.onlyReconcile')}
        </a>
      </nav>
      {body}
    </>
  );
}
