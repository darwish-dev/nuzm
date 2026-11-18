import { notFound } from 'next/navigation';
import { isLocale, t } from '@nuzm/i18n';
import { Banner, EmptyState, PageTitle } from '@nuzm/ui';
import { AGENCY_DELEGATION_FLAG, flagOn } from '../../../../../../../lib/compute';
import { isUuid } from '../../../../../../../lib/privacy';
import { requireSession } from '../../../../../../../lib/server';

/**
 * UI-M05-16: read-only view of a client's compute, for agencies. Hidden (404) unless the organization is an agency AND the M11
 * delegation flag is on. The delegated data source (per-client read grants) ships with M11, so for now the page is the guarded shell.
 */
export default async function AgencyClientCompute({
  params,
}: {
  params: Promise<{ locale: string; clientId: string }>;
}) {
  const { locale, clientId } = await params;
  if (!isLocale(locale) || !isUuid(clientId)) notFound();
  const s = await requireSession(locale);
  if (s.org?.type !== 'agency' || !flagOn(s.me.featureFlags, AGENCY_DELEGATION_FLAG)) notFound();
  return (
    <>
      <PageTitle>{t(locale, 'm05.web.agency.title')}</PageTitle>
      <Banner tone="warn">{t(locale, 'm05.web.agency.readOnly')}</Banner>
      <EmptyState
        title={t(locale, 'm05.web.agency.pending.title')}
        body={t(locale, 'm05.web.agency.pending.body')}
      />
    </>
  );
}
