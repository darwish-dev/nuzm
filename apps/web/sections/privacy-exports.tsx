import { notFound } from 'next/navigation';
import { unwrap, type Schemas } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ExportRequestButton } from '../components/PrivacyPanels';
import { PrivacyTabs } from '../components/PrivacyTabs';
import { exportTone } from '../lib/privacy';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M04-06: organization data exports (owners and administrators): pending, ready with a short-lived link, expired, or no store in this environment. */
export default async function Exports({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:export:manage'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.exp.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    // the same operation can answer an archive (?download=); this screen never asks for one
    async () =>
      (await unwrap(
        s.api.GET('/v1/compliance/data-exports', { params: { query: { limit: 50 } } }),
      )) as unknown as Schemas['DataExportPage'],
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'pv.exp.empty')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'pv.exp.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'c',
              header: t(locale, 'pv.exp.col.scope'),
              render: (r) => tDynamic(locale, `pv.exp.scope.${r.scope}`, r.scope),
            },
            {
              key: 's',
              header: t(locale, 'pv.exp.col.status'),
              icon: 'pulse',
              render: (r) => (
                <Badge tone={exportTone(r.status)}>
                  {tDynamic(locale, `pv.exp.status.${r.status}`, r.status)}
                </Badge>
              ),
            },
            {
              key: 'e',
              header: t(locale, 'pv.exp.col.expires'),
              icon: 'calendar',
              render: (r) => (r.expiresAt ? formatDateTime(r.expiresAt, locale) : '—'),
            },
            {
              key: 'z',
              header: t(locale, 'pv.exp.col.size'),
              icon: 'data',
              render: (r) =>
                r.bytes === null ? '—' : <Ltr>{`${Math.ceil(r.bytes / 1024)} KB`}</Ltr>,
            },
            {
              key: 'd',
              header: '',
              render: (r) =>
                r.downloadUrl ? <a href={r.downloadUrl}>{t(locale, 'pv.exp.download')}</a> : null,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pv.exp.title')}</PageTitle>
      <PrivacyTabs locale={locale} current="exports" can={s.can} />
      <p className="nz-muted">{t(locale, 'pv.exp.help')}</p>
      <ExportRequestButton locale={locale} />
      {body}
    </>
  );
}
