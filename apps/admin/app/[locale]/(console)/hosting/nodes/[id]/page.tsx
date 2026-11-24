import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t } from '@nuzm/i18n';
import { Badge, ForbiddenState, Icon, Ltr, Meter, PageTitle, Table } from '@nuzm/ui';
import { HostingAdminTabs } from '../../../../../../components/HostingAdminTabs';
import { NodePanelForm } from '../../../../../../components/HostingNodeForms';
import { setupSteps } from '../../../../../../lib/hosting-node';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** One hosting server: setup steps, panel connection (connect, test, activate) and capacity by dimension. */
export default async function Node({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:hosting:read'))
    return (
      <>
        <PageTitle>{t(locale, 'host.admin.nodes')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      const path = { id };
      const [node, cap] = await Promise.all([
        unwrap(s.api.GET('/v1/admin/hosting/nodes/{id}', { params: { path } })),
        unwrap(s.api.GET('/v1/admin/hosting/nodes/{id}/capacity', { params: { path } })),
      ]);
      return { node, cap };
    },
    ({ node, cap }) => {
      const steps = setupSteps(node);
      const list: [keyof typeof steps, string][] = [
        ['register', 'hnode.step.register'],
        ['connect', 'hnode.step.connect'],
        ['test', 'hnode.step.test'],
        ['activate', 'hnode.step.activate'],
      ];
      return (
        <>
          <header className="nzc-site-hero">
            <div className="nzc-site-hero-main">
              <h2>
                <Ltr>{node.name}</Ltr>
              </h2>
              <Badge
                tone={
                  node.status === 'active'
                    ? 'success'
                    : node.status === 'retired'
                      ? 'danger'
                      : 'warn'
                }
              >
                {node.status}
              </Badge>
              <Badge tone={node.health === 'healthy' ? 'success' : 'warn'}>{node.health}</Badge>
            </div>
            <dl className="nzc-site-facts">
              <div>
                <dt>{t(locale, 'host.col.region')}</dt>
                <dd>
                  <Ltr>{node.dataRegion}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'hnode.col.version')}</dt>
                <dd>
                  <Ltr>{node.panelVersion ?? '—'}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'hnode.runtimes')}</dt>
                <dd>
                  <Ltr>{node.runtimes.join(', ') || '—'}</Ltr>
                </dd>
              </div>
              <div>
                <dt>{t(locale, 'hnode.lastTest')}</dt>
                <dd>
                  {node.lastInventoryAt
                    ? formatDateTime(node.lastInventoryAt, locale)
                    : t(locale, 'hnode.never')}
                </dd>
              </div>
            </dl>
            <ol
              className="nzc-attn"
              aria-label={t(locale, 'hnode.steps')}
              style={{ margin: 0, paddingInlineStart: 18 }}
            >
              {list.map(([k, label]) => (
                <li
                  key={k}
                  data-tone={steps[k] ? undefined : 'warn'}
                  style={{ display: 'flex', gap: 8, alignItems: 'center', listStyle: 'none' }}
                >
                  <Icon name={steps[k] ? 'check' : 'chevron'} size={15} />{' '}
                  {t(locale, label as 'hnode.step.register')}
                </li>
              ))}
            </ol>
          </header>
          <NodePanelForm
            locale={locale}
            node={node}
            canManage={s.can('admin:hosting:manage')}
            mfaFactorId={s.me.mfaFactorId ?? null}
          />
          <h2 className="nz-h2">{t(locale, 'host.admin.capacity')}</h2>
          <Table
            caption={t(locale, 'host.admin.capacity')}
            rows={cap.dimensions}
            rowKey={(d) => d.dim}
            columns={[
              {
                key: 'd',
                icon: 'globe',
                header: t(locale, 'host.col.dim'),
                render: (d) => <Ltr>{d.dim}</Ltr>,
              },
              {
                key: 's',
                header: t(locale, 'host.col.sellable'),
                icon: 'globe',
                render: (d) => <Ltr>{d.sellable}</Ltr>,
              },
              {
                key: 'r',
                header: t(locale, 'host.col.reserved'),
                icon: 'globe',
                render: (d) => <Ltr>{d.reserved}</Ltr>,
              },
              {
                key: 'f',
                icon: 'globe',
                header: t(locale, 'host.col.free'),
                render: (d) => <Ltr>{d.free}</Ltr>,
              },
              {
                key: 'm',
                header: t(locale, 'host.col.quota'),
                icon: 'globe',
                render: (d) => (
                  <Meter
                    label={t(locale, 'host.usage.meter', { dim: d.dim })}
                    percent={d.sellable > 0 ? (d.reserved / d.sellable) * 100 : 0}
                  />
                ),
              },
            ]}
          />
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'host.admin.node', { name: id.slice(0, 8) })}</PageTitle>
      <HostingAdminTabs locale={locale} current="nodes" />
      {body}
    </>
  );
}
