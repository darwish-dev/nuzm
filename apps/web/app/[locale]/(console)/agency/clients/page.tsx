import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { InviteClientForm } from '../../../../../components/ProgramsPanels';
import { AgencyTabs } from '../../../../../components/ProgramTabs';
import { Status } from '../../../../../components/M11Parts';
import { FLAGS, itemsOf, linkTone, type LinkDto } from '../../../../../lib/m11';
import { agencyOf, gateM11, m11View } from '../../../../../lib/m11-server';

/** UI-M11-11: client links of the agency: invite an existing organization by id; the CLIENT accepts. Status per link. Revoking a link is SCR-M11-01 (not available). */
export default async function AgencyClients({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'agency:manage',
    title: 'm11.ag.clients.title',
    flag: FLAGS.agency,
    orgType: 'agency',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const body = await m11View(
    locale,
    async () => {
      const agency = await agencyOf(s);
      const links = agency
        ? itemsOf<LinkDto>(
            await unwrap(
              s.api.GET('/v1/agencies/{id}/clients', { params: { path: { id: agency.id } } }),
            ),
          )
        : [];
      return { agency, links };
    },
    ({ agency, links }) =>
      !agency ? (
        <EmptyState
          title={t(locale, 'm11.ag.noProfile')}
          body={t(locale, 'm11.ag.noProfileBody')}
        />
      ) : (
        <>
          <InviteClientForm
            locale={locale}
            agencyId={agency.id}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm11.ag.clients.title')}
          </h2>
          {links.length === 0 ? (
            <EmptyState
              title={t(locale, 'm11.ag.clients.empty')}
              body={t(locale, 'm11.ag.clients.emptyBody')}
            />
          ) : (
            <Table
              caption={t(locale, 'm11.ag.clients.title')}
              rows={links}
              rowKey={(l) => l.id}
              columns={[
                {
                  key: 'c',
                  header: t(locale, 'm11.ag.clientOrgId'),
                  render: (l) => <Ltr>{l.clientOrgId}</Ltr>,
                },
                {
                  key: 's',
                  header: t(locale, 'field.status'),
                  render: (l) => (
                    <Status
                      locale={locale}
                      prefix="m11.link.status"
                      value={l.status}
                      tone={linkTone(l.status)}
                    />
                  ),
                },
                {
                  key: 'a',
                  header: t(locale, 'm11.ag.accepted'),
                  render: (l) => (l.acceptedAt ? formatDateTime(l.acceptedAt, locale) : '—'),
                },
                {
                  key: 'd',
                  header: t(locale, 'field.created'),
                  render: (l) => formatDateTime(l.createdAt, locale),
                },
                {
                  key: 'x',
                  header: t(locale, 'field.action'),
                  render: (l) =>
                    l.status === 'active' ? (
                      <span className="nz-row">
                        <a href={`/${locale}/agency/clients/${l.clientOrgId}/access`}>
                          {t(locale, 'm11.ag.manageAccess')}
                        </a>
                        <a href={`/${locale}/agency/acting/${l.clientOrgId}`}>
                          {t(locale, 'm11.ag.act')}
                        </a>
                      </span>
                    ) : (
                      <span className="nz-muted">
                        {t(
                          locale,
                          l.status === 'pending' ? 'm11.ag.awaitingClient' : 'm11.ag.noActions',
                        )}
                      </span>
                    ),
                },
              ]}
            />
          )}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.ag.clients.title')}</PageTitle>
      <AgencyTabs locale={locale} current="clients" />
      {body}
    </>
  );
}
