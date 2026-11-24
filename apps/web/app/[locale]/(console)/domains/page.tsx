import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  ButtonLink,
  EmptyState,
  ForbiddenState,
  OnOff,
  Icon,
  Ltr,
  PageTitle,
  Table,
} from '@nuzm/ui';
import { domainTone, expiringSoon } from '../../../../lib/domains';
import { StartHero } from '../../../../components/StartHero';
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
            <ButtonLink href={`/domains/search`}>{t(locale, 'dom.empty.cta')}</ButtonLink>
          }
        />
      ) : (
        <>
          {soon > 0 && <Banner tone="warn">{t(locale, 'dom.expiring', { count: soon })}</Banner>}
          <Table
            caption={t(locale, 'dom.title')}
            rows={data.items}
            rowKey={(r) => r.id}
            cardIcon="domains"
            rowHref={(r) => `/domains/${r.id}`}
            manageLabel={t(locale, 'action.manage')}
            columns={[
              {
                key: 'n',
                card: 'title',
                header: t(locale, 'dom.col.name'),
                render: (r) => (
                  <a className="nzc-dname-cell" href={`/domains/${r.id}`}>
                    <Ltr>{r.name}</Ltr>
                  </a>
                ),
              },
              {
                key: 's',
                card: 'badge',
                header: t(locale, 'dom.col.state'),
                icon: 'pulse',
                render: (r) => (
                  <Badge tone={domainTone(r.state)}>
                    {tDynamic(locale, `dom.state.${r.state}`, r.state)}
                  </Badge>
                ),
              },
              {
                key: 'e',
                card: 'footer',
                header: t(locale, 'dom.col.expires'),
                icon: 'calendar',
                render: (r) => (r.expiresAt ? formatDateTime(r.expiresAt, locale) : '—'),
              },
              {
                key: 'a',
                card: 'meta',
                header: t(locale, 'dom.col.autoRenew'),
                icon: 'refresh',
                render: (r) => (
                  <OnOff on={r.autoRenew}>{t(locale, r.autoRenew ? 'dom.on' : 'dom.off')}</OnOff>
                ),
              },
              {
                key: 'r',
                card: 'chip',
                header: t(locale, 'dom.col.risk'),
                icon: 'shield',
                render: (r) =>
                  r.renewalAtRisk ? (
                    <Badge tone="danger">{t(locale, 'dom.state.renewal_at_risk')}</Badge>
                  ) : null,
              },
            ]}
          />
        </>
      );
    },
  );
  const canBuy = s.can('domain:search');
  const canTransfer = s.can('domain:write');
  return (
    <>
      <PageTitle>{t(locale, 'dom.title')}</PageTitle>
      {(canBuy || canTransfer) && (
        <StartHero
          id="dom-hero"
          art="domains"
          title={t(locale, 'dom.hero.title')}
          body={t(locale, 'dom.hero.body')}
        >
          {canTransfer && (
            <ButtonLink variant="secondary" href={`/domains/transfers#start`}>
              <Icon name="transfer" size={18} />
              {t(locale, 'dom.action.transfer')}
            </ButtonLink>
          )}
          {canBuy && (
            <ButtonLink href={`/domains/search`}>
              <Icon name="search" size={18} />
              {t(locale, 'dom.action.buy')}
            </ButtonLink>
          )}
        </StartHero>
      )}
      {body}
    </>
  );
}
