'use client';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Card, EmptyState, Field, Ltr, Select, Skeleton } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  TEST_SUITES,
  buildTree,
  sandboxTone,
  settle,
  sha256Hex,
  testTone,
  type Sandbox,
  type TestRun,
  type TreeNode,
} from '../lib/builder';
import { newKey } from '../lib/data';
import { Code, SandboxRuntime, Word } from './BuilderParts';
import { useBuilderCall } from './BuilderUi';
import { Note } from './DataUi';

const POLL_MS = 3000;

/* ------------------------------------------------------------------ file tree and viewer */

function Tree({
  nodes,
  current,
  onPick,
  open,
}: {
  nodes: TreeNode[];
  current: string | null;
  onPick: (path: string) => void;
  open: boolean;
}) {
  return (
    <ul style={{ listStyle: 'none', paddingInlineStart: 12, margin: 0 }}>
      {nodes.map((n) => (
        <li key={n.path ?? `d:${n.name}`}>
          {n.path === undefined ? (
            <details open={open}>
              <summary>
                <Ltr>{n.name}</Ltr>
              </summary>
              <Tree nodes={n.children} current={current} onPick={onPick} open={false} />
            </details>
          ) : (
            <button
              type="button"
              className="nz-btn"
              data-variant={n.path === current ? 'primary' : 'secondary'}
              aria-current={n.path === current ? 'true' : undefined}
              style={{ inlineSize: '100%', justifyContent: 'flex-start' }}
              onClick={() => onPick(n.path!)}
            >
              <Ltr>{n.name}</Ltr>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

interface Loaded {
  path: string;
  content: string;
  truncated: boolean;
  size: number | undefined;
  hash: string | null;
}

/** File tree plus a READ-ONLY viewer. Nothing is edited or executed here: a change goes through "propose change" (a safe-diff patch with the base version and the file hash). */
export function FileBrowser({
  locale,
  projectId,
  files,
  canWrite,
}: {
  locale: Locale;
  projectId: string;
  files: { path?: string; size?: number }[];
  canWrite: boolean;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tree = buildTree(files);

  async function pick(p: string) {
    setPath(p);
    setLoading(true);
    setError(null);
    setFile(null);
    const r = await settle(() =>
      browserApi().GET('/v1/builder/projects/{id}/files/content', {
        params: { path: { id: projectId }, query: { path: p } },
      }),
    );
    setLoading(false);
    if (r.response.ok && r.data) {
      const d = r.data as { content: string; truncated?: boolean; size?: number };
      const truncated = d.truncated === true;
      setFile({
        path: p,
        content: d.content,
        truncated,
        size: d.size,
        hash: truncated ? null : await sha256Hex(d.content),
      });
    } else
      setError(
        r.response.status === 0
          ? t(locale, 'm10.err.offline')
          : r.response.status === 403
            ? t(locale, 'state.forbidden.title')
            : r.response.status === 404
              ? t(locale, 'm10.ide.fileMissing')
              : t(locale, 'state.error.title'),
      );
  }

  if (files.length === 0)
    return (
      <EmptyState title={t(locale, 'm10.ide.noFiles')} body={t(locale, 'm10.ide.noFilesBody')} />
    );

  const propose = file
    ? `/${locale}/builder/projects/${projectId}/changes?${new URLSearchParams({
        op: 'modify',
        path: file.path,
        ...(file.hash ? { hash: file.hash } : {}),
      }).toString()}`
    : null;
  return (
    <div className="nz-grid" style={{ gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 3fr)' }}>
      <nav aria-label={t(locale, 'm10.ide.tree')}>
        <h2 className="nz-h2">{t(locale, 'm10.ide.tree')}</h2>
        <Tree nodes={tree} current={path} onPick={(p) => void pick(p)} open />
      </nav>
      <section aria-label={t(locale, 'm10.ide.viewer')}>
        <h2 className="nz-h2">{t(locale, 'm10.ide.viewer')}</h2>
        <p className="nz-muted">{t(locale, 'm10.ide.readOnly')}</p>
        {!path && <p className="nz-muted">{t(locale, 'm10.ide.pick')}</p>}
        {loading && <Skeleton lines={5} label={t(locale, 'state.loading')} />}
        {error && (
          <p role="alert" className="nz-error-text">
            {error}
          </p>
        )}
        {file && (
          <>
            <p>
              <Ltr>{file.path}</Ltr>
            </p>
            {file.truncated && <Banner tone="warn">{t(locale, 'm10.ide.truncated')}</Banner>}
            <Code label={t(locale, 'm10.ide.viewer')}>{file.content}</Code>
            {canWrite && propose && !file.truncated && (
              <p>
                <a className="nz-btn" data-variant="secondary" href={propose}>
                  {t(locale, 'm10.ide.propose')}
                </a>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ sandboxes and the run panel */

/** One sandbox with the runtime it really runs on. A sandbox that is not `verified` is labelled a development stand-in, always. */
export function SandboxCard({
  locale,
  projectId,
  sandbox,
  canUse,
  onTerminate,
  busy,
}: {
  locale: Locale;
  projectId: string;
  sandbox: Sandbox;
  canUse: boolean;
  onTerminate?: (s: Sandbox) => void;
  busy?: boolean;
}) {
  const live = sandbox.state === 'ready' || sandbox.state === 'starting';
  return (
    <Card aria-label={`${t(locale, 'm10.sbx.title')} ${sandbox.id.slice(0, 8)}`}>
      <div className="nz-row">
        <strong>
          <Ltr>{sandbox.id.slice(0, 8)}</Ltr>
        </strong>
        <Badge tone={sandboxTone(sandbox.state)}>
          <Word locale={locale} prefix="m10.sbx.state" value={sandbox.state} />
        </Badge>
      </div>
      <SandboxRuntime locale={locale} runtime={sandbox.runtime} />
      <dl>
        {sandbox.ttlAt && (
          <>
            <dt>{t(locale, 'm10.sbx.ttl')}</dt>
            <dd>{formatDateTime(sandbox.ttlAt, locale)}</dd>
          </>
        )}
        {sandbox.egressProfile && (
          <>
            <dt>{t(locale, 'm10.sbx.egress')}</dt>
            <dd>
              <Ltr>{sandbox.egressProfile}</Ltr>
            </dd>
          </>
        )}
        {sandbox.terminationReason && (
          <>
            <dt>{t(locale, 'field.reason')}</dt>
            <dd>
              <Ltr>{sandbox.terminationReason}</Ltr>
            </dd>
          </>
        )}
      </dl>
      {sandbox.state === 'starting' && <p role="status">{t(locale, 'm10.sbx.starting')}</p>}
      <div className="nz-row">
        {live && canUse && (
          <a
            className="nz-btn"
            data-variant="secondary"
            href={`/${locale}/builder/projects/${projectId}/sandboxes/${sandbox.id}/terminal`}
          >
            {t(locale, 'm10.sbx.openTerminal')}
          </a>
        )}
        {live && canUse && onTerminate && (
          <Button variant="danger" disabled={busy} onClick={() => onTerminate(sandbox)}>
            {t(locale, 'm10.sbx.terminate')}
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * The run panel of the IDE: start a sandbox (states: starting, quota exceeded 409, no capacity 503, offline) and run a test suite in a fresh sandbox. The
 * preview pane is a placeholder: previews are served from an isolated origin, which M10A does not implement.
 */
export function RunPanel({
  locale,
  projectId,
  initial,
  canUse,
  canTest,
  mfaFactorId,
}: {
  locale: Locale;
  projectId: string;
  initial: Sandbox[];
  canUse: boolean;
  canTest: boolean;
  mfaFactorId: string | null;
}) {
  const sandboxCall = useBuilderCall(locale, mfaFactorId);
  const testCall = useBuilderCall(locale, mfaFactorId);
  const [boxes, setBoxes] = useState<Sandbox[]>(initial);
  const [blocked, setBlocked] = useState<'quota' | 'capacity' | 'offline' | null>(null);
  const [suite, setSuite] = useState<(typeof TEST_SUITES)[number]>('all');
  const [lastRun, setLastRun] = useState<TestRun | null>(null);
  const [startKey, setStartKey] = useState(newKey());
  const [testKey, setTestKey] = useState(newKey());
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const starting = boxes.filter((b) => b.state === 'starting');
  useEffect(() => {
    alive.current = true;
    if (starting.length === 0) return;
    const id = setTimeout(async () => {
      const results = await Promise.all(
        starting.map((b) =>
          settle(() =>
            browserApi().GET('/v1/builder/projects/{projectId}/sandboxes/{sid}', {
              params: { path: { projectId, sid: b.id } },
            }),
          ),
        ),
      );
      if (!alive.current) return;
      setBoxes((cur) =>
        cur.map((b) => {
          const i = starting.findIndex((s) => s.id === b.id);
          const r = i >= 0 ? results[i] : undefined;
          return r?.response.ok && r.data ? (r.data as Sandbox) : b;
        }),
      );
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearTimeout(id);
      alive.current = false;
    };
  }, [starting.length, tick]);

  function start() {
    setBlocked(null);
    void sandboxCall.run(
      () =>
        browserApi().POST('/v1/builder/projects/{projectId}/sandboxes', {
          params: { path: { projectId }, header: { 'Idempotency-Key': startKey } },
          body: { profile: 'standard' },
        }),
      (s) => {
        setStartKey(newKey());
        setBoxes((cur) => [s as Sandbox, ...cur]);
      },
      (f) => {
        if (f.problem.code === 'sandbox_quota_exceeded') setBlocked('quota');
        else if (f.problem.status === 503 || f.problem.code === 'sandbox_no_capacity')
          setBlocked('capacity');
        else if (f.problem.status === 0) setBlocked('offline');
      },
    );
  }

  function terminate(s: Sandbox) {
    void sandboxCall.run(
      () =>
        browserApi().DELETE('/v1/builder/projects/{projectId}/sandboxes/{sid}', {
          params: { path: { projectId, sid: s.id } },
        }),
      (x) => setBoxes((cur) => cur.map((b) => (b.id === s.id ? (x as Sandbox) : b))),
    );
  }

  function runTests() {
    void testCall.run(
      () =>
        browserApi().POST('/v1/builder/projects/{projectId}/test-runs', {
          params: { path: { projectId }, header: { 'Idempotency-Key': testKey } },
          body: { suite },
        }),
      (r) => {
        setTestKey(newKey());
        setLastRun(r as TestRun);
      },
    );
  }

  return (
    <>
      <section aria-label={t(locale, 'm10.ide.preview')}>
        <h2 className="nz-h2">{t(locale, 'm10.ide.preview')}</h2>
        <Banner tone="warn">{t(locale, 'm10.ide.previewNote')}</Banner>
      </section>
      <section aria-label={t(locale, 'm10.sbx.title')}>
        <h2 className="nz-h2">{t(locale, 'm10.sbx.title')}</h2>
        {canUse ? (
          <p>
            <Button disabled={sandboxCall.busy || blocked === 'quota'} onClick={start}>
              {t(locale, 'm10.sbx.start')}
            </Button>
          </p>
        ) : (
          <p className="nz-muted">{t(locale, 'm10.sbx.noPermission')}</p>
        )}
        {blocked === 'quota' && <Banner tone="warn">{t(locale, 'm10.err.sandboxQuota')}</Banner>}
        {blocked === 'capacity' && (
          <Banner tone="warn">
            {t(locale, 'm10.err.sandboxCapacity')}{' '}
            <Button variant="secondary" onClick={start} disabled={sandboxCall.busy}>
              {t(locale, 'action.retry')}
            </Button>
          </Banner>
        )}
        {blocked === 'offline' && (
          <Banner tone="warn">
            {t(locale, 'm10.err.offline')}{' '}
            <Button variant="secondary" onClick={start} disabled={sandboxCall.busy}>
              {t(locale, 'action.retry')}
            </Button>
          </Banner>
        )}
        {blocked === null && <Note n={sandboxCall.notice} />}
        {boxes.length === 0 ? (
          <p className="nz-muted">{t(locale, 'm10.sbx.none')}</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 12 }}>
            {boxes.map((b) => (
              <li key={b.id}>
                <SandboxCard
                  locale={locale}
                  projectId={projectId}
                  sandbox={b}
                  canUse={canUse}
                  onTerminate={terminate}
                  busy={sandboxCall.busy}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={t(locale, 'm10.ide.tests')}>
        <h2 className="nz-h2">{t(locale, 'm10.ide.tests')}</h2>
        {canTest ? (
          <>
            <Field id="ide-suite" label={t(locale, 'm10.tst.suite')}>
              {(x) => (
                <Select
                  {...x}
                  value={suite}
                  onChange={(e) => setSuite(e.target.value as typeof suite)}
                >
                  {TEST_SUITES.map((s) => (
                    <option key={s} value={s}>
                      {t(locale, `m10.tst.suite.${s}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button disabled={testCall.busy} onClick={runTests}>
              {t(locale, 'm10.tst.run')}
            </Button>
            <Note n={testCall.notice} />
            {lastRun && (
              <p role="status">
                <Badge tone={testTone(lastRun.status)}>
                  <Word locale={locale} prefix="m10.tst.status" value={lastRun.status} />
                </Badge>{' '}
                <a href={`/${locale}/builder/projects/${projectId}/tests`}>
                  {t(locale, 'm10.ide.seeResults')}
                </a>
              </p>
            )}
          </>
        ) : (
          <p className="nz-muted">{t(locale, 'm10.tst.noPermission')}</p>
        )}
      </section>
      {sandboxCall.panel}
      {testCall.panel}
    </>
  );
}
