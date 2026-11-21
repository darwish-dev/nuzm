import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { KnowledgeResource } from '../../../../../../components/KnowledgeResource';
import {
  isUuidLike,
  type KnowledgeDetail,
  type KnowledgeVersion,
} from '../../../../../../lib/knowledge';
import { requireStaff } from '../../../../../../lib/server';
import { view } from '../../../../../../lib/view';

/** One resource of the knowledge library: facts, permissions, analysis state, versions, edit, disable and archive (SCR-K-01). */
export default async function KnowledgeResourcePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai_knowledge:read'))
    return (
      <>
        <PageTitle>{t(locale, 'kn.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'kn.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const missing = (
    <>
      <PageTitle>{t(locale, 'kn.title')}</PageTitle>
      <EmptyState title={t(locale, 'kn.d.notFound.title')} body={t(locale, 'kn.d.notFound.body')} />
      <p>
        <a href={`/${locale}/ai-intelligence/library`}>{t(locale, 'kn.d.back')}</a>
      </p>
    </>
  );
  if (!isUuidLike(id)) return missing;
  let gone = false;
  const body = await view(
    locale,
    async () => {
      try {
        const [detail, versions] = await Promise.all([
          unwrap(s.api.GET('/v1/admin/knowledge/resources/{id}', { params: { path: { id } } })),
          unwrap(
            s.api.GET('/v1/admin/knowledge/resources/{id}/versions', {
              params: { path: { id }, query: { limit: 50 } },
            }),
          ),
        ]);
        return {
          detail: detail as unknown as KnowledgeDetail,
          versions: (versions as unknown as { items: KnowledgeVersion[] }).items,
        };
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          gone = true;
          return null;
        }
        throw e;
      }
    },
    (data) =>
      data ? (
        <KnowledgeResource
          locale={locale}
          detail={data.detail}
          versions={data.versions}
          canManage={s.can('admin:ai_knowledge:manage')}
          canPublish={s.can('admin:ai_knowledge:publish')}
        />
      ) : null,
  );
  return gone ? missing : body;
}
