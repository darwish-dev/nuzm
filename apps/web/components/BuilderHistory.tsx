'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Icon, type IconName } from '@nuzm/ui';
import { bapi, newKey } from '../lib/builder-client';

/**
 * The builder's chat history, organised the way the work is: one folder per project with that project's AI conversations inside (newest first), a "+"
 * on each folder to start a new conversation in that project, and the conversations that belong to no project at the end. A sidebar icon pinned at the
 * top corner opens it; on a wide screen it docks beside the page and the page makes room for it (like the support panel), on a narrow one it slides
 * over. Escape or the close icon closes it. Data: `GET /v1/builder/projects`, `GET /v1/ai/sessions`; a new chat is `POST /v1/ai/sessions {projectId}`.
 */
export interface HistorySession {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
}
export interface HistoryProject {
  id: string;
  name: string;
  type: string;
  updatedAt: string;
}
export type Bucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

/** Which day group a conversation falls in, relative to `now` (local calendar days). */
export function bucketOf(iso: string, now = new Date()): Bucket {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return 'week';
  if (diff < 30) return 'month';
  return 'older';
}

export interface Folder {
  project: HistoryProject;
  chats: HistorySession[];
  /** the newest activity: its latest chat, else the project's last update */
  latest: string;
}
/** Projects as folders of their chats, most recently active first; chats with no project (or one not in the list) are returned apart. */
export function foldersOf(
  projects: readonly HistoryProject[],
  sessions: readonly HistorySession[],
): { folders: Folder[]; loose: HistorySession[] } {
  const byProject = new Map<string, HistorySession[]>();
  const loose: HistorySession[] = [];
  const known = new Set(projects.map((p) => p.id));
  for (const s of [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (s.projectId && known.has(s.projectId))
      byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);
    else loose.push(s);
  }
  const folders = projects.map((p) => {
    const chats = byProject.get(p.id) ?? [];
    return { project: p, chats, latest: chats[0]?.createdAt ?? p.updatedAt };
  });
  folders.sort((a, b) => b.latest.localeCompare(a.latest));
  return { folders, loose };
}

const typeIcon = (type: string): IconName =>
  type === 'mobile' ? 'phone' : type === 'webapp' ? 'code' : 'globe';

export function BuilderHistory({ locale, canChat = true }: { locale: Locale; canChat?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<HistoryProject[] | null>(null);
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  // folders start closed; the person opens the ones they want (a search opens every folder it matches)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const loaded = useRef(false);

  async function load() {
    setFailed(false);
    const [p, s] = await Promise.all([
      bapi.get<{ items: HistoryProject[] }>('/v1/builder/projects', { query: { limit: 50 } }),
      bapi.get<{ items: HistorySession[] }>('/v1/ai/sessions', { query: { limit: 100 } }),
    ]);
    if (!p.response.ok || !p.data) return setFailed(true);
    setProjects(p.data.items);
    // the conversations are context: without `ai:read` the folders still show
    setSessions(s.response.ok && s.data ? s.data.items : []);
  }

  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    if (!loaded.current) {
      loaded.current = true;
      void load();
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);

  // the sidebar scrolls on its own: a wheel or touch scroll over it never moves the page behind it, even past the end of the list
  useEffect(() => {
    const el = panel.current;
    if (!el || !open) return;
    const wheel = (e: WheelEvent) => {
      const list = el.querySelector<HTMLElement>('.bh-list');
      if (!list || !list.contains(e.target as Node)) return e.preventDefault();
      const atTop = list.scrollTop <= 0;
      const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atEnd)) e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [open]);

  async function newChat(projectId: string) {
    if (creating) return;
    setCreating(projectId);
    setCreateErr(null);
    const r = await bapi.post<{ id: string }>('/v1/ai/sessions', {
      body: { title: t(locale, 'bld.hist.newChatTitle'), projectId },
      idempotencyKey: newKey(),
    });
    setCreating(null);
    if (!r.response.ok || !r.data) return setCreateErr(projectId);
    router.push(`/builder/projects/${projectId}?session=${r.data.id}`);
  }

  const needle = q.trim().toLowerCase();
  const { folders, loose } = foldersOf(projects ?? [], sessions ?? []);
  const match = (x: string) => !needle || x.toLowerCase().includes(needle);
  const shown = folders
    .map((f) => ({
      ...f,
      // a project whose name matches shows all its chats; otherwise only the matching ones
      chats: match(f.project.name) ? f.chats : f.chats.filter((c) => match(c.title)),
    }))
    .filter((f) => match(f.project.name) || f.chats.length > 0);
  const looseShown = loose.filter((c) => match(c.title));
  const flip = (id: string) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const when = (iso: string) => t(locale, `bld.hist.when.${bucketOf(iso)}` as MessageKey);

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="bh-toggle"
        aria-expanded={open}
        aria-controls="bh-panel"
        title={t(locale, 'bld.hist.title')}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="panel" size={19} />
        <span>{t(locale, 'bld.hist.projects')}</span>
      </button>
      {open && <div className="bh-scrim" aria-hidden="true" onClick={close} />}
      <aside
        id="bh-panel"
        ref={panel}
        className="bh-panel"
        aria-label={t(locale, 'bld.hist.title')}
        hidden={!open}
      >
        <header className="bh-head">
          <span className="bh-avatar" aria-hidden="true">
            <img src="/brand/nuzm-mark.png?v=mint3" alt="" width={20} height={16} />
          </span>
          <span className="bh-head-text">
            <strong>{t(locale, 'bld.hist.title')}</strong>
            <small>{t(locale, 'bld.hist.sub')}</small>
          </span>
          <button
            type="button"
            className="bh-icon"
            aria-label={t(locale, 'bld.hist.close')}
            onClick={close}
          >
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="bh-tools">
          <a
            className="bh-new"
            href="/builder/projects"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('bld-prompt')?.focus();
            }}
          >
            <span className="bh-new-icon">
              <Icon name="plus" size={15} />
            </span>
            {t(locale, 'bld.hist.new')}
          </a>
          <label className="bh-search">
            <Icon name="search" size={15} />
            <span className="nz-sr">{t(locale, 'bld.hist.search')}</span>
            <input
              type="search"
              value={q}
              placeholder={t(locale, 'bld.hist.search')}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
        <nav className="bh-list" aria-label={t(locale, 'bld.hist.projects')}>
          {failed ? (
            <p className="bh-note" role="alert">
              {t(locale, 'state.error.body')}{' '}
              <button type="button" className="bh-link" onClick={() => void load()}>
                {t(locale, 'action.retry')}
              </button>
            </p>
          ) : projects === null ? (
            <p className="bh-note" role="status" aria-busy="true">
              {t(locale, 'state.loading')}
            </p>
          ) : shown.length === 0 && looseShown.length === 0 ? (
            <p className="bh-note">
              {needle ? t(locale, 'bld.hist.noMatch') : t(locale, 'bld.hist.empty')}
            </p>
          ) : (
            <>
              <p className="bh-label">{t(locale, 'bld.hist.projects')}</p>
              <ul className="bh-folders">
                {shown.map((f) => {
                  // a project with one chat (or none) is a direct link: there is nothing to unfold
                  const single = f.chats.length <= 1;
                  const isOpen = !single && (needle !== '' || expanded.has(f.project.id));
                  const listId = `bh-f-${f.project.id}`;
                  const head = (
                    <>
                      <span className="bh-folder-icon" data-type={f.project.type}>
                        <Icon name={typeIcon(f.project.type)} size={14} />
                      </span>
                      <span className="bh-folder-name" dir="auto">
                        {f.project.name}
                      </span>
                    </>
                  );
                  return (
                    <li key={f.project.id} className="bh-folder" data-open={isOpen || undefined}>
                      <div className="bh-folder-row">
                        {single ? (
                          <a
                            className="bh-folder-btn"
                            href={
                              f.chats[0]
                                ? `/builder/projects/${f.project.id}?session=${f.chats[0].id}`
                                : `/builder/projects/${f.project.id}`
                            }
                            title={f.project.name}
                          >
                            <span className="bh-chev" aria-hidden="true" />
                            {head}
                            <small className="bh-when">{when(f.latest)}</small>
                          </a>
                        ) : (
                          <button
                            type="button"
                            className="bh-folder-btn"
                            aria-expanded={isOpen}
                            aria-controls={listId}
                            title={f.project.name}
                            onClick={() => flip(f.project.id)}
                          >
                            <span className="bh-chev" aria-hidden="true">
                              <Icon name="chevron" size={12} />
                            </span>
                            {head}
                            <span className="bh-count">{f.chats.length}</span>
                          </button>
                        )}
                        {canChat && (
                          <button
                            type="button"
                            className="bh-add"
                            aria-label={t(locale, 'bld.hist.newChatIn', {
                              name: f.project.name,
                            })}
                            title={t(locale, 'bld.hist.newChat')}
                            disabled={creating !== null}
                            aria-busy={creating === f.project.id || undefined}
                            onClick={() => void newChat(f.project.id)}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                        )}
                      </div>
                      {createErr === f.project.id && (
                        <p className="bh-note bh-err" role="alert">
                          {t(locale, 'bld.hist.newChatErr')}
                        </p>
                      )}
                      {isOpen && (
                        <ul className="bh-chats" id={listId}>
                          {f.chats.map((c) => (
                            <li key={c.id}>
                              <a
                                href={`/builder/projects/${f.project.id}?session=${c.id}`}
                                title={c.title}
                              >
                                <span dir="auto">{c.title}</span>
                                <small>{when(c.createdAt)}</small>
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
              {looseShown.length > 0 && (
                <section aria-label={t(locale, 'bld.hist.other')}>
                  <p className="bh-label">{t(locale, 'bld.hist.other')}</p>
                  <ul className="bh-chats bh-loose">
                    {looseShown.map((c) => (
                      <li key={c.id}>
                        <span className="bh-orphan" title={c.title}>
                          <span dir="auto">{c.title}</span>
                          <small>{when(c.createdAt)}</small>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </nav>
      </aside>
    </>
  );
}
