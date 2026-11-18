import { notFound } from 'next/navigation';
import { ApiError, unwrap, type Schemas } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { PrivacyTabs } from '../../../../../../components/PrivacyTabs';
import { slaTone, statusTone } from '../../../../../../lib/privacy';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M04-04: one request: its status, deadline, steps and, when it was refused, the reason in plain words. The archive link is shown when ready. */
export default async function RequestDetail({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:dsr:self'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.req.detail')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  let r: Schemas['DsrRequest'];
  try {
    // the same operation can answer an archive (?download=); this screen never asks for one
    r = (await unwrap(
      s.api.GET('/v1/compliance/data-subject-requests/{id}', { params: { path: { id } } }),
    )) as unknown as Schemas['DsrRequest'];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const rr = r;
  const body = await view(
    locale,
    async () => rr,
    (d) => (
      <>
        <section className="nz-card" aria-label={t(locale, 'pv.req.detail')}>
          <p>
            <strong>{tDynamic(locale, `pv.req.type.${d.type}`, d.type)}</strong>{' '}
            <Badge tone={statusTone(d.status)}>
              {tDynamic(locale, `pv.req.status.${d.status}`, d.status)}
            </Badge>{' '}
            {d.closedAt === null && (
              <Badge tone={slaTone(d.slaState)}>
                {tDynamic(locale, `pv.req.sla.${d.slaState}`, d.slaState)}
              </Badge>
            )}
          </p>
          <p className="nz-muted">
            {t(locale, 'pv.req.col.due')}: {formatDateTime(d.dueAt, locale)}
          </p>
          {d.reason && (
            <Banner tone="warn">
              {t(locale, 'pv.req.reason')}: {locale === 'ar' ? d.reason.ar : d.reason.en}
            </Banner>
          )}
          {d.downloadUrl && (
            <p>
              <a href={d.downloadUrl}>{t(locale, 'pv.req.download')}</a>
              <span className="nz-muted"> {t(locale, 'pv.req.downloadHelp')}</span>
            </p>
          )}
        </section>
        {d.tasks.length > 0 && (
          <>
            <h2 className="nz-h2">{t(locale, 'pv.req.tasks')}</h2>
            <Table
              caption={t(locale, 'pv.req.tasks')}
              rows={d.tasks}
              rowKey={(r2) => `${r2.handler}-${r2.action}`}
              columns={[
                {
                  key: 'h',
                  header: t(locale, 'pv.req.task.col.handler'),
                  render: (r2) => <Ltr>{r2.handler}</Ltr>,
                },
                {
                  key: 's',
                  header: t(locale, 'pv.req.task.col.status'),
                  icon: 'pulse',
                  render: (r2) => tDynamic(locale, `pv.req.task.${r2.status}`, r2.status),
                },
                {
                  key: 'r',
                  header: t(locale, 'pv.req.task.col.reason'),
                  render: (r2) =>
                    r2.reason ? (locale === 'ar' ? r2.reason.ar : r2.reason.en) : '—',
                },
              ]}
            />
          </>
        )}
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pv.req.detail')}</PageTitle>
      <PrivacyTabs locale={locale} current="requests" can={s.can} />
      {body}
    </>
  );
}
