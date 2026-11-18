import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { ButtonLink, EmptyState, ForbiddenState, Icon, PageTitle } from '@nuzm/ui';
import { CreateZoneButton, DnsEditor } from '../../../../../../components/DomainPanels';
import { requireSession } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** UI-M07-05: records table with a change-set editor and ETag conflict handling; validation errors are shown per change; a degraded zone blocks editing. */
export default async function Dns({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('dns:read'))
    return (
      <>
        <PageTitle>{t(locale, 'dom.dns.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const d = await unwrap(s.api.GET('/v1/domains/{id}', { params: { path: { id } } }));
      const zones = await unwrap(s.api.GET('/v1/dns/zones', { params: { query: { limit: 200 } } }));
      const zone = zones.items.find((z) => z.domainId === id) ?? null;
      const recs = zone
        ? await unwrap(
            s.api.GET('/v1/dns/zones/{id}/records', { params: { path: { id: zone.id } } }),
          )
        : null;
      return { d, zone, recs };
    },
    ({ d, zone, recs }) => (
      <div className="nz-stack" style={{ gap: 18 }}>
        <section className="nzc-panel" aria-labelledby="ns-h">
          <h2 id="ns-h">{t(locale, 'dom.ns.title')}</h2>
          <p className="nzc-panel-sub">{t(locale, 'dom.ns.desc')}</p>
          {d.nameservers.length ? (
            <ul className="nzc-ns-list">
              {d.nameservers.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="nz-muted">{t(locale, 'dom.ns.none')}</p>
          )}
          {s.can('domain:write') && d.capabilities.nameservers && (
            <p style={{ margin: '16px 0 0' }}>
              <ButtonLink href={`/${locale}/domains/${id}#settings`}>
                {t(locale, 'dom.ns.change')}
              </ButtonLink>
            </p>
          )}
        </section>
        {!zone || !recs ? (
          <EmptyState
            title={t(locale, 'dom.dns.noZone')}
            body={
              d.capabilities.dns ? t(locale, 'state.empty.body') : t(locale, 'dom.dns.unsupported')
            }
            action={
              d.capabilities.dns && s.can('dns:write') ? (
                <CreateZoneButton locale={locale} domainId={d.id} />
              ) : undefined
            }
          />
        ) : (
          <section className="nzc-panel" aria-labelledby="dns-h">
            <h2 id="dns-h">{t(locale, 'dom.dns.manageTitle')}</h2>
            <p className="nzc-panel-sub">{t(locale, 'dom.dns.desc')}</p>
            {zone.dnssec?.available ? (
              <p className="nz-muted">{t(locale, 'dom.dns.dnssecOn')}</p>
            ) : null}
            <DnsEditor
              locale={locale}
              zoneId={zone.id}
              version={recs.version}
              degraded={zone.degraded}
              readOnly={!s.can('dns:write')}
              records={recs.items as never}
            />
          </section>
        )}
      </div>
    ),
  );
  return (
    <>
      <a className="nzc-back" href={`/${locale}/domains/${id}`}>
        <Icon name="chevron" size={16} />
        {t(locale, 'dom.detail.title')}
      </a>
      <PageTitle>{t(locale, 'dom.dns.title')}</PageTitle>
      {body}
    </>
  );
}
