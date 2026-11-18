import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, t, tDynamic } from '@nuzm/i18n';
import { Badge, ButtonLink, Card, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BuilderTabs, SandboxRuntime, Word } from '../../../../../../components/BuilderParts';
import { Fact } from '../../../../../../components/DataParts';
import { deploymentTone, isUuid, runTone, sandboxTone } from '../../../../../../lib/builder';
import { bgate, bview } from '../../../../../../lib/builder-gate';
import { view } from '../../../../../../lib/view';

/** UI-M10-02: project overview: versions, runs, deployments and sandboxes, with the buttons to the other screens. */
export default async function ProjectOverview({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const g = await bgate(params, 'builder:read', 'm10.ov.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return bview(
    locale,
    async () => {
      const project = await unwrap(
        s.api.GET('/v1/builder/projects/{id}', { params: { path: { id } } }),
      );
      const sections = await Promise.all([
        s.can('ai:read')
          ? view(
              locale,
              () => unwrap(s.api.GET('/v1/ai/runs', { params: { query: { projectId: id } } })),
              (d) =>
                d.items.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'm10.ov.noRuns')}</p>
                ) : (
                  <Table
                    caption={t(locale, 'm10.ov.runs')}
                    rows={d.items.slice(0, 10)}
                    rowKey={(r) => r.id}
                    columns={[
                      {
                        key: 'i',
                        header: t(locale, 'm10.tst.col.run'),
                        render: (r) => (
                          <a href={`/${locale}/builder/projects/${id}/runs/${r.id}`}>
                            <Ltr>{r.id.slice(0, 8)}</Ltr>
                          </a>
                        ),
                      },
                      {
                        key: 'k',
                        header: t(locale, 'field.kind'),
                        render: (r) => <Ltr>{r.kind}</Ltr>,
                      },
                      {
                        key: 's',
                        header: t(locale, 'field.status'),
                        render: (r) => (
                          <Badge tone={runTone(r.state)}>
                            <Word locale={locale} prefix="m10.run.state" value={r.state} />
                          </Badge>
                        ),
                      },
                    ]}
                  />
                ),
            )
          : null,
        s.can('deploy:read')
          ? view(
              locale,
              () => unwrap(s.api.GET('/v1/deployments', { params: { query: { projectId: id } } })),
              (d) =>
                d.items.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'm10.ov.noDeployments')}</p>
                ) : (
                  <Table
                    caption={t(locale, 'm10.ov.deployments')}
                    rows={d.items.slice(0, 10)}
                    rowKey={(x) => x.id}
                    columns={[
                      {
                        key: 'i',
                        header: t(locale, 'm10.dep.col.id'),
                        render: (x) => (
                          <a href={`/${locale}/builder/projects/${id}/deployments`}>
                            <Ltr>{x.id.slice(0, 8)}</Ltr>
                          </a>
                        ),
                      },
                      {
                        key: 'e',
                        header: t(locale, 'm10.dep.env'),
                        render: (x) => t(locale, `m10.dep.env.${x.environment}`),
                      },
                      {
                        key: 's',
                        header: t(locale, 'field.status'),
                        render: (x) => (
                          <Badge tone={deploymentTone(x.state)}>
                            <Word locale={locale} prefix="m10.dep.state" value={x.state} />
                          </Badge>
                        ),
                      },
                    ]}
                  />
                ),
            )
          : null,
        s.can('sandbox:use')
          ? view(
              locale,
              () =>
                unwrap(
                  s.api.GET('/v1/builder/projects/{projectId}/sandboxes', {
                    params: { path: { projectId: id } },
                  }),
                ),
              (d) =>
                d.items.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'm10.sbx.none')}</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
                    {d.items.slice(0, 5).map((b) => (
                      <li key={b.id}>
                        <Card aria-label={`${t(locale, 'm10.sbx.title')} ${b.id.slice(0, 8)}`}>
                          <div className="nz-row">
                            <a href={`/${locale}/builder/projects/${id}/ide`}>
                              <Ltr>{b.id.slice(0, 8)}</Ltr>
                            </a>
                            <Badge tone={sandboxTone(b.state)}>
                              <Word locale={locale} prefix="m10.sbx.state" value={b.state} />
                            </Badge>
                          </div>
                          <SandboxRuntime locale={locale} runtime={b.runtime} />
                        </Card>
                      </li>
                    ))}
                  </ul>
                ),
            )
          : null,
      ]);
      return { project, sections };
    },
    ({ project: p, sections: [runs, deployments, sandboxes] }) => {
      const base = `/${locale}/builder/projects/${p.id}`;
      return (
        <>
          <PageTitle>{p.name}</PageTitle>
          <BuilderTabs locale={locale} id={p.id} current="overview" />
          <Card aria-label={t(locale, 'm10.ov.title')}>
            <dl>
              <Fact label={t(locale, 'field.type')}>
                {tDynamic(locale, `m10.proj.type.${p.type}`, p.type)}
              </Fact>
              <Fact label={t(locale, 'field.region')}>
                <Ltr>{p.dataRegion ?? '—'}</Ltr>
              </Fact>
              <Fact label={t(locale, 'm10.ov.head')}>
                {p.headVersionId ? (
                  <Ltr>{p.headVersionId.slice(0, 8)}</Ltr>
                ) : (
                  t(locale, 'm10.ov.noHead')
                )}
              </Fact>
              {p.createdAt && (
                <Fact label={t(locale, 'field.created')}>
                  {formatDateTime(p.createdAt, locale)}
                </Fact>
              )}
            </dl>
            <div className="nz-row">
              {s.can('sandbox:use') && (
                <ButtonLink href={`${base}/ide`}>{t(locale, 'm10.tab.ide')}</ButtonLink>
              )}
              <ButtonLink variant="secondary" href={`${base}/changes`}>
                {t(locale, 'm10.tab.changes')}
              </ButtonLink>
              <ButtonLink variant="secondary" href={`${base}/tests`}>
                {t(locale, 'm10.tab.tests')}
              </ButtonLink>
              {s.can('deploy:read') && (
                <ButtonLink variant="secondary" href={`${base}/deployments`}>
                  {t(locale, 'm10.tab.deployments')}
                </ButtonLink>
              )}
              {s.can('builder:export') && (
                <ButtonLink variant="secondary" href={`${base}/exports`}>
                  {t(locale, 'm10.tab.exports')}
                </ButtonLink>
              )}
              {s.can('ai:budget') && (
                <ButtonLink variant="secondary" href={`${base}/settings/budget`}>
                  {t(locale, 'm10.tab.budget')}
                </ButtonLink>
              )}
              {s.can('ai:read') && (
                <ButtonLink variant="secondary" href={`/${locale}/approvals`}>
                  {t(locale, 'm10.apr.title')}
                </ButtonLink>
              )}
            </div>
          </Card>
          <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
            {t(locale, 'm10.ov.versions')}
          </h2>
          {(p.versions ?? []).length === 0 ? (
            <EmptyState
              title={t(locale, 'm10.ov.noVersions')}
              body={t(locale, 'm10.ov.noVersionsBody')}
            />
          ) : (
            <Table
              caption={t(locale, 'm10.ov.versions')}
              rows={p.versions ?? []}
              rowKey={(v) => v.id ?? ''}
              columns={[
                {
                  key: 'i',
                  header: t(locale, 'm10.chg.version'),
                  render: (v) => <Ltr>{(v.id ?? '').slice(0, 8)}</Ltr>,
                },
                { key: 'l', header: t(locale, 'm10.ov.label'), render: (v) => v.label ?? '—' },
                {
                  key: 's',
                  header: t(locale, 'm10.ov.source'),
                  render: (v) => (v.source ? <Ltr>{v.source}</Ltr> : '—'),
                },
                {
                  key: 'c',
                  header: t(locale, 'field.created'),
                  render: (v) => (v.createdAt ? formatDateTime(v.createdAt, locale) : '—'),
                },
              ]}
            />
          )}
          {runs && (
            <>
              <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
                {t(locale, 'm10.ov.runs')}
              </h2>
              {runs}
            </>
          )}
          {deployments && (
            <>
              <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
                {t(locale, 'm10.ov.deployments')}
              </h2>
              {deployments}
            </>
          )}
          {sandboxes && (
            <>
              <h2 className="nz-h2" style={{ marginBlockStart: 16 }}>
                {t(locale, 'm10.ov.sandboxes')}
              </h2>
              {sandboxes}
            </>
          )}
        </>
      );
    },
  );
}
