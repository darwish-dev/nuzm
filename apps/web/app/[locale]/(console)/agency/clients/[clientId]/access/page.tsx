import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ProposeGrantForm } from '../../../../../../../components/ProgramsPanels';
import { AgencyTabs } from '../../../../../../../components/ProgramTabs';
import { DisabledAction, Section, Status } from '../../../../../../../components/M11Parts';
import {
  FLAGS,
  isUuid,
  itemsOf,
  linkTone,
  type GrantDto,
  type LinkDto,
} from '../../../../../../../lib/m11';
import { agencyOf, gateM11, m11View } from '../../../../../../../lib/m11-server';

/** UI-M11-12: delegated access to one client: propose a grant (scopes from the delegable catalogue, mandatory expiry), see the grants and their state. REVOKE is SCR-M11-01 (not available): shown disabled. */
export default async function ClientAccess({
  params,
}: {
  params: Promise<{ locale: string; clientId: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'agency:manage',
    title: 'm11.gr.title',
    flag: FLAGS.agency,
    orgType: 'agency',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const client = clientId.toLowerCase();
  const body = await m11View(
    locale,
    async () => {
      const agency = await agencyOf(s);
      if (!agency)
        return { agency, link: undefined as LinkDto | undefined, grants: [] as GrantDto[] };
      const [links, grants] = await Promise.all([
        unwrap(
          s.api.GET('/v1/agencies/{id}/clients', { params: { path: { id: agency.id } } }),
        ).then((x) => itemsOf<LinkDto>(x)),
        unwrap(
          s.api.GET('/v1/agencies/{id}/delegated-access', { params: { path: { id: agency.id } } }),
        ).then((x) => itemsOf<GrantDto>(x)),
      ]);
      return {
        agency,
        link:
          links.find((l) => l.clientOrgId === client && l.status === 'active') ??
          links.find((l) => l.clientOrgId === client),
        grants: grants.filter((x) => x.clientOrgId === client),
      };
    },
    ({ agency, link, grants }) =>
      !agency || !link ? (
        <EmptyState title={t(locale, 'm11.gr.noLink')} body={t(locale, 'm11.gr.noLinkBody')} />
      ) : (
        <>
          <p className="nz-row">
            <Ltr>{client}</Ltr>
            <Status
              locale={locale}
              prefix="m11.link.status"
              value={link.status}
              tone={linkTone(link.status)}
            />
          </p>
          {link.status === 'active' ? (
            <ProposeGrantForm
              locale={locale}
              agencyId={agency.id}
              clientOrgId={client}
              mfaFactorId={s.me.mfaFactorId ?? null}
            />
          ) : (
            <Banner tone="warn">{t(locale, 'm11.gr.linkNotActive')}</Banner>
          )}
          <Section title={t(locale, 'm11.gr.list')} help={t(locale, 'm11.gr.immutable')}>
            {grants.length === 0 ? (
              <p className="nz-muted">{t(locale, 'm11.gr.empty')}</p>
            ) : (
              <Table
                caption={t(locale, 'm11.gr.list')}
                rows={grants}
                rowKey={(x) => x.id}
                columns={[
                  {
                    key: 's',
                    header: t(locale, 'm11.gr.scopes'),
                    render: (x) => x.scopes.map((sc) => <Badge key={sc}>{sc}</Badge>),
                  },
                  {
                    key: 'st',
                    header: t(locale, 'field.status'),
                    render: (x) => (
                      <Status
                        locale={locale}
                        prefix="m11.grant.status"
                        value={x.status}
                        tone={linkTone(x.status)}
                      />
                    ),
                  },
                  {
                    key: 'e',
                    header: t(locale, 'm11.gr.expiry'),
                    render: (x) => formatDateTime(x.expiresAt, locale),
                  },
                  {
                    key: 'g',
                    header: t(locale, 'm11.gr.grantedAt'),
                    render: (x) => (x.grantedAt ? formatDateTime(x.grantedAt, locale) : '—'),
                  },
                  {
                    key: 'r',
                    header: t(locale, 'field.action'),
                    render: (x) => (
                      <DisabledAction
                        id={`rev-${x.id}`}
                        label={t(locale, 'm11.gr.revoke')}
                        reason={t(locale, 'm11.gr.revokeBlocked')}
                      />
                    ),
                  },
                ]}
              />
            )}
          </Section>
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.gr.title')}</PageTitle>
      <AgencyTabs locale={locale} current="clients" />
      {body}
    </>
  );
}
