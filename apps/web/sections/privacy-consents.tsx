import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, ForbiddenState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { PrivacyTabs } from '../components/PrivacyTabs';
import { WithdrawButton } from '../components/PrivacyPanels';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** UI-M04-01: the consents of the signed-in person (administrators see the organization's). Withdrawal applies at once; the history is kept. */
export default async function Consents({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('privacy:consent:self'))
    return (
      <>
        <PageTitle>{t(locale, 'pv.consents.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/compliance/consents', { params: { query: { limit: 100 } } })),
    (data) =>
      data.items.length === 0 ? (
        <EmptyState title={t(locale, 'pv.consents.empty')} body={t(locale, 'state.empty.body')} />
      ) : (
        <Table
          caption={t(locale, 'pv.consents.title')}
          rows={data.items}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'p',
              header: t(locale, 'pv.consents.col.purpose'),
              render: (r) => <Ltr>{r.purposeId}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'pv.consents.col.state'),
              icon: 'pulse',
              render: (r) => (
                <Badge tone={r.state === 'granted' ? 'success' : 'warn'}>
                  {tDynamic(locale, `pv.consents.state.${r.state}`, r.state)}
                </Badge>
              ),
            },
            {
              key: 'u',
              header: t(locale, 'pv.consents.col.subject'),
              render: (r) => (
                <Ltr>{r.subjectRef === 'org' ? 'org' : r.subjectRef.slice(0, 15)}</Ltr>
              ),
            },
            {
              key: 'd',
              header: t(locale, 'pv.consents.col.date'),
              icon: 'calendar',
              render: (r) => formatDateTime(r.createdAt, locale),
            },
            {
              key: 'a',
              header: '',
              render: (r) =>
                r.state === 'granted' ? <WithdrawButton locale={locale} id={r.id} /> : null,
            },
          ]}
        />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'pv.consents.title')}</PageTitle>
      <PrivacyTabs locale={locale} current="consents" can={s.can} />
      <p className="nz-muted">{t(locale, 'pv.consents.help')}</p>
      {body}
      <p className="nz-muted">{t(locale, 'pv.consents.grantMissing')}</p>
    </>
  );
}
