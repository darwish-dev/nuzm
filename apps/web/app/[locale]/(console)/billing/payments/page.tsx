import { StackedScreens } from '../../../../../sections/stack';
import Payments from '../../../../../sections/billing-payments';
import PaymentMethods from '../../../../../sections/billing-payment-methods';
import Wallet from '../../../../../sections/billing-wallet';

/** Payments, payment methods and the wallet on one page (one billing tab). */
export default async function PaymentsMethodsWallet(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="bill.tab.payments"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'payments', title: 'pay.title', perm: ['billing:read'], Screen: Payments },
        {
          id: 'methods',
          title: 'pay.methods.title',
          perm: ['billing:read'],
          Screen: PaymentMethods,
        },
        { id: 'wallet', title: 'wallet.title', perm: ['billing:read'], Screen: Wallet },
      ]}
    />
  );
}
