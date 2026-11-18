'use client';
import { useEffect, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Ltr, Table } from '@nuzm/ui';
import type { FileContent, Page_, ProjectFile, Version } from '../lib/builder';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';
import { VersionCompare } from './BuilderVersions';

/**
 * UI-M09-03 "code / diff" tab: the rendered files of the current version (read-only; the site is generated from the model, never hand-edited), one file at a
 * time as text, and the diff between two versions. Files are shown as plain text in a `<pre>`: nothing from a generated file is ever executed or injected here.
 */
export function CodePane({
  locale,
  projectId,
  versionId,
}: {
  locale: Locale;
  projectId: string;
  versionId: string;
}) {
  const files = useBuilderCall();
  const file = useBuilderCall();
  const vers = useBuilderCall();
  const [list, setList] = useState<ProjectFile[] | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [open, setOpen] = useState<FileContent | null>(null);

  useEffect(() => {
    setOpen(null);
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

  const read = (path: string) =>
    void file.run(
      () =>
        bapi.get<FileContent>(`/v1/builder/projects/${projectId}/files/content`, {
          query: { path, versionId },
        }),
      (c) => setOpen(c),
    );

  return (
    <div>
      {files.problem && <ProblemNote locale={locale} problem={files.problem} />}
      {list === null && !files.problem && (
        <p role="status" aria-busy="true">
          {t(locale, 'state.loading')}
        </p>
      )}
      {list && list.length === 0 && <p className="nz-muted">{t(locale, 'bld.code.noFiles')}</p>}
      {list && list.length > 0 && (
        <Table
          caption={t(locale, 'bld.code.files')}
          rows={list}
          rowKey={(f) => f.path}
          columns={[
            {
              key: 'p',
              header: t(locale, 'bld.code.col.path'),
              render: (f) => (
                <Button
                  variant="secondary"
                  aria-pressed={open?.path === f.path}
                  disabled={file.busy}
                  onClick={() => read(f.path)}
                >
                  <Ltr>{f.path}</Ltr>
                </Button>
              ),
            },
            {
              key: 'm',
              header: t(locale, 'bld.code.col.type'),
              render: (f) => <Ltr>{f.mime}</Ltr>,
            },
            {
              key: 's',
              header: t(locale, 'bld.code.col.size'),
              render: (f) => <Ltr>{f.size}</Ltr>,
            },
          ]}
        />
      )}
      {file.problem && <ProblemNote locale={locale} problem={file.problem} />}
      {open && (
        <section aria-labelledby="bld-file-h">
          <h3 className="nz-h2" id="bld-file-h">
            <Ltr>{open.path}</Ltr>
          </h3>
          {open.encoding === 'utf8' ? (
            <pre className="bld-pre" tabIndex={0} aria-label={t(locale, 'bld.code.content')}>
              {open.content}
            </pre>
          ) : (
            <p className="nz-muted">{t(locale, 'bld.code.binary', { size: open.size })}</p>
          )}
        </section>
      )}
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
  );
}
