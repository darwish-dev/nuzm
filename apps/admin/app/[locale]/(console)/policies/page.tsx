import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { GovernanceTabs } from '../../../../components/M12Tabs';
import { PolicyPublishForm } from '../../../../components/GovernancePanels';
import { gate } from '../../../../lib/gate';
import { shortId } from '../../../../lib/ops';
import { view } from '../../../../lib/view';

/** UI-M12-12: policy versions (security, privacy, AUP, ...). The body is a document reference, never the text; a version without an approver is a draft. */
export default async function Policies({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ history?: string }>;
}) {
  const g = await gate(params, 'admin:compliance:read', 'm12.pol.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const q = await searchParams;
  const history = q.history === 'true';
  const canManage = s.can('admin:compliance:manage');
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/policy-versions', { params: { query: { history } } })),
    (data) => {
      const versions: Record<string, number> = {};
      for (const p of data.items)
        versions[p.policyKey] = Math.max(versions[p.policyKey] ?? 0, p.version);
      return (
        <>
          <p>
            <a href={`/${locale}/policies${history ? '' : '?history=true'}`}>
              {t(locale, history ? 'm12.pol.showCurrent' : 'm12.pol.showHistory')}
            </a>
          </p>
          {data.items.length === 0 ? (
            <EmptyState title={t(locale, 'm12.pol.none')} body={t(locale, 'm12.pol.noneBody')} />
          ) : (
            <Table
              caption={t(locale, 'm12.pol.title')}
              rows={data.items}
              rowKey={(r) => r.id}
              columns={[
                {
                  key: 'k',
                  header: t(locale, 'm12.pol.col.key'),
                  render: (r) => <Ltr>{r.policyKey}</Ltr>,
                },
                {
                  key: 'v',
                  header: t(locale, 'm12.pol.col.version'),
                  render: (r) => <Ltr>{String(r.version)}</Ltr>,
                },
                { key: 't', header: t(locale, 'm12.pol.col.title'), render: (r) => r.title ?? '—' },
                {
                  key: 'st',
                  header: t(locale, 'field.status'),
                  render: (r) =>
                    r.status ? (
                      <Badge tone={r.status === 'approved' ? 'success' : 'warn'}>
                        {tDynamic(locale, `m12.pol.status.${r.status}`, r.status)}
                      </Badge>
                    ) : (
                      '—'
                    ),
                },
                {
                  key: 'ef',
                  header: t(locale, 'm12.pol.col.effective'),
                  render: (r) => (r.effectiveFrom ? <Ltr>{r.effectiveFrom}</Ltr> : '—'),
                },
                {
                  key: 'ref',
                  header: t(locale, 'm12.pol.col.ref'),
                  render: (r) => (r.bodyRef ? <Ltr>{r.bodyRef}</Ltr> : '—'),
                },
                {
                  key: 'ap',
                  header: t(locale, 'm12.pol.col.approved'),
                  render: (r) =>
                    r.approvedBy ? (
                      <>
                        <Ltr>{shortId(r.approvedBy)}</Ltr>
                        {r.approvalRef && (
                          <div>
                            <Ltr>{r.approvalRef}</Ltr>
                          </div>
                        )}
                      </>
                    ) : (
                      t(locale, 'm12.pol.notApproved')
                    ),
                },
                {
                  key: 'cr',
                  header: t(locale, 'field.created'),
                  render: (r) => (r.createdAt ? formatDateTime(r.createdAt, locale) : '—'),
                },
              ]}
            />
          )}
          {canManage ? (
            <PolicyPublishForm
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              versions={versions}
            />
          ) : (
            <p className="nz-muted">{t(locale, 'm12.readOnly')}</p>
          )}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.pol.title')}</PageTitle>
      <GovernanceTabs locale={locale} current="policies" can={s.can} />
      <Banner tone="warn">{t(locale, 'm12.pol.help')}</Banner>
      {body}
    </>
  );
}
