'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import type { IconName } from '@nuzm/ui';
import {
  isRunActive,
  isRunFinished,
  type Message,
  type Page_,
  type Run,
  type Session,
} from '../lib/builder';
import { bapi } from '../lib/builder-client';
import { runsByMessage, type OpenTarget } from '../lib/webapp-events';
import { APP_TABS, type AppTab } from '../lib/webapp-workspace';
import { Chat } from './BuilderChat';
import { DeleteProject } from './DeleteProject';
import { PanelForbidden } from './PanelLoad';
import {
  AppDeploymentsTab,
  AppExportsTab,
  AppPreviewPanel,
  AppSpecTab,
  AppTestsTab,
  AppVersionsTab,
  type AppCan,
  type AppProject,
} from './WebAppPanels';
import { AppCodePanel } from './WebAppCode';
import { AppDataPane, type DataView } from './WebAppData';
import { WebAppRunHistory } from './WebAppHistory';
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
  /** earlier builds of the project, shown in the conversation after the request that started them */
  const [pastRuns, setPastRuns] = useState<Run[]>([]);
  /** a link from the chat to a file in Code or a table / migration / endpoint list in Data (`n` makes the same target open again) */
  const [codeOpen, setCodeOpen] = useState<{ path: string; n: number } | null>(null);
  const [dataFocus, setDataFocus] = useState<{ view?: DataView; n: number } | null>(null);
  const nonce = useRef(0);
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

  // the persisted runs of the project (the conversation keeps them after the next request); not readable without `ai:read`: the chat then shows the current run only
  useEffect(() => {
    let stop = false;
    void bapi
      .get<Page_<Run>>('/v1/ai/runs', { query: { projectId: project.id, limit: 20 } })
      .then((r) => {
        if (stop || !r.response.ok || !r.data) return;
        setPastRuns(r.data.items.filter((x) => x.kind === 'webapp' || x.kind === 'test-fix'));
      });
    return () => {
      stop = true;
    };
  }, [project.id, chatKey, runId]);

  /** Open a panel from a link in the chat: a file in Code, a view of Data, or the panel itself. */
  const openTarget = useCallback(
    (target: OpenTarget) => {
      nonce.current += 1;
      if (target.tab === 'code' && target.path)
        setCodeOpen({ path: target.path, n: nonce.current });
      if (target.tab === 'design') setDataFocus({ view: target.view, n: nonce.current });
      select(target.tab);
    },
    [select],
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
      {can.write && (
        <li>
          <DeleteProject
            locale={locale}
            variant="menu"
            project={{ id: project.id, name: project.name }}
            mfaFactorId={mfaFactorId}
            redirectTo={`/${locale}/builder/projects`}
          />
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
      scene={tab === 'preview' && progress.active}
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
          history={(msgs) => {
            const g = runsByMessage(msgs, pastRuns, runId);
            const card = (r: Run) => (
              <WebAppRunHistory key={r.id} locale={locale} run={r} onOpen={openTarget} />
            );
            return {
              before: g.before.length > 0 ? g.before.map(card) : undefined,
              after: (m) => g.after.get(m.id)?.map(card),
            };
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
                onOpen={openTarget}
              />
            ) : undefined
          }
        />
      }
    >
      {!open ? (
        <div className="mws-panel" data-panel={tab}>
          <PanelForbidden locale={locale} />
        </div>
      ) : tab === 'code' ? (
        <AppCodePanel
          locale={locale}
          projectId={project.id}
          headVersionId={project.headVersionId}
          can={can}
          mfaFactorId={mfaFactorId}
          refresh={refresh}
          open={codeOpen}
        />
      ) : tab === 'design' ? (
        <AppDataPane
          locale={locale}
          projectId={project.id}
          headVersionId={project.headVersionId}
          refresh={refresh}
          focus={dataFocus}
          onOpenFile={(path) => openTarget({ tab: 'code', path })}
        />
      ) : (
        <div className="mws-panel" data-panel={tab}>
          {tab === 'preview' ? (
            <AppPreviewPanel
              locale={locale}
              project={project}
              refresh={refresh}
              canWrite={can.write}
            />
          ) : tab === 'spec' ? (
            <AppSpecTab locale={locale} projectId={project.id} refresh={refresh} />
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
      )}
    </WorkspaceShell>
  );
}
