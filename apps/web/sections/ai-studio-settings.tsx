import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { EmptyState, PageTitle } from '@nuzm/ui';
import { AiStudioSettings, type AiStudioSettingsView } from '../components/AiStudioSettings';
import { serverCompute } from '../lib/compute-server';
import { requireSession } from '../lib/server';
import { view } from '../lib/view';

/** AI Studio switches of the organization (ADR-064), on the organization page. */
export default async function AiStudioSettingsScreen({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  const orgId = s.org?.orgId;
  if (!orgId)
    return <EmptyState title={t(locale, 'home.noOrg.title')} body={t(locale, 'home.noOrg.body')} />;
  const body = await view(
    locale,
    async () => {
      const r = await (
        await serverCompute(orgId)
      ).get<AiStudioSettingsView>('/v1/builder/ai-studio/settings');
      if (!r.response.ok || !r.data) throw new Error(`ai studio settings: ${r.response.status}`);
      return r.data;
    },
    (d) => <AiStudioSettings locale={locale} initial={d} canEdit={s.can('org:update')} />,
  );
  return (
    <>
      <PageTitle>{t(locale, 'ais.set.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'ais.set.help')}</p>
      {body}
    </>
  );
}
