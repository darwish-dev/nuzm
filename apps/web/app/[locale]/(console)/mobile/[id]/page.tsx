import { redirect } from 'next/navigation';
import { mobileGuard } from '../../../../../lib/mobile-view';

/** A mobile project opens on its overview. */
export default async function MobileProject({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const m = await mobileGuard(params, 'builder:read', 'mobile.title.overview');
  if (!m.ok) return m.node;
  redirect(`/${m.locale}/mobile/${m.id}/preview`);
}
