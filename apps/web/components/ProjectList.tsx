'use client';
import { useState } from 'react';
import type { Locale } from '@nuzm/i18n';
import { applyFilter, type ProjectFilter } from '../lib/appworkspace';
import type { Project } from '../lib/builder';
import { ProjectCards, ProjectFilterTabs } from './BuilderProjects';

/**
 * The project list with its type filter. The server sends every loaded project once; choosing a filter changes the list in place (no navigation, no
 * reload, the prompt box and the open tab above it are untouched) and keeps the address in sync so a refresh or a shared link shows the same filter.
 */
export function FilterableProjects({
  locale,
  items,
  nextCursor,
  canCreate,
  canDelete,
  mfaFactorId,
  appsEnabled,
  mobileEnabled,
  initial,
}: {
  locale: Locale;
  items: Project[];
  nextCursor: string | null;
  canCreate: boolean;
  canDelete: boolean;
  mfaFactorId: string | null;
  appsEnabled: boolean;
  mobileEnabled: boolean;
  initial: ProjectFilter;
}) {
  const [filter, setFilter] = useState<ProjectFilter>(initial);
  const select = (f: ProjectFilter) => {
    setFilter(f);
    try {
      const url = `/${locale}/builder/projects${f === 'all' ? '' : `?type=${f}`}`;
      window.history.replaceState(window.history.state, '', url + window.location.hash);
    } catch {
      /* the address is a convenience: the list has already switched */
    }
  };
  return (
    <>
      <ProjectFilterTabs
        locale={locale}
        current={filter}
        appsEnabled={appsEnabled}
        mobileEnabled={mobileEnabled}
        onSelect={select}
      />
      <ProjectCards
        locale={locale}
        items={applyFilter(items, filter)}
        nextCursor={nextCursor}
        canCreate={canCreate}
        canDelete={canDelete}
        mfaFactorId={mfaFactorId}
        filtered={filter !== 'all'}
      />
    </>
  );
}
