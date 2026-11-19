import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { BuilderStart } from '../../../../../components/BuilderStart';
import { ProjectCards } from '../../../../../components/BuilderProjects';
import { one, unwrapCall } from '../../../../../lib/compute';
import type { Credits, Page_, Project } from '../../../../../lib/builder';
import { builderGuard, builderView } from '../../../../../lib/builder-view';

/**
 * UI-M09-01/02 (merged): "Start a project". One prompt box (the project type, the first AI run and the workspace follow from it, no wizard), then the
 * organization's existing projects. A person who can read but not write sees only the list.
 */
export default async function Projects({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  if (!isLocale(locale)) notFound();
  const g = await builderGuard(locale, 'builder:read', 'bld.start.title');
  if (!g.ok) return g.denied;
  const canCreate = g.s.can('builder:write');
  const canRun = canCreate && g.s.can('ai:write');
  const body = await builderView(
    locale,
    async () => {
      const page = await unwrapCall(
        g.c.get<Page_<Project>>('/v1/builder/projects', {
          query: { limit: 24, cursor: one(sp.cursor) || undefined },
        }),
      );
      // the balance is informational: a failure to read it must not block the screen
      let wallet: Credits | null = null;
      if (canRun) {
        const r = await g.c.get<Credits>('/v1/ai/credits');
        wallet = r.response.ok ? (r.data ?? null) : null;
      }
      return { page, wallet };
    },
    ({ page, wallet }) => (
      <>
        {canCreate && (
          <div className="nzc-start-full">
            <BuilderStart locale={locale} credits={wallet} canRun={canRun} />
          </div>
        )}
        {page.items.length > 0 && (
          <div className="nzc-start-projects">
            <h2 className="nzc-yp-head">{t(locale, 'bld.start.yourProjects')}</h2>
            <ProjectCards
              locale={locale}
              items={page.items}
              nextCursor={page.nextCursor}
              canCreate={canCreate}
            />
          </div>
        )}
        {page.items.length === 0 && !canCreate && (
          <ProjectCards locale={locale} items={[]} nextCursor={null} canCreate={false} />
        )}
      </>
    ),
  );
  return (
    <>
      {/* full screen: the heading stays for screen readers and the page title, but is not drawn */}
      <h1 className="nz-sr">{t(locale, 'bld.start.title')}</h1>
      {body}
    </>
  );
}
