'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Icon, Skeleton } from '@nuzm/ui';
import { bapi } from '../lib/builder-client';
import type {
  BuilderForm,
  CmsCollection,
  Deployment,
  HostingSiteRef,
  Page_,
  ProjectDetail,
  Submission,
  Version,
} from '../lib/builder';
import { DeploymentsPanel } from './BuilderDeployments';
import { FormsPanel } from './BuilderForms';
import { CmsPanel } from './BuilderCms';
import { SeoPanel } from './BuilderSeo';
import { VersionsPanel } from './BuilderVersions';

/** The sections of a site, in the order of the studio's tab row. Each one is a panel of the studio for THAT site (never a page of the console). */
export const STUDIO_SECTIONS = ['versions', 'seo', 'forms', 'cms', 'deployments'] as const;
export type StudioSection = (typeof STUDIO_SECTIONS)[number];
export const studioSection = (v: string | null | undefined): StudioSection | null =>
  (STUDIO_SECTIONS as readonly string[]).includes(v ?? '') ? (v as StudioSection) : null;

type State<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

/** Loads once per section and site; switching sections or reopening reloads, so a panel always shows the site as it is now. */
function useLoaded<T>(key: string, load: () => Promise<T>): State<T> {
  const [state, setState] = useState<State<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    loadRef
      .current()
      .then((data) => alive && setState({ status: 'ready', data }))
      .catch(() => alive && setState({ status: 'error' }));
    return () => {
      alive = false;
    };
  }, [key]);
  return state;
}

/** One builder read: the typed body, or a throw (the panel then shows its error state, never a raw server message). */
async function read<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  const r = await bapi.get<T>(path, query ? { query } : undefined);
  if (!r.response.ok || r.data === undefined || r.data === null) throw new Error(`read ${path}`);
  return r.data;
}

export interface StudioCan {
  write: boolean;
  deployWrite: boolean;
  sitesRead: boolean;
}

function SectionBody({
  locale,
  projectId,
  section,
  can,
}: {
  locale: Locale;
  projectId: string;
  section: StudioSection;
  can: StudioCan;
}): ReactNode {
  const base = `/v1/builder/projects/${projectId}`;
  const state = useLoaded(`${projectId}:${section}`, async () => {
    switch (section) {
      case 'versions':
        return { section, versions: await read<Page_<Version>>(`${base}/versions`, { limit: 50 }) };
      case 'seo':
        return { section, detail: await read<ProjectDetail>(base) };
      case 'forms': {
        const [forms, subs] = await Promise.all([
          read<{ items: BuilderForm[] }>(`${base}/forms`),
          read<Page_<Submission>>(`${base}/form-submissions`, { limit: 50 }),
        ]);
        return { section, forms, subs };
      }
      case 'cms':
        return { section, cms: await read<{ items: CmsCollection[] }>(`${base}/cms-collections`) };
      case 'deployments': {
        const [project, deployments] = await Promise.all([
          read<ProjectDetail>(base),
          read<Page_<Deployment>>('/v1/deployments', { projectId, limit: 20 }),
        ]);
        // the hosting sites feed the target selector; hosting may be off or unreadable for this member: the form then explains it
        let sites: HostingSiteRef[] = [];
        if (can.sitesRead) {
          try {
            const r = await read<{ items: HostingSiteRef[] }>('/v1/hosting/sites', { limit: 100 });
            sites = r.items.map((x) => ({
              id: x.id,
              name: x.name,
              status: x.status,
              primaryDomain: x.primaryDomain ?? null,
            }));
          } catch {
            sites = [];
          }
        }
        return { section, project, deployments, sites };
      }
    }
  });
  if (state.status === 'loading') return <Skeleton lines={5} label={t(locale, 'state.loading')} />;
  if (state.status === 'error')
    return (
      <div className="nz-state" role="alert">
        <h2>{t(locale, 'state.error.title')}</h2>
        <p>{t(locale, 'state.error.body')}</p>
      </div>
    );
  const d = state.data;
  switch (d.section) {
    case 'versions':
      return (
        <VersionsPanel
          locale={locale}
          projectId={projectId}
          initial={d.versions}
          canWrite={can.write}
        />
      );
    case 'seo':
      return <SeoPanel locale={locale} initial={d.detail} canWrite={can.write} />;
    case 'forms':
      return (
        <FormsPanel
          locale={locale}
          projectId={projectId}
          forms={d.forms.items}
          submissions={d.subs.items}
          nextCursor={d.subs.nextCursor}
          formId=""
          canWrite={can.write}
        />
      );
    case 'cms':
      return (
        <CmsPanel
          locale={locale}
          projectId={projectId}
          initial={d.cms.items}
          canWrite={can.write}
        />
      );
    case 'deployments':
      return (
        <DeploymentsPanel
          locale={locale}
          projectId={projectId}
          projectName={d.project.name}
          headSeq={d.project.versionSeq}
          initial={d.deployments.items}
          sites={d.sites}
          canWrite={can.deployWrite}
        />
      );
  }
}

/**
 * A slide-over of the studio for the open site: Versions, SEO, Forms, Content and Publishing without leaving the studio (the preview, the chat and the
 * unsent text stay where they are). Escape or the close button hands control back; the sections offered are the ones this member may read.
 */
export function StudioPanel({
  locale,
  projectId,
  section,
  sections,
  can,
  onSelect,
  onClose,
}: {
  locale: Locale;
  projectId: string;
  section: StudioSection;
  sections: StudioSection[];
  can: StudioCan;
  onSelect: (s: StudioSection) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside
      className="bws-panel"
      role="dialog"
      aria-label={t(locale, `bld.tab.${section}` as 'bld.tab.versions')}
      tabIndex={-1}
      ref={ref}
    >
      <div className="bws-panel-head">
        <div role="tablist" className="bws-panel-tabs">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === section}
              className="bws-panel-tab"
              onClick={() => onSelect(s)}
            >
              {t(locale, `bld.tab.${s}` as 'bld.tab.versions')}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="bws-icon-btn"
          aria-label={t(locale, 'bld.ws.panel.close')}
          title={t(locale, 'bld.ws.panel.close')}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="bws-panel-body" role="tabpanel">
        <SectionBody locale={locale} projectId={projectId} section={section} can={can} />
      </div>
    </aside>
  );
}
