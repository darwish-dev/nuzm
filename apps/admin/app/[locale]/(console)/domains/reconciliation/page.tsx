import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';
import { RunRc04Button } from '../../../../../components/DomainAdminPanels';

/** UI-M07-11: RC-04 runs (provider cost vs ledger and the registrar statement). The variance threshold is D-31 (open): every non-zero variance is a break; resolution happens in the finance reconciliation screen. */
export default async function Reconciliation({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:billing:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.admin.recon.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () =>
      unwrap(
        s.api.GET('/v1/admin/billing/reconciliations', {
          params: { query: { type: 'RC-04', limit: 50 } },
        }),
      ),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'dom.admin.recon.empty')}
          body={t(locale, 'state.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'dom.admin.recon.title')}
          rows={
            data.items as {
              id: string;
              type: string;
              status: string;
              periodFrom: string;
              periodTo: string;
              breakCount?: number;
              createdAt: string;
            }[]
          }
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'p',
              header: t(locale, 'dom.col.expires'),
              icon: 'calendar',
              render: (r) => <Ltr>{`${r.periodFrom} → ${r.periodTo}`}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'dom.col.state'),
              icon: 'pulse',
              render: (r) => <Badge>{r.status}</Badge>,
            },
            { key: 'b', header: '#', render: (r) => <Ltr>{String(r.breakCount ?? 0)}</Ltr> },
            { key: 'c', header: '', render: (r) => formatDateTime(r.createdAt, locale) },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.admin.recon.title')}</PageTitle>
      <Banner tone="warn">{t(locale, 'dom.admin.recon.help')}</Banner>
      {s.can('admin:billing:manage') ? (
        <RunRc04Button locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
      ) : null}
      {body}
    </>
  );
}
