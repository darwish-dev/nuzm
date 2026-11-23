import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { KnowledgeRetrieval } from '../../../../../components/KnowledgeRetrieval';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * AI Intelligence Center → Search and recommendations (ADR-065, SCR-K-07). Staff search the platform library, simulate a recommendation with its full explanation, and see or
 * change the recommendation weights. Reading needs `admin:ai_knowledge:read`; changing the weights `admin:ai_knowledge:publish` (the API enforces each). While the platform flag
 * `knowledge.library` is off the API answers 404 and this page says so.
 */
export default async function KnowledgeSearchPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const head = <PageTitle>{t(locale, 'kr.title')}</PageTitle>;
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
  let off = false;
  const body = await view(
    locale,
    async () => {
      try {
        // the settings are cheap to read and tell whether the library is on at all
        await unwrap(
          s.api.GET('/v1/admin/knowledge/settings/recommendation' as never, {} as never),
        );
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          off = true;
          return false;
        }
        throw e;
      }
    },
    (ok) =>
      ok ? (
        <KnowledgeRetrieval locale={locale} canPublish={s.can('admin:ai_knowledge:publish')} />
      ) : null,
  );
  return (
    <>
      {head}
      <p className="nz-muted">{t(locale, 'kr.intro')}</p>
      {off ? (
        <EmptyState title={t(locale, 'kn.off.title')} body={t(locale, 'kn.off.body')} />
      ) : (
        <>
          <Banner tone="warn">{t(locale, 'kr.notice')}</Banner>
          {body}
        </>
      )}
    </>
  );
}
