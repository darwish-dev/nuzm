import { StackedScreens } from '../../../../../sections/stack';
import Usage from '../../../../../sections/billing-usage';
import Quotas from '../../../../../sections/billing-quotas';

/** Usage and quotas on one page (one billing tab). */
export default async function UsageAndQuotas(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="nc.item.usageQuotas"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'usage', title: 'bill.usage.title', perm: ['usage:read'], Screen: Usage },
        { id: 'quotas', title: 'bill.quotas.title', perm: ['usage:read'], Screen: Quotas },
      ]}
    />
  );
}
