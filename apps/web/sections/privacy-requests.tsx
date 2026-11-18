import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, EmptyState, ForbiddenState, PageTitle, Table } from '@nuzm/ui';
import { PrivacyTabs } from '../components/PrivacyTabs';
import { slaTone, statusTone } from '../lib/privacy';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M04-02: the requests, with the deadline state (on time, near, escalated, overdue). A member sees their own; administrators see the organization's. */
export default async function Requests({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:dsr:self'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.req.title')}</PageTitle>
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
        s.api.GET('/v1/compliance/data-subject-requests', { params: { query: { limit: 100 } } }),
      ),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'pv.req.empty')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'pv.req.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          rowHref={(r) => `/${locale}/privacy/requests/${r.id}`}
          manageLabel={t(locale, 'action.manage')}
          columns={[
            {
              key: 't',
              header: t(locale, 'pv.req.col.type'),
              icon: 'code',
              render: (r) => (
                <a href={`/${locale}/privacy/requests/${r.id}`}>
                  {tDynamic(locale, `pv.req.type.${r.type}`, r.type)}
                </a>
              ),
            },
            {
              key: 's',
              header: t(locale, 'pv.req.col.status'),
              icon: 'pulse',
              render: (r) => (
                <Badge tone={statusTone(r.status)}>
                  {tDynamic(locale, `pv.req.status.${r.status}`, r.status)}
                </Badge>
              ),
            },
            {
              key: 'd',
              header: t(locale, 'pv.req.col.due'),
              icon: 'calendar',
              render: (r) => formatDateTime(r.dueAt, locale),
            },
            {
              key: 'l',
              header: t(locale, 'pv.req.col.sla'),
              render: (r) =>
                ['fulfilled', 'rejected', 'partially_fulfilled'].includes(r.status) ? (
                  '—'
                ) : (
                  <Badge tone={slaTone(r.slaState)}>
                    {tDynamic(locale, `pv.req.sla.${r.slaState}`, r.slaState)}
                  </Badge>
                ),
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pv.req.title')}</PageTitle>
      <PrivacyTabs locale={locale} current="requests" can={s.can} />
      <p className="nz-muted">{t(locale, 'pv.req.help')}</p>
      <p>
        <ButtonLink href={`/${locale}/privacy/requests/new`}>{t(locale, 'pv.req.new')}</ButtonLink>
      </p>
      {body}
    </>
  );
}
