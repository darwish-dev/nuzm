'use client';
import type { ComponentProps } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { EmptyState } from '@nuzm/ui';
import type { HostingSiteRef, Page_, Version } from '../lib/builder';
import { AppDeployments } from './AppDeployments';
import { AppSpecPanel, AppVersions, NoBuildYet } from './AppBlueprint';
import { Exports } from './BuilderExports';
import { TestRuns } from './BuilderTests';
import { Gate } from './PanelLoad';
import { gone, Section, useApi, useBuilt } from './WebAppLoad';
import { WebAppLivePreview } from './WebAppLivePreview';

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

/**
 * Preview: the running app (live preview, ADR-063) alone, edge to edge in the canvas like the website preview. What the agents built is listed in the
 * conversation, the spec in its own panel and the project's details in Deployments and Versions, so none of it repeats above the app.
 */
export function AppPreviewPanel({
  locale,
  project,
  canWrite,
}: {
  locale: Locale;
  project: AppProject;
  canWrite: boolean;
}) {
  return (
    <WebAppLivePreview
      locale={locale}
      projectId={project.id}
      canWrite={canWrite}
      buildId={project.headVersionId}
    />
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
