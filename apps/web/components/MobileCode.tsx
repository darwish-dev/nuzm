'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon } from '@nuzm/ui';
import { buildTree } from '../lib/appbuilder';
import type { FileContent, ProjectFile } from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { fileKind, highlight, toLines } from '../lib/code-view';
import { sizeText } from '../lib/mobile';
import { ProblemNote } from './BuilderBits';
import { Tree } from './BuilderCode';

const MAX_LINES = 2000;

/**
 * The Code panel of the mobile workspace: the generated Flutter project of the current version as a file tree and a read-only viewer (the website Code view's
 * tree and styles, over the same project files API). Files are shown as text only, nothing in them is executed, and a hand edit would be overwritten by the next
 * design, so the viewer has no editing; changes are made by asking in the chat.
 */
export function MobileCode({
  locale,
  projectId,
  versionId,
}: {
  locale: Locale;
  projectId: string;
  versionId: string | null;
}) {
  const files = useBuilderCall();
  const file = useBuilderCall();
  const [list, setList] = useState<ProjectFile[] | null>(null);
  const [open, setOpen] = useState<FileContent | null>(null);
  const [cache, setCache] = useState<Record<string, FileContent>>({});
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setOpen(null);
    setCache({});
    setList(null);
    void files.run(
      () =>
        bapi.get<{ items: ProjectFile[] }>(`/v1/builder/projects/${projectId}/files`, {
          query: versionId ? { versionId } : {},
        }),
      (d) => setList(d.items),
    );
    return () => clearTimeout(timer.current);
    // the callbacks of useBuilderCall are stable
  }, [projectId, versionId]);

  const tree = useMemo(() => buildTree(list ?? []), [list]);
  const lines = useMemo(
    () =>
      open && open.encoding === 'utf8' ? toLines(highlight(open.content, fileKind(open.path))) : [],
    [open],
  );
  const bytes = (list ?? []).reduce((n, f) => n + f.size, 0);

  const read = (path: string) => {
    const hit = cache[path];
    if (hit) return setOpen(hit);
    void file.run(
      () =>
        bapi.get<FileContent>(`/v1/builder/projects/${projectId}/files/content`, {
          query: versionId ? { path, versionId } : { path },
        }),
      (c) => {
        setCache((m) => ({ ...m, [path]: c }));
        setOpen(c);
      },
    );
  };
  const copy = () => {
    if (!open || open.encoding !== 'utf8') return;
    void navigator.clipboard?.writeText(open.content).then(() => {
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="bwc mws-code">
      <div className="bwc-main">
        <aside className="bwc-side" aria-label={t(locale, 'bld.code.files')}>
          {files.problem && <ProblemNote locale={locale} problem={files.problem} />}
          {list === null && !files.problem && (
            <p role="status" aria-busy="true" className="nz-muted bwc-pad">
              {t(locale, 'state.loading')}
            </p>
          )}
          {list && list.length === 0 && (
            <p className="nz-muted bwc-pad">{t(locale, 'mws.code.none')}</p>
          )}
          {list && list.length > 0 && (
            <>
              <p className="nz-muted bwc-pad mws-code-count">
                {t(locale, 'mws.code.count', { n: list.length, size: sizeText(bytes) })}
              </p>
              <Tree nodes={tree} current={open?.path ?? null} onPick={read} />
            </>
          )}
        </aside>
        <section className="bwc-editor" aria-label={t(locale, 'bld.code.content')}>
          {file.problem && <ProblemNote locale={locale} problem={file.problem} />}
          {!open ? (
            <div className="bwc-empty">
              <Icon name="code" size={28} />
              <strong>{t(locale, 'bld.cx.empty.title')}</strong>
              <p className="nz-muted">{t(locale, 'mws.code.hint')}</p>
            </div>
          ) : (
            <>
              <header className="bwc-bar">
                <Icon name="list" size={15} />
                <span dir="ltr" className="bwc-path" title={`${open.path} · ${open.size} B`}>
                  {open.path}
                </span>
                <span className="bwc-chip">{t(locale, 'bld.cx.readonly')}</span>
                {open.encoding === 'utf8' && (
                  <button type="button" className="bwc-copy" onClick={copy}>
                    {t(locale, copied ? 'bld.cx.copied' : 'bld.cx.copy')}
                  </button>
                )}
              </header>
              {open.encoding === 'utf8' ? (
                <div className="bwc-code" dir="ltr" tabIndex={0}>
                  {lines.slice(0, MAX_LINES).map((l, i) => (
                    <div key={i} className="bwc-line" data-line={i + 1}>
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
    </div>
  );
}
