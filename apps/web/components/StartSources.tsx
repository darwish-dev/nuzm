'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import { bapi } from '../lib/builder-client';
import type { GithubConnection } from '../lib/ai-studio';
import {
  MAX_IMPORT_FILES,
  emptySkipped,
  gitignoreMatcher,
  guessProjectType,
  looksBinary,
  skipReason,
  skippedTotal,
  sourceLabel,
  stripCommonRoot,
  type StartSource,
} from '../lib/start-sources';

/**
 * The "+" of the start screen's prompt box: start a project from a folder or files on the person's device or from a GitHub repository — the way a
 * chat starts with an attachment (templates have their own button; projects are in the history sidebar). Files are read in the browser and only text files are kept (see
 * `lib/start-sources.ts`); the upload itself happens when the person presses Start, through the API's safe-diff change path.
 */

type MenuItem = {
  id: 'folder' | 'files' | 'github';
  icon: IconName;
  label: string;
  hint: string;
  disabled?: boolean;
};

export function SourceMenu({
  locale,
  appsEnabled,
  githubEnabled,
  onFolder,
  onFiles,
  onGithub,
}: {
  locale: Locale;
  /** the web-app builder is on: imported code becomes a web app (or a mobile app for Flutter) */
  appsEnabled: boolean;
  /** AI Studio is on for the organization (GitHub goes through its GitHub App connection) */
  githubEnabled: boolean;
  onFolder: () => void;
  onFiles: () => void;
  onGithub: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const items: MenuItem[] = [
    {
      id: 'folder',
      icon: 'projects',
      label: t(locale, 'bld.src.folder'),
      hint: appsEnabled ? t(locale, 'bld.src.folder.hint') : t(locale, 'bld.src.needsApps'),
      disabled: !appsEnabled,
    },
    {
      id: 'files',
      icon: 'copy',
      label: t(locale, 'bld.src.files'),
      hint: appsEnabled ? t(locale, 'bld.src.files.hint') : t(locale, 'bld.src.needsApps'),
      disabled: !appsEnabled,
    },
    {
      id: 'github',
      icon: 'code',
      label: t(locale, 'bld.src.github'),
      hint: !appsEnabled
        ? t(locale, 'bld.src.needsApps')
        : githubEnabled
          ? t(locale, 'bld.src.github.hint')
          : t(locale, 'bld.src.github.off'),
      disabled: !appsEnabled || !githubEnabled,
    },
  ];
  const act: Record<MenuItem['id'], () => void> = {
    folder: onFolder,
    files: onFiles,
    github: onGithub,
  };
  return (
    <div className="bl-src" ref={wrap}>
      <button
        type="button"
        className="bl-src-plus"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(locale, 'bld.src.add')}
        title={t(locale, 'bld.src.add')}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="plus" size={18} />
      </button>
      {open && (
        <div className="bl-src-menu" role="menu" aria-label={t(locale, 'bld.src.menu')}>
          <p className="bl-src-title">{t(locale, 'bld.src.menu')}</p>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className="bl-src-item"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                act[it.id]();
              }}
            >
              <span className="bl-src-icon">
                <Icon name={it.icon} size={17} />
              </span>
              <span className="bl-src-text">
                <b>{it.label}</b>
                <small>{it.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Reads the picked files in the browser: drops what never belongs in a project and keeps the text files, keyed by their path in the project. */
export async function readLocalSource(
  list: FileList | readonly File[],
): Promise<StartSource | 'empty' | { tooMany: number }> {
  const all = [...list];
  const raw = all.map(
    (f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
  );
  const paths = stripCommonRoot(raw);
  // the project's own .gitignore: what is never committed is never uploaded
  const gi = all[paths.indexOf('.gitignore')];
  const ignored = gi ? gitignoreMatcher(await gi.text()) : () => false;
  const skipped = emptySkipped();
  const keep: { path: string; file: File }[] = [];
  all.forEach((file, i) => {
    const why = skipReason(paths[i]!, file.size) ?? (ignored(paths[i]!) ? 'ignored' : null);
    if (why) skipped[why]++;
    else keep.push({ path: paths[i]!, file });
  });
  if (keep.length > MAX_IMPORT_FILES) return { tooMany: keep.length };
  const files = new Map<string, string>();
  for (const k of keep) {
    const text = await k.file.text();
    if (looksBinary(text)) skipped.binary++;
    else files.set(k.path, text);
  }
  if (files.size === 0) return 'empty';
  return {
    kind: 'local',
    label: sourceLabel(raw),
    files,
    skipped,
    type: guessProjectType([...files.keys()]),
  };
}

/** The chosen source, above the prompt: what it is, how many files, what was left out, and a way to remove it. */
export function SourceChip({
  locale,
  source,
  onRemove,
}: {
  locale: Locale;
  source: StartSource;
  onRemove: () => void;
}) {
  const left = source.kind === 'local' ? skippedTotal(source.skipped) : 0;
  return (
    <div className="bl-chip-src" data-kind={source.kind}>
      <span className="bl-chip-icon" aria-hidden="true">
        <Icon name={source.kind === 'github' ? 'code' : 'projects'} size={16} />
      </span>
      <span className="bl-chip-text">
        <b dir="auto">{source.kind === 'github' ? source.fullName : source.label}</b>
        <small>
          {source.kind === 'github'
            ? source.private
              ? `GitHub · ${t(locale, 'bld.gh.private')}`
              : 'GitHub'
            : t(locale, 'bld.src.local.count', { count: source.files.size })}
          {left > 0 && (
            <>
              {' · '}
              <span title={t(locale, 'bld.src.skippedHelp')}>
                {t(locale, 'bld.src.local.skipped', { count: left })}
              </span>
            </>
          )}
        </small>
      </span>
      <button
        type="button"
        className="bl-chip-x"
        aria-label={t(locale, 'bld.src.remove')}
        title={t(locale, 'bld.src.remove')}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** Picks a repository the organization's GitHub App can see; offers to connect GitHub first when it is not connected. */
export function GithubPicker({
  locale,
  onPick,
  onClose,
}: {
  locale: Locale;
  onPick: (repo: { fullName: string; private: boolean }) => void;
  onClose: () => void;
}) {
  const [conn, setConn] = useState<GithubConnection | null>(null);
  const [repos, setRepos] = useState<{ fullName: string; private: boolean }[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    void (async () => {
      const c = await bapi.get<GithubConnection>('/v1/builder/github');
      if (!live) return;
      if (!c.response.ok || !c.data) return setFailed(true);
      setConn(c.data);
      if (c.data.available && c.data.connection) {
        const r = await bapi.get<{ items: { fullName: string; private: boolean }[] }>(
          '/v1/builder/github/repositories',
        );
        if (!live) return;
        if (!r.response.ok || !r.data) return setFailed(true);
        setRepos(r.data.items);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const list = (repos ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(q.trim().toLowerCase()),
  );
  let body: ReactNode;
  if (failed) body = <p className="bl-gh-note">{t(locale, 'state.error.body')}</p>;
  else if (!conn)
    body = (
      <p className="bl-gh-note" role="status" aria-busy="true">
        {t(locale, 'state.loading')}
      </p>
    );
  else if (!conn.available) body = <p className="bl-gh-note">{t(locale, 'bld.gh.unavailable')}</p>;
  else if (!conn.connection)
    body = (
      <div className="bl-gh-connect">
        <p className="bl-gh-note">{t(locale, 'bld.gh.connectBody')}</p>
        {conn.installUrl && (
          <a className="bl-go" href={conn.installUrl} rel="noopener noreferrer">
            <span>{t(locale, 'bld.gh.connect')}</span>
            <Icon name="external" size={16} />
          </a>
        )}
      </div>
    );
  else if (!repos)
    body = (
      <p className="bl-gh-note" role="status" aria-busy="true">
        {t(locale, 'state.loading')}
      </p>
    );
  else
    body = (
      <>
        <label className="bl-gh-search">
          <Icon name="search" size={15} />
          <span className="nz-sr">{t(locale, 'bld.gh.search')}</span>
          <input
            type="search"
            dir="ltr"
            value={q}
            placeholder={t(locale, 'bld.gh.search')}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </label>
        {list.length === 0 ? (
          <p className="bl-gh-note">{t(locale, 'bld.gh.none')}</p>
        ) : (
          <ul className="bl-gh-list">
            {list.map((r) => (
              <li key={r.fullName}>
                <button type="button" onClick={() => onPick(r)}>
                  <Icon name="code" size={15} />
                  <span dir="ltr">{r.fullName}</span>
                  {r.private && <small>{t(locale, 'bld.gh.private')}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  return (
    <div className="bl-gh" role="dialog" aria-labelledby="bl-gh-h">
      <div className="bl-gh-head">
        <h3 id="bl-gh-h">{t(locale, 'bld.gh.title')}</h3>
        <button
          type="button"
          className="bl-chip-x"
          aria-label={t(locale, 'bld.gh.close')}
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {conn?.adapter === 'fake' && <p className="bl-gh-fake">{t(locale, 'ais.gh.fake')}</p>}
      {body}
    </div>
  );
}
