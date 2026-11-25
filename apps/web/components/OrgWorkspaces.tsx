'use client';
import { useRouter } from 'next/navigation';
import { type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, Ltr } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

interface Workspace {
  id: string;
  name: string;
  slug: string;
}
interface Project {
  id: string;
  name: string;
  workspaceId: string;
}

/**
 * The organization's workspaces, each a card holding its projects: create a workspace, add a project inside one, open a project, delete either (with a
 * confirmation). The same API calls as the Workspaces and Projects pages; every button is shown only when the member holds its permission.
 */
export function OrgWorkspaces(p: {
  locale: Locale;
  workspaces: Workspace[];
  projects: Project[];
  can: { wsCreate: boolean; wsDelete: boolean; prCreate: boolean; prDelete: boolean };
}) {
  const router = useRouter();
  const a = useAction(p.locale, null);
  const confirmDelete = (name: string) => window.confirm(t(p.locale, 'confirm.delete', { name }));

  function addWorkspace(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    void a.run(
      () =>
        browserApi().POST('/v1/workspaces', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { name },
        }),
      () => {
        form.reset();
        router.refresh();
      },
    );
  }
  function addProject(e: FormEvent<HTMLFormElement>, workspaceId: string) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    void a.run(
      () =>
        browserApi().POST('/v1/projects', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { workspaceId, name },
        }),
      () => {
        form.reset();
        router.refresh();
      },
    );
  }

  return (
    <div className="nzc-orgws">
      {p.can.wsCreate && (
        <form className="nzc-orgws-new" onSubmit={addWorkspace} noValidate>
          <label className="nz-sr" htmlFor="orgws-name">
            {t(p.locale, 'org.ws.namePlaceholder')}
          </label>
          <input
            id="orgws-name"
            name="name"
            required
            maxLength={120}
            placeholder={t(p.locale, 'org.ws.namePlaceholder')}
          />
          <button type="submit" disabled={a.busy}>
            <Icon name="plus" size={16} />
            {t(p.locale, 'org.ws.new')}
          </button>
        </form>
      )}
      <NoticeText notice={a.notice} />
      {p.workspaces.length === 0 ? (
        <p className="nzc-orgws-none">{t(p.locale, 'org.ws.none')}</p>
      ) : (
        <ul className="nzc-orgws-grid">
          {p.workspaces.map((w) => {
            const projects = p.projects.filter((x) => x.workspaceId === w.id);
            return (
              <li key={w.id} className="nzc-orgws-card">
                <header>
                  <span className="nzc-orgws-icon" aria-hidden="true">
                    <Icon name="projects" size={18} />
                  </span>
                  <span className="nzc-orgws-title">
                    <strong>{w.name}</strong>
                    <small>
                      <Ltr>{w.slug}</Ltr> · {t(p.locale, 'org.ws.projects', { n: projects.length })}
                    </small>
                  </span>
                  {p.can.wsDelete && (
                    <button
                      type="button"
                      className="nzc-orgws-del"
                      disabled={a.busy}
                      aria-label={`${t(p.locale, 'action.delete')}: ${w.name}`}
                      title={t(p.locale, 'action.delete')}
                      onClick={() =>
                        confirmDelete(w.name) &&
                        void a.run(
                          () =>
                            browserApi().DELETE('/v1/workspaces/{id}', {
                              params: { path: { id: w.id } },
                            }),
                          () => router.refresh(),
                          { 409: t(p.locale, 'err.conflict') },
                        )
                      }
                    >
                      <Icon name="close" size={15} />
                    </button>
                  )}
                </header>
                {projects.length === 0 ? (
                  <p className="nzc-orgws-empty">{t(p.locale, 'org.pr.none')}</p>
                ) : (
                  <ul className="nzc-orgws-projects">
                    {projects.map((x) => (
                      <li key={x.id}>
                        <a href={`/projects/${x.id}/environments`}>
                          <span className="nzc-orgws-dot" aria-hidden="true" />
                          <span>{x.name}</span>
                          <Icon name="arrow" size={14} />
                        </a>
                        {p.can.prDelete && (
                          <button
                            type="button"
                            className="nzc-orgws-del"
                            disabled={a.busy}
                            aria-label={`${t(p.locale, 'action.delete')}: ${x.name}`}
                            title={t(p.locale, 'action.delete')}
                            onClick={() =>
                              confirmDelete(x.name) &&
                              void a.run(
                                () =>
                                  browserApi().DELETE('/v1/projects/{id}', {
                                    params: { path: { id: x.id } },
                                  }),
                                () => router.refresh(),
                              )
                            }
                          >
                            <Icon name="close" size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {p.can.prCreate && (
                  <form className="nzc-orgws-add" onSubmit={(e) => addProject(e, w.id)} noValidate>
                    <label className="nz-sr" htmlFor={`orgpr-${w.id}`}>
                      {t(p.locale, 'org.pr.namePlaceholder')}
                    </label>
                    <input
                      id={`orgpr-${w.id}`}
                      name="name"
                      required
                      maxLength={120}
                      placeholder={t(p.locale, 'org.pr.namePlaceholder')}
                    />
                    <button type="submit" disabled={a.busy}>
                      <Icon name="plus" size={14} />
                      {t(p.locale, 'org.pr.add')}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
