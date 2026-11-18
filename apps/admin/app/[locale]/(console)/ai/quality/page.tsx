import { notFound } from 'next/navigation';
import { ApiError } from '@nuzm/sdk';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, EmptyState, ForbiddenState, PageTitle } from '@nuzm/ui';
import { AiAdminTabs } from '../../../../../components/AiAdminTabs';
import { QualityPanel } from '../../../../../components/AiQualityPanel';
import { parseQuality } from '../../../../../lib/ai';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M09-14: evaluation reports against the PROPOSED thresholds (owner approval pending) and a trend table. Reports from the scripted mock are
 * NOT VERIFIED: they prove plumbing, not model quality. A missing endpoint (404) or no report is the empty state: quality rows need a real model (BLOCKED until HG-09-01/D-18).
 */
export default async function AiQuality({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  if (!s.can('admin:ai:read'))
    return (
      <>
        <PageTitle>{t(locale, 'aia.quality.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const body = await view(
    locale,
    async () => {
      try {
        const r = await s.api.GET('/v1/admin/ai/quality', {});
        if (r.response.status === 404) return null;
        if (!r.response.ok)
          throw new ApiError(
            r.response.status,
            (r.error as { code?: string } | undefined)?.code ?? 'error',
            undefined,
            undefined,
            undefined,
          );
        return parseQuality(r.data);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    (q) =>
      q === null || q.reports.length === 0 ? (
        <EmptyState
          title={t(locale, 'aia.quality.empty')}
          body={t(locale, 'aia.quality.emptyBody')}
        />
      ) : (
        <QualityPanel locale={locale} quality={q} />
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'aia.quality.title')}</PageTitle>
      <AiAdminTabs locale={locale} current="quality" />
      <Banner tone="warn">{t(locale, 'aia.quality.notice')}</Banner>
      {body}
    </>
  );
}
