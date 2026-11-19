'use client';
import type { ComponentProps } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, EmptyState } from '@nuzm/ui';
import {
  latestBuiltRun,
  pick,
  readApi,
  readSchema,
  readSpec,
  type ApiView,
  type SchemaView,
  type SpecView,
} from '../lib/appworkspace';
import type { Built } from '../lib/appworkspace-server';
import type { Sandbox } from '../lib/appbuilder';
import type { HostingSiteRef, Page_, Run, Version } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import { AppDeployments } from './AppDeployments';
import {
  AccessPanel,
  ApiPanel,
  AppSpecPanel,
  AppSummary,
  AppVersions,
  DataModelPanel,
  NoBuildYet,
} from './AppBlueprint';
import { FileBrowser, RunPanel } from './BuilderIde';
import { Exports } from './BuilderExports';
import { TestRuns } from './BuilderTests';
import { NotEnabledState } from './BuilderParts';
import { fetched, Gate, useLoad, type Fetched, type Load } from './PanelLoad';

/** What the member may do in the web-app panels, decided on the server from the session (functions cannot cross to the browser). */
export interface AppCan {
  /** `ai:write`: describe an app, cancel a run */
  ai: boolean;
  /** `builder:write` + `ai:write` */
  describe: boolean;
  /** `ai:approve`: decide the approvals of a build */
  approve: boolean;
  /** `builder:write` */
  write: boolean;
  /** `sandbox:use` */
  sandbox: boolean;
  /** `builder:test` */
  test: boolean;
  /** `ai:run` */
  run: boolean;
  /** `builder:export` */
  export: boolean;
  /** `deploy:write` */
  deployWrite: boolean;
  /** `hosting:site:read`: the hosting sites a deployment can target */
  sites: boolean;
}

/** What the workspace reads of a web-app project (`GET /v1/builder/projects/{id}`). */
export interface AppProject {
  id: string;
  name: string;
  dataRegion: string;
  headVersionId: string | null;
  headSeq: number | null;
  lastDeployment: { state: string; url: string | null } | null;
}

/** A 404 in a web-app panel is the app builder being off (or the item gone): the same "not enabled" state the former pages showed. */
const gone = (locale: Locale) => <NotEnabledState locale={locale} />;

/** The newest build's `app_spec`, `db_schema` and `api_contract` (the browser's twin of the server's `loadBuilt`): null while no build produced a spec. */
async function readBuilt(projectId: string): Promise<Fetched<Built | null>> {
  const runs = await bapi.get<Page_<Run>>('/v1/ai/runs', { query: { projectId, limit: 20 } });
  if (!runs.response.ok || !runs.data) return fetched(runs);
  const run = latestBuiltRun(runs.data.items);
  if (!run) return { ok: true, status: 200, data: null };
  const payload = async (type: string): Promise<unknown> => {
    const a = run.artifacts.find((x) => x.type === type);
    if (!a) return null;
    const r = await bapi.get<{ payload: unknown }>(`/v1/ai/runs/${run.id}/artifacts/${a.id}`);
    return r.response.ok ? (r.data?.payload ?? null) : null;
  };
  const [spec, schema, api] = await Promise.all([
    payload('app_spec'),
    payload('db_schema'),
    payload('api_contract'),
  ]);
  return {
    ok: true,
    status: 200,
    data: { run, spec: readSpec(spec), schema: readSchema(schema), api: readApi(api) },
  };
}
const useBuilt = (projectId: string, refresh: number): [Load<Built | null>, () => void] =>
  useLoad<Built | null>(() => readBuilt(projectId), `built:${projectId}:${refresh}`);

/** A read of one list or object of the builder API as a panel's data. */
const useApi = <T,>(
  path: string,
  query: Record<string, string | number> | undefined,
  refresh: number,
  enabled = true,
): [Load<T>, () => void] =>
  useLoad<T>(
    async () => fetched<T>(await bapi.get<T>(path, query ? { query } : undefined)),
    `${path}:${JSON.stringify(query ?? {})}:${refresh}`,
    enabled,
  );

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) => (
  <section aria-labelledby={id}>
    <h2 className="nz-h2" id={id}>
      {title}
    </h2>
    {children}
  </section>
);

/** Preview: the project at a glance and what the agents built. There is no live preview of a web app yet, and the panel says so. */
export function AppPreviewPanel({
  locale,
  project,
  refresh,
}: {
  locale: Locale;
  project: AppProject;
  refresh: number;
}) {
  const [built, retry] = useBuilt(project.id, refresh);
  return (
    <div className="mws-app-preview">
      <AppSummary locale={locale} project={project} />
      <Banner tone="warn">{t(locale, 'mws.web.preview.note')}</Banner>
      <Section id="mws-web-built-h" title={t(locale, 'mws.web.preview.built')}>
        <Gate locale={locale} load={built} retry={retry} gone={gone(locale)}>
          {(b) =>
            b?.spec ? <BuiltList locale={locale} spec={b.spec} /> : <NoBuildYet locale={locale} />
          }
        </Gate>
      </Section>
    </div>
  );
}

/** Entities, pages and roles of the agreed spec as three short lists (the Spec panel has the detail). */
function BuiltList({ locale, spec }: { locale: Locale; spec: SpecView }) {
  return (
    <div className="mws-built">
      <p>
        <bdi dir="auto">
          <strong>{spec.name}</strong>
        </bdi>
        {spec.description && (
          <span className="nz-muted">
            {' '}
            <bdi dir="auto">{spec.description}</bdi>
          </span>
        )}
      </p>
      <dl className="mws-dl">
        <dt>{t(locale, 'mws.web.preview.entities')}</dt>
        <dd>
          {spec.entities.map((e) => (
            <Badge key={e.name}>
              <bdi dir="auto">{pick(e.label, locale, e.name)}</bdi>
            </Badge>
          ))}
        </dd>
        <dt>{t(locale, 'mws.web.preview.pages')}</dt>
        <dd>
          {spec.pages.map((p, i) => (
            <Badge key={`${p.path}:${i}`}>
              <bdi dir="auto">{pick(p.title, locale, p.path)}</bdi>
            </Badge>
          ))}
        </dd>
        <dt>{t(locale, 'mws.web.preview.roles')}</dt>
        <dd>
          {spec.roles.map((r) => (
            <Badge key={r.name}>
              <bdi dir="auto">{pick(r.label, locale, r.name)}</bdi>
            </Badge>
          ))}
        </dd>
      </dl>
    </div>
  );
}

/** Code: the generated files in a read-only viewer, and the sandbox panel (start a sandbox, run the tests). Needs `sandbox:use`, as the former IDE page did. */
export function AppCodePanel({
  locale,
  projectId,
  can,
  mfaFactorId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  mfaFactorId: string | null;
  refresh: number;
}) {
  const [files, retry] = useApi<{ items: { path?: string; size?: number }[] }>(
    `/v1/builder/projects/${projectId}/files`,
    undefined,
    refresh,
  );
  const [boxes] = useApi<{ items: Sandbox[] }>(
    `/v1/builder/projects/${projectId}/sandboxes`,
    undefined,
    refresh,
  );
  return (
    <Section id="mws-web-code-h" title={t(locale, 'm10a.tab.ide')}>
      <Gate locale={locale} load={files} retry={retry} gone={gone(locale)}>
        {(f) => (
          <>
            <FileBrowser
              locale={locale}
              projectId={projectId}
              files={f.items}
              canWrite={can.write}
            />
            <Gate locale={locale} load={boxes} retry={retry} gone={gone(locale)}>
              {(s) => (
                <RunPanel
                  locale={locale}
                  projectId={projectId}
                  initial={s.items}
                  canUse={can.sandbox}
                  canTest={can.test}
                  mfaFactorId={mfaFactorId}
                />
              )}
            </Gate>
          </>
        )}
      </Gate>
    </Section>
  );
}

/** Spec: the application spec of the newest build (entities, roles, pages, API settings, non-functional requirements). */
export function AppSpecTab({
  locale,
  projectId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  refresh: number;
}) {
  const [built, retry] = useBuilt(projectId, refresh);
  return (
    <Section id="mws-web-spec-h" title={t(locale, 'm10a.spec.title')}>
      <Gate locale={locale} load={built} retry={retry} gone={gone(locale)}>
        {(b) =>
          b?.spec ? (
            <>
              <p className="nz-muted">
                {t(locale, 'm10a.spec.from', { run: b.run.id.slice(0, 8) })}
              </p>
              <AppSpecPanel locale={locale} spec={b.spec} />
            </>
          ) : (
            <NoBuildYet locale={locale} />
          )
        }
      </Gate>
    </Section>
  );
}

/** Data, API and access: what the database, backend and security agents generated (schema and migrations, REST API, the role × entity matrix). */
export function AppDesignTab({
  locale,
  projectId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  refresh: number;
}) {
  const [built, retry] = useBuilt(projectId, refresh);
  return (
    <Section id="mws-web-design-h" title={t(locale, 'm10a.design.title')}>
      <Gate locale={locale} load={built} retry={retry} gone={gone(locale)}>
        {(b) => {
          if (!b) return <NoBuildYet locale={locale} />;
          const roles = b.api?.rbac.length ? b.api.rbac : (b.spec?.roles ?? []);
          const notYet = <p className="nz-muted">{t(locale, 'm10a.bp.notYet')}</p>;
          return (
            <>
              <section aria-labelledby="m10a-data">
                <h3 className="nz-h2" id="m10a-data">
                  {t(locale, 'm10a.data.title')}
                </h3>
                {b.schema ? (
                  <DataModelPanel locale={locale} schema={b.schema as SchemaView} spec={b.spec} />
                ) : (
                  notYet
                )}
              </section>
              <section aria-labelledby="m10a-api">
                <h3 className="nz-h2" id="m10a-api">
                  {t(locale, 'm10a.api.title')}
                </h3>
                {b.api ? <ApiPanel locale={locale} api={b.api as ApiView} /> : notYet}
              </section>
              <section aria-labelledby="m10a-access">
                <h3 className="nz-h2" id="m10a-access">
                  {t(locale, 'm10a.access.title')}
                </h3>
                {roles.length > 0 ? (
                  <AccessPanel
                    locale={locale}
                    roles={roles}
                    entities={b.spec?.entities.map((e) => e.name) ?? []}
                  />
                ) : (
                  notYet
                )}
              </section>
            </>
          );
        }}
      </Gate>
    </Section>
  );
}

/** Tests: test runs, structured results, re-run and "Ask AI to fix" (a `test-fix` run). */
export function AppTestsTab({
  locale,
  projectId,
  can,
  mfaFactorId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  mfaFactorId: string | null;
  refresh: number;
}) {
  const [runs, retry] = useApi<{ items: ComponentProps<typeof TestRuns>['initial'] }>(
    `/v1/builder/projects/${projectId}/test-runs`,
    undefined,
    refresh,
  );
  return (
    <Section id="mws-web-tests-h" title={t(locale, 'm10.tst.title')}>
      <Gate locale={locale} load={runs} retry={retry} gone={gone(locale)}>
        {(r) => (
          <TestRuns
            locale={locale}
            projectId={projectId}
            initial={r.items}
            canTest={can.test}
            canRun={can.run}
            mfaFactorId={mfaFactorId}
          />
        )}
      </Gate>
    </Section>
  );
}

/** Deployments: deploy a version to a hosting site, the human approvals a production deploy needs, the health gate, rollback. */
export function AppDeploymentsTab({
  locale,
  project,
  can,
  refresh,
}: {
  locale: Locale;
  project: AppProject;
  can: AppCan;
  refresh: number;
}) {
  const [deps, retry] = useApi<{ items: ComponentProps<typeof AppDeployments>['initial'] }>(
    '/v1/deployments',
    { projectId: project.id, limit: 20 },
    refresh,
  );
  // the hosting sites feed the target selector; hosting may be off or not readable for this member: the form then explains it
  const [sites] = useApi<{
    items: { id: string; name: string; status: string; primaryDomain?: string | null }[];
  }>('/v1/hosting/sites', { limit: 100 }, refresh, can.sites);
  const refs: HostingSiteRef[] =
    sites.state === 'ready'
      ? sites.data.items.map((x) => ({
          id: x.id,
          name: x.name,
          status: x.status,
          primaryDomain: x.primaryDomain ?? null,
        }))
      : [];
  return (
    <Section id="mws-web-deploy-h" title={t(locale, 'm10.tab.deployments')}>
      <Gate locale={locale} load={deps} retry={retry} gone={gone(locale)}>
        {(d) =>
          can.sites && sites.state === 'loading' ? (
            <p role="status" aria-busy="true" className="nz-muted">
              {t(locale, 'state.loading')}
            </p>
          ) : (
            <AppDeployments
              locale={locale}
              projectId={project.id}
              versionId={project.headVersionId}
              headSeq={project.headSeq}
              initial={d.items}
              sites={refs}
              canWrite={can.deployWrite}
            />
          )
        }
      </Gate>
    </Section>
  );
}

/** Exports: request an export, its checksum and SBOM reference, the reasons a blocked export is blocked. */
export function AppExportsTab({
  locale,
  projectId,
  can,
  mfaFactorId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  mfaFactorId: string | null;
  refresh: number;
}) {
  const [list, retry] = useApi<{ items: ComponentProps<typeof Exports>['initial'] }>(
    `/v1/builder/projects/${projectId}/exports`,
    undefined,
    refresh,
  );
  return (
    <Section id="mws-web-exports-h" title={t(locale, 'm10.exp.title')}>
      <Gate locale={locale} load={list} retry={retry} gone={gone(locale)}>
        {(l) => (
          <Exports
            locale={locale}
            projectId={projectId}
            initial={l.items}
            canExport={can.export}
            mfaFactorId={mfaFactorId}
          />
        )}
      </Gate>
    </Section>
  );
}

/** Versions: the immutable versions of the project (every build and every applied change creates one). */
export function AppVersionsTab({
  locale,
  projectId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  refresh: number;
}) {
  const [vers, retry] = useApi<Page_<Version>>(
    `/v1/builder/projects/${projectId}/versions`,
    { limit: 50 },
    refresh,
  );
  return (
    <Section id="mws-web-versions-h" title={t(locale, 'm10a.tab.versions')}>
      <Gate locale={locale} load={vers} retry={retry} gone={gone(locale)}>
        {(v) =>
          v.items.length === 0 ? (
            <EmptyState
              title={t(locale, 'm10a.ver.empty.title')}
              body={t(locale, 'm10a.ver.empty.body')}
            />
          ) : (
            <AppVersions locale={locale} projectId={projectId} versions={v.items} />
          )
        }
      </Gate>
    </Section>
  );
}
