import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ComplianceTabs } from '../../../../../components/ComplianceTabs';
import { ControlMapForm } from '../../../../../components/CompliancePanels';
import { controlTone } from '../../../../../lib/compliance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M04-09: the control register. Statuses say only what exists (mapped, evidence collected, reviewed), never a verdict. */
export default async function Controls({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:compliance:read'))
    return (
      <>
        <PageTitle>{t(locale, 'cmp.ctl.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/compliance/controls', { params: { query: {} } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
      ) : (
        <>
          <Table
            caption={t(locale, 'cmp.ctl.title')}
            rows={data.items}
            rowKey={(r) => r.controlId}
            columns={[
              {
                key: 'id',
                header: t(locale, 'cmp.ctl.col.id'),
                render: (r) => <Ltr>{r.controlId}</Ltr>,
              },
              { key: 'ti', header: t(locale, 'cmp.ctl.col.title'), render: (r) => r.title },
              {
                key: 'ow',
                header: t(locale, 'cmp.ctl.col.owner'),
                icon: 'user',
                render: (r) => <Ltr>{r.ownerRole}</Ltr>,
              },
              {
                key: 'im',
                header: t(locale, 'cmp.ctl.col.impl'),
                render: (r) =>
                  tDynamic(
                    locale,
                    `cmp.ctl.impl.${r.implementation.status}`,
                    r.implementation.status,
                  ),
              },
              {
                key: 'st',
                header: t(locale, 'cmp.ctl.col.status'),
                icon: 'pulse',
                render: (r) => (
                  <>
                    <Badge tone={controlTone(r.status)}>
                      {tDynamic(locale, `cmp.ctl.status.${r.status}`, r.status)}
                    </Badge>
                    {r.evidence.latestReview && (
                      <div className="nz-muted">
                        {t(locale, 'cmp.ctl.reviewedBy', {
                          role: r.evidence.latestReview.reviewerRole ?? '—',
                        })}
                        {r.evidence.latestReview.overdue
                          ? ` · ${t(locale, 'cmp.ctl.overdue')}`
                          : ''}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'ma',
                header: t(locale, 'cmp.ctl.col.mappings'),
                render: (r) =>
                  r.mappings.length === 0
                    ? '—'
                    : r.mappings.map((m) => `${m.module}: ${m.feature}`).join('; '),
              },
              {
                key: 'ev',
                header: t(locale, 'cmp.ctl.col.evidence'),
                render: (r) => (
                  <>
                    {t(locale, 'cmp.ctl.automated', { n: r.evidence.automated })}
                    {r.evidence.latestAutomated && (
                      <div className="nz-muted">
                        {t(locale, 'cmp.ctl.lastRun', {
                          collector: r.evidence.latestAutomated.collector,
                        })}{' '}
                        · {formatDateTime(r.evidence.latestAutomated.collectedAt, locale)}
                        {r.evidence.latestAutomated.ok === false
                          ? ` · ${t(locale, 'cmp.ctl.failed')}`
                          : ''}
                      </div>
                    )}
                  </>
                ),
              },
            ]}
          />
          {s.can('admin:controls:manage') && (
            <ControlMapForm
              locale={locale}
              mfaFactorId={s.me.mfaFactorId ?? null}
              controls={data.items.map((c) => ({ controlId: c.controlId, title: c.title }))}
            />
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.ctl.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="controls" />
      <Banner tone="warn">{t(locale, 'cmp.notice')}</Banner>
      {body}
    </>
  );
}
