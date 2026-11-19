'use client';
import { useCallback, useRef, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import type { IconName } from '@nuzm/ui';
import { isRunActive, isRunFinished, type Message, type Run, type Session } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import { APP_TABS, type AppTab } from '../lib/webapp-workspace';
import { Chat } from './BuilderChat';
import { PanelForbidden } from './PanelLoad';
import {
  AppCodePanel,
  AppDeploymentsTab,
  AppDesignTab,
  AppExportsTab,
  AppPreviewPanel,
  AppSpecTab,
  AppTestsTab,
  AppVersionsTab,
  type AppCan,
  type AppProject,
} from './WebAppPanels';
import { WebAppRunCard, type AppRunProgress } from './WebAppRun';
import { WorkspaceShell, useShellTab } from './WorkspaceShell';

const TAB_ICON: Record<AppTab, IconName> = {
  preview: 'eye',
  code: 'code',
  spec: 'list',
  design: 'data',
  tests: 'shield',
  deployments: 'cloud',
  exports: 'external',
  versions: 'refresh',
};
const TAB_LABEL: Record<AppTab, MessageKey> = {
  preview: 'mws.web.tab.preview',
  code: 'mws.web.tab.code',
  spec: 'mws.web.tab.spec',
  design: 'mws.web.tab.design',
  tests: 'mws.web.tab.tests',
  deployments: 'mws.web.tab.deployments',
  exports: 'mws.web.tab.exports',
  versions: 'mws.web.tab.versions',
};

/**
 * The web-app builder in the same full-screen workspace as the website builder (the former tabbed project page): on the left the chat (the brief, the live progress of
 * the agent graph, the approvals a build waits on, the composer for the next request); on the right the former pages as panels: Preview, Code (files and sandbox),
 * Spec, Data (data, API and access), Tests, Deployments, Exports and Versions. Each panel needs the permission its page needed. The page follows the build live and
 * re-reads the panels when it finishes. Nothing here publishes anything by itself: deployments keep their human approvals.
 */
export function WebAppWorkspace({
  locale,
  initial,
  session,
  messages,
  initialRun,
  initialTab = 'preview',
  allowedTabs,
  mfaFactorId,
  can,
}: {
  locale: Locale;
  initial: AppProject;
  session: Session | null;
  messages: Message[];
  initialRun: Run | null;
  initialTab?: AppTab;
  /** the panels this member may open (each needs the permission its former page needed) */
  allowedTabs: AppTab[];
  mfaFactorId: string | null;
  can: AppCan;
}) {
  const [project, setProject] = useState(initial);
  const [tab, select] = useShellTab<AppTab>(initialTab);
  const [runId, setRunId] = useState<string | null>(initialRun?.id ?? null);
  const [runActive, setRunActive] = useState(initialRun ? isRunActive(initialRun.state) : false);
  const [chatKey, setChatKey] = useState(0);
  /** bumped when a build finishes: every panel reads its data again */
  const [refresh, setRefresh] = useState(0);
  const [progress, setProgress] = useState<AppRunProgress>({ active: false, label: '' });
  const [reloadError, setReloadError] = useState(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const tabs = APP_TABS.filter((x) => allowedTabs.includes(x));

  /** The project as the server has it now (head version, last deployment). */
  const reload = useCallback(async () => {
    const r = await bapi.get<AppProject>(`/v1/builder/projects/${projectRef.current.id}`);
    if (!r.response.ok || !r.data) {
      setReloadError(true);
      return;
    }
    setReloadError(false);
    setProject({
      id: r.data.id,
      name: r.data.name,
      dataRegion: r.data.dataRegion,
      headVersionId: r.data.headVersionId ?? null,
      headSeq: r.data.headSeq ?? null,
      lastDeployment: r.data.lastDeployment ?? null,
    });
  }, []);

  const onRun = useCallback(
    (run: Run) => {
      setRunId(run.id);
      setRunActive(isRunActive(run.state));
      setChatKey((k) => k + 1);
      if (isRunFinished(run.state)) {
        void reload();
        setRefresh((n) => n + 1);
      }
    },
    [reload],
  );

  const menu = (
    <>
      {project.headSeq !== null && (
        <li className="bws-more-meta">{t(locale, 'bld.ws.version', { seq: project.headSeq })}</li>
      )}
      {runId && (
        <li>
          <a href={`/${locale}/builder/runs/${runId}`}>{t(locale, 'bld.run.details')}</a>
        </li>
      )}
    </>
  );

  const open = allowedTabs.includes(tab);
  return (
    <WorkspaceShell
      locale={locale}
      mode="webapp"
      backHref={`/${locale}/builder/projects?type=webapp`}
      name={project.name}
      tabsLabel={t(locale, 'mws.web.tabs')}
      tabs={tabs.map((x) => ({ id: x, icon: TAB_ICON[x], label: t(locale, TAB_LABEL[x]) }))}
      tab={tab}
      onTab={select}
      menu={project.headSeq !== null || runId ? menu : null}
      primary={
        allowedTabs.includes('deployments') ? (
          <button
            type="button"
            className="bws-publish mws-build"
            onClick={() => select('deployments')}
          >
            {t(locale, 'mws.web.deploy')}
          </button>
        ) : null
      }
      banner={reloadError ? t(locale, 'mws.web.reloadFailed') : null}
      working={progress}
      chat={
        <Chat
          locale={locale}
          projectId={project.id}
          projectName={project.name}
          session={session}
          initialMessages={messages}
          canWrite={can.describe}
          refreshKey={chatKey}
          activeRun={runActive}
          mode="webapp"
          onRun={(run) => {
            setRunId(run.id);
            setRunActive(true);
          }}
          thread={
            runId ? (
              <WebAppRunCard
                key={runId}
                locale={locale}
                runId={runId}
                canWrite={can.ai}
                canApprove={can.approve}
                mfaFactorId={mfaFactorId}
                onRun={onRun}
                onProgress={setProgress}
              />
            ) : undefined
          }
        />
      }
    >
      <div className="mws-panel" data-panel={tab}>
        {!open ? (
          <PanelForbidden locale={locale} />
        ) : tab === 'preview' ? (
          <AppPreviewPanel locale={locale} project={project} refresh={refresh} />
        ) : tab === 'code' ? (
          <AppCodePanel
            locale={locale}
            projectId={project.id}
            can={can}
            mfaFactorId={mfaFactorId}
            refresh={refresh}
          />
        ) : tab === 'spec' ? (
          <AppSpecTab locale={locale} projectId={project.id} refresh={refresh} />
        ) : tab === 'design' ? (
          <AppDesignTab locale={locale} projectId={project.id} refresh={refresh} />
        ) : tab === 'tests' ? (
          <AppTestsTab
            locale={locale}
            projectId={project.id}
            can={can}
            mfaFactorId={mfaFactorId}
            refresh={refresh}
          />
        ) : tab === 'deployments' ? (
          <AppDeploymentsTab locale={locale} project={project} can={can} refresh={refresh} />
        ) : tab === 'exports' ? (
          <AppExportsTab
            locale={locale}
            projectId={project.id}
            can={can}
            mfaFactorId={mfaFactorId}
            refresh={refresh}
          />
        ) : (
          <AppVersionsTab locale={locale} projectId={project.id} refresh={refresh} />
        )}
      </div>
    </WorkspaceShell>
  );
}
