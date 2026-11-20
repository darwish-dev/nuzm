import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { KnowledgeLibrary } from '../../../../../components/KnowledgeLibrary';
import { filtersToQuery, parseFilters, type KnowledgePage } from '../../../../../lib/knowledge';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * AI Intelligence Center → Knowledge Library (ADR-065, SCR-K-01). Staff list the platform library, filter it, upload packages and open a resource.
 * Reading needs `admin:ai_knowledge:read`; uploading and editing `admin:ai_knowledge:manage` (the API enforces each). While the platform flag
 * `knowledge.library` is off the API answers 404 and this page says so.
 */
export default async function KnowledgeLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const head = <PageTitle>{t(locale, 'kn.title')}</PageTitle>;
  if (!s.can('admin:ai_knowledge:read'))
    return (
      <>
        {head}
        <ForbiddenState
          title={t(locale, 'kn.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const filters = parseFilters(await searchParams);
  let off = false;
  const body = await view(
    locale,
    async () => {
      try {
        return (await unwrap(
          s.api.GET('/v1/admin/knowledge/resources', {
            params: { query: filtersToQuery(filters) as never },
          }),
        )) as unknown as KnowledgePage;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          off = true;
          return null;
        }
        throw e;
      }
    },
    (page) =>
      page ? (
        <KnowledgeLibrary
          locale={locale}
          page={page}
          filters={filters}
          canManage={s.can('admin:ai_knowledge:manage')}
        />
      ) : null,
  );
  return (
    <>
      {head}
      <p className="nz-muted">{t(locale, 'kn.intro')}</p>
      {off ? (
        <EmptyState title={t(locale, 'kn.off.title')} body={t(locale, 'kn.off.body')} />
      ) : (
        <>
          <Banner tone="warn">{t(locale, 'kn.notice')}</Banner>
          {body}
        </>
      )}
    </>
  );
}
