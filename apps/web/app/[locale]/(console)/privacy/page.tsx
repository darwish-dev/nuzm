import { StackedScreens } from '../../../../sections/stack';
import Residency from '../../../../sections/data-residency';
import Consents from '../../../../sections/privacy-consents';
import Exports from '../../../../sections/privacy-exports';
import Requests from '../../../../sections/privacy-requests';

/** Privacy and data: requests, consents, exports and residency on one page (opened from the account menu). */
export default async function Privacy(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="nc.grp.privacy"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'requests', title: 'pv.req.title', perm: ['privacy:dsr:self'], Screen: Requests },
        {
          id: 'consents',
          title: 'pv.consents.title',
          perm: ['privacy:consent:self'],
          Screen: Consents,
        },
        { id: 'exports', title: 'pv.exp.title', perm: ['privacy:export:manage'], Screen: Exports },
        {
          id: 'residency',
          title: 'pv.res.title',
          perm: ['privacy:residency:read'],
          Screen: Residency,
        },
      ]}
    />
  );
}
