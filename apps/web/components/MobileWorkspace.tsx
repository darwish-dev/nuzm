'use client';
import { useCallback, useMemo, useRef, useState } from 'react';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Banner, EmptyState, Icon, type IconName } from '@nuzm/ui';
import { isRunActive, isRunFinished, type Message, type Run, type Session } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import {
  WORKSPACE_TABS,
  biText,
  manifestSpec,
  mobileApprovalView,
  previewSpec,
  type PreviewSpec,
  type WorkspaceTab,
} from '../lib/mobile';
import { Chat } from './BuilderChat';
import { DeleteProject } from './DeleteProject';
import { MobileCode } from './MobileCode';
import { BuildsPanel, ReleasesPanel, SigningPanel } from './MobilePanels';
import { PanelForbidden } from './PanelLoad';
import { WorkspaceShell, useShellTab } from './WorkspaceShell';
import { PhonePreview, type PhoneDevice } from './MobilePhone';
import { MobileRunCard, type MobileRunProgress } from './MobileRun';
import { MobileSpecPane } from './MobileSpecPane';

/** What the mobile workspace reads of the project (`GET /v1/builder/projects/{id}` of a mobile project: the manifest holds the approved spec, never file bytes). */
export interface MobileProject {
  id: string;
  name: string;
  versionId: string | null;
  versionSeq: number | null;
  manifest: unknown;
}
/** What the member may do, decided on the server from the session (functions cannot cross to the browser). */
export interface MobileCan {
  /** `ai:write`: describe an app, approve or decline a design, cancel a run */
  ai: boolean;
  /** `builder:write` + `ai:write` */
  describe: boolean;
  build: boolean;
  /** `builder:write`: the "more" menu offers deleting the project */
  write?: boolean;
  signing: boolean;
  release: boolean;
}

const TAB_ICON: Record<WorkspaceTab, IconName> = {
  preview: 'eye',
  code: 'code',
  spec: 'list',
  builds: 'hosting',
  signing: 'key',
  releases: 'tag',
};
const TAB_LABEL: Record<WorkspaceTab, MessageKey> = {
  preview: 'mws.tab.preview',
  code: 'mws.tab.code',
  spec: 'mws.tab.spec',
  builds: 'mws.tab.builds',
  signing: 'mws.tab.signing',
  releases: 'mws.tab.releases',
};

/**
 * The mobile (Flutter) app builder in the same full-screen workspace as the website builder: on the left the chat (the design request, the live steps of the run, the
 * design to approve or decline, the composer for the next request); on the right the Preview (a phone or tablet frame drawn from the approved spec), the generated
 * Flutter files, the Spec, and the mobile features that used to be separate pages: Builds, Signing (references only) and Releases. The page follows the run live and
 * takes the new project when it finishes. Nothing here submits to a store, signs with a secret or promises how the app behaves on a device.
 */
export function MobileWorkspace({
  locale,
  initial,
  session,
  messages,
  initialRun,
  initialTab = 'preview',
  startRelease = false,
  userId,
  can,
}: {
  locale: Locale;
  initial: MobileProject;
  session: Session | null;
  messages: Message[];
  initialRun: Run | null;
  initialTab?: WorkspaceTab;
  /** open the Releases panel on the preparation wizard (the old `/releases/new` link) */
  startRelease?: boolean;
  userId: string;
  can: MobileCan;
}) {
  const [project, setProject] = useState(initial);
  const spec = useMemo(() => manifestSpec(project.manifest), [project.manifest]);
  const [tab, select] = useShellTab<WorkspaceTab>(initialTab);
  const [device, setDevice] = useState<PhoneDevice>('phone');
  const [lang, setLang] = useState<'ar' | 'en'>(
    spec?.defaultLocale ?? (locale === 'ar' ? 'ar' : 'en'),
  );
  const [dark, setDark] = useState(spec?.theme.dark ?? false);
  const [runId, setRunId] = useState<string | null>(initialRun?.id ?? null);
  const [runActive, setRunActive] = useState(initialRun ? isRunActive(initialRun.state) : false);
  const [chatKey, setChatKey] = useState(0);
  const [progress, setProgress] = useState<MobileRunProgress>({ active: false, label: '' });
  const [proposal, setProposal] = useState<PreviewSpec | null>(null);
  const [reloadError, setReloadError] = useState(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const grant: Record<WorkspaceTab, boolean> = {
    preview: true,
    code: true,
    spec: true,
    builds: can.build,
    signing: can.signing,
    releases: can.release,
  };
  const tabs = WORKSPACE_TABS.filter((x) => grant[x]);

  /** The project as the server has it now (the approved spec and the head version). */
  const reload = useCallback(async () => {
    const r = await bapi.get<MobileProject>(`/v1/builder/projects/${projectRef.current.id}`);
    if (!r.response.ok || !r.data) {
      setReloadError(true);
      return;
    }
    setReloadError(false);
    const next: MobileProject = {
      id: r.data.id,
      name: r.data.name,
      versionId: r.data.versionId ?? null,
      versionSeq: r.data.versionSeq ?? null,
      manifest: r.data.manifest,
    };
    // a new version carries a new design: the preview takes its language and theme (a choice made in the top bar holds until then)
    const s = manifestSpec(next.manifest);
    if (s && next.versionId !== projectRef.current.versionId) {
      setLang(s.defaultLocale);
      setDark(s.theme.dark);
    }
    setProject(next);
  }, []);

  /** A run changed state: take the new project when it finished, read the proposed design while it waits for the person. */
  const onRun = useCallback(
    (run: Run) => {
      setRunId(run.id);
      setRunActive(isRunActive(run.state));
      setChatKey((k) => k + 1);
      if (isRunFinished(run.state)) {
        setProposal(null);
        void reload();
      } else if (run.state === 'waiting_approval' && run.pendingApproval) {
        const id = mobileApprovalView(run.pendingApproval.summary).artifactId;
        if (!id) return setProposal(null);
        void bapi
          .get<{ payload: unknown }>(`/v1/ai/runs/${run.id}/artifacts/${id}`)
          .then((r) => setProposal(r.response.ok && r.data ? previewSpec(r.data.payload) : null));
      } else setProposal(null);
    },
    [reload],
  );

  const shown = proposal ?? spec;
  const name = project.manifest && spec ? biText(spec.app.name, lang) : '';
  const allowed = grant[tab];

  const controls =
    tab === 'preview' ? (
      <>
        <div className="bws-seg bws-seg-icons" role="group" aria-label={t(locale, 'bld.ws.device')}>
          {(['phone', 'tablet'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              aria-label={t(locale, `mws.device.${d}`)}
              title={t(locale, `mws.device.${d}`)}
              onClick={() => setDevice(d)}
            >
              <Icon name={d} size={17} />
            </button>
          ))}
        </div>
        <div className="bws-seg" role="group" aria-label={t(locale, 'mws.lang')}>
          {(['ar', 'en'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {t(locale, `bld.lang.${l}`)}
            </button>
          ))}
        </div>
        <div className="bws-seg bws-seg-icons" role="group" aria-label={t(locale, 'mws.theme')}>
          {(['light', 'dark'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={dark === (m === 'dark')}
              aria-label={t(locale, `mws.theme.${m}`)}
              title={t(locale, `mws.theme.${m}`)}
              onClick={() => setDark(m === 'dark')}
            >
              <Icon name={m === 'dark' ? 'moon' : 'sun'} size={17} />
            </button>
          ))}
        </div>
      </>
    ) : null;
  const menu =
    project.versionSeq !== null || runId || can.write ? (
      <>
        {project.versionSeq !== null && (
          <li className="bws-more-meta">
            {t(locale, 'bld.ws.version', { seq: project.versionSeq })}
          </li>
        )}
        {runId && (
          <li>
            <a href={`/builder/runs/${runId}`}>{t(locale, 'bld.run.details')}</a>
          </li>
        )}
        {can.write && (
          <li>
            <DeleteProject
              locale={locale}
              variant="menu"
              project={{ id: project.id, name: project.name }}
              redirectTo={`/builder/projects`}
            />
          </li>
        )}
      </>
    ) : null;

  return (
    <WorkspaceShell
      locale={locale}
      mode="mobile"
      backHref={`/builder/projects?type=mobile`}
      name={project.name}
      tabsLabel={t(locale, 'mobile.tab.label')}
      tabs={tabs.map((x) => ({ id: x, icon: TAB_ICON[x], label: t(locale, TAB_LABEL[x]) }))}
      tab={tab}
      onTab={select}
      controls={controls}
      menu={menu}
      primary={
        can.build ? (
          <button type="button" className="bws-publish mws-build" onClick={() => select('builds')}>
            {t(locale, 'mws.build')}
          </button>
        ) : null
      }
      banner={reloadError ? t(locale, 'mws.reloadFailed') : null}
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
          mode="mobile"
          onRun={(run) => {
            setRunId(run.id);
            setRunActive(true);
          }}
          thread={
            runId ? (
              <MobileRunCard
                key={runId}
                locale={locale}
                runId={runId}
                canWrite={can.ai}
                onRun={onRun}
                onProgress={setProgress}
              />
            ) : undefined
          }
        />
      }
    >
      {!allowed ? (
        <div className="mws-panel" data-table-default="table">
          <PanelForbidden locale={locale} />
        </div>
      ) : tab === 'preview' ? (
        <div className="mws-preview">
          <Banner tone="warn">{t(locale, 'mobile.preview.notice')}</Banner>
          {shown ? (
            <div className="mws-stage" data-device={device}>
              {proposal && (
                <p className="mws-proposed" role="status">
                  <Icon name="sparkle" size={15} /> {t(locale, 'mws.preview.proposed')}
                </p>
              )}
              <PhonePreview
                locale={locale}
                spec={shown}
                device={device}
                lang={lang}
                dark={dark}
                label={name ? t(locale, 'mws.preview.frameOf', { name }) : undefined}
              />
            </div>
          ) : (
            <EmptyState
              title={t(
                locale,
                progress.active ? 'mws.preview.designing' : 'mws.preview.emptyTitle',
              )}
              body={t(
                locale,
                progress.active ? 'mws.preview.designingBody' : 'mws.preview.emptyBody',
              )}
            />
          )}
        </div>
      ) : tab === 'code' ? (
        <MobileCode locale={locale} projectId={project.id} versionId={project.versionId} />
      ) : (
        <div className="mws-panel" data-table-default="table">
          {tab === 'spec' && <MobileSpecPane locale={locale} manifest={project.manifest} />}
          {tab === 'builds' && (
            <BuildsPanel
              locale={locale}
              projectId={project.id}
              manifest={project.manifest}
              canBuild={can.build}
            />
          )}
          {tab === 'signing' && (
            <SigningPanel locale={locale} userId={userId} canSign={can.signing} />
          )}
          {tab === 'releases' && (
            <ReleasesPanel
              locale={locale}
              projectId={project.id}
              manifest={project.manifest}
              canRelease={can.release}
              canBuild={can.build}
              startWizard={startRelease}
            />
          )}
        </div>
      )}
    </WorkspaceShell>
  );
}
