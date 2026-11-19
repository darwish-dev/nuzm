import { redirectToWorkspace } from '../../../../../../lib/mobile-view';

/** The former preview page: the Preview panel of the workspace. Kept as a redirect so existing links keep working. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return redirectToWorkspace(params, 'preview');
}
