import { redirectToWorkspace } from '../../../../../lib/mobile-view';

/** A mobile project opens in the builder workspace, on its preview. Kept as a redirect so existing links keep working. */
export default function Page({ params }: { params: Promise<{ locale: string; id: string }> }) {
  return redirectToWorkspace(params, 'preview');
}
