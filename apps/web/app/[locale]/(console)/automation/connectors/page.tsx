import { unwrap } from '@nuzm/sdk';
import { t, tDynamic } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import {
  AuthState,
  ConnectorAuthorize,
  NewConnectorForm,
} from '../../../../../components/AutomationPanels';
import { Status } from '../../../../../components/M11Parts';
import { FLAGS, connectorTone, itemsOf, type ConnectorDto } from '../../../../../lib/m11';
import { gateM11, m11View } from '../../../../../lib/m11-server';

/** UI-M11-04: connectors (what a workflow may call, with which scopes) and their authorization. Only vault REFERENCES are used: no secret value is asked for or shown. */
export default async function Connectors({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: 'connector:manage',
    title: 'm11.cn.title',
    flag: FLAGS.automation,
  });
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const factor = s.me.mfaFactorId ?? null;
  const body = await m11View(
    locale,
    async () =>
      itemsOf<ConnectorDto>(
        await unwrap(s.api.GET('/v1/connectors', { params: { query: { limit: 100 } } })),
      ),
    (items) => (
      <>
        <NewConnectorForm locale={locale} mfaFactorId={factor} />
        <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
          {t(locale, 'm11.cn.title')}
        </h2>
        {items.length === 0 ? (
          <EmptyState title={t(locale, 'm11.cn.empty')} body={t(locale, 'm11.cn.emptyBody')} />
        ) : (
          <Table
            caption={t(locale, 'm11.cn.title')}
            rows={items}
            rowKey={(c) => c.id}
            columns={[
              {
                key: 'n',
                header: t(locale, 'field.name'),
                render: (c) => <bdi dir="auto">{c.name}</bdi>,
              },
              {
                key: 't',
                header: t(locale, 'field.type'),
                render: (c) => tDynamic(locale, `m11.cn.type.${c.type}`, c.type),
              },
              {
                key: 'sc',
                header: t(locale, 'm11.cn.scopes'),
                render: (c) =>
                  c.scopes.length ? c.scopes.map((x) => <Badge key={x}>{x}</Badge>) : '—',
              },
              {
                key: 's',
                header: t(locale, 'field.status'),
                render: (c) => (
                  <Status
                    locale={locale}
                    prefix="m11.cn.status"
                    value={c.status}
                    tone={connectorTone(c.status)}
                  />
                ),
              },
              {
                key: 'a',
                header: t(locale, 'm11.cn.authorization'),
                render: (c) => <AuthState locale={locale} c={c} />,
              },
              {
                key: 'r',
                header: t(locale, 'm11.cn.rate'),
                render: (c) => <Ltr>{`${c.rateLimit.perMinute}/min · ${c.rateLimit.burst}`}</Ltr>,
              },
              {
                key: 'x',
                header: t(locale, 'field.action'),
                render: (c) => (
                  <ConnectorAuthorize
                    locale={locale}
                    connector={c}
                    orgId={s.org!.orgId}
                    mfaFactorId={factor}
                  />
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
      <PageTitle>{t(locale, 'm11.cn.title')}</PageTitle>
      {body}
    </>
  );
}
