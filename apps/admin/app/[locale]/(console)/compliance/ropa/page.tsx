import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t, tDynamic } from '@nuzm/i18n';
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
        <PageTitle>{t(locale, 'cmp.ropa.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/compliance/ropa', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'cmp.ropa.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'k',
              header: t(locale, 'cmp.ropa.col.key'),
              render: (r) => <Ltr>{r.entryKey}</Ltr>,
            },
            { key: 'a', header: t(locale, 'cmp.ropa.col.activity'), render: (r) => r.activity },
            {
              key: 'c',
              header: t(locale, 'cmp.ropa.col.classes'),
              render: (r) => <Ltr>{r.dataClasses.join(', ')}</Ltr>,
            },
            {
              key: 'p',
              header: t(locale, 'cmp.ropa.col.processors'),
              render: (r) =>
                r.processors.length === 0 ? '—' : r.processors.map((x) => x.name).join(', '),
            },
            {
              key: 's',
              header: t(locale, 'cmp.ropa.col.status'),
              render: (r) => (
                <Badge>{tDynamic(locale, `cmp.ropa.status.${r.status}`, r.status)}</Badge>
              ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.ropa.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="ropa" />
      <p className="nz-muted">{t(locale, 'cmp.ropa.help')}</p>
      {body}
    </>
  );
}
