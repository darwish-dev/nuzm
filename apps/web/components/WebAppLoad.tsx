'use client';
import type { ReactNode } from 'react';
import type { Locale } from '@nuzm/i18n';
import { latestBuiltRun } from '../lib/appworkspace';
import type { Built } from '../lib/appworkspace-server';
import type { Page_, Run } from '../lib/builder';
import { bapi } from '../lib/builder-client';
import { readRunBuilt } from '../lib/webapp-built';
import { NotEnabledState } from './BuilderParts';
import { fetched, useLoad, type Fetched, type Load } from './PanelLoad';

/** A 404 in a web-app panel is the app builder being off (or the item gone): the same "not enabled" state the former pages showed. */
export const gone = (locale: Locale) => <NotEnabledState locale={locale} />;

/** The newest build's `app_spec`, `db_schema` and `api_contract` (the browser's twin of the server's `loadBuilt`): null while no build produced a spec. */
async function readBuilt(projectId: string): Promise<Fetched<Built | null>> {
  const runs = await bapi.get<Page_<Run>>('/v1/ai/runs', { query: { projectId, limit: 20 } });
  if (!runs.response.ok || !runs.data) return fetched(runs);
  const run = latestBuiltRun(runs.data.items);
  if (!run) return { ok: true, status: 200, data: null };
  return { ok: true, status: 200, data: await readRunBuilt(run) };
}
export const useBuilt = (projectId: string, refresh: number): [Load<Built | null>, () => void] =>
  useLoad<Built | null>(() => readBuilt(projectId), `built:${projectId}:${refresh}`);

/** A read of one list or object of the builder API as a panel's data. */
export const useApi = <T,>(
  path: string,
  query: Record<string, string | number> | undefined,
  refresh: number,
  enabled = true,
): [Load<T>, () => void] =>
  useLoad<T>(
    async () => fetched<T>(await bapi.get<T>(path, query ? { query } : undefined)),
    `${path}:${JSON.stringify(query ?? {})}:${refresh}`,
    enabled,
  );

export const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) => (
  <section aria-labelledby={id}>
    <h2 className="nz-h2" id={id}>
      {title}
    </h2>
    {children}
  </section>
);
