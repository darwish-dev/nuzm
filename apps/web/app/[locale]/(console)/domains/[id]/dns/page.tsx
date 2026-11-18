import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
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
    ({ d, zone, recs }) =>
      !zone || !recs ? (
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
        <>
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
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'dom.dns.title')}</PageTitle>
      {body}
    </>
  );
}
