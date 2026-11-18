import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, ForbiddenState, Ltr, PageTitle } from '@nuzm/ui';
import { DomainSettings, RenewButton } from '../../../../../components/DomainPanels';
import { domainTone } from '../../../../../lib/domains';
import { requireSession } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/** UI-M07-04: overview, nameservers, lock, auto-renew; pending / reconciling / degraded states are explained. Read for everyone, write for owner/admin/developer. */
export default async function DomainPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('domain:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.detail.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/domains/{id}', { params: { path: { id } } })),
    (d) => (
      <>
        <Card>
          <p>
            <Ltr>{d.name}</Ltr>{' '}
            <Badge tone={domainTone(d.state)}>
              {tDynamic(locale, `dom.state.${d.state}`, d.state)}
            </Badge>
          </p>
          {d.state === 'pending' || d.state === 'transferring' ? (
            <Banner tone="warn">{t(locale, 'dom.detail.pending')}</Banner>
          ) : null}
          {d.renewalAtRisk ? (
            <Banner tone="danger">{t(locale, 'dom.state.renewal_at_risk')}</Banner>
          ) : null}
          <dl>
            <dt>{t(locale, 'dom.col.expires')}</dt>
            <dd>{d.expiresAt ? formatDateTime(d.expiresAt, locale) : '—'}</dd>
            <dt>{t(locale, 'dom.detail.region')}</dt>
            <dd>
              <Ltr>{d.providerRegionId ?? '—'}</Ltr>
            </dd>
          </dl>
          {s.can('domain:renew') && d.state !== 'pending' && d.state !== 'failed' ? (
            <RenewButton locale={locale} id={d.id} name={d.name} />
          ) : null}
        </Card>
        {s.can('domain:write') ? (
          <DomainSettings
            locale={locale}
            id={d.id}
            version={d.version}
            nameservers={d.nameservers}
            locked={d.locked}
            autoRenew={d.autoRenew}
            caps={d.capabilities}
          />
        ) : null}
        <nav aria-label={t(locale, 'dom.detail.links')} className="nz-row">
          <a className="nz-btn" data-variant="secondary" href={`/${locale}/domains/${d.id}/dns`}>
            {t(locale, 'dom.link.dns')}
          </a>
          <a
            className="nz-btn"
            data-variant="secondary"
            href={`/${locale}/domains/${d.id}/contacts`}
          >
            {t(locale, 'dom.link.contacts')}
          </a>
          <a
            className="nz-btn"
            data-variant="secondary"
            href={`/${locale}/domains/${d.id}/hosting`}
          >
            {t(locale, 'dom.link.hosting')}
          </a>
        </nav>
      </>
    ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.detail.title')}</PageTitle>
      {body}
    </>
  );
}
