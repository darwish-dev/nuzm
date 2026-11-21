import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { ActingControls, ActingSwitcher } from '../../../../../../components/ProgramsPanels';
import { AgencyTabs } from '../../../../../../components/ProgramTabs';
import { Status } from '../../../../../../components/M11Parts';
import {
  FLAGS,
  actingClients,
  isUuid,
  itemsOf,
  workflowTone,
  type GrantDto,
  type LinkDto,
  type WorkflowDto,
} from '../../../../../../lib/m11';
import type { Session } from '../../../../../../lib/server';
import {
  actingHeader,
  actingOrgOf,
  agencyOf,
  gateM11,
  m11View,
} from '../../../../../../lib/m11-server';

/**
 * UI-M11-13: acting as a client. Choosing "act" sets the client context; from then on EVERY page of the console shows the client-context banner, and the automation workflow screens (the only
 * delegable ones) send `X-Nuzm-Org` = the agency and `X-Nuzm-Acting-Org` = the client. Everything else answers 403 (rendered as the forbidden state). The grant is re-validated by the API on every request.
 */
export default async function Acting({
  params,
}: {
  params: Promise<{ locale: string; clientId: string }>;
}) {
  const g = await gateM11(params, {
    permission: 'org:read',
    title: 'm11.act.title',
    flag: FLAGS.agency,
    orgType: 'agency',
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const client = clientId.toLowerCase();
  const current = await actingOrgOf(s);
  const active = current === client;
  const wf = active ? await clientWorkflows(s, locale, client) : null;
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
      const clients = actingClients(links, grants);
      const entry = clients.find((c) => c.clientOrgId === client);
      const link = links.find((l) => l.clientOrgId === client && l.status === 'active');
      const live = grants.filter(
        (x) =>
          x.clientOrgId === client && x.status === 'active' && Date.parse(x.expiresAt) > Date.now(),
      );
      return (
        <>
          <div className="nz-row">
            <ActingSwitcher locale={locale} current={current} clients={clients} />
            <ActingControls
              locale={locale}
              clientOrgId={client}
              active={active}
              canAct={!!agency && !!entry}
            />
          </div>
          <Card aria-label={t(locale, 'm11.act.client')}>
            <dl>
              <dt>{t(locale, 'm11.act.client')}</dt>
              <dd>
                <Ltr>{client}</Ltr>
              </dd>
              <dt>{t(locale, 'm11.act.link')}</dt>
              <dd>
                {link ? (
                  <Status locale={locale} prefix="m11.link.status" value="active" tone="success" />
                ) : (
                  <Badge tone="danger">{t(locale, 'm11.act.noLink')}</Badge>
                )}
              </dd>
              <dt>{t(locale, 'm11.act.mode')}</dt>
              <dd>
                {active ? (
                  <Badge tone="danger">{t(locale, 'm11.act.modeActing')}</Badge>
                ) : (
                  <Badge>{t(locale, 'm11.act.modeOwn')}</Badge>
                )}
              </dd>
            </dl>
          </Card>
          {!entry ? (
            <EmptyState
              title={t(locale, 'm11.act.noGrant')}
              body={t(locale, 'm11.act.noGrantBody')}
            />
          ) : (
            <>
              <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
                {t(locale, 'm11.act.grants')}
              </h2>
              <Table
                caption={t(locale, 'm11.act.grants')}
                rows={live}
                rowKey={(x) => x.id}
                columns={[
                  {
                    key: 's',
                    header: t(locale, 'm11.gr.scopes'),
                    render: (x) => x.scopes.map((sc) => <Badge key={sc}>{sc}</Badge>),
                  },
                  {
                    key: 'e',
                    header: t(locale, 'm11.gr.expiry'),
                    render: (x) => formatDateTime(x.expiresAt, locale),
                  },
                ]}
              />
            </>
          )}
          <Banner tone="warn">{t(locale, 'm11.act.delegableOnly')}</Banner>
          {wf}
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm11.act.title')}</PageTitle>
      <AgencyTabs locale={locale} current="clients" />
      {body}
    </>
  );
}

/** The client's workflows read in the client's context (a delegable route): the proof that acting works, and the forbidden state when the grant does not carry `automation:read`. */
async function clientWorkflows(s: Session, locale: Locale, client: string) {
  return m11View(
    locale,
    async () =>
      itemsOf<WorkflowDto>(
        await unwrap(
          s.api.GET('/v1/workflows', {
            params: { query: { limit: 20 }, header: actingHeader(client) },
          }),
        ),
      ),
    (items) => (
      <>
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm11.act.workflows')}
        </h2>
        {items.length === 0 ? (
          <p className="nz-muted">{t(locale, 'm11.act.workflowsEmpty')}</p>
        ) : (
          <Table
            caption={t(locale, 'm11.act.workflows')}
            rows={items}
            rowKey={(w) => w.id}
            columns={[
              {
                key: 'n',
                header: t(locale, 'field.name'),
                render: (w) => (
                  <a href={`/automation/workflows/${w.id}/edit`}>
                    <bdi dir="auto">{w.name}</bdi>
                  </a>
                ),
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (w) => (
                  <Status
                    locale={locale}
                    prefix="m11.wf.status"
                    value={w.status}
                    tone={workflowTone(w.status)}
                  />
                ),
              },
            ]}
          />
        )}
        <p>
          <a href={`/automation/workflows`}>{t(locale, 'm11.act.openWorkflows')}</a>
        </p>
      </>
    ),
  );
}
