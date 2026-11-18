import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ComplianceTabs } from '../../../../../components/ComplianceTabs';
import { EvidenceForm } from '../../../../../components/CompliancePanels';
import { shortHash } from '../../../../../lib/compliance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M04-10: evidence. Automated items come from the collectors (hash shown); people add documents, attestations and external reports. */
export default async function Evidence({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:compliance:read'))
    return (
      <>
        <PageTitle>{t(locale, 'cmp.ev.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const [ev, ctl] = await Promise.all([
        unwrap(s.api.GET('/v1/admin/compliance/evidence', { params: { query: { limit: 100 } } })),
        unwrap(s.api.GET('/v1/admin/compliance/controls', { params: { query: {} } })),
      ]);
      return { ev, ctl };
    },
    ({ ev, ctl }) => (
      <>
        {ev.items.length === 0 ? (
          <EmptyState title={t(locale, 'cmp.none')} body={t(locale, 'state.empty.body')} />
        ) : (
          <Table
            caption={t(locale, 'cmp.ev.title')}
            rows={ev.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'c',
                header: t(locale, 'cmp.ev.col.control'),
                render: (r) => <Ltr>{r.controlId}</Ltr>,
              },
              {
                key: 't',
                header: t(locale, 'cmp.ev.col.type'),
                icon: 'code',
                render: (r) => tDynamic(locale, `cmp.ev.type.${r.type}`, r.type),
              },
              {
                key: 's',
                header: t(locale, 'cmp.ev.col.source'),
                render: (r) => (
                  <Ltr>
                    {r.collector
                      ? `${r.collector} v${r.collectorVersion ?? ''}`
                      : (r.documentRef ?? r.source)}
                  </Ltr>
                ),
              },
              {
                key: 'h',
                header: t(locale, 'cmp.ev.col.hash'),
                render: (r) => (
                  <Ltr>
                    <span title={r.contentHash}>{shortHash(r.contentHash)}</span>
                  </Ltr>
                ),
              },
              {
                key: 'b',
                header: t(locale, 'cmp.ev.col.by'),
                icon: 'user',
                render: (r) => (r.attestedBy ? <Ltr>{r.attestedBy.slice(0, 8)}</Ltr> : '—'),
              },
              {
                key: 'd',
                header: t(locale, 'cmp.col.date'),
                icon: 'calendar',
                render: (r) => formatDateTime(r.collectedAt, locale),
              },
            ]}
          />
        )}
        {s.can('admin:controls:manage') && (
          <EvidenceForm
            locale={locale}
            mfaFactorId={s.me.mfaFactorId ?? null}
            controls={ctl.items.map((c) => ({ controlId: c.controlId, title: c.title }))}
          />
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'cmp.ev.title')}</PageTitle>
      <ComplianceTabs locale={locale} current="evidence" />
      <p className="nz-muted">{t(locale, 'cmp.ev.help')}</p>
      {body}
    </>
  );
}
