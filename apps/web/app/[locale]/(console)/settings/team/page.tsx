import { StackedScreens } from '../../../../../sections/stack';
import ApiKeys from '../../../../../sections/api-keys';
import Invitations from '../../../../../sections/invitations';
import Members from '../../../../../sections/members';

/** Team and access: members, invitations and API keys on one page (opened from the account menu). */
export default async function Team(props: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return (
    <StackedScreens
      locale={(await props.params).locale}
      title="nc.grp.team"
      params={props.params}
      searchParams={props.searchParams}
      screens={[
        { id: 'members', title: 'members.title', perm: ['member:read'], Screen: Members },
        {
          id: 'invitations',
          title: 'invitations.title',
          perm: ['member:invite'],
          Screen: Invitations,
        },
        { id: 'apikeys', title: 'apikeys.title', perm: ['apikey:read'], Screen: ApiKeys },
      ]}
    />
  );
}
