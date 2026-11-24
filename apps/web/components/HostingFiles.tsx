'use client';
import { useRef, useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { useLoad, useToolRun } from '../lib/hosting-tools-client';
import { NoticeText } from './Feedback';

/**
 * The file manager: browse, upload, download, edit, rename and delete inside the website folder. The server proves every path is inside that folder and refuses links; this
 * screen only sends RELATIVE paths. It never talks to the node.
 */
const key = () => crypto.randomUUID();
const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
type Entry = {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string | null;
};

export function FileManager({
  locale,
  siteId,
  domains,
  uploadMb,
  canWrite,
}: {
  locale: Locale;
  siteId: string;
  domains: string[];
  uploadMb: number;
  canWrite: boolean;
}) {
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [dir, setDir] = useState<string[]>([]);
  const here = dir.join('/');
  const api = browserApi();
  const list = useLoad(
    locale,
    () =>
      api.GET('/v1/hosting/sites/{id}/files', {
        params: {
          path: { id: siteId },
          query: { domain: domain || undefined, path: here || undefined },
        },
      }),
    `${domain}|${here}`,
  );
  const a = useToolRun(locale);
  const [editing, setEditing] = useState<{
    name: string;
    path: string;
    content: string;
    sha256: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ name: string; to: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const rel = (name: string) => (here ? `${here}/${name}` : name);
  const q = { domain: domain || undefined };
  const reload = () => void list.reload();

  function open(e: Entry) {
    if (e.type === 'dir') return setDir((d) => [...d, e.name]);
    void a.run(
      () =>
        api.GET('/v1/hosting/sites/{id}/files/text', {
          params: { path: { id: siteId }, query: { ...q, path: rel(e.name) } },
        }),
      null,
      (d) => d && setEditing({ name: e.name, path: d.path, content: d.content, sha256: d.sha256 }),
      'ht.files.textOnly',
    );
  }
  function save() {
    if (!editing) return;
    void a.run(
      () =>
        api.PUT('/v1/hosting/sites/{id}/files/text', {
          params: { path: { id: siteId }, query: { ...q, path: editing.path } },
          body: { content: editing.content, expectedSha256: editing.sha256 },
        }),
      'ht.files.saved',
      (d) => d && setEditing({ ...editing, sha256: d.sha256 }),
    );
  }
  function upload(e: FormEvent) {
    e.preventDefault();
    const f = file.current?.files?.[0];
    if (!f) return;
    void a.run(
      () =>
        api.PUT('/v1/hosting/sites/{id}/files/content', {
          params: { path: { id: siteId }, query: { ...q, path: rel(f.name), overwrite } },
          // the raw file bytes (the API takes application/octet-stream)
          body: f as unknown as string,
          bodySerializer: (b: unknown) => b as BodyInit,
          headers: { 'Content-Type': 'application/octet-stream' },
        } as never) as never,
      'ht.files.uploaded',
      () => {
        if (file.current) file.current.value = '';
        reload();
      },
    );
  }
  const items: Entry[] = list.data?.items ?? [];

  if (editing)
    return (
      <section
        className="nz-card"
        aria-label={t(locale, 'ht.files.editing', { name: editing.name })}
      >
        <h2 className="nz-h2">{t(locale, 'ht.files.editing', { name: editing.name })}</h2>
        <textarea
          className="nz-input nzc-editor"
          dir="ltr"
          spellCheck={false}
          rows={22}
          aria-label={editing.name}
          value={editing.content}
          onChange={(e) => setEditing({ ...editing, content: e.target.value })}
        />
        <Button disabled={a.busy} onClick={save}>
          {t(locale, 'ht.files.save')}
        </Button>{' '}
        <Button variant="secondary" onClick={() => setEditing(null)}>
          {t(locale, 'ht.files.cancel')}
        </Button>
        <NoticeText notice={a.notice} />
      </section>
    );

  return (
    <>
      <p className="nz-muted">{t(locale, 'ht.files.intro')}</p>
      {domains.length > 1 && (
        <Field id="ht-files-domain" label={t(locale, 'ht.files.domain')}>
          {(x) => (
            <Select
              {...x}
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setDir([]);
              }}
            >
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <nav aria-label={t(locale, 'ht.files.root')} className="nzc-crumbs">
        <Button variant="secondary" onClick={() => setDir([])} disabled={dir.length === 0}>
          {t(locale, 'ht.files.root')}
        </Button>{' '}
        {dir.length > 0 && (
          <Button variant="secondary" onClick={() => setDir((d) => d.slice(0, -1))}>
            {t(locale, 'ht.files.up')}
          </Button>
        )}{' '}
        <Ltr>{`/${here}`}</Ltr>
      </nav>
      {list.loading && !list.data && <p className="nz-muted">{t(locale, 'ht.loading')}</p>}
      {list.error && (
        <p role="alert" className="nz-error-text">
          {list.error}
        </p>
      )}
      {list.data &&
        (items.length === 0 ? (
          <EmptyState title={t(locale, 'ht.files.empty')} body={t(locale, 'state.empty.body')} />
        ) : (
          <>
            {list.data.truncated && (
              <p className="nz-muted">{t(locale, 'ht.files.truncated', { n: items.length })}</p>
            )}
            <Table
              caption={t(locale, 'ht.files.title')}
              rows={items}
              rowKey={(e: Entry) => e.name}
              columns={[
                {
                  key: 'n',
                  header: t(locale, 'ht.files.name'),
                  render: (e: Entry) =>
                    e.type === 'symlink' ? (
                      <Ltr>{e.name}</Ltr>
                    ) : (
                      <button type="button" className="nz-linkbtn" onClick={() => open(e)}>
                        <Ltr>{e.name}</Ltr>
                      </button>
                    ),
                },
                {
                  key: 't',
                  header: t(locale, 'ht.files.size'),
                  render: (e: Entry) =>
                    e.type === 'file' ? (
                      size(e.size)
                    ) : (
                      <Badge>{t(locale, `ht.files.type.${e.type}`)}</Badge>
                    ),
                },
                {
                  key: 'm',
                  header: t(locale, 'ht.files.modified'),
                  render: (e: Entry) => (e.modifiedAt ? formatDateTime(e.modifiedAt, locale) : '—'),
                },
                {
                  key: 'a',
                  header: t(locale, 'ht.files.actions'),
                  render: (e: Entry) => (
                    <>
                      {e.type === 'file' && (
                        <a
                          className="nz-btn"
                          data-variant="secondary"
                          href={`/v1/hosting/sites/${siteId}/files/download?${new URLSearchParams({ ...(domain ? { domain } : {}), path: rel(e.name) })}`}
                        >
                          {t(locale, 'ht.files.download')}
                        </a>
                      )}{' '}
                      {canWrite && e.type !== 'symlink' && (
                        <Button
                          variant="secondary"
                          onClick={() => setRenaming({ name: e.name, to: e.name })}
                        >
                          {t(locale, 'ht.files.rename')}
                        </Button>
                      )}{' '}
                      {canWrite && (
                        <Button variant="danger" onClick={() => setConfirm(e.name)}>
                          {t(locale, 'ht.files.delete')}
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </>
        ))}
      {confirm && (
        <div className="nz-card" role="alertdialog" aria-label={t(locale, 'ht.files.delete')}>
          <p>{t(locale, 'ht.files.confirmDelete', { name: confirm })}</p>
          <Button
            variant="danger"
            disabled={a.busy}
            onClick={() => {
              const name = confirm;
              setConfirm(null);
              void a.run(
                () =>
                  api.DELETE('/v1/hosting/sites/{id}/files', {
                    params: {
                      path: { id: siteId },
                      query: { ...q, path: rel(name), recursive: true },
                    },
                  }),
                'ht.files.deleted',
                reload,
              );
            }}
          >
            {t(locale, 'ht.files.delete')}
          </Button>{' '}
          <Button variant="secondary" onClick={() => setConfirm(null)}>
            {t(locale, 'ht.files.cancel')}
          </Button>
        </div>
      )}
      {renaming && (
        <form
          className="nz-card"
          aria-label={t(locale, 'ht.files.rename')}
          onSubmit={(e) => {
            e.preventDefault();
            const r = renaming;
            setRenaming(null);
            void a.run(
              () =>
                api.POST('/v1/hosting/sites/{id}/files/renames', {
                  params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
                  body: { ...(domain ? { domain } : {}), from: rel(r.name), to: rel(r.to) },
                }),
              'ht.files.renamed',
              reload,
            );
          }}
        >
          <Field id="ht-files-rename" label={t(locale, 'ht.files.newName')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                value={renaming.to}
                onChange={(e) => setRenaming({ ...renaming, to: e.target.value })}
              />
            )}
          </Field>
          <Button type="submit" disabled={a.busy || !renaming.to.trim()}>
            {t(locale, 'ht.files.rename')}
          </Button>{' '}
          <Button variant="secondary" onClick={() => setRenaming(null)}>
            {t(locale, 'ht.files.cancel')}
          </Button>
        </form>
      )}
      {canWrite && (
        <>
          <form onSubmit={upload} className="nz-card" aria-label={t(locale, 'ht.files.upload')}>
            <h2 className="nz-h2">{t(locale, 'ht.files.upload')}</h2>
            <p className="nz-muted">{t(locale, 'ht.files.uploadLimit', { mb: uploadMb })}</p>
            <Field id="ht-files-file" label={t(locale, 'ht.files.upload')}>
              {(x) => <Input {...x} type="file" ref={file} />}
            </Field>
            <label>
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />{' '}
              {t(locale, 'ht.files.overwrite')}
            </label>
            <Button type="submit" disabled={a.busy}>
              {t(locale, 'ht.files.upload')}
            </Button>
          </form>
          <form
            className="nz-card"
            aria-label={t(locale, 'ht.files.newFolder')}
            onSubmit={(e) => {
              e.preventDefault();
              const n = folder.trim();
              if (!n) return;
              void a.run(
                () =>
                  api.POST('/v1/hosting/sites/{id}/files/folders', {
                    params: { path: { id: siteId }, header: { 'Idempotency-Key': key() } },
                    body: { ...(domain ? { domain } : {}), path: rel(n) },
                  }),
                'ht.files.created',
                () => {
                  setFolder('');
                  reload();
                },
              );
            }}
          >
            <Field id="ht-files-folder" label={t(locale, 'ht.files.folderName')}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  maxLength={200}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={a.busy || !folder.trim()}>
              {t(locale, 'ht.files.create')}
            </Button>
          </form>
        </>
      )}
      <NoticeText notice={a.notice} />
    </>
  );
}
