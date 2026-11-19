'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { buildTree, type TreeNode } from '../lib/appbuilder';
import {
  DEPLOY_ACTIVE,
  isPreviewUrl,
  type Deployment,
  type DeployLog,
  type FileContent,
  type Page_,
  type ProjectFile,
  type SiteModel,
  type Version,
} from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import {
  fileKind,
  highlight,
  isSourcePath,
  searchFiles,
  sourceFiles,
  toLines,
  type SearchHit,
} from '../lib/code-view';
import { ProblemNote } from './BuilderBits';
import { VersionCompare } from './BuilderVersions';

const MAX_LINES = 2000;

const hasCurrent = (n: TreeNode, current: string | null): boolean =>
  current !== null && n.children.some((c) => c.path === current || hasCurrent(c, current));

/** The files of a site as a tree. Directories start closed and open on the way to the open file; a file is a button. */
function Tree({
  nodes,
  current,
  onPick,
  depth = 0,
}: {
  nodes: TreeNode[];
  current: string | null;
  onPick: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul className="bwc-tree" data-depth={depth}>
      {nodes.map((n) =>
        n.path === undefined ? (
          <li key={`d:${n.name}`}>
            <details open={hasCurrent(n, current) ? true : undefined}>
              <summary>
                <Icon name="chevron" size={14} />
                <span dir="ltr">{n.name}</span>
              </summary>
              <Tree nodes={n.children} current={current} onPick={onPick} depth={depth + 1} />
            </details>
          </li>
        ) : (
          <li key={n.path}>
            <button
              type="button"
              className="bwc-file"
              aria-current={current === n.path ? 'true' : undefined}
              onClick={() => onPick(n.path!)}
            >
              <Icon name="list" size={14} />
              <span dir="ltr">{n.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/** What was last published: its state, address and log lines (polled while it is still going). Needs `deploy:read`; without it the panel says so. */
function PublishOutput({ locale, projectId }: { locale: Locale; projectId: string }) {
  const [dep, setDep] = useState<Deployment | null | undefined>(undefined);
  const [denied, setDenied] = useState(false);
  const [logs, setLogs] = useState<DeployLog[]>([]);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await bapi.get<Page_<Deployment>>('/v1/deployments', {
        query: { projectId, limit: 1 },
      });
      if (stop) return;
      if (r.response.status === 403) return setDenied(true);
      const d = r.response.ok ? (r.data?.items[0] ?? null) : null;
      setDep(d);
      if (!d) return;
      const l = await bapi.get<{ items: DeployLog[] }>(`/v1/deployments/${d.id}/logs`, {
        query: { after: 0 },
      });
      if (!stop && l.response.ok && l.data) setLogs(l.data.items);
      if (!stop && (DEPLOY_ACTIVE as readonly string[]).includes(d.state))
        timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
  const link = `/${locale}/builder/projects/${projectId}/deployments`;
  if (denied) return <p className="nz-muted">{t(locale, 'bld.cx.pub.noaccess')}</p>;
  if (dep === undefined)
    return (
      <p role="status" aria-busy="true" className="nz-muted">
        {t(locale, 'state.loading')}
      </p>
    );
  if (dep === null)
    return (
      <p className="nz-muted">
        {t(locale, 'bld.cx.pub.none')} <a href={link}>{t(locale, 'bld.cx.pub.open')}</a>
      </p>
    );
  return (
    <div className="bwc-pub">
      <p className="bwc-pub-head">
        <strong>{t(locale, `bld.dep.state.${dep.state}` as 'bld.dep.state.succeeded')}</strong>
        {dep.url && isPreviewUrl(`${dep.url}/`) && (
          <a href={dep.url} target="_blank" rel="noopener noreferrer" dir="ltr">
            {dep.url}
          </a>
        )}
        <a href={link}>{t(locale, 'bld.cx.pub.open')}</a>
      </p>
      <pre className="bwc-log" dir="ltr" tabIndex={0}>
        {logs.map((x) => `${x.level.toUpperCase().padEnd(5)} ${x.message}`).join('\n') || '—'}
      </pre>
    </div>
  );
}

/**
 * The Code view: the generated files of the current version in a file tree with search, a line-numbered and tinted viewer, and a collapsible bottom panel with
 * the changes between versions and the last publish. Read-only on purpose: a site is generated from its structure, so a hand edit of a generated file would be
 * overwritten by the next change; edits are made in the visual editor or by asking in the chat. Files are shown as text only; nothing in them is executed.
 */
export function CodePane({
  locale,
  projectId,
  versionId,
  model,
}: {
  locale: Locale;
  projectId: string;
  versionId: string;
  /** the site model of this version: its source files are shown beside the generated ones */
  model?: SiteModel;
}) {
  const files = useBuilderCall();
  const file = useBuilderCall();
  const vers = useBuilderCall();
  const [list, setList] = useState<ProjectFile[] | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [open, setOpen] = useState<FileContent | null>(null);
  const [side, setSide] = useState<'files' | 'search'>('files');
  const [q, setQ] = useState('');
  const [cache, setCache] = useState<Record<string, FileContent>>({});
  const [bottom, setBottom] = useState<'status' | 'changes' | 'publish' | null>('status');
  const [jump, setJump] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(null);
    setCache({});
    void files.run(
      () =>
        bapi.get<{ items: ProjectFile[] }>(`/v1/builder/projects/${projectId}/files`, {
          query: { versionId },
        }),
      (d) => setList(d.items),
    );
    void vers.run(
      () =>
        bapi.get<Page_<Version>>(`/v1/builder/projects/${projectId}/versions`, {
          query: { limit: 50 },
        }),
      (p) => setVersions(p.items),
    );
    // the callbacks of useBuilderCall are stable
  }, [projectId, versionId]);

  const source = useMemo(
    () => sourceFiles(model, { projectId, versionId }),
    [model, projectId, versionId],
  );
  const sourceByPath = useMemo(() => Object.fromEntries(source.map((f) => [f.path, f])), [source]);
  const all: ProjectFile[] | null = useMemo(
    () =>
      list
        ? [
            ...source.map((f) => ({ path: f.path, size: f.size, mime: f.mime, contentHash: '' })),
            ...list,
          ]
        : null,
    [list, source],
  );

  const read = (path: string, line?: number) => {
    setJump(line && line > 0 ? line : null);
    const own = sourceByPath[path];
    if (own) return setOpen(own);
    const hit = cache[path];
    if (hit) return setOpen(hit);
    void file.run(
      () =>
        bapi.get<FileContent>(`/v1/builder/projects/${projectId}/files/content`, {
          query: { path, versionId },
        }),
      (c) => {
        setCache((m) => ({ ...m, [path]: c }));
        setOpen(c);
      },
    );
  };

  // search reads the text of every file once (a generated site is a handful of small files)
  useEffect(() => {
    if (side !== 'search' || !list) return;
    const missing = list.filter((f) => !cache[f.path] && fileKind(f.path) !== 'image');
    if (missing.length === 0) return;
    let stop = false;
    void Promise.all(
      missing.slice(0, 40).map((f) =>
        bapi
          .get<FileContent>(`/v1/builder/projects/${projectId}/files/content`, {
            query: { path: f.path, versionId },
          })
          .then((r) => (r.response.ok && r.data ? r.data : null)),
      ),
    ).then((all) => {
      if (stop) return;
      setCache((m) => {
        const next = { ...m };
        for (const c of all) if (c) next[c.path] = c;
        return next;
      });
    });
    return () => {
      stop = true;
    };
  }, [side, list, projectId, versionId]);

  const texts = useMemo(
    () =>
      Object.fromEntries(
        [...Object.values(cache), ...source]
          .filter((c) => c.encoding === 'utf8')
          .map((c) => [c.path, c.content]),
      ),
    [cache, source],
  );
  const hits: SearchHit[] = useMemo(() => (all ? searchFiles(all, texts, q) : []), [all, texts, q]);
  const tree = useMemo(() => buildTree(all ?? []), [all]);
  const lines = useMemo(
    () =>
      open && open.encoding === 'utf8' ? toLines(highlight(open.content, fileKind(open.path))) : [],
    [open],
  );

  useEffect(() => {
    if (jump === null || !codeRef.current) return;
    codeRef.current.querySelector(`[data-line="${jump}"]`)?.scrollIntoView?.({ block: 'center' });
  }, [jump, open]);

  const copy = () => {
    if (!open || open.encoding !== 'utf8') return;
    void navigator.clipboard?.writeText(open.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const tab = (id: 'status' | 'changes' | 'publish') => () =>
    setBottom((b) => (b === id ? null : id));
  const seq = versions.find((v) => v.id === versionId)?.seq ?? versions[0]?.seq;
  const bytes = (list ?? []).reduce((n, f) => n + f.size, 0);
  const sizeText = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

  return (
    <div className="bwc" data-bottom={bottom ?? 'closed'}>
      <div className="bwc-main">
        <aside className="bwc-side" aria-label={t(locale, 'bld.code.files')}>
          <div className="bwc-side-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={side === 'files'}
              onClick={() => setSide('files')}
            >
              <Icon name="list" size={15} />
              {t(locale, 'bld.cx.tab.files')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={side === 'search'}
              onClick={() => setSide('search')}
            >
              <Icon name="search" size={15} />
              {t(locale, 'bld.cx.tab.search')}
            </button>
          </div>
          {files.problem && <ProblemNote locale={locale} problem={files.problem} />}
          {list === null && !files.problem && (
            <p role="status" aria-busy="true" className="nz-muted bwc-pad">
              {t(locale, 'state.loading')}
            </p>
          )}
          {list && all && all.length === 0 && (
            <p className="nz-muted bwc-pad">{t(locale, 'bld.code.noFiles')}</p>
          )}
          {all && all.length > 0 && side === 'files' && (
            <Tree nodes={tree} current={open?.path ?? null} onPick={(p) => read(p)} />
          )}
          {all && all.length > 0 && side === 'search' && (
            <div className="bwc-search">
              <input
                type="search"
                dir="auto"
                autoFocus
                value={q}
                placeholder={t(locale, 'bld.cx.search.ph')}
                aria-label={t(locale, 'bld.cx.search.ph')}
                onChange={(e) => setQ(e.target.value)}
              />
              {q.trim() === '' ? (
                <p className="nz-muted">{t(locale, 'bld.cx.search.hint')}</p>
              ) : hits.length === 0 ? (
                <p className="nz-muted">{t(locale, 'bld.cx.search.none')}</p>
              ) : (
                <ul>
                  {hits.map((h, i) => (
                    <li key={`${h.path}:${h.line}:${i}`}>
                      <button type="button" onClick={() => read(h.path, h.line)}>
                        <span dir="ltr" className="bwc-hit-path">
                          {h.path}
                          {h.line > 0 ? `:${h.line}` : ''}
                        </span>
                        {h.line > 0 && (
                          <span dir="ltr" className="bwc-hit-text">
                            {h.text}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </aside>

        <section className="bwc-editor" aria-label={t(locale, 'bld.code.content')}>
          {file.problem && <ProblemNote locale={locale} problem={file.problem} />}
          {!open ? (
            <div className="bwc-empty">
              <Icon name="code" size={28} />
              <strong>{t(locale, 'bld.cx.empty.title')}</strong>
              <p className="nz-muted">{t(locale, 'bld.cx.empty.body')}</p>
            </div>
          ) : (
            <>
              <header className="bwc-bar">
                <Icon name="list" size={15} />
                <span dir="ltr" className="bwc-path" title={`${open.mime} · ${open.size} B`}>
                  {open.path.split('/').pop()}
                </span>
                <span className="bwc-chip" title={t(locale, 'bld.cx.empty.body')}>
                  {isSourcePath(open.path)
                    ? `${t(locale, 'bld.cx.source')} · ${t(locale, 'bld.cx.readonly')}`
                    : t(locale, 'bld.cx.readonly')}
                </span>
                {open.encoding === 'utf8' && (
                  <button type="button" className="bwc-copy" onClick={copy}>
                    {t(locale, copied ? 'bld.cx.copied' : 'bld.cx.copy')}
                  </button>
                )}
              </header>
              {open.encoding === 'utf8' ? (
                <div className="bwc-code" ref={codeRef} dir="ltr" tabIndex={0}>
                  {lines.slice(0, MAX_LINES).map((l, i) => (
                    <div
                      key={i}
                      className="bwc-line"
                      data-line={i + 1}
                      data-hit={jump === i + 1 ? 'true' : undefined}
                    >
                      <span className="bwc-ln">{i + 1}</span>
                      <code>
                        {l.length === 0
                          ? '​'
                          : l.map((tk, j) => (
                              <span key={j} className={`tok tok-${tk.c}`}>
                                {tk.s}
                              </span>
                            ))}
                      </code>
                    </div>
                  ))}
                  {lines.length > MAX_LINES && (
                    <p className="nz-muted bwc-pad">
                      {t(locale, 'bld.cx.truncated', { n: MAX_LINES })}
                    </p>
                  )}
                </div>
              ) : (
                <p className="nz-muted bwc-pad">
                  {t(locale, 'bld.code.binary', { size: open.size })}
                </p>
              )}
            </>
          )}
        </section>
      </div>

      <section className="bwc-bottom" aria-label={t(locale, 'bld.cx.panel.label')}>
        <div className="bwc-btabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={bottom === 'status'}
            onClick={tab('status')}
          >
            <Icon name="sparkle" size={15} />
            {t(locale, 'bld.cx.panel.status')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={bottom === 'changes'}
            onClick={tab('changes')}
          >
            <Icon name="refresh" size={15} />
            {t(locale, 'bld.cx.panel.changes')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={bottom === 'publish'}
            onClick={tab('publish')}
          >
            <Icon name="external" size={15} />
            {t(locale, 'bld.cx.panel.publish')}
          </button>
          <span className="bws-spacer" />
          <button
            type="button"
            className="bwc-collapse"
            aria-expanded={bottom !== null}
            aria-label={t(locale, bottom ? 'bld.cx.panel.collapse' : 'bld.cx.panel.expand')}
            onClick={() => setBottom((b) => (b ? null : 'status'))}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
        {bottom === 'status' && (
          <div className="bwc-bbody bwc-term" dir="ltr">
            <p>
              <b className="ok">NUZM</b> {t(locale, 'bld.cx.status.ready', { n: seq ?? '—' })}
            </p>
            <p>
              <span className="arrow">→</span>{' '}
              {t(locale, 'bld.cx.status.files', { n: list?.length ?? 0, size: sizeText })}
            </p>
            {model && (
              <p>
                <span className="arrow">→</span>{' '}
                {t(locale, 'bld.cx.status.pages', {
                  n: model.pages.length,
                  langs: model.locales.join(', '),
                })}
              </p>
            )}
            {source.length > 0 && (
              <p>
                <span className="arrow">→</span>{' '}
                {t(locale, 'bld.cx.status.source', { n: source.length })}
              </p>
            )}
            <p className="hint">{t(locale, 'bld.cx.status.hint')}</p>
          </div>
        )}
        {bottom === 'changes' && (
          <div className="bwc-bbody">
            {vers.problem ? (
              <ProblemNote locale={locale} problem={vers.problem} />
            ) : (
              <VersionCompare
                key={versions[0]?.id ?? 'none'}
                locale={locale}
                projectId={projectId}
                versions={versions}
              />
            )}
          </div>
        )}
        {bottom === 'publish' && (
          <div className="bwc-bbody">
            <PublishOutput locale={locale} projectId={projectId} />
          </div>
        )}
      </section>
    </div>
  );
}
