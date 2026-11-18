import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  ButtonLink,
  EmptyState,
  ForbiddenState,
  Ltr,
  PageTitle,
  Table,
} from '@nuzm/ui';
import { DomainTabs } from '../../../../components/DomainTabs';
import { domainTone, expiringSoon } from '../../../../lib/domains';
import { requireSession } from '../../../../lib/server';
import { view } from '../../../../lib/view';

/** UI-M07-01: the organization's domains: status, expiry, auto-renew and renewal risk; an expiring banner; an empty state that leads to search. */
export default async function Domains({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/domains', { params: { query: { limit: 100 } } })),
    (data) => {
      const soon = data.items.filter(
        (d) => ['active', 'renewal_at_risk'].includes(d.state) && expiringSoon(d.expiresAt),
      ).length;
      return data.items.length === 0 ? (
        <EmptyState
          title={t(locale, 'dom.empty.title')}
          body={t(locale, 'state.empty.body')}
          action={
            <ButtonLink href={`/${locale}/domains/search`}>{t(locale, 'dom.empty.cta')}</ButtonLink>
          }
        />
      ) : (
        <>
          {soon > 0 && <Banner tone="warn">{t(locale, 'dom.expiring', { count: soon })}</Banner>}
          <Table
            caption={t(locale, 'dom.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'n',
                header: t(locale, 'dom.col.name'),
                render: (r) => (
                  <a href={`/${locale}/domains/${r.id}`}>
                    <Ltr>{r.name}</Ltr>
                  </a>
                ),
              },
              {
                key: 's',
                header: t(locale, 'dom.col.state'),
                render: (r) => (
                  <Badge tone={domainTone(r.state)}>
                    {tDynamic(locale, `dom.state.${r.state}`, r.state)}
                  </Badge>
                ),
              },
              {
                key: 'e',
                header: t(locale, 'dom.col.expires'),
                render: (r) => (r.expiresAt ? formatDateTime(r.expiresAt, locale) : '—'),
              },
              {
                key: 'a',
                header: t(locale, 'dom.col.autoRenew'),
                render: (r) => t(locale, r.autoRenew ? 'dom.on' : 'dom.off'),
              },
              {
                key: 'r',
                header: t(locale, 'dom.col.risk'),
                render: (r) =>
                  r.renewalAtRisk ? (
                    <Badge tone="danger">{t(locale, 'dom.state.renewal_at_risk')}</Badge>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.title')}</PageTitle>
      <DomainTabs locale={locale} current="list" can={s.can} />
      {body}
    </>
  );
}
