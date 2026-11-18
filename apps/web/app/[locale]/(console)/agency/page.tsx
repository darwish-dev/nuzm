import { unwrap } from '@nuzm/sdk';
import { t } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle } from '@nuzm/ui';
import { CreateProfileButton } from '../../../../components/ProgramsPanels';
import { AgencyTabs } from '../../../../components/ProgramTabs';
import { BlockedState } from '../../../../components/M11Parts';
import { FLAGS, actingClients, itemsOf, type GrantDto, type LinkDto } from '../../../../lib/m11';
import { agencyOf, gateM11, m11View } from '../../../../lib/m11-server';

const SOON = 14 * 86_400_000;

/** UI-M11-10: the agency dashboard: client links, grants (pending, active, expiring), the clients that can be acted in. Health and usage per client are not available (no endpoint): said, not faked. */
export default async function AgencyDashboard({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: ['agency:manage', 'org:read'],
    title: 'm11.ag.title',
    flag: FLAGS.agency,
    orgType: 'agency',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await m11View(
    locale,
    async () => {
      const agency = await agencyOf(s);
      if (!agency) return { agency, links: [] as LinkDto[], grants: [] as GrantDto[] };
      const [links, grants] = await Promise.all([
        unwrap(
          s.api.GET('/v1/agencies/{id}/clients', { params: { path: { id: agency.id } } }),
        ).then((x) => itemsOf<LinkDto>(x)),
        unwrap(
          s.api.GET('/v1/agencies/{id}/delegated-access', { params: { path: { id: agency.id } } }),
        ).then((x) => itemsOf<GrantDto>(x)),
      ]);
      return { agency, links, grants };
    },
    ({ agency, links, grants }) => {
      if (!agency)
        return (
          <EmptyState
            title={t(locale, 'm11.ag.noProfile')}
            body={t(locale, 'm11.ag.noProfileBody')}
            action={
              s.can('agency:manage') ? (
                <CreateProfileButton
                  locale={locale}
                  kind="agency"
                  mfaFactorId={s.me.mfaFactorId ?? null}
                />
              ) : undefined
            }
          />
        );
      const now = Date.now();
      const count = (st: string) => links.filter((l) => l.status === st).length;
      const soon = grants.filter(
        (x) =>
          x.status === 'active' &&
          Date.parse(x.expiresAt) > now &&
          Date.parse(x.expiresAt) - now < SOON,
      ).length;
      const acting = actingClients(links, grants, now);
      return (
        <>
          {agency.status === 'suspended' && (
            <Banner tone="danger">{t(locale, 'm11.ag.suspended')}</Banner>
          )}
          <p className="nz-row">
            <strong>
              <bdi dir="auto">{agency.name}</bdi>
            </strong>
            <Badge tone={agency.status === 'active' ? 'success' : 'danger'}>
              {t(locale, `m11.ag.status.${agency.status}`)}
            </Badge>
          </p>
          <div className="nz-grid">
            <Card aria-label={t(locale, 'm11.ag.stat.clients')}>
              <h2 className="nz-h2">{t(locale, 'm11.ag.stat.clients')}</h2>
              <p style={{ fontSize: '1.6rem', margin: 0 }}>
                <Ltr>{count('active')}</Ltr>
              </p>
              <p className="nz-muted">
                {t(locale, 'm11.ag.stat.clientsDetail', {
                  pending: count('pending'),
                  declined: count('declined') + count('revoked'),
                })}
              </p>
              <a href={`/${locale}/agency/clients`}>{t(locale, 'm11.ag.clients.title')}</a>
            </Card>
            <Card aria-label={t(locale, 'm11.ag.stat.grants')}>
              <h2 className="nz-h2">{t(locale, 'm11.ag.stat.grants')}</h2>
              <p style={{ fontSize: '1.6rem', margin: 0 }}>
                <Ltr>{grants.filter((x) => x.status === 'active').length}</Ltr>
              </p>
              <p className="nz-muted">
                {t(locale, 'm11.ag.stat.grantsDetail', {
                  pending: grants.filter((x) => x.status === 'pending').length,
                  soon,
                })}
              </p>
            </Card>
            <Card aria-label={t(locale, 'm11.ag.stat.acting')}>
              <h2 className="nz-h2">{t(locale, 'm11.ag.stat.acting')}</h2>
              {acting.length === 0 ? (
                <p className="nz-muted">{t(locale, 'm11.ag.stat.actingNone')}</p>
              ) : (
                <ul>
                  {acting.map((c) => (
                    <li key={c.clientOrgId}>
                      <a href={`/${locale}/agency/acting/${c.clientOrgId}`}>
                        <Ltr>{c.clientOrgId}</Ltr>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <BlockedState
            locale={locale}
            title={t(locale, 'm11.ag.health.title')}
            body={t(locale, 'm11.ag.health.body')}
            missing={t(locale, 'm11.ag.health.missing')}
          />
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.ag.title')}</PageTitle>
      <AgencyTabs locale={locale} current="dashboard" />
      {body}
    </>
  );
}
