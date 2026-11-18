import { StackedScreens } from '../../../../../sections/stack';
import Plans from '../../../../../sections/billing-plans';
import Subscriptions from '../../../../../sections/billing-subscriptions';

/** Plans and subscriptions on one page (one billing tab). */
export default async function PlansAndSubscriptions(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="nc.item.plansSubs"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'plans', title: 'bill.plans.title', perm: ['org:read'], Screen: Plans },
        { id: 'subscriptions', title: 'sub.title', perm: ['billing:read'], Screen: Subscriptions },
      ]}
    />
  );
}
