import { redirect } from 'next/navigation';
import { mobileGuard } from '../../../../../lib/mobile-view';

/**
 * UI-M10-12: starting a mobile app is the builder's "Start a project" screen with the Mobile tile selected (one prompt, then the workspace opens). This route stays as
 * the Mobile apps entry of the navigation: it still answers the "not enabled" state while `mobile_builder.enabled` is off, and otherwise redirects.
 */
export default async function NewMobileApp({ params }: { params: Promise<{ locale: string }> }) {
  const m = await mobileGuard(params, 'builder:read', 'mobile.title.new');
  if (!m.ok) return m.node;
  redirect(`/${m.locale}/builder/projects?type=mobile`);
}
