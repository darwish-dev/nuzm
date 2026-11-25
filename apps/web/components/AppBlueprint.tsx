import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, Ltr, Table } from '@nuzm/ui';
import {
  bytesText,
  pick,
  rbacMatrix,
  type ApiView,
  type EntityView,
  type RoleView,
  type SchemaView,
  type SpecView,
} from '../lib/appworkspace';
import type { Version } from '../lib/builder';
import { when } from './BuilderBits';
import { Code } from './BuilderParts';

/** Server-safe, stateless panels that show what the agents generated (app spec, schema, API, access). Everything shown is read-only. */

/** No build has produced this artifact yet (or the run is still working on it): an honest empty state, not a blank page. */
export const NoBuildYet = ({ locale }: { locale: Locale }) => (
  <EmptyState title={t(locale, 'm10a.bp.none.title')} body={t(locale, 'm10a.bp.none.body')} />
);

/** The section belongs to web-app projects: a website project has its own workspace. */
export const NotAnApp = ({ locale, projectId }: { locale: Locale; projectId: string }) => (
  <EmptyState
    title={t(locale, 'm10a.notApp.title')}
    body={t(locale, 'm10a.notApp.body')}
    action={
      <a className="nz-btn" href={`/builder/projects/${projectId}`}>
        {t(locale, 'm10a.notApp.back')}
      </a>
    }
  />
);

/** Header of the web-app workspace: type, region, head version and the last deployment, with the quick links a finished build leads to. */
export function AppSummary({
  locale,
  project,
}: {
  locale: Locale;
  project: {
    id: string;
    name: string;
    dataRegion: string;
    headSeq: number | null;
    lastDeployment: { state: string; url: string | null } | null;
  };
}) {
  return (
    <Card aria-labelledby="m10a-sum-h">
      <h2 className="nz-h2" id="m10a-sum-h">
        <bdi dir="auto">{project.name}</bdi>
      </h2>
      <p className="nz-row">
        <Badge>{t(locale, 'm10.proj.type.webapp')}</Badge>
        <span className="nz-muted">
          {t(locale, 'bld.run.region')}: <Ltr>{project.dataRegion}</Ltr>
        </span>
        <span className="nz-muted">
          {project.headSeq !== null
            ? t(locale, 'm10a.dep.version', { seq: project.headSeq })
            : t(locale, 'm10a.dep.noVersion')}
        </span>
        <span className="nz-muted">
          {t(locale, 'bld.projects.lastDeployment')}:{' '}
          {project.lastDeployment
            ? tDynamic(
                locale,
                `m10a.dep.state.${project.lastDeployment.state}`,
                project.lastDeployment.state,
              )
            : t(locale, 'bld.projects.neverDeployed')}
        </span>
      </p>
    </Card>
  );
}

const yes = (locale: Locale, v: boolean) => t(locale, v ? 'm10a.yes' : 'm10a.no');

function EntityTable({ locale, e }: { locale: Locale; e: EntityView }) {
  return (
    <section className="nz-card" aria-labelledby={`bp-e-${e.name}`}>
      <h3 className="nz-h2" id={`bp-e-${e.name}`}>
        <bdi dir="auto">{pick(e.label, locale, e.name)}</bdi> <Ltr>{e.name}</Ltr>
      </h3>
      <p className="nz-row">
        <Badge>{tDynamic(locale, `m10a.own.${e.ownership}`, e.ownership)}</Badge>
        {e.audit && <Badge>{t(locale, 'm10a.spec.audited')}</Badge>}
        {e.stageField && (
          <Badge>
            {t(locale, 'm10a.spec.stages')}: <Ltr>{e.stageField}</Ltr>
          </Badge>
        )}
      </p>
      <Table
        caption={t(locale, 'm10a.spec.fieldsOf', { entity: e.name })}
        rows={e.fields}
        rowKey={(f) => f.name}
        columns={[
          {
            key: 'n',
            header: t(locale, 'm10a.spec.field'),
            render: (f) => (
              <>
                <Ltr>{f.name}</Ltr>{' '}
                <span className="nz-muted">
                  <bdi dir="auto">{pick(f.label, locale)}</bdi>
                </span>
              </>
            ),
          },
          {
            key: 't',
            header: t(locale, 'm10a.spec.type'),
            render: (f) => (
              <>
                <Ltr>{f.type}</Ltr>
                {f.references ? (
                  <>
                    {' → '}
                    <Ltr>{f.references}</Ltr>
                  </>
                ) : null}
                {f.enumValues.length > 0 ? (
                  <span className="nz-muted">
                    {' '}
                    (<Ltr>{f.enumValues.join(', ')}</Ltr>)
                  </span>
                ) : null}
              </>
            ),
          },
          {
            key: 'f',
            header: t(locale, 'm10a.spec.flags'),
            render: (f) => (
              <span className="nz-row">
                {f.required && <Badge>{t(locale, 'm10a.spec.required')}</Badge>}
                {f.unique && <Badge>{t(locale, 'm10a.spec.unique')}</Badge>}
                {f.pii && <Badge tone="warn">{t(locale, 'm10a.spec.pii')}</Badge>}
                {!f.required && !f.unique && !f.pii && '—'}
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}

/** UI-M10-02: the application spec the agents agreed on (entities and fields, roles, pages, API settings, non-functional requirements). */
export function AppSpecPanel({ locale, spec }: { locale: Locale; spec: SpecView }) {
  return (
    <>
      <Card aria-labelledby="bp-spec-h">
        <h2 className="nz-h2" id="bp-spec-h">
          <bdi dir="auto">{spec.name}</bdi>
        </h2>
        {spec.description && (
          <p>
            <bdi dir="auto">{spec.description}</bdi>
          </p>
        )}
        <dl>
          <dt>{t(locale, 'm10a.spec.slug')}</dt>
          <dd>
            <Ltr>{spec.slug}</Ltr>
          </dd>
          <dt>{t(locale, 'm10a.spec.locales')}</dt>
          <dd>
            {spec.locales
              .map((l) => t(locale, l === 'ar' ? 'bld.lang.ar' : 'bld.lang.en'))
              .join(' · ')}
            {spec.defaultLocale && (
              <span className="nz-muted">
                {' '}
                ({t(locale, 'm10a.spec.default')}:{' '}
                {t(locale, spec.defaultLocale === 'ar' ? 'bld.lang.ar' : 'bld.lang.en')})
              </span>
            )}
          </dd>
        </dl>
      </Card>

      <h2 className="nz-h2">{t(locale, 'm10a.spec.entities')}</h2>
      {spec.entities.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm10a.spec.noEntities')}</p>
      ) : (
        <div className="nz-grid">
          {spec.entities.map((e) => (
            <EntityTable key={e.name} locale={locale} e={e} />
          ))}
        </div>
      )}

      <h2 className="nz-h2">{t(locale, 'm10a.spec.roles')}</h2>
      <Table
        caption={t(locale, 'm10a.spec.roles')}
        rows={spec.roles}
        rowKey={(r) => r.name}
        columns={[
          {
            key: 'n',
            header: t(locale, 'm10a.spec.role'),
            render: (r) => (
              <>
                <bdi dir="auto">{pick(r.label, locale, r.name)}</bdi> <Ltr>{r.name}</Ltr>
                {r.admin && (
                  <>
                    {' '}
                    <Badge tone="warn">{t(locale, 'm10a.spec.admin')}</Badge>
                  </>
                )}
              </>
            ),
          },
          {
            key: 's',
            header: t(locale, 'm10a.spec.scope'),
            render: (r) => tDynamic(locale, `m10a.scope.${r.scope}`, r.scope),
          },
        ]}
      />

      <h2 className="nz-h2">{t(locale, 'm10a.spec.pages')}</h2>
      <Table
        caption={t(locale, 'm10a.spec.pages')}
        rows={spec.pages}
        rowKey={(p) => p.path}
        columns={[
          {
            key: 'p',
            header: t(locale, 'm10a.spec.path'),
            render: (p) => <Ltr>{p.path}</Ltr>,
          },
          {
            key: 't',
            header: t(locale, 'm10a.spec.pageTitle'),
            render: (p) => <bdi dir="auto">{pick(p.title, locale)}</bdi>,
          },
          {
            key: 'k',
            header: t(locale, 'm10a.spec.kind'),
            render: (p) => tDynamic(locale, `m10a.pagekind.${p.kind}`, p.kind),
          },
          {
            key: 'e',
            header: t(locale, 'm10a.spec.entity'),
            render: (p) => (p.entity ? <Ltr>{p.entity}</Ltr> : '—'),
          },
        ]}
      />

      <h2 className="nz-h2">{t(locale, 'm10a.spec.api')}</h2>
      <dl>
        <dt>{t(locale, 'm10a.spec.basePath')}</dt>
        <dd>
          <Ltr>{spec.api.basePath || '—'}</Ltr>
        </dd>
        <dt>{t(locale, 'm10a.spec.pageSize')}</dt>
        <dd>
          <Ltr>{`${spec.api.defaultLimit} / ${spec.api.maxLimit}`}</Ltr>
        </dd>
      </dl>

      <h2 className="nz-h2">{t(locale, 'm10a.spec.nfr')}</h2>
      <dl>
        <dt>{t(locale, 'm10a.spec.rtl')}</dt>
        <dd>{yes(locale, spec.nonFunctional.rtl)}</dd>
        <dt>{t(locale, 'm10a.spec.a11y')}</dt>
        <dd>
          <Ltr>{spec.nonFunctional.accessibility || '—'}</Ltr>
        </dd>
        <dt>{t(locale, 'm10a.spec.region')}</dt>
        <dd>
          <Ltr>{spec.nonFunctional.dataRegion || '—'}</Ltr>
        </dd>
        <dt>{t(locale, 'm10a.spec.csv')}</dt>
        <dd>{yes(locale, spec.nonFunctional.csvImportExport)}</dd>
        <dt>{t(locale, 'm10a.spec.attachments')}</dt>
        <dd>
          <Ltr>{bytesText(spec.nonFunctional.attachmentMaxBytes)}</Ltr>
        </dd>
        <dt>{t(locale, 'm10a.spec.notifications')}</dt>
        <dd>
          {spec.nonFunctional.notifications.length === 0
            ? '—'
            : spec.nonFunctional.notifications.map((n) => (
                <Badge key={n.event}>
                  <Ltr>{`${n.event} · ${n.channel}`}</Ltr>
                </Badge>
              ))}
        </dd>
      </dl>
    </>
  );
}

/** UI-M10-02: the generated database — tables and the versioned, reversible migrations. A destructive statement is flagged: deploying it needs a human approval. */
export function DataModelPanel({
  locale,
  schema,
  spec,
}: {
  locale: Locale;
  schema: SchemaView;
  spec: SpecView | null;
}) {
  const anyDestructive = schema.migrations.some((m) => m.destructive.length > 0);
  return (
    <>
      {anyDestructive && <Banner tone="warn">{t(locale, 'm10a.data.destructiveNote')}</Banner>}
      <h3 className="nz-h3">{t(locale, 'm10a.data.tables')}</h3>
      {schema.tables.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm10a.data.noTables')}</p>
      ) : (
        <ul className="bld-list" aria-label={t(locale, 'm10a.data.tables')}>
          {schema.tables.map((tb) => {
            const e = spec?.entities.find((x) => x.plural === tb);
            return (
              <li key={tb}>
                <Ltr>{tb}</Ltr>
                {e && (
                  <span className="nz-muted">
                    {' '}
                    · {t(locale, 'm10a.data.columns', { count: e.fields.length })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="nz-h3">{t(locale, 'm10a.data.migrations')}</h3>
      <ol className="bld-list" aria-label={t(locale, 'm10a.data.migrations')}>
        {schema.migrations.map((m) => (
          <li key={m.version}>
            <details>
              <summary>
                <Ltr>{`${String(m.version).padStart(4, '0')}_${m.name}`}</Ltr>{' '}
                {m.destructive.length > 0 && (
                  <Badge tone="danger">
                    {t(locale, 'm10a.data.destructive', { count: m.destructive.length })}
                  </Badge>
                )}
              </summary>
              {m.destructive.length > 0 && (
                <ul className="bld-list" aria-label={t(locale, 'm10a.data.destructiveList')}>
                  {m.destructive.map((d, i) => (
                    <li key={`${m.version}-${i}`}>
                      <Ltr>{d}</Ltr>
                    </li>
                  ))}
                </ul>
              )}
              <Code label={t(locale, 'm10a.data.up')}>{m.up}</Code>
              <Code label={t(locale, 'm10a.data.down')}>{m.down}</Code>
            </details>
          </li>
        ))}
      </ol>
    </>
  );
}

export const METHOD_TONE: Record<string, 'success' | 'warn' | 'danger' | undefined> = {
  GET: 'success',
  DELETE: 'danger',
  PUT: 'warn',
  PATCH: 'warn',
};

/** The dependency-policy verdict on the generated package manifest and its findings. */
export function ApiDeps({ locale, api }: { locale: Locale; api: ApiView }) {
  return (
    <>
      <h3 className="nz-h3">{t(locale, 'm10a.api.deps')}</h3>
      <p role="status">
        <Badge tone={api.dependencies.ok ? 'success' : 'warn'}>
          {t(locale, api.dependencies.ok ? 'm10a.api.depsOk' : 'm10a.api.depsReview')}
        </Badge>{' '}
        <span className="nz-muted">
          {t(locale, 'm10a.api.depCount', { count: api.dependencies.count })}
        </span>
      </p>
      {api.dependencies.findings.length > 0 && (
        <ul className="bld-list" aria-label={t(locale, 'm10a.api.deps')}>
          {api.dependencies.findings.map((f, i) => (
            <li key={`${f.level}-${i}`}>
              <Badge tone={f.level === 'block' ? 'danger' : 'warn'}>{f.level}</Badge>{' '}
              <bdi dir="auto">{f.message}</bdi>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** UI-M10-02: the generated REST API (from its OpenAPI) and the dependency-policy verdict on the generated package manifest. */
export function ApiPanel({ locale, api }: { locale: Locale; api: ApiView }) {
  return (
    <>
      <h3 className="nz-h3">{t(locale, 'm10a.api.endpoints')}</h3>
      {api.endpoints.length === 0 ? (
        <p className="nz-muted">{t(locale, 'm10a.api.noEndpoints')}</p>
      ) : (
        <Table
          caption={t(locale, 'm10a.api.endpoints')}
          rows={api.endpoints}
          rowKey={(e) => `${e.method} ${e.path}`}
          columns={[
            {
              key: 'm',
              header: t(locale, 'm10a.api.method'),
              render: (e) => (
                <Badge tone={METHOD_TONE[e.method]}>
                  <Ltr>{e.method}</Ltr>
                </Badge>
              ),
            },
            { key: 'p', header: t(locale, 'm10a.spec.path'), render: (e) => <Ltr>{e.path}</Ltr> },
            {
              key: 's',
              header: t(locale, 'm10a.api.summary'),
              render: (e) => (e.summary ? <bdi dir="auto">{e.summary}</bdi> : '—'),
            },
          ]}
        />
      )}
      <ApiDeps locale={locale} api={api} />
    </>
  );
}

/** UI-M10-02: the access matrix — what each role may do on each entity, and how far its data scope reaches (own / team / all). Empty cell = no access. */
export function AccessPanel({
  locale,
  roles,
  entities,
}: {
  locale: Locale;
  roles: RoleView[];
  entities: string[];
}) {
  const m = rbacMatrix(roles, entities);
  if (m.rows.length === 0) return <p className="nz-muted">{t(locale, 'm10a.access.none')}</p>;
  return (
    <div
      style={{ overflowX: 'auto' }}
      role="region"
      tabIndex={0}
      aria-label={t(locale, 'm10a.access.title')}
    >
      <table className="nz-table">
        <caption>{t(locale, 'm10a.access.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t(locale, 'm10a.spec.role')}</th>
            <th scope="col">{t(locale, 'm10a.spec.scope')}</th>
            {m.entities.map((e) => (
              <th key={e} scope="col">
                <Ltr>{e}</Ltr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.role}>
              <th scope="row">
                <Ltr>{r.role}</Ltr>
              </th>
              <td>{tDynamic(locale, `m10a.scope.${r.scope}`, r.scope)}</td>
              {r.cells.map((c) => (
                <td key={c.entity}>
                  {c.actions.length === 0 ? (
                    <span className="nz-muted">
                      <span aria-hidden="true">—</span>
                      <span className="nz-sr">{t(locale, 'm10a.access.noAccess')}</span>
                    </span>
                  ) : (
                    <span className="nz-row">
                      {c.actions.map((a) => (
                        <Badge key={a}>{tDynamic(locale, `m10a.crud.${a}`, a)}</Badge>
                      ))}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** UI-M10-02: the immutable versions of a web-app project (read-only: every build and every applied change creates a new one; restoring is a website feature). */
export function AppVersions({
  locale,
  projectId,
  versions,
}: {
  locale: Locale;
  projectId: string;
  versions: Version[];
}) {
  if (versions.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm10a.ver.empty.title')}
        body={t(locale, 'm10a.ver.empty.body')}
      />
    );
  return (
    <Table
      caption={t(locale, 'm10a.tab.versions')}
      rows={versions}
      rowKey={(v) => v.id}
      columns={[
        {
          key: 'n',
          header: t(locale, 'm10a.ver.version'),
          render: (v) => (
            <>
              <Ltr>{`#${v.seq}`}</Ltr>{' '}
              {v.isHead && <Badge tone="success">{t(locale, 'm10a.ver.head')}</Badge>}
            </>
          ),
        },
        {
          key: 'l',
          header: t(locale, 'm10a.ver.label'),
          render: (v) => (v.label ? <bdi dir="auto">{v.label}</bdi> : '—'),
        },
        {
          key: 's',
          header: t(locale, 'm10a.ver.source'),
          render: (v) => tDynamic(locale, `bld.ver.source.${v.source}`, v.source),
        },
        {
          key: 'c',
          header: t(locale, 'bld.dep.started'),
          render: (v) => when(v.createdAt, locale),
        },
        {
          key: 'r',
          header: t(locale, 'm10a.ver.run'),
          render: (v) =>
            v.runId ? (
              <a href={`/builder/runs/${v.runId}`}>
                <Ltr>{v.runId.slice(0, 8)}</Ltr>
              </a>
            ) : (
              '—'
            ),
        },
        {
          key: 'f',
          header: t(locale, 'm10a.ver.files'),
          render: () => (
            <a href={`/builder/projects/${projectId}/ide`}>{t(locale, 'm10a.ver.browse')}</a>
          ),
        },
      ]}
    />
  );
}
