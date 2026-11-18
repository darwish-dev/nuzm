import { PageTitle } from '@nuzm/ui';
import { t } from '@nuzm/i18n';
import { NewDatabaseForm } from '../../../../../components/DatabasePanels';
import { gate } from '../../../../../lib/gate';

/** UI-M08-02: engine, version, plan, storage and network → price estimate (quote) → confirm. Unsupported options are refused by the API with a reason. */
export default async function NewDatabase({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gate(params, 'data:db:write', 'm8.dbn.title');
  if (!g.ok) return g.node;
  const { locale, s } = g;
  return (
    <>
      <PageTitle>{t(locale, 'm8.dbn.title')}</PageTitle>
      <p className="nz-muted">{t(locale, 'm8.dbn.help')}</p>
      <NewDatabaseForm locale={locale} mfaFactorId={s.me.mfaFactorId ?? null} />
    </>
  );
}
