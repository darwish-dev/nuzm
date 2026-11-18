import { StackedScreens } from '../../../../../sections/stack';
import Invoices from '../../../../../sections/billing-invoices';
import CreditNotes from '../../../../../sections/billing-credit-notes';

/** Invoices and credit notes on one page (one billing tab). */
export default async function InvoicesAndCreditNotes(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="bill.tab.invoices"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'invoices', title: 'inv.title', perm: ['billing:read'], Screen: Invoices },
        { id: 'creditNotes', title: 'cn.title', perm: ['billing:read'], Screen: CreditNotes },
      ]}
    />
  );
}
