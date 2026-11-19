'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Icon, type IconName } from '@nuzm/ui';
import {
  emptyHistory,
  finishRedo,
  finishUndo,
  findSection,
  isRunActive,
  isRunFinished,
  nextRedo,
  nextUndo,
  pushEdit,
  type BuilderProblem,
  type ChangeResult,
  type History,
  type Message,
  type Op,
  type ProjectDetail,
  type Run,
  type Session,
  type SiteLocale,
  type Viewport,
  VIEWPORTS,
} from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { BrandMark } from './BrandLogo';
import { BuildingScene } from './BuildingScene';
import { Chat } from './BuilderChat';
import { CodePane } from './BuilderCode';
import { DataPane } from './BuilderData';
import { Inspector, type Selection } from './BuilderInspector';
import { PreviewPane } from './BuilderPreview';
import { RunCard, type RunProgress } from './BuilderRunCard';

type Mode = 'edit' | 'undo' | 'redo';

/**
 * UI-M09-03: the builder workspace. Left: the conversation and the run timeline (live over SSE). Centre: the sandboxed responsive preview, or the generated
 * files and version diff. Right: the outline and property inspector with undo / redo. Every manual edit is a set of ops sent with the base version the
 * editor is looking at: a stale base (409) offers reload or rebase, an invalid op (422) lists its issues, and the server answers with the safe diff, the risk
 * flags and the inverse ops that feed undo and redo. A viewer (no `builder:write`) sees everything and changes nothing.
 */
export function Workspace({
  locale,
  initial,
  session,
  messages,
  initialRun,
  canWrite,
  canAi,
  links = [],
}: {
  locale: Locale;
  initial: ProjectDetail;
  session: Session | null;
  messages: Message[];
  initialRun: Run | null;
  canWrite: boolean;
  canAi: boolean;
  /** the project's other screens (versions, SEO, forms, CMS, deployments) the person may open: shown under "More"; `publish` is the deployments link */
  links?: { key: string; href: string; label: string }[];
}) {
  const call = useBuilderCall();
  const [detail, setDetail] = useState(initial);
  const detailRef = useRef(initial);
  detailRef.current = detail;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [last, setLast] = useState<ChangeResult | null>(null);
  const [conflict, setConflict] = useState<{
    problem: BuilderProblem;
    ops: Op[];
    mode: Mode;
  } | null>(null);
  const [view, setView] = useState<'preview' | 'code' | 'data'>('preview');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [siteLocale, setSiteLocale] = useState<SiteLocale>(
    (initial.siteModel.locales[0] as SiteLocale | undefined) ?? 'ar',
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [progress, setProgress] = useState<RunProgress>({ active: false, label: '' });
  // the "site being built" scene stays a moment after the run ends so it fades out instead of vanishing
  const [scene, setScene] = useState<'off' | 'on' | 'leaving'>('off');
  useEffect(() => {
    if (progress.active) return setScene('on');
    setScene((s) => (s === 'on' ? 'leaving' : s));
    const h = setTimeout(() => setScene((s) => (s === 'leaving' ? 'off' : s)), 700);
    return () => clearTimeout(h);
  }, [progress.active]);
  const [runId, setRunId] = useState<string | null>(initialRun?.id ?? null);
  const [runActive, setRunActive] = useState(initialRun ? isRunActive(initialRun.state) : false);
  const [chatKey, setChatKey] = useState(0);
  const [reloadError, setReloadError] = useState(false);

  /** The head of the project as the server has it now (model and version). */
  const reload = useCallback(async (): Promise<ProjectDetail | null> => {
    const r = await bapi.get<ProjectDetail>(`/v1/builder/projects/${detailRef.current.id}`);
    if (!r.response.ok || !r.data) {
      setReloadError(true);
      return null;
    }
    setReloadError(false);
    setDetail(r.data);
    detailRef.current = r.data;
    setSelection((s) => (s && findSection(r.data!.siteModel, s.pageId, s.sectionId) ? s : null));
    return r.data;
  }, []);

  const apply = useCallback(
    async (ops: Op[], mode: Mode = 'edit', retryBase?: string): Promise<boolean> => {
      const base = retryBase ?? detailRef.current.versionId;
      return call.run(
        () =>
          bapi.post<ChangeResult>(`/v1/builder/projects/${detailRef.current.id}/changes`, {
            body: { baseVersion: base, ops, source: 'user' },
          }),
        async (res) => {
          setConflict(null);
          setLast(res);
          setHistory((h) =>
            mode === 'edit'
              ? pushEdit(h, res.inverseOps)
              : mode === 'undo'
                ? finishUndo(h, res.inverseOps)
                : finishRedo(h, res.inverseOps),
          );
          await reload();
        },
        (p) => {
          if (p.code === 'base_outdated') {
            setConflict({ problem: p, ops, mode });
            return true;
          }
          // an uncertain answer (network): look at the head before anything is sent again
          if (p.status === 599) void reload();
          return false;
        },
      );
    },
    [call, reload],
  );

  const undo = () => {
    const ops = nextUndo(history);
    if (ops) void apply(ops, 'undo');
  };
  const redo = () => {
    const ops = nextRedo(history);
    if (ops) void apply(ops, 'redo');
  };
  const rebase = async () => {
    const c = conflict;
    if (!c) return;
    const head = await reload();
    if (!head) return;
    setConflict(null);
    // the same ops against the new head: they are keyed by component and page ids, so they usually still apply; if not, the server says why
    await apply(c.ops, c.mode, head.versionId);
  };
  const reloadDiscard = async () => {
    setConflict(null);
    setHistory(emptyHistory);
    await reload();
  };

  const onRun = useCallback(
    (run: Run) => {
      setRunId(run.id);
      setRunActive(isRunActive(run.state));
      setChatKey((k) => k + 1);
      // a finished run may have created a version (generation, an approved change set): take the new head; the undo history of the old one no longer applies
      if (isRunFinished(run.state)) {
        setHistory(emptyHistory);
        void reload();
      }
    },
    [reload],
  );

  const model = detail.siteModel;
  const siteLocales = model.locales as SiteLocale[];
  const DEVICES: { id: Viewport; icon: IconName }[] = [
    { id: 'desktop', icon: 'desktop' },
    { id: 'tablet', icon: 'tablet' },
    { id: 'mobile', icon: 'phone' },
  ];
  const publish = links.find((l) => l.key === 'deployments');
  const more = links.filter((l) => l.key !== 'deployments');
  return (
    <div className="bws" data-inspector={inspectorOpen ? 'open' : 'closed'}>
      <header className="bws-top">
        <a className="bws-logo" href={`/${locale}`} aria-label={t(locale, 'bld.ws.home')}>
          <BrandMark />
        </a>
        <a className="bws-back" href={`/${locale}/builder/projects`}>
          {t(locale, 'bld.ws.back')}
        </a>
        <h2 className="bws-title">
          <bdi dir="auto">{detail.name}</bdi>
        </h2>
        {call.busy && (
          <span className="bws-state" role="status">
            {t(locale, 'bld.ws.saving')}
          </span>
        )}
        <div className="bws-seg" role="group" aria-label={t(locale, 'bld.ws.view')}>
          <button
            type="button"
            aria-pressed={view === 'preview'}
            onClick={() => setView('preview')}
          >
            <Icon name="eye" size={16} />
            {t(locale, 'bld.ws.preview')}
          </button>
          <button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}>
            <Icon name="code" size={16} />
            {t(locale, 'bld.ws.code')}
          </button>
          <button type="button" aria-pressed={view === 'data'} onClick={() => setView('data')}>
            <Icon name="data" size={16} />
            {t(locale, 'bld.ws.data')}
          </button>
        </div>
        <span className="bws-spacer" />
        {view === 'preview' && (
          <div
            className="bws-seg bws-seg-icons"
            role="group"
            aria-label={t(locale, 'bld.ws.device')}
          >
            {DEVICES.map((d) => (
              <button
                key={d.id}
                type="button"
                aria-pressed={viewport === d.id}
                aria-label={t(locale, `bld.preview.${d.id}`, { width: VIEWPORTS[d.id] })}
                title={t(locale, `bld.preview.${d.id}`, { width: VIEWPORTS[d.id] })}
                onClick={() => setViewport(d.id)}
              >
                <Icon name={d.icon} size={17} />
              </button>
            ))}
          </div>
        )}
        {view === 'preview' && siteLocales.length > 1 && (
          <div className="bws-seg" role="group" aria-label={t(locale, 'bld.ws.lang')}>
            {siteLocales.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={siteLocale === l}
                onClick={() => setSiteLocale(l)}
              >
                {t(locale, `bld.lang.${l}`)}
              </button>
            ))}
          </div>
        )}
        {canWrite && (
          <div className="bws-seg bws-seg-icons">
            <button
              type="button"
              disabled={call.busy || nextUndo(history) === null}
              aria-label={t(locale, 'bld.ws.undo')}
              title={t(locale, 'bld.ws.undo')}
              onClick={undo}
            >
              <Icon name="undo" size={17} />
            </button>
            <button
              type="button"
              disabled={call.busy || nextRedo(history) === null}
              aria-label={t(locale, 'bld.ws.redo')}
              title={t(locale, 'bld.ws.redo')}
              onClick={redo}
            >
              <Icon name="redo" size={17} />
            </button>
          </div>
        )}
        <button
          type="button"
          className="bws-edit"
          aria-pressed={inspectorOpen}
          onClick={() => setInspectorOpen((o) => !o)}
        >
          <Icon name="panel" size={16} />
          {t(locale, 'bld.ws.edit')}
        </button>
        <details className="bws-more">
          <summary aria-label={t(locale, 'bld.ws.more')} title={t(locale, 'bld.ws.more')}>
            <Icon name="more" size={18} />
          </summary>
          <ul>
            <li className="bws-more-meta">
              {t(locale, 'bld.ws.version', { seq: detail.versionSeq })}
            </li>
            {more.map((l) => (
              <li key={l.key}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
          </ul>
        </details>
        {publish && (
          <a className="bws-publish" href={publish.href}>
            {t(locale, 'bld.ws.publish')}
          </a>
        )}
        <a
          className="bws-exit"
          href={`/${locale}`}
          aria-label={t(locale, 'bld.ws.exit')}
          title={t(locale, 'bld.ws.exit')}
        >
          <Icon name="close" size={18} />
        </a>
      </header>

      <div className="bws-body">
        <section className="bws-chat" aria-label={t(locale, 'bld.ws.chat')}>
          <Chat
            locale={locale}
            projectId={detail.id}
            projectName={detail.name}
            session={session}
            initialMessages={messages}
            canWrite={canAi}
            refreshKey={chatKey}
            activeRun={runActive}
            onRun={(run) => {
              setRunId(run.id);
              setRunActive(true);
            }}
            thread={
              runId ? (
                <RunCard
                  key={runId}
                  locale={locale}
                  runId={runId}
                  canWrite={canAi}
                  onRun={onRun}
                  onProgress={setProgress}
                />
              ) : undefined
            }
          />
        </section>

        <section className="bws-canvas" aria-label={t(locale, 'bld.ws.canvas')}>
          {reloadError && <Banner tone="danger">{t(locale, 'bld.ws.reloadFailed')}</Banner>}
          {view === 'preview' && scene !== 'off' && (
            <div className="bscene-wrap" data-leaving={scene === 'leaving' ? 'true' : undefined}>
              <BuildingScene locale={locale} label={progress.label} />
            </div>
          )}
          {progress.active && (
            <div className="bws-working" role="status">
              <span className="bld-spinner" aria-hidden="true" />
              {progress.label || t(locale, 'bld.card.working')}
            </div>
          )}
          {view === 'preview' ? (
            <PreviewPane
              bare
              locale={locale}
              projectId={detail.id}
              versionId={detail.versionId}
              siteLocales={siteLocales}
              canWrite={canWrite}
              viewport={viewport}
              onViewport={setViewport}
              siteLocale={siteLocale}
              onSiteLocale={setSiteLocale}
            />
          ) : view === 'code' ? (
            <CodePane
              locale={locale}
              projectId={detail.id}
              versionId={detail.versionId}
              model={model}
            />
          ) : (
            <DataPane locale={locale} projectId={detail.id} model={model} siteLocale={siteLocale} />
          )}
        </section>

        <aside
          className="bws-insp"
          aria-label={t(locale, 'bld.ws.inspector')}
          hidden={!inspectorOpen}
        >
          <Inspector
            locale={locale}
            model={model}
            versionId={detail.versionId}
            selection={selection}
            onSelect={setSelection}
            canWrite={canWrite}
            busy={call.busy}
            apply={(ops) => apply(ops)}
            canUndo={nextUndo(history) !== null}
            canRedo={nextRedo(history) !== null}
            undo={undo}
            redo={redo}
            last={last}
            problem={call.problem}
            conflict={conflict ? { headSeq: conflict.problem.headSeq } : null}
            onReload={() => void reloadDiscard()}
            onRebase={() => void rebase()}
          />
        </aside>
      </div>
    </div>
  );
}
