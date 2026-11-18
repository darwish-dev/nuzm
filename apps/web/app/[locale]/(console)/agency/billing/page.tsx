import { t } from '@nuzm/i18n';
import { PageTitle } from '@nuzm/ui';
import { AgencyTabs } from '../../../../../components/ProgramTabs';
import { BlockedState } from '../../../../../components/M11Parts';
import { FLAGS } from '../../../../../lib/m11';
import { gateM11 } from '../../../../../lib/m11-server';

/**
 * UI-M11-14: consolidated billing for an agency. BLOCKED: the API has no consolidated-billing endpoint (the agency profile carries a `consolidatedBilling` flag but nothing reads or writes
 * invoices across organizations, and the invoice-issuer model is D-24, open). An explanatory state, not a mock.
 */
export default async function AgencyBilling({ params }: { params: Promise<{ locale: string }> }) {
  const g = await gateM11(params, {
    permission: ['agency:finance', 'agency:manage'],
    title: 'm11.ag.billing.title',
    flag: FLAGS.agency,
    orgType: 'agency',
  });
  if (!g.ok) return g.node;
  const { locale } = g;
  return (
    <>
      <PageTitle>{t(locale, 'm11.ag.billing.title')}</PageTitle>
      <AgencyTabs locale={locale} current="billing" />
      <BlockedState
        locale={locale}
        title={t(locale, 'm11.ag.billing.blockedTitle')}
        body={t(locale, 'm11.ag.billing.blockedBody')}
        missing={t(locale, 'm11.ag.billing.missing')}
      />
    </>
  );
}
