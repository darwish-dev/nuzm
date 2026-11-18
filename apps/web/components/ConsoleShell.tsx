'use client';
import { ProfileMenu as BaseProfileMenu } from '@nuzm/ui';
import { browserApi } from '../lib/client';

export { ConsoleFrame } from '@nuzm/ui';

type MenuProps = Parameters<typeof BaseProfileMenu>[0];

/** The account menu wired to the customer realm's sign-out. */
export function ProfileMenu(props: Omit<MenuProps, 'onSignOut'>) {
  return <BaseProfileMenu {...props} onSignOut={() => browserApi().POST('/v1/auth/logout', {})} />;
}
