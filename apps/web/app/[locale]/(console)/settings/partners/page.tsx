import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t } from '@nuzm/i18n';
import { Badge, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { AnswerRequest } from '../../../../../components/ProgramsPanels';
import { DisabledAction, Section, Status } from '../../../../../components/M11Parts';
import {
  FLAGS,
  itemsOf,
  linkTone,
  type AgencyDto,
  type GrantDto,
  type LinkDto,
  type ResellerDto,
  type SubOrgDto,
} from '../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../lib/m11-server';
import { flagEnabled } from '../../../../../lib/services';

/**
 * UI-M11-19 (client side): the agencies and resellers that asked this organization to link, and the access grants proposed to it. Only the client can accept; a grant keeps its scopes and expiry
 * forever. Revoking an accepted grant is SCR-M11-01 (not available): shown disabled, with the mandatory expiry as the lever that exists.
 */
export default async function Partners({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'partners:manage',
    title: 'm11.pt.title',
    flag: [FLAGS.agency, FLAGS.reseller],
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const factor = s.me.mfaFactorId ?? null;
  const flagOn = (f: string) => flagEnabled(s.me.featureFlags, f);
  const body = await m11View(
    locale,
    async () => {
      const agencies = flagOn(FLAGS.agency)
        ? itemsOf<AgencyDto>(await unwrap(s.api.GET('/v1/agencies', {}))).filter(
            (a) => a.role === 'client',
          )
        : [];
      const per = await Promise.all(
        agencies.map(async (a) => ({
          agency: a,
          links: itemsOf<LinkDto>(
            await unwrap(
              s.api.GET('/v1/agencies/{id}/clients', { params: { path: { id: a.id } } }),
            ),
          ),
          grants: itemsOf<GrantDto>(
            await unwrap(
              s.api.GET('/v1/agencies/{id}/delegated-access', { params: { path: { id: a.id } } }),
            ),
          ),
        })),
      );
      const resellers = flagOn(FLAGS.reseller)
        ? itemsOf<ResellerDto>(await unwrap(s.api.GET('/v1/resellers', {}))).filter(
            (r) => r.role === 'sub_organization',
          )
        : [];
      const subs = await Promise.all(
        resellers.map(async (r) => ({
          reseller: r,
          links: itemsOf<SubOrgDto>(
            await unwrap(
              s.api.GET('/v1/resellers/{id}/sub-organizations', { params: { path: { id: r.id } } }),
            ),
          ),
        })),
      );
      return { per, subs };
    },
    ({ per, subs }) => {
      const nothing =
        per.every((p) => p.links.length === 0 && p.grants.length === 0) &&
        subs.every((x) => x.links.length === 0);
      if (nothing)
        return (
          <EmptyState title={t(locale, 'm11.pt.empty')} body={t(locale, 'm11.pt.emptyBody')} />
        );
      return (
        <>
          {per.map(({ agency, links, grants }) => (
            <Card key={agency.id} aria-label={agency.name}>
              <h2 className="nz-h2">
                <bdi dir="auto">{agency.name}</bdi>{' '}
                <Badge tone={agency.status === 'active' ? 'success' : 'danger'}>
                  {t(locale, `m11.ag.status.${agency.status}`)}
                </Badge>
              </h2>
              <Section title={t(locale, 'm11.pt.links')}>
                {links.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'm11.pt.noLinks')}</p>
                ) : (
                  <Table
                    caption={t(locale, 'm11.pt.links')}
                    rows={links}
                    rowKey={(l) => l.id}
                    columns={[
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
                        key: 'd',
                        header: t(locale, 'field.created'),
                        render: (l) => formatDateTime(l.createdAt, locale),
                      },
                      {
                        key: 'x',
                        header: t(locale, 'field.action'),
                        render: (l) =>
                          l.status === 'pending' ? (
                            <AnswerRequest
                              locale={locale}
                              kind="link"
                              agencyId={agency.id}
                              id={l.id}
                              mfaFactorId={factor}
                            />
                          ) : (
                            <span className="nz-muted">—</span>
                          ),
                      },
                    ]}
                  />
                )}
              </Section>
              <Section title={t(locale, 'm11.pt.grants')} help={t(locale, 'm11.pt.grantsHelp')}>
                {grants.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'm11.pt.noGrants')}</p>
                ) : (
                  <Table
                    caption={t(locale, 'm11.pt.grants')}
                    rows={grants}
                    rowKey={(x) => x.id}
                    columns={[
                      {
                        key: 'sc',
                        header: t(locale, 'm11.gr.scopes'),
                        render: (x) => x.scopes.map((sc) => <Badge key={sc}>{sc}</Badge>),
                      },
                      {
                        key: 'e',
                        header: t(locale, 'm11.gr.expiry'),
                        render: (x) => formatDateTime(x.expiresAt, locale),
                      },
                      {
                        key: 's',
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
                        key: 'x',
                        header: t(locale, 'field.action'),
                        render: (x) =>
                          x.status === 'pending' ? (
                            <AnswerRequest
                              locale={locale}
                              kind="grant"
                              agencyId={agency.id}
                              id={x.id}
                              mfaFactorId={factor}
                            />
                          ) : x.status === 'active' ? (
                            <DisabledAction
                              id={`rv-${x.id}`}
                              label={t(locale, 'm11.gr.revoke')}
                              reason={t(locale, 'm11.gr.revokeBlocked')}
                            />
                          ) : (
                            <span className="nz-muted">—</span>
                          ),
                      },
                    ]}
                  />
                )}
              </Section>
            </Card>
          ))}
          {subs.map(({ reseller, links }) => (
            <Card key={reseller.id} aria-label={reseller.name}>
              <h2 className="nz-h2">
                <bdi dir="auto">{reseller.name}</bdi>{' '}
                <span className="nz-muted">{t(locale, 'm11.pt.reseller')}</span>
              </h2>
              <Table
                caption={t(locale, 'm11.pt.resellerLinks')}
                rows={links}
                rowKey={(l) => l.id}
                columns={[
                  {
                    key: 'p',
                    header: t(locale, 'm11.rs.priceBookRef'),
                    render: (l) => (l.priceBookRef ? <Ltr>{l.priceBookRef}</Ltr> : '—'),
                  },
                  {
                    key: 's',
                    header: t(locale, 'field.status'),
                    render: (l) => (
                      <Status
                        locale={locale}
                        prefix="m11.sub.status"
                        value={l.status}
                        tone={linkTone(l.status)}
                      />
                    ),
                  },
                  {
                    key: 'x',
                    header: t(locale, 'field.action'),
                    render: (l) =>
                      l.status === 'pending' ? (
                        <AnswerRequest
                          locale={locale}
                          kind="reseller"
                          agencyId={reseller.id}
                          resellerId={reseller.id}
                          id={l.id}
                          mfaFactorId={factor}
                        />
                      ) : (
                        <span className="nz-muted">—</span>
                      ),
                  },
                ]}
              />
            </Card>
          ))}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.pt.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm11.pt.help')}</p>
      {body}
    </>
  );
}
