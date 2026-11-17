import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
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
        <PageTitle>{t(locale, 'cmp.ret.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/compliance/retention-policies', { params: { query: {} } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'cmp.ret.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'c',
              header: t(locale, 'cmp.ret.col.class'),
              render: (r) => <Ltr>{r.dataClass}</Ltr>,
            },
            {
              key: 'd',
              header: t(locale, 'cmp.ret.col.dataset'),
              render: (r) => (r.dataset ? <Ltr>{r.dataset}</Ltr> : '—'),
            },
            {
              key: 'r',
              header: t(locale, 'cmp.ret.col.retain'),
              render: (r) => <Ltr>{String(r.retainDays)}</Ltr>,
            },
            {
              key: 'a',
              header: t(locale, 'cmp.ret.col.archive'),
              render: (r) => <Ltr>{String(r.archiveAfterDays)}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'cmp.ret.col.status'),
              render: (r) => <Badge>{r.status}</Badge>,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.ret.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="retention" />
      <p className="nz-muted">{t(locale, 'cmp.ret.help')}</p>
      {body}
    </>
  );
}
