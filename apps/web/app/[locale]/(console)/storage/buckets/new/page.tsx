import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { NewBucketForm } from '../../../../../../components/StoragePanels';
import { gate } from '../../../../../../lib/gate';

/** UI-M08-06 (create): name and estimated size → price estimate → confirm. Private by default. */
export default async function NewBucket({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'data:storage:write', 'm8.stn.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  return (
    <>
      <PageTitle>{t(locale, 'm8.stn.title')}</PageTitle>
      <NewBucketForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
    </>
  );
}
