'use client';
import { useCallback, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button } from '@nuzm/ui';
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
} from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { Chat } from './BuilderChat';
import { CodePane } from './BuilderCode';
import { Inspector, type Selection } from './BuilderInspector';
import { PreviewPane } from './BuilderPreview';
import { RunPanel } from './BuilderRun';

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
}: {
  locale: Locale;
  initial: ProjectDetail;
  session: Session | null;
  messages: Message[];
  initialRun: Run | null;
  canWrite: boolean;
  canAi: boolean;
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
  const [view, setView] = useState<'preview' | 'code'>('preview');
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
  return (
    <>
      <h2 className="nz-h2">
        <bdi dir="auto">{detail.name}</bdi>
      </h2>
      <div className="bld-ws">
        <section aria-label={t(locale, 'bld.ws.chat')}>
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
          />
          <h2 className="nz-h2">{t(locale, 'bld.run.title')}</h2>
          {runId ? (
            <RunPanel locale={locale} runId={runId} canWrite={canAi} onRun={onRun} compact />
          ) : (
            <p className="nz-muted">{t(locale, 'bld.run.none')}</p>
          )}
        </section>

        <section aria-label={t(locale, 'bld.ws.canvas')}>
          <div className="nz-row" role="group" aria-label={t(locale, 'bld.ws.view')}>
            <Button
              variant={view === 'preview' ? 'primary' : 'secondary'}
              aria-pressed={view === 'preview'}
              onClick={() => setView('preview')}
            >
              {t(locale, 'bld.ws.preview')}
            </Button>
            <Button
              variant={view === 'code' ? 'primary' : 'secondary'}
              aria-pressed={view === 'code'}
              onClick={() => setView('code')}
            >
              {t(locale, 'bld.ws.code')}
            </Button>
            <span className="nz-muted">
              {t(locale, 'bld.ws.version', { seq: detail.versionSeq })}
            </span>
          </div>
          {reloadError && <Banner tone="danger">{t(locale, 'bld.ws.reloadFailed')}</Banner>}
          {view === 'preview' ? (
            <PreviewPane
              locale={locale}
              projectId={detail.id}
              versionId={detail.versionId}
              siteLocales={model.locales as SiteLocale[]}
              canWrite={canWrite}
            />
          ) : (
            <CodePane locale={locale} projectId={detail.id} versionId={detail.versionId} />
          )}
        </section>

        <section aria-label={t(locale, 'bld.ws.inspector')}>
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
        </section>
      </div>
    </>
  );
}
