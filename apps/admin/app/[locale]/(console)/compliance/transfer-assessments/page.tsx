import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ComplianceTabs } from '../../../../../components/ComplianceTabs';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** Read-only list (the edit flows for this register are not built in this milestone; see the S15 report). */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:compliance:read'))
    return (
      <>
        <PageTitle>{t(locale, 'cmp.tr.title')}</PageTitle>
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
        s.api.GET('/v1/admin/compliance/transfer-assessments', {
          params: { query: { limit: 100 } },
        }),
      ),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'cmp.tr.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'c',
              header: t(locale, 'cmp.tr.col.class'),
              render: (r) => <Ltr>{r.dataClass}</Ltr>,
            },
            {
              key: 'r',
              header: t(locale, 'cmp.tr.col.region'),
              icon: 'pin',
              render: (r) => <Ltr>{r.region}</Ltr>,
            },
            { key: 'k', header: t(locale, 'cmp.tr.col.risk'), render: (r) => r.risk },
            {
              key: 's',
              header: t(locale, 'cmp.tr.col.status'),
              icon: 'pulse',
              render: (r) => (
                <Badge
                  tone={
                    r.status === 'approved' && !r.expired
                      ? 'success'
                      : r.status === 'rejected' || r.expired
                        ? 'danger'
                        : 'warn'
                  }
                >
                  {r.expired ? 'expired' : r.status}
                </Badge>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'cmp.tr.col.expires'),
              icon: 'calendar',
              render: (r) => (r.expiresAt ? formatDateTime(r.expiresAt, locale) : '—'),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.tr.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="transfer-assessments" />
      <p className="nz-muted">{t(locale, 'cmp.tr.help')}</p>
      {body}
    </>
  );
}
